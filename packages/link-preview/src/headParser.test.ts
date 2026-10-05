import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHeadParser, parseHead, type HeadParser } from "./headParser";

/**
 * The main thread's side (headParser.ts) against a stand-in worker written as plain JavaScript (vitest cannot start the
 * TypeScript entry in a worker thread; the real entry, worker.ts, is a few lines and is checked by the consumers' smoke
 * tests). The stand-in speaks the same protocol and misbehaves on request: "hang" spins forever, "crash" throws, "exit"
 * leaves, anything else is echoed back as the title together with the worker's thread id.
 */
const FAKE = `
import { parentPort, threadId } from "node:worker_threads";
parentPort.on("message", (job) => {
  const text = Buffer.from(job.bytes).toString();
  if (text === "hang") { for (;;) {} }
  if (text === "crash") throw new Error("crashed on purpose");
  if (text === "exit") process.exit(3);
  parentPort.postMessage({ id: job.id, meta: { title: "T:" + text + ":" + threadId, description: job.contentType, siteName: job.baseUrl, imageUrl: null } });
});
parentPort.postMessage({ ready: true });
`;

/** Says `ready` only after 150 ms; the first job must wait for it (it is never posted before). */
const SLOW = FAKE.replace('parentPort.postMessage({ ready: true });', 'setTimeout(() => parentPort.postMessage({ ready: true }), 150);');
/** Never says `ready` (a start that hangs): the parser gives up after the budget and reads on the calling thread. */
const NEVER = FAKE.replace('parentPort.postMessage({ ready: true });', 'for (;;) {}');

let dir: string;
let fake: string;
let slow: string;
let never: string;
const parsers: HeadParser[] = [];
const make = (options: Parameters<typeof createHeadParser>[0]) => { const p = createHeadParser(options); parsers.push(p); return p; };
const ask = (p: HeadParser, text: string) => p.parse(Buffer.from(text), "text/html", "https://example.org/");
const threadOf = (title: string | null | undefined) => title?.split(":").pop();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "squorli-head-parser-"));
  fake = join(dir, "fake.mjs");
  slow = join(dir, "slow.mjs");
  never = join(dir, "never.mjs");
  await writeFile(fake, FAKE);
  await writeFile(slow, SLOW);
  await writeFile(never, NEVER);
});
afterAll(async () => {
  await Promise.all(parsers.map((p) => p.close()));
  await rm(dir, { recursive: true, force: true });
});

describe("createHeadParser", () => {
  it("hands the page to the worker and brings its answer back, one page after the other", async () => {
    const p = make({ workerFile: fake });
    expect(p.mode).toBe("worker");
    const answers = await Promise.all(["a", "b", "c", "d", "e"].map((t) => ask(p, t)));
    expect(answers.map((m) => m?.title?.slice(0, 3))).toEqual(["T:a", "T:b", "T:c", "T:d", "T:e"]);
    expect(answers[0]).toMatchObject({ description: "text/html", siteName: "https://example.org/", imageUrl: null });
    expect(new Set(answers.map((m) => threadOf(m?.title))).size).toBe(1); // one worker for all five
  });

  it("a page that is not read within the budget counts as unreadable; the next page gets a fresh worker", async () => {
    const warnings: string[] = [];
    const p = make({ workerFile: fake, budgetMs: 300, warn: (m, d) => warnings.push(`${m} ${JSON.stringify(d)}`) });
    const first = await ask(p, "x");
    const t0 = performance.now();
    expect(await ask(p, "hang")).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(warnings.some((w) => w.includes("budget") && w.includes("https://example.org/"))).toBe(true);
    const after = await ask(p, "y");
    expect(after?.title?.startsWith("T:y:")).toBe(true);
    expect(threadOf(after?.title)).not.toBe(threadOf(first?.title));
    expect(p.mode).toBe("worker");
  });

  it("a worker that throws or leaves makes only its page unreadable", async () => {
    const warnings: string[] = [];
    const p = make({ workerFile: fake, warn: (m) => warnings.push(m) });
    expect(await ask(p, "crash")).toBeNull();
    expect((await ask(p, "a"))?.title?.startsWith("T:a:")).toBe(true);
    expect(await ask(p, "exit")).toBeNull();
    expect((await ask(p, "b"))?.title?.startsWith("T:b:")).toBe(true);
    expect(warnings.filter((w) => w.includes("failed") || w.includes("exited")).length).toBe(2);
    expect(p.mode).toBe("worker");
  });

  it("holds the first page until the worker says ready, and gives up on a worker that never does (5 October 2026, the race seen on a Windows runner)", async () => {
    // A late `ready`: the page waits and is read by the worker, not on the calling thread.
    const late = make({ workerFile: slow, budgetMs: 2000 });
    const first = await ask(late, "late");
    expect(first?.title?.startsWith("T:late:")).toBe(true);
    expect(late.mode).toBe("worker");
    // A crash on the very first job (the case of the race): unreadable, and the parser stays with the worker.
    const crashFirst = make({ workerFile: fake });
    expect(await ask(crashFirst, "crash")).toBeNull();
    expect((await ask(crashFirst, "z"))?.title?.startsWith("T:z:")).toBe(true);
    expect(crashFirst.mode).toBe("worker");
    // No `ready` within the budget: this page and the next are read on the calling thread, the worker is gone.
    const warnings: string[] = [];
    const stuck = make({ workerFile: never, budgetMs: 300, warn: (m, d) => warnings.push(`${m} ${JSON.stringify(d)}`) });
    const html = Buffer.from("<title>Stuck</title>");
    const t0 = performance.now();
    expect((await stuck.parse(html, "text/html", "https://example.org/"))?.title).toBe("Stuck");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(stuck.mode).toBe("inline");
    expect(warnings.some((w) => w.includes("could not start") && w.includes("not ready"))).toBe(true);
    expect((await stuck.parse(html, "text/html", "https://example.org/"))?.title).toBe("Stuck");
  }, 15_000);

  it("without a worker file, or when the worker cannot start, the page is read on the calling thread", async () => {
    const html = Buffer.from('<title>Inline</title><meta property="og:description" content="d">');
    const none = make({});
    expect(none.mode).toBe("inline");
    expect(await none.parse(html, "text/html", "https://example.org/")).toEqual(parseHead(html, "text/html", "https://example.org/"));

    const warnings: string[] = [];
    const missing = make({ workerFile: join(dir, "missing.mjs"), warn: (m) => warnings.push(m) });
    expect(missing.mode).toBe("worker");
    expect(await missing.parse(html, "text/html", "https://example.org/")).toEqual({ title: "Inline", description: "d", siteName: null, imageUrl: null });
    expect(missing.mode).toBe("inline");
    await missing.parse(html, "text/html", "https://example.org/");
    expect(warnings.filter((w) => w.includes("could not start")).length).toBe(1);
  });

  it("stops the worker after idle time and starts a new one for the next page", async () => {
    const p = make({ workerFile: fake, idleMs: 100 });
    const a = await ask(p, "a");
    await new Promise((r) => setTimeout(r, 400));
    const b = await ask(p, "b");
    expect(threadOf(a?.title)).not.toBe(threadOf(b?.title));
  });

  it("after close, pages are read on the calling thread", async () => {
    const p = make({ workerFile: fake });
    expect((await ask(p, "a"))?.title?.startsWith("T:a:")).toBe(true);
    await p.close();
    expect(p.mode).toBe("inline");
    const html = Buffer.from("<title>Danach</title>");
    expect((await p.parse(html, "text/html", "https://example.org/"))?.title).toBe("Danach");
  });
});
