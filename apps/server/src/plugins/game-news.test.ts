import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readPluginFile } from "./manifest";
import { PluginRunner, type InvocationContext } from "./runner";
import { netAllowed } from "./service";

/**
 * The game news plugin that ships with the server (apps/server/plugins/game-news.ts), run in the real sandbox against a
 * host this test plays: storage, settings, the schedule, the channels and the internet are plain values here. What is
 * checked is the plugin's own logic: what counts as new, that nothing is posted twice or from before a game was added, that
 * foreign text cannot mention or format, the limits of a round, and that a source that fails stops nothing.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "..", "plugins", "game-news.ts"), "utf8");
const U = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a01", F = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a02", D = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a03";
const SOMEBODY = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a11";

let store = new Map<string, unknown>();
let settings: Record<string, unknown> = {};
let sent: { channelId: string; content: string }[] = [];
let scheduled: { when: number; name: string; key?: string; payload?: unknown }[] = [];
let cancelled: string[] = [];
let asked: string[] = [];
let logged: string[] = [];
/** What the played internet answers: the first entry whose key the address starts with. A function or a thrown error works too. */
let web: [string, unknown][] = [];
const failures: string[] = [];
let hosts: string[] = [];

const runner = new PluginRunner({
  workerFile: join(here, "..", "plugin-worker.ts"), execArgv: ["--import", "tsx"], cpuMs: 200, memoryMb: 32,
  answerMax: (fn) => (fn === "net.get" ? 1024 * 1024 : 64 * 1024),
  onFailure: (_id, kind, message) => failures.push(`${kind}: ${message}`),
  onCall: async (_id, _ctx, fn, raw) => {
    const args = raw as Record<string, unknown>;
    switch (fn) {
      case "storage.get": return store.has(args.key as string) ? JSON.parse(JSON.stringify(store.get(args.key as string))) : null;
      case "storage.set": store.set(args.key as string, args.value); return true;
      case "settings.get": return settings;
      case "schedule.at": scheduled.push(args as never); return { id: "job", dueAt: new Date(args.when as number).toISOString() };
      case "schedule.cancel": cancelled.push(args.key as string); return true;
      case "messages.send": sent.push(args as never); return { id: "message", seq: 1 };
      case "log": logged.push(`${String(args.level)}: ${String(args.text)}`); return true;
      case "net.get": {
        const url = String(args.url);
        asked.push(url);
        // The real host function's rule: an address outside the manifest's hosts never leaves the server.
        if (!netAllowed(new URL(url), hosts)) throw new Error(`net.get: ${new URL(url).host} is not among the hosts of the plugin's manifest`);
        const hit = web.find(([prefix]) => url.startsWith(prefix));
        if (!hit) throw new Error("net.get: no usable answer");
        const body = typeof hit[1] === "function" ? (hit[1] as (u: string) => unknown)(url) : hit[1];
        return { url, contentType: "application/json", text: typeof body === "string" ? body : JSON.stringify(body) };
      }
      default: return undefined;
    }
  },
});
const ctx = (event: string): InvocationContext => ({ event, depth: 0 });
type Answer = { ok?: boolean; message?: { en: string; de: string } };
const command = async (name: string, text = "") => (await runner.invoke("game-news", "command", { command: name, channelId: U, by: SOMEBODY, text, values: {} }, ctx("command"))).value as Answer;
const job = (name: string, payload: unknown = null) => runner.invoke("game-news", "job", { name, key: name, payload, dueAt: new Date().toISOString(), late: false, attempt: 1 }, ctx("job"));
const step = (i: number, u = 0, f = 0) => job("step", { i, u, f });
type Game = { id: number; name: string; since: number; seen: string[] };
const games = () => (store.get("games") ?? []) as Game[];
const nowSeconds = () => Math.floor(Date.now() / 1000);

