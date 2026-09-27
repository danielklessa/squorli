import { describe, expect, it } from "vitest";
import { parseWatchingAttribute, viewersOf, watchingAttribute } from "./shareViewers";

describe("the watching attribute", () => {
  it("is sorted, without doubles and survives the round trip", () => {
    expect(watchingAttribute(["b", "a", "b", ""])).toBe("a,b");
    expect(parseWatchingAttribute("a,b")).toEqual(["a", "b"]);
    expect(parseWatchingAttribute(undefined)).toEqual([]);
    expect(parseWatchingAttribute(" a , ,a")).toEqual(["a"]);
    expect(watchingAttribute([])).toBe("");
  });
  it("names the viewers of a share, never the sharer or the local user", () => {
    const people = [
      { identity: "me", isLocal: true, watching: ["anna"] },
      { identity: "anna", isLocal: false, watching: ["me"] },
      { identity: "ben", isLocal: false, watching: [] },
      { identity: "cem", isLocal: false, watching: ["me", "anna"] },
    ];
    expect(viewersOf(people, "me").map((p) => p.identity)).toEqual(["anna", "cem"]);
    expect(viewersOf(people, "anna").map((p) => p.identity)).toEqual(["cem"]);
  });
});
