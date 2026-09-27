import { refusedHostHash } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { REFUSED_LIST_MAX_AGE_MS, hostRefused, loadDismissedRefused, loadRefusedList, refusedList, refusedListDue, sameHidden, saveDismissedRefused, saveRefusedList, shownRefused } from "./refusedServers";

const DIR = "https://directory.example.org";
const NOW = 1_800_000_000_000;
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe("refused chat servers", () => {
  it("refuses a host that is on the list, whatever its case, and no other", async () => {
    const list = refusedList(DIR, [await refusedHostHash("bad.example.org"), await refusedHostHash("bad.example.org:8443")], NOW);
    expect(await hostRefused(list, DIR, "bad.example.org")).toBe(true);
    expect(await hostRefused(list, `${DIR}/`, "BAD.example.org")).toBe(true);
    expect(await hostRefused(list, DIR, "bad.example.org:8443")).toBe(true);
    expect(await hostRefused(list, DIR, "bad.example.org:9000")).toBe(false);
    expect(await hostRefused(list, DIR, "good.example.org")).toBe(false);
  });

  it("refuses nothing without a list, and nothing under another directory", async () => {
    const list = refusedList(DIR, [await refusedHostHash("bad.example.org")], NOW);
    expect(await hostRefused(null, DIR, "bad.example.org")).toBe(false);
    expect(await hostRefused(list, null, "bad.example.org")).toBe(false);
    expect(await hostRefused(list, "https://other.example.org", "bad.example.org")).toBe(false);
    expect(await hostRefused(refusedList(DIR, [], NOW), DIR, "bad.example.org")).toBe(false);
  });

  it("keeps an older list in force: its age only says when to fetch again", async () => {
    const list = refusedList(DIR, [await refusedHostHash("bad.example.org")], NOW);
    const later = NOW + 30 * 86_400_000;
    expect(refusedListDue(list, DIR, later)).toBe(true);
    expect(await hostRefused(list, DIR, "bad.example.org")).toBe(true);
  });

  it("is due without a list, for another directory and after an hour", () => {
    const list = refusedList(DIR, [], NOW);
    expect(refusedListDue(null, DIR, NOW)).toBe(true);
    expect(refusedListDue(list, DIR, NOW + REFUSED_LIST_MAX_AGE_MS - 1)).toBe(false);
    expect(refusedListDue(list, `${DIR}/`, NOW + 1)).toBe(false);
    expect(refusedListDue(list, DIR, NOW + REFUSED_LIST_MAX_AGE_MS)).toBe(true);
    expect(refusedListDue(list, "https://other.example.org", NOW + 1)).toBe(true);
  });

  it("survives on the device and drops what is no hash", async () => {
    const storage = memory();
    const hash = await refusedHostHash("bad.example.org");
    saveRefusedList(refusedList(DIR, [hash, hash], NOW), storage);
    expect(loadRefusedList(storage)).toEqual({ directory: DIR, fetchedAt: NOW, hashes: [hash] });
    storage.setItem("chat.refusedServers.v1", JSON.stringify({ directory: DIR, fetchedAt: NOW, hashes: [hash, "bad.example.org", 5] }));
    expect(loadRefusedList(storage)?.hashes).toEqual([hash]);
    storage.setItem("chat.refusedServers.v1", "{nope");
    expect(loadRefusedList(storage)).toBeNull();
    expect(loadRefusedList(memory())).toBeNull();
    expect(loadRefusedList(null)).toBeNull();
  });
});

describe("refused servers of the account's list", () => {
  const key = (h: string) => h.toLowerCase();
  const refused = [{ host: "Bad.example.org" }, { host: "worse.example.org" }];

  it("shows them all until the user removes one on this device", () => {
    expect(shownRefused(refused, [], key)).toEqual({ shown: refused, dismissed: [] });
    expect(shownRefused(refused, ["bad.example.org"], key)).toEqual({ shown: [refused[1]], dismissed: ["bad.example.org"] });
  });

  it("forgets the removal of a server that is not refused any more, so it shows again when allowed", () => {
    expect(shownRefused([refused[1]!], ["bad.example.org", "worse.example.org"], key)).toEqual({ shown: [], dismissed: ["worse.example.org"] });
    expect(shownRefused([], ["bad.example.org"], key)).toEqual({ shown: [], dismissed: [] });
  });

  it("compares two lists of hidden hosts whatever their order; an account that says nothing hides nothing", () => {
    expect(sameHidden(["a.example", "b.example"], ["b.example", "a.example"])).toBe(true);
    expect(sameHidden(["a.example"], ["a.example", "b.example"])).toBe(false);
    expect(sameHidden([], null)).toBe(true);
    expect(sameHidden(["a.example"], null)).toBe(false);
  });

  it("keeps the removals on the device and drops what is no host", () => {
    const storage = memory();
    expect(loadDismissedRefused(storage)).toEqual([]);
    saveDismissedRefused(["bad.example.org", "worse.example.org"], storage);
    expect(loadDismissedRefused(storage)).toEqual(["bad.example.org", "worse.example.org"]);
    storage.setItem("chat.refusedDismissed.v1", JSON.stringify(["bad.example.org", "bad.example.org", 5, "", null]));
    expect(loadDismissedRefused(storage)).toEqual(["bad.example.org"]);
    storage.setItem("chat.refusedDismissed.v1", "{nope");
    expect(loadDismissedRefused(storage)).toEqual([]);
    expect(loadDismissedRefused(null)).toEqual([]);
  });
});
