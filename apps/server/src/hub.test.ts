import { AFK_AFTER_MS } from "@squorli/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { Hub } from "./hub";

const sock = () => ({ readyState: 1, OPEN: 1, send() {}, close() {} }) as unknown as WebSocket;

describe("Hub AFK state", () => {
  afterEach(() => vi.useRealTimers());

  it("is AFK only while every connection of the user is idle", () => {
    const hub = new Hub();
    const a = sock(), b = sock();
    hub.add("u1", a, "s1"); hub.add("u1", b, "s2");
    hub.setIdle(a, true);
    expect(hub.isAfk("u1")).toBe(false);
    hub.setIdle(b, true);
    expect(hub.isAfk("u1")).toBe(true);
    expect(hub.afkUsers()).toEqual(["u1"]);
    hub.setIdle(a, false);
    expect(hub.isAfk("u1")).toBe(false);
  });

  it("tells the presence listeners about every change, once", () => {
    const hub = new Hub();
    const events: string[] = [];
    hub.onPresence((userId, online) => events.push(`${userId}:${online}`));
    const a = sock();
    hub.add("u1", a, "s1");
    hub.setIdle(a, true); hub.setIdle(a, true);
    hub.setIdle(a, false);
    expect(events).toEqual(["u1:true", "u1:true", "u1:true"]);
  });

  it("counts a new connection as active and forgets the state when the user goes offline", () => {
    const hub = new Hub();
    const a = sock(), b = sock();
    hub.add("u1", a, "s1");
    hub.setIdle(a, true);
    hub.add("u1", b, "s2");
    expect(hub.isAfk("u1")).toBe(false);
    hub.remove(b); hub.remove(a);
    expect(hub.isAfk("u1")).toBe(false);
    expect(hub.isOnline("u1")).toBe(false);
  });

  it("a connection whose client went silent counts as idle until it speaks again", () => {
    const hub = new Hub();
    const a = sock(), b = sock();
    hub.add("u1", a, "s1"); hub.add("u1", b, "s2");
    hub.setIdle(a, true);
    hub.setStale(b, true);
    expect(hub.isAfk("u1")).toBe(true);
    hub.setStale(b, false);
    expect(hub.isAfk("u1")).toBe(false);
    // Closing a silent connection is not "the connection in use closed": no new waiting time.
    hub.setStale(b, true);
    hub.remove(b);
    expect(hub.isAfk("u1")).toBe(true);
  });

  it("waits the full time after the connection in use has closed", () => {
    vi.useFakeTimers();
    const hub = new Hub();
    const events: string[] = [];
    const a = sock(), b = sock();
    hub.add("u1", a, "s1"); hub.add("u1", b, "s2");
    hub.setIdle(a, true);
    hub.onPresence((userId) => events.push(userId));
    // The user was active in b until it closed: the idle connection that remains does not make them absent right away.
    hub.remove(b);
    expect(hub.isAfk("u1")).toBe(false);
    vi.advanceTimersByTime(AFK_AFTER_MS - 1000);
    expect(hub.isAfk("u1")).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(hub.isAfk("u1")).toBe(true);
    expect(events).toEqual(["u1"]);
  });

  it("activity during that time keeps the user present", () => {
    vi.useFakeTimers();
    const hub = new Hub();
    const a = sock(), b = sock();
    hub.add("u1", a, "s1"); hub.add("u1", b, "s2");
    hub.setIdle(a, true);
    hub.remove(b);
    hub.setIdle(a, false);
    vi.advanceTimersByTime(AFK_AFTER_MS);
    expect(hub.isAfk("u1")).toBe(false);
  });
});

describe("Hub game display", () => {
  it("answers every viewer by the rule that came with the game and fires the listeners when the rule alone changes", () => {
    const hub = new Hub();
    const A = "a".repeat(64), B = "b".repeat(64);
    const s = sock();
    hub.add("u1", s, "s1");
    let told = 0;
    hub.onPresence(() => { told++; });
    hub.setGame(s, { name: "Balatro" });
    expect(hub.hasGameAudiences()).toBe(false);
    expect(hub.gameFor("u1", null)).toEqual({ name: "Balatro" });
    told = 0;
    hub.setGame(s, { name: "Balatro" }, { mode: "only", keys: [A] });
    expect(told).toBe(1);
    expect(hub.hasGameAudiences()).toBe(true);
    expect(hub.gameFor("u1", A)).toEqual({ name: "Balatro" });
    expect(hub.gameFor("u1", B)).toBeNull();
    expect(hub.gameFor("u1", null)).toBeNull();
    hub.setGame(s, { name: "Balatro" }, { mode: "only", keys: [A] });
    expect(told).toBe(1);
    hub.setGame(s, { name: "Balatro" }, { mode: "except", keys: [A] });
    expect(hub.gameFor("u1", A)).toBeNull();
    expect(hub.gameFor("u1", B)).toEqual({ name: "Balatro" });
    hub.setGame(s, null);
    expect(hub.hasGameAudiences()).toBe(false);
  });

  const cs2 = { id: "steam:730", name: "Counter-Strike 2" };
  const balatro = { name: "Balatro" };

  it("takes the game a connection reports, the last report among a member's connections counts", () => {
    const hub = new Hub();
    const a = sock(), b = sock();
    hub.add("u1", a, "s1"); hub.add("u1", b, "s2");
    expect(hub.gameOf("u1")).toBeNull();
    hub.setGame(a, cs2);
    hub.setGame(b, balatro);
    expect(hub.gameOf("u1")).toEqual(balatro);
    hub.setGame(a, cs2); // reported again: now the last one
    expect(hub.gameOf("u1")).toEqual(cs2);
    hub.setGame(a, null);
    expect(hub.gameOf("u1")).toEqual(balatro);
    expect(hub.gameOf("u2")).toBeNull();
  });

  it("tells the presence listeners about a change only, and is independent of the AFK state", () => {
    const hub = new Hub();
    const a = sock();
    hub.add("u1", a, "s1");
    const events: string[] = [];
    hub.onPresence((userId) => events.push(userId));
    hub.setGame(a, cs2); hub.setGame(a, { ...cs2 }); hub.setGame(a, null); hub.setGame(a, null);
    expect(events).toEqual(["u1", "u1"]);
    hub.setGame(a, cs2);
    hub.setIdle(a, true);
    expect(hub.isAfk("u1")).toBe(true);
    expect(hub.gameOf("u1")).toEqual(cs2);
  });

  it("drops the game with the connection that reported it and says so while the member stays online", () => {
    const hub = new Hub();
    const a = sock(), b = sock();
    hub.add("u1", a, "s1"); hub.add("u1", b, "s2");
    hub.setGame(a, cs2);
    const events: string[] = [];
    hub.onPresence((userId, online) => events.push(`${userId}:${online}`));
    hub.remove(a);
    expect(hub.gameOf("u1")).toBeNull();
    expect(events).toEqual(["u1:true"]);
    hub.setGame(b, balatro);
    hub.remove(b);
    expect(hub.gameOf("u1")).toBeNull();
    expect(events).toEqual(["u1:true", "u1:true", "u1:false"]);
  });
});