const STEAM = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=";
const EPIC = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
const GP = "https://www.gamerpower.com/api/giveaways";
const NVIDIA = "https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php";
const news = (gid: string, date: number, title: string, contents: string, tags: string[] = ["patchnotes"]) => ({ gid, title, url: `https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/${gid}`, contents, date, tags, feedname: "steam_community_announcements" });
const steamAnswer = (appid: number, items: unknown[]) => ({ appnews: { appid, newsitems: items, count: items.length } });
const epicGame = (over: Record<string, unknown>) => ({
  title: "Knightica", id: "9975548b", offerType: "BASE_GAME", productSlug: null, urlSlug: "72b46f5d95624fd5b7e7d81b7dcaead1",
  catalogNs: { mappings: [{ pageSlug: "knightica-3be45c", pageType: "productHome" }] },
  price: { totalPrice: { discountPrice: 0, originalPrice: 1349 } },
  promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: "2020-01-01T16:00:00.000Z", endDate: "2099-07-01T15:00:00.000Z", discountSetting: { discountType: "PERCENTAGE", discountPercentage: 0 } }] }], upcomingPromotionalOffers: [] },
  ...over,
});
const epicAnswer = (elements: unknown[]) => ({ data: { Catalog: { searchStore: { elements } } } });
const giveaway = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: `Game ${id} (Steam) Giveaway`, worth: "$19.99", description: "Claim it and keep it forever.", platforms: "PC, Steam", end_date: "2099-01-15 23:59:00", type: "Game", status: "Active",
  gamerpower_url: `https://www.gamerpower.com/game-${id}-giveaway`, open_giveaway_url: `https://www.gamerpower.com/open/game-${id}-giveaway`, ...over,
});
const nvidiaAnswer = (version: string) => `{ "Success" : "1", "IDS" : [{ "downloadInfo": { "Success" : "1", "ID" : "285320", "Name" : "GeForce%20Game%20Ready%20Driver", "Version" : "${version}", "ReleaseDateTime" : "Thu Nov 12, 2026", "DetailsURL" : "https://www.nvidia.com/en-us/drivers/details/285320/" } }] }`;

beforeAll(async () => {
  const read = readPluginFile(source, "game-news.ts");
  if (!read.ok) throw new Error(read.message);
  hosts = read.manifest.network?.hosts ?? [];
  const prepared = await runner.prepare(source, read.language);
  if (!prepared.ok) throw new Error(prepared.message);
  runner.load("game-news", prepared.code, read.manifest.apiVersion);
}, 30_000);
afterAll(() => runner.close());
beforeEach(() => {
  store = new Map(); sent = []; scheduled = []; cancelled = []; asked = []; logged = []; web = []; failures.length = 0;
  settings = { updatesChannel: U, freeChannel: F, driversChannel: D, language: "de", interval: "30", patchnotesOnly: true, epic: true, gamerpower: true, loot: false, nvidia: true };
});
const follow = (...list: [number, string][]) => store.set("games", list.map(([id, name]) => ({ id, name, since: nowSeconds() - 3600, seen: [] })));

