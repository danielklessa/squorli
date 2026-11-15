/* squorli-plugin
{
  "id": "game-news",
  "name": { "en": "Game news", "de": "Spiele-News" },
  "description": {
    "en": "Posts news into channels of your choice: patch notes of the games you follow on Steam, games that are free to keep right now, and new graphics drivers.",
    "de": "Schreibt News in Kanäle deiner Wahl: Patchnotes der Spiele, denen ihr auf Steam folgt, Spiele, die es gerade kostenlos gibt, und neue Grafiktreiber."
  },
  "version": "1.0.0",
  "apiVersion": 2,
  "author": "Squorli",
  "homepage": "https://squorli.com/en/docs/plugins/",
  "capabilities": ["messages.write", "net.fetch"],
  "network": {
    "hosts": ["api.steampowered.com", "store.steampowered.com", "store-site-backend-static.ak.epicgames.com", "www.gamerpower.com", "gfwsl.geforce.com"]
  },
  "settings": [
    {
      "key": "updatesChannel",
      "type": "channel",
      "label": { "en": "Channel for game updates", "de": "Kanal für Spiele-Updates" },
      "help": { "en": "Patch notes of the games added with /news-add. Empty = no game updates.", "de": "Patchnotes der Spiele, die mit /news-add hinzugefügt wurden. Leer = keine Spiele-Updates." }
    },
    {
      "key": "freeChannel",
      "type": "channel",
      "label": { "en": "Channel for free games", "de": "Kanal für kostenlose Spiele" },
      "help": { "en": "Empty = no free games.", "de": "Leer = keine kostenlosen Spiele." }
    },
    {
      "key": "driversChannel",
      "type": "channel",
      "label": { "en": "Channel for graphics drivers", "de": "Kanal für Grafiktreiber" },
      "help": { "en": "Empty = no driver news.", "de": "Leer = keine Treiber-News." }
    },
    {
      "key": "language",
      "type": "select",
      "default": "de",
      "label": { "en": "Language of the news", "de": "Sprache der News" },
      "options": [
        { "value": "de", "label": "Deutsch" },
        { "value": "en", "label": "English" }
      ]
    },
    {
      "key": "interval",
      "type": "select",
      "default": "30",
      "label": { "en": "Look for news every", "de": "Nach News suchen alle" },
      "options": [
        { "value": "15", "label": { "en": "15 minutes", "de": "15 Minuten" } },
        { "value": "30", "label": { "en": "30 minutes", "de": "30 Minuten" } },
        { "value": "60", "label": { "en": "hour", "de": "Stunde" } },
        { "value": "180", "label": { "en": "3 hours", "de": "3 Stunden" } }
      ]
    },
    {
      "key": "patchnotesOnly",
      "type": "boolean",
      "default": true,
      "label": { "en": "Game updates: patch notes only", "de": "Spiele-Updates: nur Patchnotes" },
      "help": { "en": "Off = every announcement of a game's developers, events and sales included.", "de": "Aus = jede Ankündigung der Entwickler eines Spiels, auch Events und Rabattaktionen." }
    },
    {
      "key": "epic",
      "type": "boolean",
      "default": true,
      "label": { "en": "Free games: Epic Games Store", "de": "Kostenlose Spiele: Epic Games Store" }
    },
    {
      "key": "gamerpower",
      "type": "boolean",
      "default": true,
      "label": { "en": "Free games: Steam, GOG and others (via GamerPower)", "de": "Kostenlose Spiele: Steam, GOG und andere (über GamerPower)" }
    },
    {
      "key": "loot",
      "type": "boolean",
      "default": false,
      "label": { "en": "Free games: add-ons, in-game items and beta keys too", "de": "Kostenlose Spiele: auch Erweiterungen, Beigaben und Beta-Zugänge" }
    },
    {
      "key": "nvidia",
      "type": "boolean",
      "default": true,
      "label": { "en": "Graphics drivers: NVIDIA GeForce", "de": "Grafiktreiber: NVIDIA GeForce" }
    }
  ],
  "commands": [
    {
      "name": "news-add",
      "permission": "MANAGE_SERVER",
      "input": "text",
      "description": { "en": "Follow a game on Steam", "de": "Einem Spiel auf Steam folgen" },
      "textHint": { "en": "name of the game or its Steam number", "de": "Name des Spiels oder seine Steam-Nummer" }
    },
    {
      "name": "news-remove",
      "permission": "MANAGE_SERVER",
      "input": "text",
      "description": { "en": "Stop following a game", "de": "Einem Spiel nicht mehr folgen" },
      "textHint": { "en": "name of the game or its Steam number", "de": "Name des Spiels oder seine Steam-Nummer" }
    },
    { "name": "news-list", "description": { "en": "Shows the games this server follows", "de": "Zeigt die Spiele, denen dieser Server folgt" } }
  ],
  "views": [
    {
      "id": "games",
      "title": { "en": "Followed games", "de": "Beobachtete Spiele" },
      "columns": [
        { "key": "name", "label": { "en": "Game", "de": "Spiel" } },
        { "key": "appId", "label": { "en": "Steam number", "de": "Steam-Nummer" } },
        { "key": "since", "type": "time", "label": { "en": "Followed since", "de": "Beobachtet seit" } }
      ]
    }
  ]
}
*/
// SPDX-License-Identifier: Apache-2.0

