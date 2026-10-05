import { Worker } from "node:worker_threads";
import { decodeHtml, parsePageMeta, type PageMeta } from "./parse";

/**
 * Reading a page's head away from the thread that serves everybody else (security audit of 5 October 2026, H-1). The
 * parser itself is linear now (`parse.ts`); this is the second wall: whoever looks links up (the chat server, the
 * directory, the desktop app) hands the page's bytes to one worker thread and waits at most `budgetMs`. A page that is not
 * read in time is terminated together with its worker and counts as unreadable (no preview); the next page gets a fresh
 * worker. The worker is started when the first page arrives and stopped after `idleMs` without work; it never keeps the
 * process alive. Without a `workerFile`, or when the worker cannot be started (the file is missing, no loader for it), the
 * page is read on the calling thread, with a warning once: a preview is never worth a feature that stops working.
 *
 * The consumer bundles the worker's entry file itself (a few lines that call `runHeadParserWorker()` from
 * `@squorli/link-preview/worker`) and passes its path: the three consumers are bundled differently (tsup ESM, tsup CJS for
 * Electron), and the file has to lie next to the bundle in development and in the build alike.
 */
export type HeadParser = {
  /** What the page says about itself; null = not readable within the budget (the caller treats it as "no preview"). */
  parse(body: Buffer, contentType: string, baseUrl: string): Promise<PageMeta | null>;
  /** Stops the worker. Pages that still arrive are read on the calling thread. */
  close(): Promise<void>;
  /** How the next page would be read: in the worker, or on the calling thread. */
  readonly mode: "worker" | "inline";
};

export type HeadParserOptions = {
  /** The consumer's bundled worker entry. None = read every page on the calling thread. */
  workerFile?: string | URL | undefined;
  /** Wall-clock time a page may take, default DEFAULT_BUDGET_MS. */
  budgetMs?: number | undefined;
  /** Time without work after which the worker is stopped, default 60 s; 0 = never. */
  idleMs?: number | undefined;
  /** Node options for the worker; default: inherited from the process (so a TypeScript loader in development reaches it). */
  execArgv?: string[] | undefined;
  /** Something the operator should know: the budget was exceeded (the detail names the address), the worker failed or could not start. */
  warn?: ((message: string, detail: Record<string, unknown>) => void) | undefined;
};

/** What the main thread sends: the page's bytes (transferred, not copied), its type and address; the worker answers with the same id. */
export type HeadParserJob = { id: number; bytes: ArrayBuffer; contentType: string; baseUrl: string };
/** `ready` once the worker listens (a job is posted only after it, so a worker that dies before it is one that could not start), then one answer per job. */
export type HeadParserReply = { ready: true } | { id: number; meta: PageMeta } | { id: number; error: string };

export const DEFAULT_BUDGET_MS = 1000;
const DEFAULT_IDLE_MS = 60_000;
/** The worker's heap: a 512 KB page and its decoded text need a few MB; a bomb hits this and only kills the worker. */
const WORKER_HEAP_MB = 128;

/** The whole reading on the calling thread: decode, then parse. */
export function parseHead(body: Buffer, contentType: string, baseUrl: string): PageMeta {
  return parsePageMeta(decodeHtml(body, contentType), baseUrl);
}

type Pending = { job: HeadParserJob | null; body: Buffer; contentType: string; baseUrl: string; resolve: (meta: PageMeta | null) => void };

