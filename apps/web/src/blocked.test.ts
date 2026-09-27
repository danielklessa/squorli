import { BLOCKED_USERS_MAX } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { normalizeBlocked, parseBlockedLists, parseBlockedNames, sameBlocked, withBlocked } from "./blocked";

const k = (c: string) => c.repeat(64);

describe("blocked people", () => {
  it("keeps only real keys, lower-cased, without repeats and at most the schema's maximum", () => {
    expect(normalizeBlocked([k("A"), " " + k("a"), "not a key", "", 5, k("b"), k("b")])).toEqual([k("a"), k("b")]);
    const many = Array.from({ length: BLOCKED_USERS_MAX + 5 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(normalizeBlocked(many)).toHaveLength(BLOCKED_USERS_MAX);
    expect(normalizeBlocked("nope")).toEqual([]);
  });
  it("compares without the order, and no list counts as an empty one", () => {
    expect(sameBlocked([k("a"), k("b")], [k("b"), k("a")])).toBe(true);
    expect(sameBlocked(null, [])).toBe(true);
    expect(sameBlocked([k("a")], undefined)).toBe(false);
    expect(sameBlocked([k("a")], [k("a"), k("b")])).toBe(false);
  });
  it("blocks and unblocks one key and leaves a full list alone", () => {
    expect(withBlocked([], k("A"), true)).toEqual([k("a")]);
    expect(withBlocked([k("a")], k("a"), true)).toEqual([k("a")]);
    expect(withBlocked([k("a"), k("b")], k("a"), false)).toEqual([k("b")]);
    expect(withBlocked([k("b")], k("a"), false)).toEqual([k("b")]);
    const full = Array.from({ length: BLOCKED_USERS_MAX }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(withBlocked(full, k("f"), true)).toHaveLength(BLOCKED_USERS_MAX);
  });
  it("reads stored lists per identity and ignores broken data", () => {
    expect(parseBlockedLists(null)).toEqual({});
    expect(parseBlockedLists("{broken")).toEqual({});
    expect(parseBlockedLists("[1]")).toEqual({});
    expect(parseBlockedLists(JSON.stringify({ [k("1")]: [k("a"), "x"], nope: [k("b")], [k("2")]: [] }))).toEqual({ [k("1")]: [k("a")] });
  });
  it("reads stored names and drops what is no name", () => {
    expect(parseBlockedNames(JSON.stringify({ [k("a")]: "  Lea ", [k("b")]: "", [k("c")]: 3, x: "Jules" }))).toEqual({ [k("a")]: "Lea" });
    expect(parseBlockedNames("[]")).toEqual({});
  });
});