// Game news: the plugin that ships with Squorli Server and fetches from the internet (https://squorli.com/en/docs/plugins/).
// It shows what a plugin with the capability `net.fetch` looks like: every address it asks is one of the hosts its manifest
// names, every answer is treated as text somebody else wrote, and a source that is down never stops the others.
//
// How it works. A job named "round" comes back every interval of the settings. It only plans: the next round first, then
// the first "step". A step asks ONE source (one game on Steam, Epic, GamerPower, NVIDIA), posts what is new and schedules
// the step after it, a few seconds later. One request per event keeps a step inside the ten seconds an event has, and the
// gap keeps a round inside the thirty requests a minute a plugin may make.
//
// What was posted already is remembered by the sources' own ids, so a restart or a job that comes twice posts nothing
// twice. A game that was just added starts at "now": nothing from before is posted.
//
// Sources (all read without a key or an account):
//   Steam        api.steampowered.com/ISteamNews/GetNewsForApp     the developers' announcements of one game
//                store.steampowered.com/api/storesearch, /appdetails   finding a game by name or number (/news-add)
//   Epic         store-site-backend-static.ak.epicgames.com/freeGamesPromotions   not documented by Epic; may change
//   GamerPower   www.gamerpower.com/api/giveaways                  its terms ask for a link back, which every post carries
//   NVIDIA       gfwsl.geforce.com/.../AjaxDriverService.php       not documented by NVIDIA; may change

interface Game { id: number; name: string; /** Seconds: news from before are never posted. */ since: number; /** News handled already, the newest last. */ seen: string[] }
interface Free { epic: string[]; gp: number[]; /** Which list of GamerPower `gp` belongs to; another one starts silently. */ gpMode: string }
interface Drivers { nvidia?: string }
interface Config { updates?: string; free?: string; drivers?: string; language: "de" | "en"; interval: number; patchnotesOnly: boolean; epic: boolean; gamerpower: boolean; loot: boolean; nvidia: boolean }
type Step = { kind: "steam"; game: number } | { kind: "epic" } | { kind: "gamerpower" } | { kind: "nvidia" };
/** A step's payload: its place in the round and how many posts the round made so far (updates, free games). */
interface Progress { i: number; u: number; f: number }
type Json = Record<string, unknown>;

const GAMES = "games", FREE = "free", DRIVERS = "drivers";
const ROUND = "round", STEP = "step";
const MAX_GAMES = 50;
/** At most this many posts per round and kind; what is left over comes with the next round. */
const MAX_PER_ROUND = 5;
const SEEN_NEWS = 30, SEEN_EPIC = 100, SEEN_GP = 500;
const STEP_GAP_MS = 4000;

