import { describe, expect, it } from "vitest";
import { dmReactionsOf, type DmReactionCarrier } from "./dmReactions";

const A = "a".repeat(64), B = "b".repeat(64), X = "c".repeat(64);
const M1 = "6f1c2a4e-1b2c-4d3e-8f90-1234567890a1", M2 = "6f1c2a4e-1b2c-4d3e-8f90-1234567890a2";
let seq = 0;
const text = (id: string, from: string): DmReactionCarrier => ({ id, seq: ++seq, from });
const react = (from: string, id: string, emoji: string, on = true): DmReactionCarrier => ({ id: `${id}-${++seq}`, seq, from, control: { type: "reaction", id, emoji, on } });

describe("reactions in a direct message conversation (docs/features/reactions.md)", () => {
  it("folds the instructions into chips: count, me, who, in the order of the first reaction", () => {
    const list = [text(M1, A), text(M2, B), react(B, M1, "👍"), react(A, M1, "🎉"), react(A, M1, "👍")];
    const r = dmReactionsOf(list, A, B);
    expect(r.get(M1)?.chips).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🎉", count: 1, me: true }]);
    expect(r.get(M1)?.who.get("👍")).toEqual([B, A]);
    expect(r.get(M2)).toBeUndefined();
  });
  it("the newest word per sender and emoji counts, and the selector makes no second chip", () => {
    const list = [text(M1, A), react(B, M1, "❤️"), react(A, M1, "❤"), react(B, M1, "❤️", false)];
    const r = dmReactionsOf(list, A, B);
    expect(r.get(M1)?.chips).toEqual([{ emoji: "❤", count: 1, me: true }]); // A's form, B's word is "off"
    const again = dmReactionsOf([...list, react(B, M1, "❤️")], A, B);
    expect(again.get(M1)?.chips).toHaveLength(1);
    expect(again.get(M1)?.chips[0]?.count).toBe(2);
  });
  it("ignores a stranger, an unloaded message and a reaction that was taken back", () => {
    const list = [text(M1, A), react(X, M1, "👍"), react(B, M2, "👍"), react(B, M1, "🎉"), react(B, M1, "🎉", false)];
    expect(dmReactionsOf(list, A, B).size).toBe(0);
  });
  it("the order of arrival decides, not the order of the list", () => {
    const on = react(B, M1, "👍"), off = react(B, M1, "👍", false);
    expect(dmReactionsOf([text(M1, A), off, on], A, B).get(M1)).toBeUndefined();
  });
});
