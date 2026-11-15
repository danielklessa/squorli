import { PLUGIN_API_VERSION, PLUGIN_ID_PATTERN, PluginNetworkHost, cleanPluginText, type PluginText } from "@squorli/protocol";
import { z } from "zod";

/**
 * The catalogue of signed plugins as the server reads it (docs/features/plugins.md, 15 November 2026); pure and tested.
 *
 * The list is `catalog.json` of the public repository squorli-plugins, written by its signing workflow. The server fetches
 * it only when somebody opens the catalogue in Verwaltung > Plugins (never by itself, never at start), keeps it for a few
 * minutes, and installs from it by downloading the signed file from that repository's release. Nothing in the list is
 * trusted for what a plugin may do: the downloaded file must carry Squorli's signature like any other, and it must be the
 * very file the list names (its hash). The list only says what exists; its texts are an author's texts and are cleaned
 * like a manifest's.
 *
 * Two addresses, both fixed here and never taken from the list: the list itself and a release's file. `catalogAllowed`
 * is the `allowHost` of both fetches, so a redirect cannot lead anywhere else.
 */

export const CATALOG_REPOSITORY = "https://github.com/danielklessa/squorli-plugins";
export const CATALOG_URL = "https://raw.githubusercontent.com/danielklessa/squorli-plugins/main/catalog.json";
/** GitHub answers a release's download with a redirect to one of these. */
const RELEASE_ASSET_HOSTS = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"];
const RELEASE_PATH = "/danielklessa/squorli-plugins/releases/download/";
export const CATALOG_MAX_BYTES = 1024 * 1024;
export const CATALOG_ENTRIES_MAX = 500;
/** How long a fetched list is served, and how soon "reload" may ask GitHub again. */
export const CATALOG_CACHE_MS = 10 * 60_000;
export const CATALOG_REFRESH_MIN_MS = 30_000;

// Breaks and tabs become spaces first: the cleaning takes control characters out without leaving a gap.
const oneLine = (s: string, max: number): string => cleanPluginText(s.replace(/\s+/g, " ")).trim().slice(0, max);
const CatalogText = (max: number) => z.object({ en: z.string(), de: z.string().optional() }).transform((t, ctx): PluginText => {
  const en = oneLine(t.en, max), de = t.de === undefined ? "" : oneLine(t.de, max);
  if (!en) { ctx.addIssue({ code: "custom", message: "an empty text" }); return z.NEVER; }
  return { en, ...(de ? { de } : {}) };
});
const optionalLine = (max: number) => z.string().nullish().transform((s) => (typeof s === "string" && oneLine(s, max)) || null);

/** One entry of `catalog.json` (squorli-plugins/AGENTS.md has the format). Keys this server does not know are ignored. */
export const CatalogFileEntry = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN),
  name: CatalogText(60),
  description: CatalogText(300),
  author: optionalLine(80),
  homepage: z.string().nullish().transform((s) => (typeof s === "string" && /^https:\/\/[^\s<>"'`\\]{1,290}$/.test(s) ? s : null)),
  kind: z.enum(["official", "reviewed"]),
  version: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/),
  apiVersion: z.number().int().min(1),
  capabilities: z.array(z.string().regex(/^[a-z][a-z.]{0,39}$/)).max(32).default([]),
  hosts: z.array(PluginNetworkHost).max(20).default([]),
  language: z.enum(["ts", "js"]),
  file: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  key: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
  signedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((e) => e.file === `${e.id}.${e.language}`, "the file is named after the plugin");
export type CatalogFileEntry = z.infer<typeof CatalogFileEntry>;

/**
 * The entries of a fetched list. An entry this server cannot read is left out alone (a list written for a later server
 * must not cost the others); a second entry with an id that was there already is left out too. Anything that is no list
 * at all gives null.
 */
export function readCatalog(json: unknown): CatalogFileEntry[] | null {
  const file = z.object({ version: z.number().int(), plugins: z.array(z.unknown()) }).safeParse(json);
  if (!file.success || file.data.version < 1) return null;
  const out: CatalogFileEntry[] = [];
  const seen = new Set<string>();
  for (const raw of file.data.plugins.slice(0, CATALOG_ENTRIES_MAX)) {
    const entry = CatalogFileEntry.safeParse(raw);
    if (!entry.success || seen.has(entry.data.id)) continue;
    seen.add(entry.data.id);
    out.push(entry.data);
  }
  return out;
}

/** Where the list is fetched from; `testOrigin` (LINK_PREVIEW_TEST_ORIGIN, tests only) plays the repository on one origin. */
export function catalogAddress(testOrigin?: string): string {
  return testOrigin ? `${testOrigin}/catalog.json` : CATALOG_URL;
}
/** Where an entry's signed file lies: built from its id, version and file name, never read from the list. */
export function releaseAddress(entry: Pick<CatalogFileEntry, "id" | "version" | "file">, testOrigin?: string): string {
  return `${testOrigin ?? CATALOG_REPOSITORY}/releases/download/${entry.id}-v${entry.version}/${entry.file}`;
}

/** May the fetch of the list or of a release's file ask this address (also asked for every redirect)? */
export function catalogAllowed(url: URL, what: "catalog" | "release", testOrigin?: string): boolean {
  if (url.username || url.password) return false;
  if (testOrigin !== undefined && url.origin === testOrigin) return true;
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (what === "catalog") return url.href === CATALOG_URL;
  return (url.hostname === "github.com" && url.pathname.startsWith(RELEASE_PATH)) || RELEASE_ASSET_HOSTS.includes(url.hostname);
}

/** -1, 0 or 1 for two versions of three numbers. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * What the catalogue says about one entry on this server: "needs_server" (written for a later plugin interface), "new",
 * "update" (the list's version is above the installed one) or "installed" (the same, or the server has a newer one).
 */
export function catalogStatus(entry: Pick<CatalogFileEntry, "version" | "apiVersion">, installedVersion: string | null, apiVersion = PLUGIN_API_VERSION): "needs_server" | "new" | "update" | "installed" {
  if (entry.apiVersion > apiVersion) return "needs_server";
  if (installedVersion === null) return "new";
  return compareVersions(entry.version, installedVersion) > 0 ? "update" : "installed";
}
