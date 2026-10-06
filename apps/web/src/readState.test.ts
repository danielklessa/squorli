import type { Message } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { catchUp, markRead, pruneReadState } from "./readState";

const me = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
const msg = (seq: number, authorId: string, content = "hi"): Message => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, seq, channelId: "c", authorId, content, attachments: [], notice: false, createdAt: "2026-09-17T10:00:00.000Z", editedAt: null,
});

describe("read state", () => {
  it("marks a channel unread for newer messages of others and counts mentions among them", () => {
    const list = [msg(5, other), msg(6, other, `<@${me}> schon gelesen`), msg(7, me), msg(8, other, `hey <@${me}>`), msg(9, other, `\`<@${me}>\` nur Code`), msg(10, other, `<@${me}>`)];
    expect(catchUp(list, 6, me)).toEqual({ unread: true, count: 3, mentions: 2, latest: 10 });
    expect(catchUp(list, 10, me)).toEqual({ unread: false, count: 0, mentions: 0, latest: 10 });
  });
  it("does not count own messages", () => {
    expect(catchUp([msg(5, other), msg(6, me), msg(7, me)], 5, me)).toEqual({ unread: false, count: 0, mentions: 0, latest: 7 });
  });
  it("starts a channel this device never saw as read", () => {
    expect(catchUp([msg(5, other, `<@${me}>`)], undefined, me)).toEqual({ unread: false, count: 0, mentions: 0, latest: 5 });
  });
  it("leaves a blocked person's messages out of the marks", () => {
    const list = [msg(5, other), msg(6, other, `<@${me}>`)];
    expect(catchUp(list, 4, me, new Set([other]))).toEqual({ unread: false, count: 0, mentions: 0, latest: 6 });
    expect(catchUp(list, 4, me, new Set(["somebody-else"]))).toEqual({ unread: true, count: 2, mentions: 1, latest: 6 });
    expect(catchUp([], undefined, me)).toEqual({ unread: false, count: 0, mentions: 0, latest: null });
  });
  it("remembers the newest shown message and keeps the object when nothing changed", () => {
    const state = { c: 7 };
    expect(markRead(state, "c", [msg(8, other), msg(9, other)])).toEqual({ c: 9 });
    expect(markRead(state, "c", [msg(3, other)])).toBe(state);
    expect(markRead(state, "d", [])).toBe(state);
    expect(markRead({}, "d", [msg(0, other)])).toEqual({ d: 0 });
  });
  it("forgets deleted channels", () => {
    const state = { a: 1, b: 2 };
    expect(pruneReadState(state, ["a"])).toEqual({ a: 1 });
    expect(pruneReadState(state, ["a", "b", "x"])).toBe(state);
  });
});
