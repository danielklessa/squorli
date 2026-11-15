import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PluginFailure, PluginRunner, type InvocationContext, type RunnerOptions } from "./runner";
import type { FailureKind } from "./wire";

/**
 * The sandbox against a hostile plugin (docs/features/plugins.md): the real worker (`src/plugin-worker.ts` through tsx), the
 * real engine. What a plugin can reach, and that every budget ends the plugin and nothing else.
 */
const workerFile = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin-worker.ts");
const ctx: InvocationContext = { event: "test", depth: 0 };

type Harness = { runner: PluginRunner; failures: { id: string; kind: FailureKind; message: string }[]; calls: { id: string; fn: string; args: unknown }[] };
const open: PluginRunner[] = [];
function harness(over: Partial<RunnerOptions> = {}): Harness {
  const failures: Harness["failures"] = [], calls: Harness["calls"] = [];
  const runner = new PluginRunner({
    workerFile, execArgv: ["--import", "tsx"], cpuMs: 200, memoryMb: 32,
    onCall: async (id, _ctx, fn, args) => { calls.push({ id, fn, args }); if (fn === "storage.get") return { stored: (args as { key: string }).key }; if (fn === "boom") throw new Error("refused by the host"); return undefined; },
    onFailure: (id, kind, message) => failures.push({ id, kind, message }),
    ...over,
  });
  open.push(runner);
  return { runner, failures, calls };
}
afterEach(async () => { await Promise.all(open.splice(0).map((r) => r.close())); });

const on = (event: string, body: string) => `squorli.on(${JSON.stringify(event)}, async (e) => { ${body} });`;
async function failureOf(p: Promise<unknown>): Promise<PluginFailure> {
  try { await p; } catch (err) { return err as PluginFailure; }
  throw new Error("expected the event to fail");
}

describe("what a plugin can reach", () => {
  it("has the language and squorli, and nothing of Node", async () => {
    const h = harness();
    h.runner.load("probe", on("test", `
      const g = (function () {}).constructor("return this")();
      let imported = "no";
      try { await import("node:fs"); imported = "yes"; } catch (err) { imported = String(err); }
      return { process: typeof process, require: typeof require, fetch: typeof fetch, setTimeout: typeof setTimeout, WebAssembly: typeof WebAssembly,
        sameGlobal: g === globalThis, imported, api: squorli.apiVersion, frozen: Object.isFrozen(squorli), payload: e };`), 1);
    const r = await h.runner.invoke("probe", "test", { hello: 1 }, ctx);
    expect(r.handled).toBe(true);
    expect(r.value).toEqual({ process: "undefined", require: "undefined", fetch: "undefined", setTimeout: "undefined", WebAssembly: "undefined",
      sameGlobal: true, imported: expect.stringContaining("could not load module"), api: 1, frozen: true, payload: { hello: 1 } });
    expect(h.failures).toEqual([]);
  }, 30_000);

  it("reaches the host only through calls the main thread answers", async () => {
    const h = harness();
    h.runner.load("caller", on("test", `
      const a = await squorli.storage.get("k1");
      let refused = "";
      try { await __host("boom", "null"); } catch (err) { refused = String(err.message); }
      return { a, refused };`), 1);
    const r = await h.runner.invoke("caller", "test", null, ctx);
    expect(r.value).toEqual({ a: { stored: "k1" }, refused: "squorli: refused by the host" });
    expect(h.calls.map((c) => c.fn)).toEqual(["storage.get", "boom"]);
  }, 30_000);

  it("gets no answer from the host outside an event", async () => {
    const h = harness();
    h.runner.load("stray", `let late = "nothing"; squorli.storage.get("at-load").catch((e) => { late = String(e.message); });\n${on("test", "return late;")}`, 1);
    const r = await h.runner.invoke("stray", "test", null, ctx);
    expect(r.value).toMatch(/only while an event is being handled/);
    expect(h.calls).toEqual([]);
  }, 30_000);

  it("says so when the plugin does not listen to an event, without a failure", async () => {
    const h = harness();
    h.runner.load("quiet", on("test", "return 1;"), 1);
    expect(await h.runner.invoke("quiet", "other", null, ctx)).toEqual({ handled: false, value: undefined });
    expect(h.runner.listens("quiet", "test")).toBe(true);
    expect(h.runner.listens("quiet", "other")).toBe(false);
    expect(h.failures).toEqual([]);
  }, 30_000);
});

