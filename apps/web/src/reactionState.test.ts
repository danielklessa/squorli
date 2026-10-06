import { describe, expect, it } from "vitest";
import type { Message } from "@squorli/protocol";
import { applyReactionEvent, keepMe, withReactions } from "./reactionState";

const ME = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", OTHER = "6f1c2a4e-1b2c-4d3e-8f90-123456789abd", CH = "6f1c2a4e-1b2c-4d3e-8f90-123456789abe";
const msg = (id: string, reactions?: Message["reactions"]): Message => ({ id, seq: 1, channelId: CH, authorId: OTHER, content: "x", attachments: [], notice: false, createdAt: "2026-10-06T10:00:00.000Z", editedAt: null, ...(reactions ? { reactions } : {}) });
const M1 = "6f1c2a4e-1b2c-4d3e-8f90-1234567890a1", M2 = "6f1c2a4e-1b2c-4d3e-8f90-1234567890a2";

describe("reactions in the channel cache (docs/features/reactions.md)", () => {
  it("my own add and remove set my flag, somebody else's leaves it as it was", () => {
    const list = [msg(M1, [{ emoji: "👍", count: 1, me: true }]), msg(M2)];
    const mine = applyReactionEvent(list, { type: "message.reactions", channelId: CH, messageId: M1, reactions: [{ emoji: "👍", count: 2 }, { emoji: "🎉", count: 1 }], by: ME, emoji: "🎉", added: true }, ME);
    expect(mine[0]!.reactions).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🎉", count: 1, me: true }]);
    expect(mine[1]).toBe(list[1]);
    const theirs = applyReactionEvent(mine, { type: "message.reactions", channelId: CH, messageId: M1, reactions: [{ emoji: "👍", count: 3 }, { emoji: "🎉", count: 2 }], by: OTHER, emoji: "👍", added: true }, ME);
    expect(theirs[0]!.reactions).toEqual([{ emoji: "👍", count: 3, me: true }, { emoji: "🎉", count: 2, me: true }]);
    const gone = applyReactionEvent(theirs, { type: "message.reactions", channelId: CH, messageId: M1, reactions: [{ emoji: "👍", count: 2 }, { emoji: "🎉", count: 2 }], by: ME, emoji: "👍", added: false }, ME);
    expect(gone[0]!.reactions).toEqual([{ emoji: "👍", count: 2, me: false }, { emoji: "🎉", count: 2, me: true }]);
  });
  it("the list is replaced: a vanished chip is gone, a configured one with count 0 stays, the selector does not matter", () => {
    const list = [msg(M1, [{ emoji: "❤️", count: 1, me: true }, { emoji: "🎉", count: 1, me: false }])];
    const next = applyReactionEvent(list, { type: "message.reactions", channelId: CH, messageId: M1, reactions: [{ emoji: "❤", count: 1 }, { emoji: "✅", count: 0, roleId: CH }], by: OTHER, emoji: "🎉", added: false }, ME);
    expect(next[0]!.reactions).toEqual([{ emoji: "❤", count: 1, me: true }, { emoji: "✅", count: 0, me: false, roleId: CH }]);
  });
  it("keepMe carries my flags across a whole message and tolerates a server without reactions", () => {
    expect(keepMe(undefined, [{ emoji: "👍", count: 1, me: true }])).toBeUndefined();
    expect(keepMe([{ emoji: "👍", count: 2, me: false }], undefined)).toEqual([{ emoji: "👍", count: 2, me: false }]);
    expect(keepMe([{ emoji: "👍", count: 2, me: false }, { emoji: "🎉", count: 1, me: false }], [{ emoji: "👍", count: 1, me: true }])).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🎉", count: 1, me: false }]);
  });
  it("a REST answer replaces the chips of its message only", () => {
    const list = [msg(M1, [{ emoji: "👍", count: 1, me: false }]), msg(M2)];
    const next = withReactions(list, { messageId: M1, channelId: CH, reactions: [{ emoji: "👍", count: 2, me: true }] });
    expect(next[0]!.reactions).toEqual([{ emoji: "👍", count: 2, me: true }]);
    expect(next[1]).toBe(list[1]);
  });
});
