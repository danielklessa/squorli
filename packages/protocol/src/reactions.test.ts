import { describe, expect, it } from "vitest";
import { Message, ReactRequest, ReactionChip, ServerEvent, ServerState, SetReactionRoleRequest, emojiKey, isSingleEmoji } from "./index";

describe("reactions: one emoji (docs/features/reactions.md)", () => {
  it("accepts exactly one emoji, sequences included", () => {
    for (const e of ["😀", "🇩🇪", "👍🏽", "👨‍👩‍👧‍👦", "❤️‍🔥", "🏳️‍🌈", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "1️⃣", "#️⃣", "☺️", "🧑‍💻", "👩🏾‍⚕️", "❤️", "✅"]) expect(isSingleEmoji(e), e).toBe(true);
  });
  it("refuses nothing, text, two emoji, typography and padding", () => {
    for (const s of ["", "a", "😀😀", "©", "<script>", " 😀", "😀 ", "1", "#", "😀a", "ab", "👍".repeat(40)]) expect(isSingleEmoji(s), JSON.stringify(s)).toBe(false);
  });
  it("keys the selector away so two keyboards' hearts are one chip, and keeps skin tones and joins apart", () => {
    expect(emojiKey("❤️")).toBe(emojiKey("❤"));
    expect(emojiKey("☺️")).toBe(emojiKey("☺"));
    expect(emojiKey("👍")).not.toBe(emojiKey("👍🏽"));
    expect(emojiKey("👨‍👩‍👧")).not.toBe(emojiKey("👨‍👩‍👧‍👦"));
    expect(emojiKey("é".normalize("NFD"))).toBe("é".normalize("NFC"));
  });
  it("normalizes a request and refuses what is not one emoji", () => {
    expect(ReactRequest.parse({ emoji: "👍" })).toEqual({ emoji: "👍" });
    expect(ReactRequest.parse({ emoji: "❤" })).toEqual({ emoji: "❤️" }); // a bare heart gets its selector
    expect(ReactRequest.parse({ emoji: "❤️" })).toEqual({ emoji: "❤️" });
    expect(ReactRequest.safeParse({ emoji: "👍👍" }).success).toBe(false);
    expect(ReactRequest.safeParse({ emoji: "" }).success).toBe(false);
    expect(ReactRequest.safeParse({ emoji: "ab" }).success).toBe(false);
    expect(SetReactionRoleRequest.parse({ emoji: "✅", roleId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc" }).removeOnUnreact).toBe(false);
  });
});

describe("reactions: wire shapes without a version bump", () => {
  const base = { id: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", seq: 1, channelId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abd", authorId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abe", content: "x", attachments: [], createdAt: "2026-10-06T10:00:00.000Z", editedAt: null };
  it("a message from a server before reactions has none; a chip defaults me to false", () => {
    expect(Message.parse(base).reactions).toBeUndefined();
    expect(Message.parse({ ...base, reactions: [{ emoji: "👍", count: 2 }] }).reactions).toEqual([{ emoji: "👍", count: 2, me: false }]);
    expect(ReactionChip.parse({ emoji: "✅", count: 0, roleId: base.channelId })).toEqual({ emoji: "✅", count: 0, me: false, roleId: base.channelId });
  });
  it("the event carries the whole list and who did what", () => {
    const e = ServerEvent.parse({ type: "message.reactions", channelId: base.channelId, messageId: base.id, reactions: [{ emoji: "👍", count: 1 }], by: base.authorId, emoji: "👍", added: true });
    expect(e.type).toBe("message.reactions");
    if (e.type === "message.reactions") expect(e.reactions).toEqual([{ emoji: "👍", count: 1 }]);
  });
  it("the state's flag is optional", () => {
    expect(ServerState.shape.reactions.isOptional()).toBe(true);
  });
});