describe("the budgets", () => {
  it("ends an endless loop at the CPU budget and keeps the plugin usable", async () => {
    const h = harness();
    h.runner.load("loop", `${on("spin", "for (;;) { try { while (true) {} } catch (e) {} }")}\n${on("test", "return 2;")}`, 1);
    const t0 = Date.now();
    const f = await failureOf(h.runner.invoke("loop", "spin", null, ctx));
    expect(f.kind).toBe("cpu");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await h.runner.invoke("loop", "test", null, ctx)).value).toBe(2);
    expect(h.failures.map((x) => x.kind)).toEqual(["cpu"]);
  }, 30_000);

  it("ends a regular expression bomb", async () => {
    const h = harness();
    h.runner.load("regex", on("test", `return /^(a+)+$/.test("a".repeat(40) + "!");`), 1);
    expect((await failureOf(h.runner.invoke("regex", "test", null, ctx))).kind).toBe("cpu");
  }, 30_000);

  it("kills a plugin that hides in a native function, and only that one", async () => {
    const h = harness();
    h.runner.load("native", on("test", `function f(n) { try { return f(n + 1) + 1; } catch (e) { return f(n + 1); } } return f(0);`), 1);
    h.runner.load("neighbour", on("test", `return "still here";`), 1);
    const slow = failureOf(h.runner.invoke("native", "test", null, ctx));
    const fine = await h.runner.invoke("neighbour", "test", null, ctx);
    expect(fine.value).toBe("still here");
    const f = await slow;
    expect(["killed", "cpu"]).toContain(f.kind);
    // The next event starts a fresh worker.
    h.runner.load("native", on("test", `return "fresh";`), 1);
    expect((await h.runner.invoke("native", "test", null, ctx)).value).toBe("fresh");
  }, 30_000);

  it("stops a memory bomb at the plugin's own ceiling", async () => {
    const h = harness();
    h.runner.load("bomb", `${on("fill", "const keep = []; for (;;) keep.push(new Uint8Array(1024 * 1024));")}\n${on("test", "return 3;")}`, 1);
    h.runner.load("neighbour", on("test", "return 4;"), 1);
    const before = process.memoryUsage().rss;
    const f = await failureOf(h.runner.invoke("bomb", "fill", null, ctx));
    expect(["memory", "cpu"]).toContain(f.kind);
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
    expect((await h.runner.invoke("neighbour", "test", null, ctx)).value).toBe(4);
    expect((await h.runner.invoke("bomb", "test", null, ctx)).value).toBe(3);
  }, 30_000);

  it("turns a deep recursion and a huge string into ordinary errors", async () => {
    const h = harness();
    h.runner.load("deep", `${on("stack", "function f(n) { return f(n + 1) + 1; } return f(0);")}\n${on("string", `return "x".repeat(2 ** 29).length;`)}`, 1);
    expect((await failureOf(h.runner.invoke("deep", "stack", null, ctx))).message).toMatch(/stack overflow/);
    expect(["memory", "error"]).toContain((await failureOf(h.runner.invoke("deep", "string", null, ctx))).kind);
  }, 30_000);

  it("refuses the fifty-first host call of one event and an oversized argument", async () => {
    const h = harness();
    h.runner.load("flood", `${on("many", `let n = 0, refused = ""; for (let i = 0; i < 60; i++) { try { await squorli.storage.get("k" + i); n++; } catch (e) { refused = String(e.message); } } return { n, refused };`)}
${on("big", `try { await squorli.storage.set("k", "x".repeat(70000)); return "sent"; } catch (e) { return String(e.message); }`)}`, 1);
    const many = await h.runner.invoke("flood", "many", null, ctx);
    expect(many.value).toEqual({ n: 50, refused: expect.stringContaining("more than 50 host calls") });
    expect((await h.runner.invoke("flood", "big", null, ctx)).value).toMatch(/larger than 64 KB/);
  }, 30_000);

  it("gives up on a handler that never settles", async () => {
    const h = harness({ wallMs: 600 });
    h.runner.load("never", `${on("hang", "await new Promise(() => {});")}\n${on("test", "return 5;")}`, 1);
    const f = await failureOf(h.runner.invoke("never", "hang", null, ctx));
    expect(f.kind).toBe("timeout");
    expect((await h.runner.invoke("never", "test", null, ctx)).value).toBe(5);
  }, 30_000);

  it("reports a handler that throws with the line it threw in", async () => {
    const h = harness();
    h.runner.load("thrower", `squorli.on("test", () => {\n  throw new Error("line two");\n});`, 1);
    const f = await failureOf(h.runner.invoke("thrower", "test", null, ctx));
    expect(f.kind).toBe("error");
    expect(f.message).toContain("Error: line two");
    expect(f.message).toContain("thrower.js:2");
  }, 30_000);

  it("fails every waiting event when the plugin cannot even start", async () => {
    const h = harness();
    h.runner.load("broken", `throw new Error("at the top");`, 1);
    const f = await failureOf(h.runner.invoke("broken", "test", null, ctx));
    expect(f.kind).toBe("load");
    expect(f.message).toContain("at the top");
  }, 30_000);

  it("stops a worker that is idle and starts it again for the next event", async () => {
    const h = harness({ idleMs: 150 });
    h.runner.load("sleepy", `let n = 0;\n${on("test", "return ++n;")}`, 1);
    expect((await h.runner.invoke("sleepy", "test", null, ctx)).value).toBe(1);
    expect(h.runner.runningCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(h.runner.runningCount()).toBe(0);
    // A fresh context: what the plugin kept in a variable is gone, which is why plugins keep state in storage.
    expect((await h.runner.invoke("sleepy", "test", null, ctx)).value).toBe(1);
  }, 30_000);
});

