import type { PluginCatalogEntry } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { catalogDate, filterCatalog } from "./catalogSearch";

const entry = (id: string, over: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry => ({
  id, name: { en: id }, description: { en: "A plugin." }, author: null, homepage: null, version: "1.0.0", capabilities: [], hosts: [], signature: { key: "2026-11", kind: "reviewed" },
  signedAt: "2026-11-15", source: null, installedVersion: null, status: "new", ...over,
});
const list = [
  entry("game-news", { name: { en: "Game news", de: "Spiele-News" }, description: { en: "Patch notes and free games.", de: "Patchnotes und kostenlose Spiele." }, author: "Squorli", hosts: ["api.steampowered.com", "www.gamerpower.com"], capabilities: [{ id: "net.fetch", text: { en: "Fetch." }, risk: "low", granted: false }] }),
  entry("weather", { name: { en: "Weather" }, description: { en: "Tomorrow's forecast, also for game nights." }, author: "Maria Beispiel", hosts: ["api.open-meteo.com"] }),
  entry("quotes", { name: { en: "Quotes", de: "Zitate" }, description: { en: "A quote a day." }, author: "Jonas Muster" }),
];
const ids = (query: string) => filterCatalog(list, query).map((e) => e.id);

describe("searching the catalogue", () => {
  it("shows everything for an empty query, in the catalogue's order", () => {
    expect(ids("")).toEqual(["game-news", "weather", "quotes"]);
    expect(ids("   ")).toEqual(["game-news", "weather", "quotes"]);
  });

  it("finds by name in either language, by description, author, id, host and capability", () => {
    expect(ids("spiele")).toEqual(["game-news"]);
    expect(ids("ZITATE")).toEqual(["quotes"]);
    expect(ids("forecast")).toEqual(["weather"]);
    expect(ids("maria")).toEqual(["weather"]);
    expect(ids("gamerpower")).toEqual(["game-news"]);
    expect(ids("open-meteo")).toEqual(["weather"]);
    expect(ids("net.fetch")).toEqual(["game-news"]);
    expect(ids("nothing-like-this")).toEqual([]);
  });

  it("wants every word, anywhere in the entry", () => {
    expect(ids("free steam")).toEqual(["game-news"]);
    expect(ids("free weather")).toEqual([]);
  });

  it("puts a match in the name before a match in the text", () => {
    // "game" stands in the weather plugin's description (it comes first in a list ordered this way) and in the news plugin's name.
    expect(filterCatalog([list[1]!, list[0]!], "game").map((e) => e.id)).toEqual(["game-news", "weather"]);
  });
});

describe("a catalogue's date", () => {
  it("is a moment of that day, or nothing", () => {
    expect(catalogDate("2026-11-15")).toBe("2026-11-15T12:00:00Z");
    expect(catalogDate(null)).toBeNull();
    expect(catalogDate("15.11.2026")).toBeNull();
  });
});
