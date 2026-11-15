import { Worker } from "node:worker_threads";
import { MAX_JSON_CHARS, type FailureKind, type FromWorker, type ToWorker, type WorkerStart } from "./wire";

/**
 * The main thread's side of the sandbox (docs/features/plugins.md): one worker thread per running plugin, started when the
 * first event is due and stopped after `idleMs` without one (a worker costs 11 to 14 MB while it runs). A plugin handles
 * one event at a time; the others wait in its queue. The runner knows nothing about what a plugin may do: host calls go to
 * `onCall` (host.ts) and failures to `onFailure`, which counts them.
 *
 * The watchdog is what bounds CPU time for real (sandbox.ts says why the engine's own interrupt cannot): a worker that
 * stays inside the engine longer than the budget plus `WATCHDOG_GRACE_MS` is terminated. Only that plugin's worker goes,
 * which is the reason for a worker each.
 */

export const WATCHDOG_GRACE_MS = 1000;
const WATCHDOG_TICK_MS = 200;
/** How long one event may take in all, host calls included. */
export const EVENT_WALL_MS = 10_000;
export const EVENT_HOST_CALLS_MAX = 50;
export const EVENT_QUEUE_MAX = 100;
const START_TIMEOUT_MS = 10_000;
const PREPARE_TIMEOUT_MS = 5_000;
/**
 * V8's own heap in a plugin's worker: the engine's JavaScript glue, never the plugin's data (that is the WebAssembly memory).
 * A ceiling, not a reservation; as wide as the link previews' worker, because under `tsx` (development, the tests) the
 * loader compiles the worker's TypeScript in that heap and 48 MB were not enough for it (15 November 2026).
 */
const WORKER_HEAP_MB = 128;

export class PluginFailure extends Error {
  constructor(readonly kind: FailureKind, message: string) { super(message); this.name = "PluginFailure"; }
}

/** What an event's handler gave back. `handled` false = the plugin does not listen to this event. */
export type InvokeResult = { handled: boolean; value: unknown };
/** What the host knows about the event a host call belongs to (who caused it, how deep in a chain of plugins). */
export type InvocationContext = { event: string; depth: number; by?: string; command?: string; channelId?: string };

export type RunnerOptions = {
  workerFile: string | URL;
  /** Node options for the worker; unset = the process's own (under `tsx` the worker inherits its loader that way). Tests name tsx. */
  execArgv?: string[];
  cpuMs: number;
  memoryMb: number;
  idleMs?: number;
  wallMs?: number;
  onCall: (pluginId: string, ctx: InvocationContext, fn: string, args: unknown) => Promise<unknown>;
  onFailure: (pluginId: string, kind: FailureKind, message: string, event: string) => void;
  /** How long the answer of one host function may be, as JSON; unset = `MAX_JSON_CHARS` for all (the service widens `net.get`). */
  answerMax?: (fn: string) => number;
  /** A worker started or stopped: for the plugin's log. */
  onLifecycle?: (pluginId: string, what: "started" | "stopped" | "killed", detail?: string) => void;
};

type Job = { event: string; payload: string; ctx: InvocationContext; resolve: (r: InvokeResult) => void; reject: (e: PluginFailure) => void };
type Running = {
  worker: Worker;
  clock: BigInt64Array;
  ready: boolean;
  handlers: Set<string>;
  startTimer: ReturnType<typeof setTimeout> | null;
};
type Slot = {
  id: string;
  code: string;
  apiVersion: number;
  running: Running | null;
  queue: Job[];
  current: (Job & { id: number; calls: number; wall: ReturnType<typeof setTimeout> }) | null;
  idle: ReturnType<typeof setTimeout> | null;
  /** The events the plugin listened to when it last started; null = never started. An event nobody listens to starts no worker. */
  knownHandlers: Set<string> | null;
};

export class PluginRunner {
  private readonly slots = new Map<string, Slot>();
  private readonly idleMs: number;
  private readonly wallMs: number;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private closed = false;

  constructor(private readonly opts: RunnerOptions) {
    this.idleMs = opts.idleMs ?? 300_000;
    this.wallMs = opts.wallMs ?? EVENT_WALL_MS;
  }

