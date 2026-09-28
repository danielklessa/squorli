import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_SIGNALS, installShutdown, type ShutdownProcess } from "./shutdown";

function setup(close: () => Promise<unknown>) {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const proc: ShutdownProcess = { on: (signal, listener) => { listeners.set(signal, listener); }, exit: (code) => { exits.push(code); } };
  const log = { info: vi.fn(), error: vi.fn() };
  const app = { close: vi.fn(close), log };
  installShutdown(app, proc, 1000);
  return { app, proc, exits, send: (signal: string) => listeners.get(signal)!(), signals: [...listeners.keys()] };
}

describe("installShutdown", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("listens for SIGINT, SIGTERM and SIGBREAK", () => {
    expect(setup(async () => {}).signals).toEqual([...SHUTDOWN_SIGNALS]);
  });

  it("closes the server once and lets the process end with code 0", async () => {
    const s = setup(async () => {});
    s.send("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.app.close).toHaveBeenCalledTimes(1);
    expect(s.proc.exitCode).toBe(0);
    expect(s.exits).toEqual([]);
    // Something still holds the process: it ends anyway, and the close timeout no longer fires.
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.exits).toEqual([0]);
  });

  it("ends the process when the close never finishes", async () => {
    const s = setup(() => new Promise(() => {}));
    s.send("SIGTERM");
    await vi.advanceTimersByTimeAsync(999);
    expect(s.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.exits).toEqual([1]);
  });

  it("ends the process at once on a second signal", async () => {
    const s = setup(() => new Promise(() => {}));
    s.send("SIGBREAK");
    s.send("SIGINT");
    expect(s.app.close).toHaveBeenCalledTimes(1);
    expect(s.exits).toEqual([1]);
  });

  it("ends with code 1 when the close fails", async () => {
    const s = setup(async () => { throw new Error("kaputt"); });
    s.send("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.exits).toEqual([1]);
    expect(s.app.log.error).toHaveBeenCalled();
  });
});
