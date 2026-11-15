import { describe, expect, it } from "vitest";
import { CATALOG_URL, catalogAddress, catalogAllowed, catalogStatus, compareVersions, readCatalog, releaseAddress } from "./catalog";

const entry = (over: Record<string, unknown> = {}) => ({
  id: "game-news", name: { en: "Game news", de: "Spiele-News" }, description: { en: "Posts news.", de: "Schreibt News." }, author: "Squorli", homepage: "https://squorli.com/en/docs/plugins/",
  kind: "official", version: "1.0.0", apiVersion: 2, capabilities: ["messages.write", "net.fetch"], hosts: ["api.steampowered.com"], language: "ts", file: "game-news.ts",
  sha256: "5".repeat(64), key: "2026-11", signedAt: "2026-11-15",
  download: "https://evil.example/game-news.ts", source: "https://evil.example/source", ...over,
});

describe("reading the catalogue", () => {
  it("takes the list as the signing workflow writes it and ignores what it does not know", () => {
    const list = readCatalog({ version: 1, plugins: [entry({ somethingNew: 1 })] })!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "game-news", kind: "official", version: "1.0.0", hosts: ["api.steampowered.com"], file: "game-news.ts", author: "Squorli" });
    // Where a file lies is never read from the list.
    expect(list[0]).not.toHaveProperty("download");
    expect(list[0]).not.toHaveProperty("source");
  });

  it("is no catalogue when it is no list, and empty when it lists nothing", () => {
    for (const bad of [null, "x", [], {}, { version: 1 }, { version: 0, plugins: [] }, { plugins: [] }]) expect(readCatalog(bad)).toBeNull();
    expect(readCatalog({ version: 1, plugins: [] })).toEqual([]);
    // A list of a later format version is read as far as its entries fit.
    expect(readCatalog({ version: 2, plugins: [entry()] })).toHaveLength(1);
  });

  it("leaves out an entry it cannot read, alone, and a second one with an id that was there", () => {
    const bad = [
      entry({ id: "Bad Id" }), entry({ id: "no-hash", file: "no-hash.ts", sha256: "xyz" }), entry({ id: "other-file", file: "evil.ts" }), entry({ id: "path-file", file: "../path-file.ts" }),
      entry({ id: "bad-kind", file: "bad-kind.ts", kind: "partner" }), entry({ id: "bad-version", file: "bad-version.ts", version: "1.0" }), entry({ id: "bad-host", file: "bad-host.ts", hosts: ["10.0.0.1"] }),
      entry({ id: "no-name", file: "no-name.ts", name: { en: "  " } }), entry({ id: "wrong-lang", file: "wrong-lang.js" }), 5, null, "x",
    ];
    const list = readCatalog({ version: 1, plugins: [...bad, entry(), entry({ description: { en: "A second one under the same id." } }), entry({ id: "plain-one", file: "plain-one.js", language: "js", kind: "reviewed", capabilities: [], hosts: [], author: null, homepage: null })] })!;
    expect(list.map((e) => e.id)).toEqual(["game-news", "plain-one"]);
    expect(list[0]!.description.en).toBe("Posts news.");
    expect(list[1]).toMatchObject({ kind: "reviewed", author: null, homepage: null, hosts: [], capabilities: [] });
  });

  it("cleans the author's texts: one line, no control characters or direction marks, a bounded length, https only", () => {
    const [e] = readCatalog({ version: 1, plugins: [entry({
      name: { en: `Game${String.fromCharCode(27)}[2J\nnews${String.fromCharCode(0x202e)}`, de: "x".repeat(200) },
      description: { en: `a\tb\n\nc ${"y".repeat(400)}` }, author: `  Somebody\n<b>else</b>${String.fromCharCode(0x202e)}  `, homepage: "javascript:alert(1)",
    })] })!;
    expect(e!.name).toEqual({ en: "Game[2J news", de: "x".repeat(60) });
    expect(e!.description.en.startsWith("a b c yyy")).toBe(true);
    expect(e!.description.en.length).toBe(300);
    expect(e!.author).toBe("Somebody <b>else</b>"); // text, shown as text
    expect(e!.homepage).toBeNull();
    expect(readCatalog({ version: 1, plugins: [entry({ homepage: "http://squorli.com/" })] })![0]!.homepage).toBeNull();
  });
});

