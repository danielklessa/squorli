import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPluginFile } from "./manifest";
import { PluginRunner, type InvocationContext } from "./runner";

/**
 * The birthdays plugin that ships with the server (apps/server/plugins/birthdays.ts), run in the real sandbox against a
 * host this test plays: storage, settings, the schedule and the channel are plain values here. What is checked is the
 * plugin's own logic: the day that counts in a time zone, summer time, 29 February, the age, one congratulation per day.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "plugins", "birthdays.ts"), "utf8");
const A = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a11", B = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a12", C = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a13";
const ROOM = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1aaa";

let store = new Map<string, unknown>();
let settings: Record<string, unknown> = {};
let sent: { channelId: string; content: string }[] = [];
let scheduled: { when: number; name: string; key?: string }[] = [];
const names: Record<string, string> = { [A]: "Anna", [B]: "Ben", [C]: "Clara" };
const failures: string[] = [];

const runner = new PluginRunner({
  workerFile: join(here, "..", "plugin-worker.ts"), execArgv: ["--import", "tsx"], cpuMs: 200, memoryMb: 32,
  onFailure: (_id, kind, message) => failures.push(`${kind}: ${message}`),
  onCall: async (_id, _ctx, fn, raw) => {
    const args = raw as Record<string, unknown>;
    switch (fn) {
      case "storage.get": return store.has(args.key as string) ? JSON.parse(JSON.stringify(store.get(args.key as string))) : null;
      case "storage.set": store.set(args.key as string, args.value); return true;
      case "settings.get": return settings;
      case "schedule.at": scheduled.push(args as never); return { id: "job", dueAt: new Date(args.when as number).toISOString() };
      case "messages.send": sent.push(args as never); return { id: "message", seq: 1 };
      case "members.get": return names[args.userId as string] ? { userId: args.userId, displayName: names[args.userId as string] } : null;
      default: return undefined;
    }
  },
});
const ctx = (event: string): InvocationContext => ({ event, depth: 0 });
type Answer = { ok?: boolean; message?: { en: string; de: string }; fieldErrors?: Record<string, { en: string; de: string }> };
const command = async (by: string, values: Record<string, unknown>, name = "geburtstag") => (await runner.invoke("birthdays", "command", { command: name, channelId: ROOM, by, text: "", values }, ctx("command"))).value as Answer;
const job = (dueAt: string) => runner.invoke("birthdays", "job", { name: "congratulate", key: "daily", payload: null, dueAt, late: false, attempt: 1 }, ctx("job"));
const entries = () => (store.get("birthdays") ?? {}) as Record<string, { d: number; m: number; y?: number }>;

beforeAll(async () => {
  const read = readPluginFile(source, "birthdays.ts");
  if (!read.ok) throw new Error(read.message);
  const prepared = await runner.prepare(source, read.language);
  if (!prepared.ok) throw new Error(prepared.message);
  runner.load("birthdays", prepared.code, 1);
}, 30_000);
afterAll(() => runner.close());
beforeEach(() => {
  store = new Map(); sent = []; scheduled = []; failures.length = 0;
  settings = { channel: ROOM, hour: 9, zone: "cet", language: "de" };
});

describe("entering a birthday", () => {
  it("stores day and month, the year only when given, and says what will happen", async () => {
    const a = await command(A, { date: "1990-12-24" });
    expect(a.ok).toBe(true);
    expect(a.message!.de).toBe("Gespeichert: 24. Dezember. Der Glückwunsch nennt dein Alter.");
    expect(a.message!.en).toBe("Saved: December 24. The congratulation will name your age.");
    const b = await command(B, { date: "--05-03" }, "birthday");
    expect(b.message!.de).toBe("Gespeichert: 3. Mai. Dein Alter wird nicht genannt, weil du kein Jahr angegeben hast.");
    expect(entries()).toEqual({ [A]: { d: 24, m: 12, y: 1990 }, [B]: { d: 3, m: 5 } });
  }, 30_000);

  it("refuses a missing date and a year that cannot be a year of birth, and takes 29 February with and without a year", async () => {
    expect((await command(A, {})).fieldErrors).toHaveProperty("date");
    expect((await command(A, { date: "2099-04-04" })).fieldErrors).toHaveProperty("date");
    expect((await command(A, { date: "1850-04-04" })).fieldErrors).toHaveProperty("date");
    // Tomorrow is no birthday of anybody alive yet.
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await command(A, { date: tomorrow })).fieldErrors).toHaveProperty("date");
    expect(entries()).toEqual({});
    expect((await command(A, { date: "2024-02-29" })).ok).toBe(true);
    expect((await command(B, { date: "--02-29" })).ok).toBe(true);
    expect(entries()).toEqual({ [A]: { d: 29, m: 2, y: 2024 }, [B]: { d: 29, m: 2 } });
  }, 30_000);

  it("lets a member take their own birthday out again, and only theirs", async () => {
    await command(A, { date: "--01-01" });
    await command(B, { date: "--02-02" });
    expect((await command(A, { remove: true })).message!.de).toBe("Dein Geburtstag wurde entfernt.");
    expect((await command(C, { remove: true })).message!.de).toBe("Von dir war kein Geburtstag eingetragen.");
    expect(entries()).toEqual({ [B]: { d: 2, m: 2 } });
  }, 30_000);

  it("says so when no channel is set up yet", async () => {
    settings = { hour: 9, zone: "cet", language: "de" };
    expect((await command(A, { date: "--01-01" })).message!.de).toContain("Noch ist kein Kanal eingestellt");
  }, 30_000);

  it("forgets a member who leaves the server", async () => {
    await command(A, { date: "--01-01" });
    await command(B, { date: "--02-02" });
    await runner.invoke("birthdays", "member.leave", { userId: A, reason: "kicked" }, ctx("member.leave"));
    expect(entries()).toEqual({ [B]: { d: 2, m: 2 } });
  }, 30_000);
});

describe("the congratulation", () => {
  it("names the age only where a year was given, in the language of the settings", async () => {
    store.set("birthdays", { [A]: { d: 24, m: 12, y: 1990 }, [B]: { d: 24, m: 12 }, [C]: { d: 25, m: 12, y: 2000 } });
    await job("2026-12-24T08:00:00.000Z");
    expect(sent).toEqual([
      { channelId: ROOM, content: `🎉 Alles Gute zum 36. Geburtstag, <@${A}>!` },
      { channelId: ROOM, content: `🎉 Alles Gute zum Geburtstag, <@${B}>!` },
    ]);
    sent = [];
    settings = { ...settings, language: "en" };
    store.set("birthdays", { [A]: { d: 25, m: 12, y: 2005 }, [B]: { d: 25, m: 12, y: 2004 }, [C]: { d: 25, m: 12, y: 2003 } });
    await job("2026-12-25T08:00:00.000Z");
    expect(sent.map((s) => s.content)).toEqual([`🎉 Happy 21st birthday, <@${A}>!`, `🎉 Happy 22nd birthday, <@${B}>!`, `🎉 Happy 23rd birthday, <@${C}>!`]);
  }, 30_000);

  it("congratulates once for a day, also when the job comes twice, and schedules the next day first", async () => {
    store.set("birthdays", { [A]: { d: 24, m: 12 } });
    await job("2026-12-24T08:00:00.000Z");
    await job("2026-12-24T08:00:00.000Z");
    expect(sent.length).toBe(1);
    expect(scheduled.length).toBe(2);
    expect(scheduled[0]).toMatchObject({ name: "congratulate", key: "daily" });
    expect(scheduled[0]!.when).toBeGreaterThan(Date.now());
    expect(scheduled[0]!.when).toBeLessThan(Date.now() + 25 * 3_600_000);
  }, 30_000);

  it("goes by the day in the time zone of the settings, summer time included", async () => {
    store.set("birthdays", { [A]: { d: 2, m: 7 }, [B]: { d: 2, m: 1 } });
    // 22:30 UTC on 1 July is half past midnight on 2 July in Berlin (UTC+2).
    await job("2026-07-01T22:30:00.000Z");
    expect(sent.map((s) => s.content)).toEqual([`🎉 Alles Gute zum Geburtstag, <@${A}>!`]);
    sent = [];
    // 22:30 UTC on 1 January is still 1 January in Berlin (UTC+1): nobody.
    await job("2026-01-01T22:30:00.000Z");
    expect(sent).toEqual([]);
    // An hour later it is the 2nd there.
    await job("2026-01-01T23:30:00.000Z");
    expect(sent.map((s) => s.content)).toEqual([`🎉 Alles Gute zum Geburtstag, <@${B}>!`]);
    sent = [];
    // A fixed zone west of UTC is still on the day before.
    settings = { ...settings, zone: "utc-8" };
    store.set("birthdays", { [C]: { d: 9, m: 3 } });
    await job("2026-03-10T05:00:00.000Z");
    expect(sent.map((s) => s.content)).toEqual([`🎉 Alles Gute zum Geburtstag, <@${C}>!`]);
  }, 30_000);

  it("congratulates somebody born on 29 February on the 28th in a year without one", async () => {
    store.set("birthdays", { [A]: { d: 29, m: 2, y: 2000 } });
    await job("2027-02-28T09:00:00.000Z");
    expect(sent.map((s) => s.content)).toEqual([`🎉 Alles Gute zum 27. Geburtstag, <@${A}>!`]);
    sent = [];
    await job("2028-02-28T09:00:00.000Z");
    expect(sent).toEqual([]);
    await job("2028-02-29T09:00:00.000Z");
    expect(sent.map((s) => s.content)).toEqual([`🎉 Alles Gute zum 28. Geburtstag, <@${A}>!`]);
  }, 30_000);

  it("writes nothing without a channel and schedules at the hour of the settings", async () => {
    settings = { hour: 9, zone: "utc+0", language: "de" };
    store.set("birthdays", { [A]: { d: 24, m: 12 } });
    await job("2026-12-24T09:00:00.000Z");
    expect(sent).toEqual([]);
    await runner.invoke("birthdays", "settings.change", {}, ctx("settings.change"));
    const next = new Date(scheduled.at(-1)!.when);
    expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([9, 0]);
    settings = { hour: 9, zone: "utc+3", language: "de" };
    await runner.invoke("birthdays", "enable", { reason: "enabled" }, ctx("enable"));
    expect(new Date(scheduled.at(-1)!.when).getUTCHours()).toBe(6);
    expect(failures).toEqual([]);
  }, 30_000);
});

describe("the next birthdays", () => {
  it("lists them from today on, with the age where a year was given, for the caller only", async () => {
    settings = { channel: ROOM, hour: 9, zone: "utc+0", language: "de" };
    const now = new Date();
    const day = (offset: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)); return { d: d.getUTCDate(), m: d.getUTCMonth() + 1, year: d.getUTCFullYear() }; };
    const today = day(0), tomorrow = day(1), yesterday = day(-1);
    store.set("birthdays", { [A]: { d: yesterday.d, m: yesterday.m }, [B]: { d: tomorrow.d, m: tomorrow.m, y: tomorrow.year - 30 }, [C]: { d: today.d, m: today.m, y: today.year - 20 } });
    const r = await command(A, {}, "geburtstage");
    const lines = r.message!.de.split("\n");
    expect(lines[0]).toBe("Die nächsten Geburtstage:");
    expect(lines[1]).toBe("heute: Clara (wird 20)");
    expect(lines[2]).toMatch(/^\d{1,2}\. \S+: Ben \(wird 30\)$/);
    // Yesterday's comes last: it is a year away.
    expect(lines[3]).toMatch(/^\d{1,2}\. \S+: Anna$/);
    expect((await command(A, {}, "birthdays")).message!.en.split("\n")[1]).toBe("today: Clara (turns 20)");
    expect(sent).toEqual([]);
  }, 30_000);

  it("says so when nobody entered one, and leaves out whoever is no member any more", async () => {
    expect((await command(A, {}, "geburtstage")).message!.de).toContain("Noch hat niemand einen Geburtstag eingetragen");
    store.set("birthdays", { "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a99": { d: 1, m: 1 } });
    expect((await command(A, {}, "geburtstage")).message!.de).toContain("Noch hat niemand");
  }, 30_000);
});
