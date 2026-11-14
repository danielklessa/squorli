import { describe, expect, it } from "vitest";
import { GAME_AUDIENCE_MAX } from "@squorli/protocol";
import { DEFAULT_GAME_AUDIENCE, audienceMenuAction, normalizeGameAudience, parseAudienceNames, sameAudienceSetting, suggestAudiencePeople, withAudiencePerson } from "./gameAudience";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);

describe("who may see my game: the setting", () => {
  it("starts with everybody and survives odd stored values", () => {
    expect(normalizeGameAudience(undefined)).toEqual(DEFAULT_GAME_AUDIENCE);
    expect(normalizeGameAudience({ mode: "only", only: [A, "nokey"], except: [B] })).toEqual({ mode: "only", only: [A], except: [B] });
  });

  it("puts a person on a list and takes them off, keeping the other list", () => {
    const one = withAudiencePerson(DEFAULT_GAME_AUDIENCE, "only", A.toUpperCase(), true);
    expect(one).toEqual({ mode: "all", only: [A], except: [] });
    expect(withAudiencePerson(one, "only", A, true)).toBe(one); // already there
    const two = withAudiencePerson(one, "except", B, true);
    expect(two).toEqual({ mode: "all", only: [A], except: [B] });
    expect(withAudiencePerson(two, "only", A, false)).toEqual({ mode: "all", only: [], except: [B] });
    expect(withAudiencePerson(two, "only", C, false)).toBe(two);
    expect(withAudiencePerson(two, "only", "nokey", true)).toBe(two);
  });

  it("never grows a list past the limit", () => {
    const full = { mode: "only" as const, only: Array.from({ length: GAME_AUDIENCE_MAX }, (_, i) => i.toString(16).padStart(64, "0")), except: [] };
    expect(withAudiencePerson(full, "only", A, true)).toBe(full);
  });

  it("compares settings without the order inside a list", () => {
    expect(sameAudienceSetting({ mode: "only", only: [A, B], except: [] }, { mode: "only", only: [B, A], except: [] })).toBe(true);
    expect(sameAudienceSetting({ mode: "only", only: [A], except: [] }, { mode: "except", only: [A], except: [] })).toBe(false);
    expect(sameAudienceSetting({ mode: "all", only: [A], except: [] }, { mode: "all", only: [], except: [A] })).toBe(false);
  });
});

describe("who may see my game: a person's menu", () => {
  it("hides from somebody, which turns everybody into all but the listed", () => {
    const a = audienceMenuAction(DEFAULT_GAME_AUDIENCE, A);
    expect(a).toEqual({ kind: "hide", next: { mode: "except", only: [], except: [A] } });
    expect(audienceMenuAction(a!.next, A)).toEqual({ kind: "unhide", next: { mode: "except", only: [], except: [] } });
    expect(audienceMenuAction(a!.next, B)?.kind).toBe("hide");
  });
  it("shows to somebody or stops showing while only selected people see it", () => {
    const only = { mode: "only" as const, only: [A], except: [B] };
    expect(audienceMenuAction(only, A)).toEqual({ kind: "unshow", next: { mode: "only", only: [], except: [B] } });
    expect(audienceMenuAction(only, C)).toEqual({ kind: "show", next: { mode: "only", only: [A, C], except: [B] } });
    expect(audienceMenuAction(only, "nokey")).toBeNull();
  });
});

describe("who may see my game: the people to choose from", () => {
  const people = [
    { publicKey: A, name: "Anna", handle: "@anna" },
    { publicKey: B, name: "Bernd Anders", handle: "~bernd" },
    { publicKey: C, name: "Zoe", handle: null },
  ];
  it("finds by name or handle, a typed prefix sign included, and leaves the listed out", () => {
    expect(suggestAudiencePeople(people, "an", new Set()).map((p) => p.name)).toEqual(["Anna", "Bernd Anders"]);
    expect(suggestAudiencePeople(people, "@anna", new Set()).map((p) => p.name)).toEqual(["Anna"]);
    expect(suggestAudiencePeople(people, "~bernd", new Set()).map((p) => p.name)).toEqual(["Bernd Anders"]);
    expect(suggestAudiencePeople(people, "an", new Set([A])).map((p) => p.name)).toEqual(["Bernd Anders"]);
    expect(suggestAudiencePeople(people, "xy", new Set())).toEqual([]);
  });
});

describe("who may see my game: remembered names", () => {
  it("reads only keys with a name", () => {
    expect(parseAudienceNames(JSON.stringify({ [A]: " Anna ", nokey: "x", [B]: "", [C]: 3 }))).toEqual({ [A]: "Anna" });
    expect(parseAudienceNames("not json")).toEqual({});
    expect(parseAudienceNames(null)).toEqual({});
  });
});
