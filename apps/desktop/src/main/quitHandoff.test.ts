import { describe, expect, it } from "vitest";
import { createQuitHandoff } from "./quitHandoff";

function timers() {
  const queue: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  return {
    queue,
    setTimer: (fn: () => void, ms: number) => { const id = next++; queue.push({ fn, ms, id }); return id; },
    clearTimer: (h: unknown) => { const i = queue.findIndex((q) => q.id === h); if (i >= 0) queue.splice(i, 1); },
    fire: () => { const q = queue.shift(); q?.fn(); },
  };
}

describe("quit hand-off", () => {
  it("holds the first attempt, asks once and carries it out on the client's answer", () => {
    const t = timers();
    const asked: number[] = [];
    const h = createQuitHandoff({ ask: (id) => { asked.push(id); return true; }, timeoutMs: 1500, ...t });
    let proceeded = 0;
    expect(h.attempt(() => { proceeded += 1; })).toBe(false);
    expect(asked).toEqual([1]);
    expect(h.pending()).toBe(true);
    expect(t.queue).toHaveLength(1);
    expect(t.queue[0]!.ms).toBe(1500);
    h.answer(1);
    expect(proceeded).toBe(1);
    expect(h.pending()).toBe(false);
    expect(t.queue).toHaveLength(0);
    // From here on every attempt goes ahead at once and the client is not asked again.
    expect(h.attempt(() => { proceeded += 1; })).toBe(true);
    expect(asked).toEqual([1]);
    expect(proceeded).toBe(1);
  });

  it("carries the held attempt out after the time limit when the client does not answer", () => {
    const t = timers();
    const h = createQuitHandoff({ ask: () => true, timeoutMs: 1500, ...t });
    let proceeded = 0;
    h.attempt(() => { proceeded += 1; });
    t.fire();
    expect(proceeded).toBe(1);
    expect(h.attempt(() => { proceeded += 1; })).toBe(true);
    expect(proceeded).toBe(1);
  });

  it("ignores an answer with another id and a late answer", () => {
    const t = timers();
    const h = createQuitHandoff({ ask: () => true, timeoutMs: 1500, ...t });
    let proceeded = 0;
    h.attempt(() => { proceeded += 1; });
    h.answer(7);
    expect(proceeded).toBe(0);
    h.answer(1);
    h.answer(1);
    expect(proceeded).toBe(1);
  });

  it("swallows a second attempt while the first waits; the first one's action runs", () => {
    const t = timers();
    const h = createQuitHandoff({ ask: () => true, timeoutMs: 1500, ...t });
    const ran: string[] = [];
    expect(h.attempt(() => ran.push("close"))).toBe(false);
    expect(h.attempt(() => ran.push("quit"))).toBe(false);
    h.answer(1);
    expect(ran).toEqual(["close"]);
  });

  it("lets an attempt go ahead when there is no client to ask, or when asking throws", () => {
    const t = timers();
    const h = createQuitHandoff({ ask: () => false, timeoutMs: 1500, ...t });
    expect(h.attempt(() => {})).toBe(true);
    expect(t.queue).toHaveLength(0);
    const h2 = createQuitHandoff({ ask: () => { throw new Error("gone"); }, timeoutMs: 1500, ...t });
    expect(h2.attempt(() => {})).toBe(true);
  });

  it("skip drops a pending request without carrying it out and lets everything through", () => {
    const t = timers();
    const h = createQuitHandoff({ ask: () => true, timeoutMs: 1500, ...t });
    let proceeded = 0;
    h.attempt(() => { proceeded += 1; });
    h.skip();
    expect(t.queue).toHaveLength(0);
    expect(h.pending()).toBe(false);
    h.answer(1);
    expect(proceeded).toBe(0);
    expect(h.attempt(() => { proceeded += 1; })).toBe(true);
  });
});