  /** Make a plugin runnable (enabled) or replace its code (update); a running worker of the old code is stopped. */
  load(id: string, code: string, apiVersion: number): void {
    this.unload(id);
    this.slots.set(id, { id, code, apiVersion, running: null, queue: [], current: null, idle: null, knownHandlers: null });
  }

  /** The plugin runs no more (disabled, removed, suspended). Events that wait fail with `killed`. */
  unload(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    this.stopWorker(slot, "stopped");
    this.failAll(slot, new PluginFailure("killed", "the plugin was stopped"));
  }

  has(id: string): boolean { return this.slots.has(id); }
  runningCount(): number { return [...this.slots.values()].filter((s) => s.running).length; }
  /** Does the plugin listen to this event? Unknown until it started once: then the answer is yes, so the first event starts it. */
  listens(id: string, event: string): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    return slot.knownHandlers === null || slot.knownHandlers.has(event);
  }

  /**
   * Hand a plugin an event and wait for its handler. Rejects with a `PluginFailure`; `onFailure` has been told by then.
   * An event of a plugin that is not loaded, or one its queue has no room for, is a failure too (the caller decides
   * whether that matters: a broadcast event is dropped, a member action tells the member).
   */
  invoke(id: string, event: string, payload: unknown, ctx: InvocationContext): Promise<InvokeResult> {
    const slot = this.slots.get(id);
    if (!slot || this.closed) return Promise.reject(new PluginFailure("killed", "the plugin is not running"));
    if (slot.knownHandlers && !slot.knownHandlers.has(event)) return Promise.resolve({ handled: false, value: undefined });
    if (slot.queue.length >= EVENT_QUEUE_MAX) return Promise.reject(new PluginFailure("timeout", `more than ${EVENT_QUEUE_MAX} events wait for this plugin; the event was dropped`));
    let text: string;
    try { text = JSON.stringify(payload ?? null); } catch { return Promise.reject(new PluginFailure("error", "the event could not be written as JSON")); }
    if (text.length > MAX_JSON_CHARS) return Promise.reject(new PluginFailure("error", "the event is too large for a plugin"));
    return new Promise<InvokeResult>((resolve, reject) => {
      slot.queue.push({ event, payload: text, ctx, resolve, reject });
      this.pump(slot);
    });
  }

  /**
   * Read a plugin file in a worker of its own, without running it (sandbox.ts `prepare`): the JavaScript that will run,
   * or why the file is refused. A file that makes the parser hang costs that worker, after `PREPARE_TIMEOUT_MS`.
   */
  prepare(source: string, language: "js" | "ts"): Promise<{ ok: true; code: string } | { ok: false; message: string }> {
    return new Promise((resolve) => {
      const start: WorkerStart = { mode: "prepare", source, language, memoryMb: this.opts.memoryMb };
      let worker: Worker;
      try { worker = this.spawn(start); } catch (err) { resolve({ ok: false, message: `the sandbox could not start: ${String(err)}` }); return; }
      let done = false;
      const finish = (r: { ok: true; code: string } | { ok: false; message: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void worker.terminate().catch(() => {});
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, message: "the file could not be read within the time limit" }), PREPARE_TIMEOUT_MS);
      worker.on("message", (m: FromWorker) => { if (m.t === "prepared") finish(m.ok ? { ok: true, code: m.code } : { ok: false, message: m.message }); });
      worker.on("error", (err) => finish({ ok: false, message: `the file could not be read: ${String((err as Error).message ?? err).split("\n")[0]}` }));
      worker.on("exit", () => finish({ ok: false, message: "the file could not be read (the sandbox ended)" }));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    const workers: Worker[] = [];
    for (const slot of this.slots.values()) {
      if (slot.running) workers.push(slot.running.worker);
      this.stopWorker(slot, "stopped", true);
      this.failAll(slot, new PluginFailure("killed", "the server is stopping"));
    }
    this.slots.clear();
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }

  // ---- inside ----

  private spawn(start: WorkerStart): Worker {
    return new Worker(this.opts.workerFile, { workerData: start, ...(this.opts.execArgv ? { execArgv: this.opts.execArgv } : {}), resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
  }

  private pump(slot: Slot): void {
    if (slot.current || slot.queue.length === 0 || this.slots.get(slot.id) !== slot) return;
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = null; }
    if (!slot.running) { this.startWorker(slot); return; }
    if (!slot.running.ready) return;
    const job = slot.queue.shift()!;
    if (!slot.running.handlers.has(job.event)) { job.resolve({ handled: false, value: undefined }); this.pump(slot); this.armIdle(slot); return; }
    const id = ++this.seq;
    const wall = setTimeout(() => this.fail(slot, "timeout", `the handler of "${job.event}" did not finish within ${this.wallMs / 1000} s`, true), this.wallMs);
    slot.current = { ...job, id, calls: 0, wall };
    this.post(slot, { t: "invoke", id, event: job.event, payload: job.payload });
  }

  private post(slot: Slot, m: ToWorker): void {
    try { slot.running?.worker.postMessage(m); } catch { /* the worker is gone; its exit event reports it */ }
  }

  private startWorker(slot: Slot): void {
    const clock = new BigInt64Array(new SharedArrayBuffer(8));
    let worker: Worker;
    try {
      worker = this.spawn({ mode: "run", pluginId: slot.id, code: slot.code, apiVersion: slot.apiVersion, cpuMs: this.opts.cpuMs, memoryMb: this.opts.memoryMb, clock: clock.buffer as SharedArrayBuffer });
    } catch (err) {
      this.failStart(slot, "crash", `the sandbox could not start: ${String(err)}`);
      return;
    }
    const running: Running = { worker, clock, ready: false, handlers: new Set(), startTimer: null };
    running.startTimer = setTimeout(() => { if (slot.running === running && !running.ready) { this.stopWorker(slot, "killed"); this.failStart(slot, "timeout", "the plugin did not start in time"); } }, START_TIMEOUT_MS);
    slot.running = running;
    this.armWatchdog();
    worker.on("message", (m: FromWorker) => { if (slot.running === running) this.onMessage(slot, running, m); });
    worker.on("error", (err) => {
      if (slot.running !== running) return;
      const message = String((err as Error).message ?? err).split("\n")[0] ?? "error";
      // V8's own heap ran out (the engine's glue, not the plugin's memory) or the worker's code threw: either way it is gone.
      this.dropWorker(slot);
      if (!running.ready) this.failStart(slot, "crash", `the sandbox failed while starting: ${message}`);
      else this.fail(slot, "crash", `the sandbox failed: ${message}`, false);
    });
    worker.on("exit", () => {
      if (slot.running !== running) return;
      this.dropWorker(slot);
      if (!running.ready) this.failStart(slot, "crash", "the sandbox ended while starting");
      else this.fail(slot, "crash", "the sandbox ended unexpectedly", false);
    });
  }

  private onMessage(slot: Slot, running: Running, m: FromWorker): void {
    switch (m.t) {
      case "ready":
        running.ready = true;
        running.handlers = new Set(m.handlers);
        slot.knownHandlers = running.handlers;
        if (running.startTimer) { clearTimeout(running.startTimer); running.startTimer = null; }
        this.opts.onLifecycle?.(slot.id, "started");
        this.pump(slot);
        this.armIdle(slot);
        return;
      case "loadError":
        this.stopWorker(slot, "stopped", true);
        this.failStart(slot, m.kind === "error" ? "load" : m.kind, m.message);
        return;
      case "call": {
        const cur = slot.current;
        if (!cur || cur.id !== m.invocation) { this.post(slot, { t: "result", callId: m.callId, ok: false, error: "squorli: the event this call belongs to has ended" }); return; }
        if (++cur.calls > EVENT_HOST_CALLS_MAX) { this.post(slot, { t: "result", callId: m.callId, ok: false, error: `squorli: more than ${EVENT_HOST_CALLS_MAX} host calls in one event` }); return; }
        let args: unknown;
        try { args = JSON.parse(m.args); } catch { this.post(slot, { t: "result", callId: m.callId, ok: false, error: "squorli: the argument is not JSON" }); return; }
        void this.opts.onCall(slot.id, cur.ctx, m.fn, args).then((value) => {
          const text = value === undefined ? "" : JSON.stringify(value);
          const max = this.opts.answerMax?.(m.fn) ?? MAX_JSON_CHARS;
          if (text.length > max) this.post(slot, { t: "result", callId: m.callId, ok: false, error: `squorli: the answer of ${m.fn} is larger than ${max / 1024} KB` });
          else this.post(slot, { t: "result", callId: m.callId, ok: true, value: text });
        }, (err) => this.post(slot, { t: "result", callId: m.callId, ok: false, error: `squorli: ${String((err as Error)?.message ?? err)}` }));
        return;
      }
      case "done": {
        const cur = slot.current;
        if (!cur || cur.id !== m.id) return;
        if (!m.ok) { this.fail(slot, m.kind, m.message, m.kind === "cpu" || m.kind === "memory"); return; }
        clearTimeout(cur.wall);
        slot.current = null;
        let value: unknown;
        try { value = m.value === "" ? undefined : JSON.parse(m.value); } catch { value = undefined; }
        cur.resolve({ handled: m.handled, value });
        this.pump(slot);
        this.armIdle(slot);
        return;
      }
      default: return;
    }
  }

  /** The event being handled failed. `restart` = the context is not trusted any more: the next event gets a fresh worker. */
  private fail(slot: Slot, kind: FailureKind, message: string, restart: boolean): void {
    const cur = slot.current;
    if (restart) this.stopWorker(slot, kind === "killed" ? "killed" : "stopped", true);
    if (cur) {
      clearTimeout(cur.wall);
      slot.current = null;
      this.opts.onFailure(slot.id, kind, message, cur.event);
      cur.reject(new PluginFailure(kind, message));
    }
    if (this.slots.get(slot.id) === slot) { this.pump(slot); this.armIdle(slot); }
  }

  /** The plugin did not even start: every event that waits fails with the reason, and the failure counts once. */
  private failStart(slot: Slot, kind: FailureKind, message: string): void {
    this.opts.onFailure(slot.id, kind, message, "start");
    this.failAll(slot, new PluginFailure(kind, message));
  }

  private failAll(slot: Slot, err: PluginFailure): void {
    const cur = slot.current;
    if (cur) { clearTimeout(cur.wall); slot.current = null; cur.reject(err); }
    for (const job of slot.queue.splice(0)) job.reject(err);
  }

  private dropWorker(slot: Slot): void {
    const r = slot.running;
    if (!r) return;
    if (r.startTimer) clearTimeout(r.startTimer);
    slot.running = null;
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = null; }
  }

  private stopWorker(slot: Slot, what: "stopped" | "killed", quiet = false): void {
    const r = slot.running;
    if (!r) return;
    this.dropWorker(slot);
    void r.worker.terminate().catch(() => {});
    if (!quiet || what === "killed") this.opts.onLifecycle?.(slot.id, what);
  }

  private armIdle(slot: Slot): void {
    if (slot.idle) { clearTimeout(slot.idle); slot.idle = null; }
    if (!slot.running || slot.current || slot.queue.length) return;
    slot.idle = setTimeout(() => { slot.idle = null; if (!slot.current && slot.queue.length === 0) this.stopWorker(slot, "stopped"); }, this.idleMs);
    slot.idle.unref();
  }

  private armWatchdog(): void {
    if (this.watchdog || this.closed) return;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      let any = false;
      for (const slot of this.slots.values()) {
        const r = slot.running;
        if (!r) continue;
        any = true;
        const since = Number(Atomics.load(r.clock, 0));
        if (since !== 0 && now - since > this.opts.cpuMs + WATCHDOG_GRACE_MS) {
          const wasReady = r.ready;
          this.stopWorker(slot, "killed", true);
          this.opts.onLifecycle?.(slot.id, "killed", `inside the engine for ${now - since} ms`);
          const message = `ran for more than ${this.opts.cpuMs + WATCHDOG_GRACE_MS} ms without a pause and was stopped`;
          if (!wasReady) this.failStart(slot, "killed", message);
          else this.fail(slot, "killed", message, false);
        }
      }
      if (!any && this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    }, WATCHDOG_TICK_MS);
    this.watchdog.unref();
  }
}