describe("the schedule", () => {
  it("starts a round a few seconds after it was switched on or its settings were saved", async () => {
    for (const event of ["enable", "settings.change"]) {
      scheduled = []; cancelled = [];
      await runner.invoke("game-news", event, {}, ctx(event));
      expect(cancelled).toEqual(["step"]);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ name: "round", key: "round" });
      expect(scheduled[0]!.when - Date.now()).toBeGreaterThan(2000);
      expect(scheduled[0]!.when - Date.now()).toBeLessThan(8000);
    }
  }, 30_000);

  it("plans the next round first, then the first step, and asks nothing itself", async () => {
    settings.interval = "60";
    await job("round");
    expect(scheduled.map((s) => [s.name, s.key])).toEqual([["round", "round"], ["step", "step"]]);
    expect(Math.round((scheduled[0]!.when - Date.now()) / 60_000)).toBe(60);
    expect(scheduled[1]!.payload).toEqual({ i: 0, u: 0, f: 0 });
    expect(asked).toEqual([]);
  }, 30_000);

  it("asks one source per step, in order, and only the kinds that have a channel", async () => {
    follow([730, "Counter-Strike 2"], [10, "Counter-Strike"]);
    web = [[`${STEAM}`, steamAnswer(0, [])], [EPIC, epicAnswer([])], [GP, []], [NVIDIA, nvidiaAnswer("621.24")]];
    for (let i = 0; i < 5; i++) await step(i);
    expect(asked.map((a) => new URL(a).host)).toEqual(["api.steampowered.com", "api.steampowered.com", "store-site-backend-static.ak.epicgames.com", "www.gamerpower.com", "gfwsl.geforce.com"]);
    expect(asked[0]).toContain("appid=730");
    expect(asked[1]).toContain("appid=10");
    // Each step schedules the one after it, a few seconds later; the last one schedules nothing.
    expect(scheduled.map((s) => (s.payload as { i: number }).i)).toEqual([1, 2, 3, 4]);
    expect(scheduled[0]!.when - Date.now()).toBeGreaterThan(2000);
    // Without a channel for updates and drivers only the free games are left.
    asked = []; scheduled = [];
    delete settings.updatesChannel; delete settings.driversChannel;
    await step(0); await step(1); await step(2);
    expect(asked.map((a) => new URL(a).host)).toEqual(["store-site-backend-static.ak.epicgames.com", "www.gamerpower.com"]);
    expect(failures).toEqual([]);
  }, 30_000);

  it("goes on with the next source when one fails, and says so in its log", async () => {
    follow([730, "Counter-Strike 2"]);
    web = [[STEAM, "<html>Service Unavailable</html>"], [GP, []], [NVIDIA, "{}"]]; // Steam sends no JSON, Epic does not answer, NVIDIA an empty object
    for (let i = 0; i < 4; i++) await step(i);
    expect(failures).toEqual([]);
    expect(sent).toEqual([]);
    expect(scheduled.map((s) => (s.payload as { i: number }).i)).toEqual([1, 2, 3]);
    expect(logged.filter((l) => l.startsWith("warn:")).map((l) => l.split(":")[1]!.trim().split(" ")[0])).toEqual(["steam", "epic", "nvidia"]);
  }, 30_000);
});