async function config(): Promise<Config> {
  const s = await squorli.settings.get();
  const channel = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const on = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  const updates = channel(s.updatesChannel), free = channel(s.freeChannel), drivers = channel(s.driversChannel);
  const interval = Number(s.interval);
  return {
    ...(updates ? { updates } : {}), ...(free ? { free } : {}), ...(drivers ? { drivers } : {}),
    language: s.language === "en" ? "en" : "de",
    interval: interval === 15 || interval === 60 || interval === 180 ? interval : 30,
    patchnotesOnly: on(s.patchnotesOnly, true), epic: on(s.epic, true), gamerpower: on(s.gamerpower, true), loot: on(s.loot, false), nvidia: on(s.nvidia, true),
  };
}
async function loadGames(): Promise<Game[]> {
  const v = await squorli.storage.get(GAMES);
  return Array.isArray(v) ? (v as Game[]) : [];
}

/** What one round asks, in order. A kind without a channel is left out. */
function plan(c: Config, games: Game[]): Step[] {
  const steps: Step[] = [];
  if (c.updates) for (const g of games) steps.push({ kind: "steam", game: g.id });
  if (c.free && c.epic) steps.push({ kind: "epic" });
  if (c.free && c.gamerpower) steps.push({ kind: "gamerpower" });
  if (c.drivers && c.nvidia) steps.push({ kind: "nvidia" });
  return steps;
}

