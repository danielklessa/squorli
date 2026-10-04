import { describe, expect, it } from "vitest";
import { moveTile, orderTiles } from "./tileOrder";

const tile = (key: string, me = false) => ({ key, me });
const keys = (items: { key: string }[]) => items.map((i) => i.key);
const fixed = (i: { me: boolean }) => i.me;

describe("orderTiles", () => {
  it("keeps the own tile first, places what the user ordered, appends the rest as it arrived", () => {
    const items = [tile("a"), tile("me", true), tile("b"), tile("c"), tile("d")];
    expect(keys(orderTiles(items, [], fixed))).toEqual(["me", "a", "b", "c", "d"]);
    expect(keys(orderTiles(items, ["c", "a"], fixed))).toEqual(["me", "c", "a", "b", "d"]);
  });
  it("skips keys that are gone and never moves the own tile, whatever the order says", () => {
    const items = [tile("me", true), tile("a"), tile("b")];
    expect(keys(orderTiles(items, ["gone", "b", "me", "a"], fixed))).toEqual(["me", "b", "a"]);
  });
  it("newcomers land at the end of a placed order", () => {
    const order = moveTile(["a", "b", "c"], 2, 0);
    expect(order).toEqual(["c", "a", "b"]);
    const later = [tile("a"), tile("b"), tile("c"), tile("new")];
    expect(keys(orderTiles(later, order, fixed))).toEqual(["c", "a", "b", "new"]);
  });
  it("moveTile leaves the list alone when nothing moves", () => {
    expect(moveTile(["a", "b"], 0, 1)).toEqual(["a", "b"]);
    expect(moveTile(["a", "b"], 0, 2)).toEqual(["b", "a"]);
  });
});