describe("game updates from Steam", () => {
  it("posts what appeared since the game was added, oldest first, once", async () => {
    follow([730, "Counter-Strike 2"]);
    const t = nowSeconds();
    web = [[STEAM, steamAnswer(730, [
      news("3", t - 60, "Counter-Strike 2 Update", "[p]\\[ MISC ][/p][list][*][p]Fixed a rendering hang on DX11[/p][/*][*][p]Improved stability[/p][/*][/list]"),
      news("2", t - 600, "Release Notes for today", "[p]Smaller fixes.[/p]"),
      news("1", t - 7200, "From before", "[p]Old.[/p]"), // before the game was followed
    ])]];
    await step(0);
    expect(sent.map((m) => m.channelId)).toEqual([U, U]);
    expect(sent[0]!.content).toBe("🎮 **Counter-Strike 2** · Update: **Release Notes for today**\nSmaller fixes.\nhttps://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/2");
    expect(sent[1]!.content).toBe("🎮 **Counter-Strike 2** · Update: **Counter-Strike 2 Update**\n\\[ MISC \\]\n• Fixed a rendering hang on DX11\n• Improved stability\nhttps://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/3");
    expect(games()[0]!.seen).toEqual(["2", "3"]);
    expect(scheduled.at(-1)!.payload).toEqual({ i: 1, u: 2, f: 0 });
    // The same answer again: nothing new.
    sent = [];
    await step(0);
    expect(sent).toEqual([]);
  }, 30_000);

  it("keeps to patch notes unless the settings ask for every announcement, and does not bring the others up later", async () => {
    follow([730, "Counter-Strike 2"]);
    const t = nowSeconds();
    web = [[STEAM, steamAnswer(730, [news("5", t - 60, "Winter sale", "[p]Everything is cheaper.[/p]", []), news("4", t - 120, "Patch 1.2", "[p]Fixes.[/p]")])]];
    await step(0);
    expect(sent.map((m) => m.content.split("\n")[0])).toEqual(["🎮 **Counter-Strike 2** · Update: **Patch 1.2**"]);
    expect(games()[0]!.seen).toEqual(["4", "5"]);
    settings.patchnotesOnly = false;
    sent = [];
    await step(0);
    expect(sent).toEqual([]);
    web = [[STEAM, steamAnswer(730, [news("6", t - 10, "Community event", "[p]Join us.[/p]", [])])]];
    await step(0);
    expect(sent.map((m) => m.content.split("\n")[0])).toEqual(["🎮 **Counter-Strike 2** · Neuigkeit: **Community event**"]);
  }, 30_000);

  it("turns foreign text into plain text: no mention, no link, no formatting, no pictures, a bounded length", async () => {
    follow([730, "Counter-Strike 2"]);
    const t = nowSeconds();
    const contents = `[img]{STEAM_CLAN_IMAGE}/1/abc.png[/img][h1]Big <@${SOMEBODY}> news[/h1][p]See https://evil.example/x and [url=https://evil.example/y]this[/url] **now** &amp; _later_[/p]${"[p]A long line of text that goes on. [/p]".repeat(40)}`;
    web = [[STEAM, steamAnswer(730, [{ ...news("9", t - 5, `**Hi** <@${SOMEBODY}> # [x](https://evil.example)`, contents), url: "javascript:alert(1)" }])]];
    await step(0);
    expect(sent).toHaveLength(1);
    const text = sent[0]!.content;
    expect(text).not.toContain("<@");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("STEAM_CLAN_IMAGE");
    expect(text).not.toContain("javascript:");
    const lines = text.split("\n");
    expect(lines[0]).toBe(`🎮 **Counter-Strike 2** · Update: **\\*\\*Hi\\*\\* @${SOMEBODY} \\# \\[x\\](**`);
    expect(lines[1]).toBe("Big news"); // what stands in angle brackets is taken for a tag and goes
    expect(lines[2]).toBe("See and this \\*\\*now\\*\\* & \\_later\\_");
    expect(lines.at(-2)).toBe("…");
    // A link the source sent that is no address of Steam is replaced by the game's news page.
    expect(lines.at(-1)).toBe("https://store.steampowered.com/news/app/730");
    expect(text.length).toBeLessThan(800);
  }, 30_000);

  it("posts at most five per round and brings the rest with the next one", async () => {
    follow([730, "Counter-Strike 2"]);
    const t = nowSeconds();
    web = [[STEAM, steamAnswer(730, [3, 2, 1].map((n) => news(String(n), t - 100 + n, `Patch ${n}`, "")))]];
    await step(0, 4); // four updates were posted in this round already
    expect(sent.map((m) => m.content.split("\n")[0])).toEqual(["🎮 **Counter-Strike 2** · Update: **Patch 1**"]);
    expect(games()[0]!.seen).toEqual(["1"]);
    sent = [];
    await step(0, 5); // the round is full
    expect(sent).toEqual([]);
    await step(0); // the next round
    expect(sent.map((m) => m.content.split("\n")[0])).toEqual(["🎮 **Counter-Strike 2** · Update: **Patch 2**", "🎮 **Counter-Strike 2** · Update: **Patch 3**"]);
  }, 30_000);
});