// ---------- Text from outside. Whatever a source sends is somebody else's text: it must not become a mention, a link of
// its own or formatting in the channel.

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One line of foreign text as plain text of a message: no angle brackets (mentions, addresses), Markdown's signs escaped. */
function esc(text: string): string {
  return text.replace(/[<>]/g, "").replace(/[\\*_~=^[\]`|#]/g, "\\$&");
}
function entities(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
/** One clean line: no line breaks, no address, cut with an ellipsis. */
function line(text: string, max: number): string {
  const t = entities(text).replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return esc(t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);
}
/** The start of a Steam announcement (BBCode) as a few plain lines; list items become bullets. */
function excerpt(raw: string, maxChars: number, maxLines: number): string {
  const text = entities(raw.slice(0, 4000))
    .replace(/\{STEAM_CLAN_IMAGE\}[^\s[]*/g, " ")
    .replace(/\[img\][^[]{0,500}\[\/img\]/gi, " ")
    .replace(/\[\*\]/g, "\n• ")
    .replace(/\[\/(?:p|h[1-6]|list|olist|\*|tr|quote|code)\]|\[br\]|\[hr\]|\[(?:list|olist)\]/gi, "\n")
    .replace(/\[\/?[a-z][^\]\n]{0,300}\]/gi, "")
    .replace(/<[^>\n]{0,300}>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\\\[/g, "[");
  const out: string[] = [];
  let used = 0;
  for (const rawLine of text.split("\n")) {
    const l = rawLine.replace(/\s+/g, " ").trim();
    if (!l || l === "•") continue;
    if (out.length >= maxLines || used + l.length > maxChars) { out.push("…"); break; }
    out.push(esc(l));
    used += l.length;
  }
  return out.join("\n");
}
/** An address a source handed over, taken only when it is a plain https address of the expected host. */
function link(v: unknown, host: string): string | null {
  const url = str(v, 400);
  return url.startsWith(`https://${host}/`) && !/[\s<>"'`\\]/.test(url) ? url : null;
}

// ---------- Time. The sandbox knows UTC only; German posts name Central European time, English ones UTC.

function lastSunday(year: number, month: number): number {
  const end = new Date(Date.UTC(year, month + 1, 0));
  return end.getUTCDate() - end.getUTCDay();
}
function centralEuropeanOffset(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear();
  const summer = utcMs >= Date.UTC(year, 2, lastSunday(year, 2), 1) && utcMs < Date.UTC(year, 9, lastSunday(year, 9), 1);
  return summer ? 120 : 60;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number): string => (n < 10 ? `0${n}` : String(n));
function dayText(language: string, utcMs: number, withTime: boolean): string {
  if (language === "en") {
    const d = new Date(utcMs);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${withTime ? `, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC` : ""}`;
  }
  const d = new Date(utcMs + centralEuropeanOffset(utcMs) * 60_000);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${withTime ? `, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} Uhr` : ""}`;
}

// ---------- The sources

async function getJson(url: string): Promise<unknown> {
  return JSON.parse((await squorli.net.get(url)).text) as unknown;
}

/** One game's announcements on Steam. Returns how many were posted. */
async function checkSteam(c: Config, games: Game[], appId: number, room: number): Promise<number> {
  const game = games.find((g) => g.id === appId);
  if (!game || !c.updates) return 0;
  const data = obj(obj(await getJson(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=5&feeds=steam_community_announcements`)).appnews);
  const items = list(data.newsitems).map(obj)
    .map((n) => ({ gid: str(n.gid, 40), title: str(n.title, 300), url: n.url, contents: str(n.contents, 4000), date: typeof n.date === "number" ? n.date : 0, patch: list(n.tags).includes("patchnotes") }))
    .filter((n) => n.gid && n.date >= game.since && !game.seen.includes(n.gid))
    .sort((a, b) => a.date - b.date);
  let posted = 0;
  for (const n of items) {
    if (!c.patchnotesOnly || n.patch) {
      if (posted >= room) break; // the rest stays unseen and comes with the next round
      const kind = n.patch ? "Update" : c.language === "en" ? "News" : "Neuigkeit";
      const address = link(n.url, "steamstore-a.akamaihd.net") ?? link(n.url, "store.steampowered.com") ?? link(n.url, "steamcommunity.com") ?? `https://store.steampowered.com/news/app/${appId}`;
      const body = excerpt(n.contents, 350, 6);
      await squorli.messages.send(c.updates, `🎮 **${line(game.name, 80)}** · ${kind}: **${line(n.title, 150)}**${body ? `\n${body}` : ""}\n${address}`);
      posted++;
    }
    game.seen.push(n.gid);
  }
  if (items.length) {
    game.seen = game.seen.slice(-SEEN_NEWS);
    await squorli.storage.set(GAMES, games);
  }
  return posted;
}

async function loadFree(): Promise<Free> {
  const v = obj(await squorli.storage.get(FREE));
  return { epic: list(v.epic).filter((x): x is string => typeof x === "string"), gp: list(v.gp).filter((x): x is number => typeof x === "number"), gpMode: str(v.gpMode, 20) };
}

/** What Epic gives away right now. Epic's list also holds games that are merely discounted or free next week: only a price of zero inside a running offer counts. */
async function checkEpic(c: Config, room: number): Promise<number> {
  if (!c.free) return 0;
  const german = c.language === "de";
  const data = await getJson(`https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=${german ? "de" : "en-US"}&country=${german ? "DE" : "US"}&allowCountries=${german ? "DE" : "US"}`);
  const elements = list(obj(obj(obj(obj(data).data).Catalog).searchStore).elements).map(obj);
  const free = await loadFree();
  const now = Date.now();
  let posted = 0, changed = false;
  for (const e of elements) {
    if (obj(obj(e.price).totalPrice).discountPrice !== 0) continue;
    if (e.offerType === "ADD_ON" && !c.loot) continue;
    let ends = 0, starts = 0;
    for (const group of list(obj(e.promotions).promotionalOffers)) for (const raw of list(obj(group).promotionalOffers)) {
      const offer = obj(raw);
      const from = Date.parse(str(offer.startDate, 40)), until = Date.parse(str(offer.endDate, 40));
      if (obj(offer.discountSetting).discountPercentage === 0 && from <= now && now < until) { starts = from; ends = until; }
    }
    if (!ends) continue;
    const key = `${str(e.id, 64)}:${starts}`;
    if (free.epic.includes(key)) continue;
    if (posted >= room) break;
    const mappings = [...list(obj(e.catalogNs).mappings), ...list(e.offerMappings)].map(obj);
    const slug = str(mappings.find((m) => m.pageType === "productHome")?.pageSlug ?? mappings[0]?.pageSlug ?? str(e.productSlug, 120).replace(/\/home$/, ""), 120);
    const store = `https://store.epicgames.com/${german ? "de" : "en-US"}`;
    const address = /^[a-z0-9][a-z0-9-]{1,118}$/i.test(slug) ? `${store}/p/${slug}` : `${store}/free-games`;
    const until = dayText(c.language, ends, true);
    await squorli.messages.send(c.free, german
      ? `🎁 **Kostenlos im Epic Games Store: ${line(str(e.title, 200), 120)}** · bis ${until}\n${address}`
      : `🎁 **Free on the Epic Games Store: ${line(str(e.title, 200), 120)}** · until ${until}\n${address}`);
    posted++;
    free.epic.push(key);
    changed = true;
  }
  if (changed) { free.epic = free.epic.slice(-SEEN_EPIC); await squorli.storage.set(FREE, free); }
  return posted;
}

/** Giveaways GamerPower lists for PC (Steam, GOG and others). A list it is asked for the first time starts silently. */
async function checkGamerPower(c: Config, room: number): Promise<number> {
  if (!c.free) return 0;
  const mode = c.loot ? "all" : "game";
  const data = await getJson(`https://www.gamerpower.com/api/giveaways?platform=pc${c.loot ? "" : "&type=game"}`);
  const items = list(data).map(obj).filter((g) => typeof g.id === "number" && (g.status === undefined || g.status === "Active"));
  const free = await loadFree();
  if (free.gpMode !== mode) {
    free.gp = [...free.gp, ...items.map((g) => g.id as number)].slice(-SEEN_GP);
    free.gpMode = mode;
    await squorli.storage.set(FREE, free);
    return 0;
  }
  const german = c.language === "de";
  let posted = 0, changed = false;
  // The newest come first in the list; post the oldest of the new ones first.
  for (const g of items.filter((x) => !free.gp.includes(x.id as number)).reverse()) {
    const platforms = str(g.platforms, 120);
    // Epic's own list tells of its giveaways already.
    const double = c.epic && /epic games/i.test(platforms);
    if (!double) {
      if (posted >= room) break;
      const address = link(g.gamerpower_url, "www.gamerpower.com") ?? "https://www.gamerpower.com/";
      const end = Date.parse(`${str(g.end_date, 30).replace(" ", "T")}Z`);
      const worth = /^\$\d{1,5}(?:\.\d{2})?$/.test(str(g.worth, 12)) && g.worth !== "$0.00" ? str(g.worth, 12) : "";
      const facts = [line(platforms, 80), worth ? (german ? `statt ${worth}` : `instead of ${worth}`) : "", Number.isFinite(end) ? `${german ? "bis" : "until"} ${dayText(c.language, end, false)}` : ""].filter(Boolean).join(" · ");
      const about = line(str(g.description, 600), 220);
      await squorli.messages.send(c.free, `🎁 **${german ? "Kostenlos" : "Free"}: ${line(str(g.title, 200), 120)}**${facts ? `\n${facts}` : ""}${about ? `\n${about}` : ""}\n${address}\n${german ? "Quelle" : "Source"}: GamerPower`);
      posted++;
    }
    free.gp.push(g.id as number);
    changed = true;
  }
  if (changed) { free.gp = free.gp.slice(-SEEN_GP); await squorli.storage.set(FREE, free); }
  return posted;
}

/** NVIDIA's newest GeForce Game Ready driver for Windows. The first version seen is only remembered. */
async function checkNvidia(c: Config): Promise<void> {
  if (!c.drivers) return;
  const data = await getJson("https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=127&pfid=995&osID=57&languageCode=1033&beta=0&isWHQL=1&dltype=-1&dch=1&upCRD=0&numberOfResults=1");
  const info = obj(obj(list(obj(data).IDS)[0]).downloadInfo);
  const version = str(info.Version, 20);
  if (!/^\d{1,4}\.\d{1,4}$/.test(version)) throw new Error("NVIDIA's answer names no driver version");
  const drivers = obj(await squorli.storage.get(DRIVERS)) as Drivers;
  if (drivers.nvidia === version) return;
  if (drivers.nvidia) {
    let name = "GeForce Game Ready Driver";
    try { name = decodeURIComponent(str(info.Name, 200)) || name; } catch { /* keep the default */ }
    const released = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(str(info.ReleaseDateTime, 40));
    const month = released ? MONTHS.indexOf(released[1]!) : -1;
    const date = released && month >= 0 ? (c.language === "en" ? `${released[1]} ${Number(released[2])}, ${released[3]}` : `${Number(released[2])}.${month + 1}.${released[3]}`) : "";
    const address = link(info.DetailsURL, "www.nvidia.com") ?? "https://www.nvidia.com/drivers/";
    await squorli.messages.send(c.drivers, `🖥️ **NVIDIA ${line(name, 80)} ${version}**${date ? ` · ${date}` : ""}\n${address}`);
  }
  await squorli.storage.set(DRIVERS, { ...drivers, nvidia: version });
}

// ---------- The schedule

async function startSoon(): Promise<void> {
  await squorli.schedule.cancel(STEP);
  await squorli.schedule.at(Date.now() + 5000, ROUND, null, { key: ROUND });
}
// A fresh installation has no job yet, and the interval or a channel may have changed.
squorli.on("enable", startSoon);
squorli.on("settings.change", startSoon);

squorli.on("job", async (job: Squorli.JobEvent): Promise<void> => {
  const c = await config();
  if (job.name === ROUND) {
    // The next round first: whatever fails from here on, the plugin comes back.
    await squorli.schedule.at(Date.now() + c.interval * 60_000, ROUND, null, { key: ROUND });
    await squorli.schedule.at(Date.now(), STEP, { i: 0, u: 0, f: 0 }, { key: STEP });
    return;
  }
  if (job.name !== STEP) return;
  const p = obj(job.payload);
  const at: Progress = { i: typeof p.i === "number" ? p.i : 0, u: typeof p.u === "number" ? p.u : 0, f: typeof p.f === "number" ? p.f : 0 };
  const games = await loadGames();
  const steps = plan(c, games);
  const step = steps[at.i];
  if (!step) return;
  try {
    if (step.kind === "steam") at.u += await checkSteam(c, games, step.game, MAX_PER_ROUND - at.u);
    else if (step.kind === "epic") at.f += await checkEpic(c, MAX_PER_ROUND - at.f);
    else if (step.kind === "gamerpower") at.f += await checkGamerPower(c, MAX_PER_ROUND - at.f);
    else await checkNvidia(c);
  } catch (err) {
    // A source that is down, changed its answer or sent something unreadable: say so in the log and go on with the next.
    squorli.log.warn(`${step.kind}${step.kind === "steam" ? ` ${step.game}` : ""}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (at.i + 1 < steps.length) await squorli.schedule.at(Date.now() + STEP_GAP_MS, STEP, { i: at.i + 1, u: at.u, f: at.f }, { key: STEP });
});

// ---------- Commands

const T = (en: string, de: string): Squorli.ActionResult => ({ ok: true, message: { en, de } });
const F = (en: string, de: string): Squorli.ActionResult => ({ ok: false, message: { en, de } });
const short = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** /news-add: a Steam number is looked up as it is; a name is searched, and several hits are listed with their numbers. */
async function addGame(text: string): Promise<Squorli.ActionResult> {
  const term = text.trim().slice(0, 100);
  if (!term) return F("Name a game or its Steam number: /news-add Counter-Strike 2", "Nenne ein Spiel oder seine Steam-Nummer: /news-add Counter-Strike 2");
  const games = await loadGames();
  if (games.length >= MAX_GAMES) return F(`This server follows ${MAX_GAMES} games already. Remove one with /news-remove first.`, `Dieser Server folgt schon ${MAX_GAMES} Spielen. Entferne zuerst eines mit /news-remove.`);
  let found: { id: number; name: string } | null = null;
  try {
    if (/^\d{1,9}$/.test(term)) {
      const app = obj(obj(await getJson(`https://store.steampowered.com/api/appdetails?appids=${term}&filters=basic`))[term]);
      const name = str(obj(app.data).name, 120);
      if (app.success === true && name) found = { id: Number(term), name };
      else return F(`Steam knows no game with the number ${term}.`, `Steam kennt kein Spiel mit der Nummer ${term}.`);
    } else {
      const hits = list(obj(await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`)).items).map(obj)
        .filter((h) => h.type === "app" && typeof h.id === "number" && typeof h.name === "string").map((h) => ({ id: h.id as number, name: str(h.name, 120) }));
      const exact = hits.filter((h) => h.name.toLowerCase() === term.toLowerCase());
      if (hits.length === 0) return F(`Steam finds nothing for "${short(term, 60)}".`, `Steam findet nichts zu „${short(term, 60)}“.`);
      if (exact.length === 1 || hits.length === 1) found = exact[0] ?? hits[0]!;
      else {
        const choices = hits.slice(0, 5).map((h) => `${short(h.name, 50)} (${h.id})`).join(", ");
        return F(`Several games fit: ${choices}. Run the command again with the number, e.g. /news-add ${hits[0]!.id}`, `Mehrere Spiele passen: ${choices}. Führe den Befehl noch einmal mit der Nummer aus, z. B. /news-add ${hits[0]!.id}`);
      }
    }
  } catch {
    return F("Steam does not answer right now. Try again in a moment.", "Steam antwortet gerade nicht. Versuche es gleich noch einmal.");
  }
  const name = short(found.name, 80);
  if (games.some((g) => g.id === found.id)) return T(`This server follows ${name} already.`, `Dieser Server folgt ${name} bereits.`);
  games.push({ id: found.id, name: found.name, since: Math.floor(Date.now() / 1000), seen: [] });
  await squorli.storage.set(GAMES, games);
  if (!(await config()).updates) return T(`Following ${name}. No channel for game updates is set yet: pick one in the plugin's settings.`, `${name} wird beobachtet. Noch ist kein Kanal für Spiele-Updates eingestellt: Wähle einen in den Einstellungen des Plugins.`);
  return T(`Following ${name}. News that appear from now on are posted.`, `${name} wird beobachtet. Was ab jetzt erscheint, wird gepostet.`);
}

async function removeGame(text: string): Promise<Squorli.ActionResult> {
  const term = text.trim().toLowerCase();
  const games = await loadGames();
  if (!term) return F("Name the game or its Steam number: /news-remove 730", "Nenne das Spiel oder seine Steam-Nummer: /news-remove 730");
  const byNumber = games.filter((g) => String(g.id) === term), byName = games.filter((g) => g.name.toLowerCase() === term), partly = games.filter((g) => g.name.toLowerCase().includes(term));
  const hits = byNumber.length ? byNumber : byName.length ? byName : partly;
  if (hits.length === 0) return F("This server follows no such game. /news-list shows the games.", "Diesem Spiel folgt der Server nicht. /news-list zeigt die Spiele.");
  if (hits.length > 1) return F(`Several games fit: ${hits.slice(0, 5).map((g) => `${short(g.name, 50)} (${g.id})`).join(", ")}. Use the number.`, `Mehrere Spiele passen: ${hits.slice(0, 5).map((g) => `${short(g.name, 50)} (${g.id})`).join(", ")}. Nimm die Nummer.`);
  await squorli.storage.set(GAMES, games.filter((g) => g.id !== hits[0]!.id));
  const name = short(hits[0]!.name, 80);
  return T(`${name} is no longer followed.`, `${name} wird nicht mehr beobachtet.`);
}

async function listGames(): Promise<Squorli.ActionResult> {
  const games = await loadGames();
  if (games.length === 0) return T("This server follows no game yet. An admin adds one with /news-add.", "Dieser Server folgt noch keinem Spiel. Ein Admin fügt eines mit /news-add hinzu.");
  const names: string[] = [];
  for (const g of [...games].sort((a, b) => a.name.localeCompare(b.name))) {
    if ([...names, g.name].join(", ").length > 400) { names.push("…"); break; }
    names.push(short(g.name, 60));
  }
  return T(`Followed games (${games.length}): ${names.join(", ")}`, `Beobachtete Spiele (${games.length}): ${names.join(", ")}`);
}

squorli.on("command", async (e: Squorli.CommandEvent): Promise<Squorli.ActionResult> => {
  if (e.command === "news-add") return addGame(e.text);
  if (e.command === "news-remove") return removeGame(e.text);
  return listGames();
});

// Verwaltung > Plugins > Spiele-News > "Beobachtete Spiele".
squorli.on("view", async (): Promise<Squorli.ViewResult> => {
  return (await loadGames()).sort((a, b) => a.name.localeCompare(b.name)).map((g) => ({ name: g.name, appId: String(g.id), since: g.since * 1000 }));
});
