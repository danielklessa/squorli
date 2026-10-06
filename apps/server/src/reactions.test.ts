import { describe, expect, it } from "vitest";
import { mergeChips, type ReactionGroup, type ReactionRuleRow } from "./reactions";

const M = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", ROLE = "6f1c2a4e-1b2c-4d3e-8f90-123456789abd", ROLE2 = "6f1c2a4e-1b2c-4d3e-8f90-123456789abe";
const g = (emojiKey: string, count: number, firstAt: number, mine = false, emoji = emojiKey): ReactionGroup => ({ messageId: M, emojiKey, emoji, count, mine, firstAt });
const r = (emojiKey: string, roleId: string, createdAt: number, emoji = emojiKey): ReactionRuleRow => ({ messageId: M, emojiKey, emoji, roleId, createdAt });

describe("reactions: the chips of a message (docs/features/reactions.md)", () => {
  it("orders by the first reaction and carries the viewer's flag", () => {
    expect(mergeChips([g("👍", 2, 20, true), g("🎉", 1, 10)], [])).toEqual([{ emoji: "🎉", count: 1, me: false }, { emoji: "👍", count: 2, me: true }]);
  });
  it("a configured emoji nobody used is a chip with count 0, and the configured ones come first in the order they were made", () => {
    expect(mergeChips([g("👍", 1, 5)], [r("✅", ROLE, 30), r("🎮", ROLE2, 20)])).toEqual([
      { emoji: "🎮", count: 0, me: false, roleId: ROLE2 }, { emoji: "✅", count: 0, me: false, roleId: ROLE }, { emoji: "👍", count: 1, me: false },
    ]);
  });
  it("a used emoji with a rule carries both, drawn as the first sender typed it", () => {
    expect(mergeChips([g("❤", 3, 1, true, "❤️")], [r("❤", ROLE, 99, "❤")])).toEqual([{ emoji: "❤️", count: 3, me: true, roleId: ROLE }]);
  });
  it("nothing gives nothing", () => {
    expect(mergeChips([], [])).toEqual([]);
  });
});
