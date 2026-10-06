import type { Channel, VoiceMember } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { categorySummary, pruneCollapsed, toggleCollapsed, type SummaryInput } from "./collapsedCategories";

const ch = (id: string, kind: "text" | "voice"): Channel => ({
  id, kind, name: id, topic: null, categoryId: "k", position: 0, audioBitrate: 64, audioStereo: false, radio: null,
  sticky: false, stickyPersist: false, stickyHideVoice: true, userLimit: null, slowmodeSeconds: 0, defaultNotify: "all", allowRadio: true, allowVideo: true, allowVoteKick: true, private: false,
} as Channel);
const vm = (userId: string): VoiceMember => ({ userId, displayName: userId, micMuted: false, deafened: false, cameraOn: false, screenOn: false });
const base: SummaryInput = { unread: {}, unreadCount: {}, mentions: {}, muted: {}, voice: {}, afkChannelId: null };

describe("collapsed categories", () => {
  const channels = [ch("t1", "text"), ch("t2", "text"), ch("t3", "text"), ch("v1", "voice"), ch("v2", "voice"), ch("afk", "voice")];
  it("sums unread messages and mentions over the text channels, people over the voice channels", () => {
    const s: SummaryInput = { ...base, unread: { t1: true, t2: true, t3: false }, unreadCount: { t1: 3, t2: 2, t3: 7 }, mentions: { t1: 1, t2: 0 }, voice: { v1: [vm("a"), vm("b")], v2: [vm("c")] } };
    expect(categorySummary(channels, s)).toEqual({ unread: 5, mentions: 1, voice: 3 });
  });
  it("leaves muted channels out of the unread sum but keeps their mentions, and the AFK channel out of the voice count", () => {
    const s: SummaryInput = { ...base, unread: { t1: true, t2: true }, unreadCount: { t1: 3, t2: 2 }, mentions: { t2: 2 }, muted: { t2: true }, voice: { v1: [vm("a")], afk: [vm("z"), vm("y")] }, afkChannelId: "afk" };
    expect(categorySummary(channels, s)).toEqual({ unread: 3, mentions: 2, voice: 1 });
  });
  it("counts an unread channel without a count as one (a server from before the count)", () => {
    expect(categorySummary(channels, { ...base, unread: { t1: true }, unreadCount: {} })).toEqual({ unread: 1, mentions: 0, voice: 0 });
    expect(categorySummary(channels, { ...base, unread: { t1: false }, unreadCount: { t1: 4 } })).toEqual({ unread: 0, mentions: 0, voice: 0 });
    expect(categorySummary([], base)).toEqual({ unread: 0, mentions: 0, voice: 0 });
  });
  it("toggles without touching the given set", () => {
    const a = new Set(["k1"]);
    const b = toggleCollapsed(a, "k2");
    expect([...b].sort()).toEqual(["k1", "k2"]);
    expect([...toggleCollapsed(b, "k1")]).toEqual(["k2"]);
    expect([...a]).toEqual(["k1"]);
  });
  it("forgets categories that are gone and keeps the set when nothing changed", () => {
    const s = new Set(["k1", "k2"]);
    expect(pruneCollapsed(s, ["k1", "k2", "k3"])).toBe(s);
    expect([...pruneCollapsed(s, ["k2"])]).toEqual(["k2"]);
  });
});