export function createHeadParser(options: HeadParserOptions = {}): HeadParser {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const warn = options.warn ?? (() => {});
  let worker: Worker | null = null;
  let ready = false;
  let inlineOnly = !options.workerFile;
  let closed = false;
  let nextId = 1;
  const queue: Pending[] = [];
  let current: Pending | null = null;
  /** The current job was handed to the worker (only after `ready`; until then it waits in `current`). */
  let sent = false;
  let budget: ReturnType<typeof setTimeout> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const inline = (p: Pending) => { try { p.resolve(parseHead(p.body, p.contentType, p.baseUrl)); } catch { p.resolve(null); } };

  function finish(): void {
    current = null;
    sent = false;
    if (budget) { clearTimeout(budget); budget = null; }
  }

  function stop(): void {
    if (idle) { clearTimeout(idle); idle = null; }
    const w = worker;
    worker = null;
    if (w) void w.terminate().catch(() => {});
  }

  /** The worker never got to work: this process reads its pages on the calling thread from now on. */
  function giveUp(err: unknown, p: Pending | null): void {
    inlineOnly = true;
    warn("link preview: parser worker could not start, reading pages on the main thread", { error: String(err) });
    if (p) inline(p);
  }

  function start(): Worker {
    const w = new Worker(options.workerFile!, { ...(options.execArgv ? { execArgv: options.execArgv } : {}), resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    ready = false;
    w.on("message", (reply: HeadParserReply) => {
      if (worker !== w) return;
      if ("ready" in reply) {
        ready = true;
        // The page that waited for the worker goes now. A job is never posted before `ready`: the worker's `error` and the
        // `ready` message travel over different ports and may overtake each other (seen on a Windows runner, 5 October
        // 2026: the crash of the first job arrived before `ready` and read as "could not start", which switched the
        // parser to the calling thread for good). With the job held back, an error before `ready` is only ever a start that failed.
        if (current && !sent) { if (budget) { clearTimeout(budget); budget = null; } dispatch(current, w); }
        return;
      }
      if (!current || reply.id !== current.job?.id) return;
      const p = current;
      finish();
      if ("meta" in reply) p.resolve(reply.meta);
      else { warn("link preview: page not readable", { error: reply.error, url: p.baseUrl }); p.resolve(null); }
      next();
    });
    w.on("error", (err) => {
      if (worker !== w) return;
      const p = current;
      finish();
      worker = null;
      if (!ready) giveUp(err, p);
      else { warn("link preview: parser worker failed", { error: String(err), url: p?.baseUrl }); p?.resolve(null); }
      next();
    });
    w.on("exit", (code) => {
      if (worker !== w) return;
      // Gone without being asked (out of memory, a crash): this page counts as unreadable, the next one gets a fresh worker.
      const p = current;
      finish();
      worker = null;
      if (!ready) giveUp(`exited with code ${code} before it was ready`, p);
      else if (p) { warn("link preview: parser worker exited", { code, url: p.baseUrl }); p.resolve(null); }
      next();
    });
    return w;
  }

  function next(): void {
    if (current) return;
    const p = queue.shift();
    if (!p) {
      if (worker) { worker.unref(); if (idleMs > 0) { idle = setTimeout(stop, idleMs); idle.unref(); } }
      return;
    }
    if (idle) { clearTimeout(idle); idle = null; }
    if (closed || inlineOnly || !p.job) { inline(p); next(); return; }
    if (!worker) {
      try { worker = start(); } catch (err) { giveUp(err, p); next(); return; }
    }
    current = p;
    worker.ref();
    const w = worker;
    if (ready) { dispatch(p, w); return; }
    // Not ready yet: the job waits for the `ready` message (the handler above dispatches it). A worker that does not get
    // there within the budget could not start: this page and every later one are read on the calling thread.
    budget = setTimeout(() => {
      if (worker !== w || current !== p) return;
      finish();
      worker = null;
      void w.terminate().catch(() => {});
      giveUp(`not ready within ${budgetMs} ms`, p);
      next();
    }, budgetMs);
  }

  /** Hands the current job to the worker and starts its budget. */
  function dispatch(p: Pending, w: Worker): void {
    sent = true;
    budget = setTimeout(() => {
      if (worker !== w || current !== p) return;
      finish();
      worker = null;
      warn("link preview: page not read within the budget", { budgetMs, url: p.baseUrl });
      p.resolve(null);
      void w.terminate().catch(() => {});
      next();
    }, budgetMs);
    w.postMessage(p.job, [p.job!.bytes]);
  }

  return {
    get mode() { return closed || inlineOnly ? "inline" : "worker"; },
    parse(body, contentType, baseUrl) {
      return new Promise((resolve) => {
        let job: HeadParserJob | null = null;
        if (!closed && !inlineOnly) {
          // Its own copy: the bytes are transferred to the worker, the caller's buffer stays as it is.
          const copy = new Uint8Array(body.byteLength);
          copy.set(body);
          job = { id: nextId++, bytes: copy.buffer, contentType, baseUrl };
        }
        queue.push({ job, body, contentType, baseUrl, resolve });
        next();
      });
    },
    async close() {
      closed = true;
      const p = current;
      finish();
      p?.resolve(null);
      stop();
      next();
    },
  };
}