describe("free games", () => {
  it("posts what Epic gives away right now: not what is only cheaper, not what comes next week, not twice", async () => {
    settings.gamerpower = false;
    const upcoming = { promotionalOffers: [], upcomingPromotionalOffers: [{ promotionalOffers: [{ startDate: "2098-01-01T16:00:00.000Z", endDate: "2099-01-01T16:00:00.000Z", discountSetting: { discountPercentage: 0 } }] }] };
    web = [[EPIC, epicAnswer([
      epicGame({}),
      epicGame({ id: "next-week", title: "Alien: Isolation", price: { totalPrice: { discountPrice: 3999, originalPrice: 3999 } }, promotions: upcoming }),
      epicGame({ id: "cheaper", title: "TerraScape", price: { totalPrice: { discountPrice: 459, originalPrice: 1529 } }, promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: "2020-01-01T16:00:00.000Z", endDate: "2099-01-01T16:00:00.000Z", discountSetting: { discountPercentage: 70 } }] }] } }),
      epicGame({ id: "always-free", title: "Free to play", promotions: null }),
      epicGame({ id: "addon", title: "Some add-on", offerType: "ADD_ON" }),
      epicGame({ id: "no-slug", title: "Winter <@game> *deal*", catalogNs: { mappings: [] }, productSlug: "../../evil", promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: "2020-01-01T16:00:00.000Z", endDate: "2099-01-15T16:00:00.000Z", discountSetting: { discountPercentage: 0 } }] }] } }),
    ])]];
    await step(0);
    expect(asked[0]).toBe(`${EPIC}?locale=de&country=DE&allowCountries=DE`);
    expect(sent.map((m) => [m.channelId, m.content])).toEqual([
      [F, "🎁 **Kostenlos im Epic Games Store: Knightica** · bis 1.7., 17:00 Uhr\nhttps://store.epicgames.com/de/p/knightica-3be45c"], // summer time
      [F, "🎁 **Kostenlos im Epic Games Store: Winter @game \\*deal\\*** · bis 15.1., 17:00 Uhr\nhttps://store.epicgames.com/de/free-games"], // winter time, no usable page name
    ]);
    sent = [];
    await step(0);
    expect(sent).toEqual([]);
    // English, and with add-ons wanted: only the add-on is new.
    settings.language = "en"; settings.loot = true;
    await step(0);
    expect(asked.at(-1)).toBe(`${EPIC}?locale=en-US&country=US&allowCountries=US`);
    expect(sent.map((m) => m.content)).toEqual(["🎁 **Free on the Epic Games Store: Some add-on** · until Jul 1, 15:00 UTC\nhttps://store.epicgames.com/en-US/p/knightica-3be45c"]);
  }, 30_000);

  it("starts silently with GamerPower's list, then posts new giveaways with the link back its terms ask for", async () => {
    settings.epic = false;
    web = [[GP, [giveaway(12), giveaway(11)]]];
    await step(0);
    expect(asked[0]).toBe(`${GP}?platform=pc&type=game`);
    expect(sent).toEqual([]);
    web = [[GP, [giveaway(14, { worth: "N/A", end_date: "N/A", title: "<@x> **Bold** game" }), giveaway(13), giveaway(12), giveaway(11)]]];
    await step(0);
    expect(sent.map((m) => [m.channelId, m.content])).toEqual([
      [F, "🎁 **Kostenlos: Game 13 (Steam) Giveaway**\nPC, Steam · statt $19.99 · bis 16.1.\nClaim it and keep it forever.\nhttps://www.gamerpower.com/game-13-giveaway\nQuelle: GamerPower"],
      [F, "🎁 **Kostenlos: @x \\*\\*Bold\\*\\* game**\nPC, Steam\nClaim it and keep it forever.\nhttps://www.gamerpower.com/game-14-giveaway\nQuelle: GamerPower"],
    ]);
    sent = [];
    await step(0);
    expect(sent).toEqual([]);
    // With add-ons switched on the list is another one: it starts silently again instead of posting eighty add-ons.
    settings.loot = true;
    web = [[GP, [giveaway(20, { type: "DLC" }), giveaway(14), giveaway(13)]]];
    await step(0);
    expect(asked.at(-1)).toBe(`${GP}?platform=pc`);
    expect(sent).toEqual([]);
    web = [[GP, [giveaway(21, { type: "DLC", gamerpower_url: "https://evil.example/x" }), giveaway(20, { type: "DLC" })]]];
    await step(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toContain("\nhttps://www.gamerpower.com/\nQuelle: GamerPower");
  }, 30_000);

  it("leaves Epic's giveaways to Epic's own list, and shares the round's five posts between both", async () => {
    web = [[GP, []]];
    await step(1);
    web = [[GP, [giveaway(31), giveaway(30, { platforms: "PC, Epic Games Store" })]]];
    await step(1);
    expect(sent.map((m) => m.content.split("\n")[0])).toEqual(["🎁 **Kostenlos: Game 31 (Steam) Giveaway**"]);
    web = [[GP, [32, 33, 34].map((n) => giveaway(n))]];
    sent = [];
    await step(1, 0, 4); // Epic posted four in this round
    expect(sent).toHaveLength(1);
    expect(scheduled.at(-1)!.payload).toEqual({ i: 2, u: 0, f: 5 });
    await step(1);
    expect(sent).toHaveLength(3);
  }, 30_000);
});