describe("reading a file before it is stored", () => {
  it("takes JavaScript as it is and removes the types of TypeScript, line for line", async () => {
    const h = harness();
    expect(await h.runner.prepare("squorli.on('test', () => 1);", "js")).toEqual({ ok: true, code: "squorli.on('test', () => 1);" });
    const ts = `interface Rule { roleId: string }\nconst rules: Rule[] = [];\nsquorli.on("test", (e: { n: number }): number => {\n  throw new Error("line four");\n});`;
    const r = await h.runner.prepare(ts, "ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code.split("\n").length).toBe(ts.split("\n").length);
    expect(r.code).not.toContain("interface");
    h.runner.load("typed", r.code, 1);
    expect((await failureOf(h.runner.invoke("typed", "test", { n: 1 }, ctx))).message).toContain("typed.js:4");
  }, 30_000);

  it("refuses what needs more than removing types, a syntax error and a file that does not compile", async () => {
    const h = harness();
    const en = await h.runner.prepare("enum Color { Red }\nsquorli.on('test', () => Color.Red);", "ts");
    expect(en).toEqual({ ok: false, message: expect.stringMatching(/enum.*bundler/s) });
    expect((await h.runner.prepare("const = ;", "ts")).ok).toBe(false);
    const js = await h.runner.prepare("function (", "js");
    expect(js.ok).toBe(false);
    if (!js.ok) expect(js.message).toMatch(/SyntaxError/);
    // A type nested 20,000 deep overflows the parser's stack: an answer, not a hang.
    expect((await h.runner.prepare(`const x: ${"Array<".repeat(20000)}number${">".repeat(20000)} = [];`, "ts")).ok).toBe(false);
  }, 30_000);
});