describe("the two addresses of the catalogue", () => {
  it("are fixed: the list at raw.githubusercontent.com, a file under the repository's releases", () => {
    expect(catalogAddress()).toBe(CATALOG_URL);
    expect(releaseAddress({ id: "game-news", version: "1.0.0", file: "game-news.ts" })).toBe("https://github.com/danielklessa/squorli-plugins/releases/download/game-news-v1.0.0/game-news.ts");
    expect(catalogAddress("http://127.0.0.1:3198")).toBe("http://127.0.0.1:3198/catalog.json");
    expect(releaseAddress({ id: "a-b", version: "2.0.1", file: "a-b.js" }, "http://127.0.0.1:3198")).toBe("http://127.0.0.1:3198/releases/download/a-b-v2.0.1/a-b.js");
  });

  it("let the list's fetch ask the list and nothing else", () => {
    const ok = (address: string) => catalogAllowed(new URL(address), "catalog");
    expect(ok(CATALOG_URL)).toBe(true);
    for (const address of [
      "https://raw.githubusercontent.com/danielklessa/squorli-plugins/main/revoked.json", "https://raw.githubusercontent.com/somebody/squorli-plugins/main/catalog.json", `${CATALOG_URL}?x=1`,
      "http://raw.githubusercontent.com/danielklessa/squorli-plugins/main/catalog.json", "https://github.com/danielklessa/squorli-plugins/releases/download/a-b-v1.0.0/a-b.ts", "https://evil.example/catalog.json",
    ]) expect(ok(address), address).toBe(false);
  });

  it("let a download ask the repository's releases and the hosts GitHub sends it on to", () => {
    const ok = (address: string) => catalogAllowed(new URL(address), "release");
    expect(ok("https://github.com/danielklessa/squorli-plugins/releases/download/game-news-v1.0.0/game-news.ts")).toBe(true);
    expect(ok("https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sp=r&sig=x")).toBe(true);
    expect(ok("https://objects.githubusercontent.com/github-production-release-asset/1/abc")).toBe(true);
    for (const address of [
      "https://github.com/somebody/squorli-plugins/releases/download/a-b-v1.0.0/a-b.ts", "https://github.com/danielklessa/squorli/releases/download/v1/x.ts", "https://github.com/danielklessa/squorli-plugins/raw/main/plugins/a-b/a-b.ts",
      "http://github.com/danielklessa/squorli-plugins/releases/download/a-b-v1.0.0/a-b.ts", "https://github.com:8443/danielklessa/squorli-plugins/releases/download/a-b-v1.0.0/a-b.ts",
      "https://user@github.com/danielklessa/squorli-plugins/releases/download/a-b-v1.0.0/a-b.ts", "https://evil.githubusercontent.com/x", "https://release-assets.githubusercontent.com.evil.example/x", "https://127.0.0.1/x",
    ]) expect(ok(address), address).toBe(false);
    // The tests' one origin, for both.
    expect(catalogAllowed(new URL("http://127.0.0.1:3198/releases/download/a-b-v1.0.0/a-b.ts"), "release", "http://127.0.0.1:3198")).toBe(true);
    expect(catalogAllowed(new URL("http://127.0.0.1:3199/catalog.json"), "catalog", "http://127.0.0.1:3198")).toBe(false);
  });
});

describe("what the catalogue says about an entry on this server", () => {
  it("compares versions by their numbers", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.12", "1.0.0")).toBe(-1);
  });

  it("is new, an update, installed, or in need of a newer server", () => {
    const e = { version: "1.2.0", apiVersion: 2 };
    expect(catalogStatus(e, null, 2)).toBe("new");
    expect(catalogStatus(e, "1.1.9", 2)).toBe("update");
    expect(catalogStatus(e, "1.2.0", 2)).toBe("installed");
    expect(catalogStatus(e, "1.3.0", 2)).toBe("installed"); // the server has a newer one (uploaded by hand)
    expect(catalogStatus({ version: "3.0.0", apiVersion: 3 }, null, 2)).toBe("needs_server");
    expect(catalogStatus({ version: "3.0.0", apiVersion: 3 }, "2.0.0", 2)).toBe("needs_server");
  });
});