describe("graphics drivers", () => {
  it("remembers the first version it sees and posts the next one", async () => {
    delete settings.updatesChannel; delete settings.freeChannel;
    web = [[NVIDIA, nvidiaAnswer("621.24")]];
    await step(0);
    expect(sent).toEqual([]);
    expect(store.get("drivers")).toEqual({ nvidia: "621.24" });
    await step(0);
    expect(sent).toEqual([]);
    web = [[NVIDIA, nvidiaAnswer("622.10")]];
    await step(0);
    expect(sent.map((m) => [m.channelId, m.content])).toEqual([[D, "🖥️ **NVIDIA GeForce Game Ready Driver 622.10** · 12.11.2026\nhttps://www.nvidia.com/en-us/drivers/details/285320/"]]);
    settings.language = "en"; sent = [];
    web = [[NVIDIA, nvidiaAnswer("623.01")]];
    await step(0);
    expect(sent[0]!.content.split("\n")[0]).toBe("🖥️ **NVIDIA GeForce Game Ready Driver 623.01** · Nov 12, 2026");
  }, 30_000);
});

describe("/news-add, /news-remove and /news-list", () => {
  it("adds a game by its Steam number and by its name, starting at now", async () => {
    web = [
      ["https://store.steampowered.com/api/appdetails?appids=730&", { "730": { success: true, data: { name: "Counter-Strike 2", type: "game" } } }],
      ["https://store.steampowered.com/api/appdetails?appids=42&", { "42": { success: false } }],
      ["https://store.steampowered.com/api/storesearch/?term=Cyberpunk%202077", { total: 2, items: [{ type: "app", name: "Cyberpunk 2077", id: 1091500 }, { type: "app", name: "Cyberpunk 2077: Phantom Liberty", id: 2138330 }] }],
      ["https://store.steampowered.com/api/storesearch/?term=counter", { total: 3, items: [{ type: "app", name: "Counter-Strike 2", id: 730 }, { type: "app", name: "Counter-Strike", id: 10 }, { type: "bundle", name: "Counter bundle", id: 5 }] }],
      ["https://store.steampowered.com/api/storesearch/?term=nothing", { total: 0, items: [] }],
    ];
    const before = nowSeconds();
    expect((await command("news-add", "730")).message!.de).toBe("Counter-Strike 2 wird beobachtet. Was ab jetzt erscheint, wird gepostet.");
    expect((await command("news-add", " Cyberpunk 2077 ")).message!.en).toBe("Following Cyberpunk 2077. News that appear from now on are posted.");
    expect(games().map((g) => [g.id, g.name, g.seen])).toEqual([[730, "Counter-Strike 2", []], [1091500, "Cyberpunk 2077", []]]);
    for (const g of games()) expect(g.since).toBeGreaterThanOrEqual(before);
    // Several hits: the choices with their numbers, nothing added.
    const several = await command("news-add", "counter");
    expect(several.ok).toBe(false);
    expect(several.message!.de).toBe("Mehrere Spiele passen: Counter-Strike 2 (730), Counter-Strike (10). Führe den Befehl noch einmal mit der Nummer aus, z. B. /news-add 730");
    expect((await command("news-add", "730")).message!.de).toBe("Dieser Server folgt Counter-Strike 2 bereits.");
    expect((await command("news-add", "42")).message!.de).toBe("Steam kennt kein Spiel mit der Nummer 42.");
    expect((await command("news-add", "nothing")).message!.de).toBe("Steam findet nichts zu „nothing“.");
    expect((await command("news-add", "down")).message!.de).toBe("Steam antwortet gerade nicht. Versuche es gleich noch einmal.");
    expect((await command("news-add", "  ")).ok).toBe(false);
    expect(games()).toHaveLength(2);
    expect(failures).toEqual([]);
  }, 30_000);

  it("says when no channel is set, and stops at fifty games", async () => {
    delete settings.updatesChannel;
    web = [["https://store.steampowered.com/api/appdetails?appids=730&", { "730": { success: true, data: { name: "Counter-Strike 2" } } }]];
    expect((await command("news-add", "730")).message!.de).toContain("Noch ist kein Kanal für Spiele-Updates eingestellt");
    store.set("games", Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `Game ${i + 1}`, since: 0, seen: [] })));
    const full = await command("news-add", "730");
    expect(full.ok).toBe(false);
    expect(full.message!.de).toContain("folgt schon 50 Spielen");
    expect(asked).toHaveLength(1);
  }, 30_000);

  it("removes by number or name and lists what is followed", async () => {
    expect((await command("news-list")).message!.de).toBe("Dieser Server folgt noch keinem Spiel. Ein Admin fügt eines mit /news-add hinzu.");
    follow([730, "Counter-Strike 2"], [10, "Counter-Strike"], [1091500, "Cyberpunk 2077"]);
    expect((await command("news-list")).message!.de).toBe("Beobachtete Spiele (3): Counter-Strike, Counter-Strike 2, Cyberpunk 2077");
    expect((await command("news-remove", "counter")).ok).toBe(false); // two games fit
    expect((await command("news-remove", "counter-strike")).message!.de).toBe("Counter-Strike wird nicht mehr beobachtet."); // the exact name wins
    expect((await command("news-remove", "cyber")).message!.de).toBe("Cyberpunk 2077 wird nicht mehr beobachtet.");
    expect((await command("news-remove", "999")).ok).toBe(false);
    expect((await command("news-remove", "730")).ok).toBe(true);
    expect(games()).toEqual([]);
    expect(asked).toEqual([]);
  }, 30_000);

  it("shows the followed games in the admin's table", async () => {
    store.set("games", [{ id: 730, name: "Counter-Strike 2", since: 1_800_000_000, seen: ["1"] }, { id: 10, name: "Counter-Strike", since: 1_700_000_000, seen: [] }]);
    const rows = (await runner.invoke("game-news", "view", { view: "games" }, ctx("view"))).value;
    expect(rows).toEqual([{ name: "Counter-Strike", appId: "10", since: 1_700_000_000_000 }, { name: "Counter-Strike 2", appId: "730", since: 1_800_000_000_000 }]);
  }, 30_000);
});

describe("the manifest", () => {
  it("names every host the plugin asks, and the plugin asks no other", () => {
    const read = readPluginFile(source, "game-news.ts");
    if (!read.ok) throw new Error(read.message);
    expect(read.manifest.capabilities).toEqual(["messages.write", "net.fetch"]);
    const inCode = new Set([...source.slice(source.indexOf("*/")).matchAll(/["`]https:\/\/([a-z0-9.-]+)\/[^"`]*["`]/g)].map((m) => m[1]!));
    // Addresses the plugin only writes into a message are no hosts it fetches from.
    for (const posted of ["store.epicgames.com", "www.nvidia.com", "squorli.com"]) inCode.delete(posted);
    expect([...inCode].sort()).toEqual([...read.manifest.network!.hosts].sort());
  });
});
