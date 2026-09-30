import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORAGE_CACHE_MS, StorageMeter, membersFull, seatsFull, seatsTaken, walkBytes } from "./limits";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "squorli-limits-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("storage quota", () => {
  it("walks folders below the data folder and counts single files; missing ones are empty", async () => {
    await mkdir(join(dir, "previews", "deep"), { recursive: true });
    await writeFile(join(dir, "previews", "a.png"), Buffer.alloc(100));
    await writeFile(join(dir, "previews", "deep", "b.png"), Buffer.alloc(50));
    await writeFile(join(dir, "server-icon"), Buffer.alloc(7));
    expect(await walkBytes(join(dir, "previews"))).toBe(150);
    expect(await walkBytes(join(dir, "nothing-here"))).toBe(0);
    const meter = new StorageMeter(1, { attachmentsBytes: async () => 1000, dirs: [join(dir, "previews"), join(dir, "reports")], files: [join(dir, "server-icon"), join(dir, "no-icon")] });
    expect(await meter.used()).toBe(1157);
    expect(meter.quotaBytes).toBe(1024 * 1024);
  });

  it("answers room() against the quota and measures again only after the cache or an invalidate", async () => {
    let attachments = 500;
    let measured = 0;
    let now = 1_000_000;
    const meter = new StorageMeter(0.001, { attachmentsBytes: async () => { measured += 1; return attachments; }, dirs: [], files: [] }, () => now);
    // 0.001 MB = 1049 bytes (rounded).
    expect(meter.quotaBytes).toBe(1049);
    expect(await meter.room(500)).toBe(true);
    expect(await meter.room(550)).toBe(false);
    expect(measured).toBe(1);
    attachments = 2000;
    expect(await meter.room()).toBe(true); // the cache still says 500
    meter.invalidate();
    expect(await meter.room()).toBe(false);
    expect(measured).toBe(2);
    now += STORAGE_CACHE_MS;
    attachments = 0;
    expect(await meter.room(1049)).toBe(true);
    expect(measured).toBe(3);
  });

  it("measures nothing and refuses nothing without a quota", async () => {
    let measured = 0;
    const meter = new StorageMeter(undefined, { attachmentsBytes: async () => { measured += 1; return 10 ** 12; }, dirs: [], files: [] });
    expect(meter.quotaBytes).toBeNull();
    expect(await meter.room(10 ** 12)).toBe(true);
    expect(measured).toBe(0);
  });

  it("shares one measurement between questions asked at the same time", async () => {
    let measured = 0;
    const meter = new StorageMeter(1, { attachmentsBytes: async () => { measured += 1; await new Promise((r) => setTimeout(r, 5)); return 1; }, dirs: [], files: [] });
    await Promise.all([meter.used(), meter.used(), meter.room(1)]);
    expect(measured).toBe(1);
  });
});

describe("voice seats", () => {
  const lk = new Map([["u1", "c1"], ["bot", "c2"]]);
  it("counts every person once across the presence list and LiveKit, and not the one asking", () => {
    expect(seatsTaken([{ userId: "u1" }, { userId: "u2" }], lk)).toBe(3);
    expect(seatsTaken([{ userId: "u1" }, { userId: "u2" }], lk, "u1")).toBe(2);
    expect(seatsTaken([{ userId: "u1" }, { userId: "u2" }], null, "u3")).toBe(2);
    expect(seatsTaken([], null)).toBe(0);
  });
  it("is full at the limit and never without one", () => {
    expect(seatsFull(2, 2)).toBe(true);
    expect(seatsFull(1, 2)).toBe(false);
    expect(seatsFull(1000, undefined)).toBe(false);
  });
});

describe("member limit", () => {
  it("is full at the limit and never without one", () => {
    expect(membersFull(5, 5)).toBe(true);
    expect(membersFull(4, 5)).toBe(false);
    expect(membersFull(4, undefined)).toBe(false);
  });
});
