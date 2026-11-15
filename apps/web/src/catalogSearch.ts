import type { PluginCatalogEntry } from "@squorli/protocol";

/**
 * The catalogue of signed plugins in Verwaltung > Plugins, the pure and tested part (docs/features/plugins.md): the search.
 * Every word of the query must stand somewhere in an entry: in its name or description (both languages, whatever the
 * app's language is: a German reader may type the English name), its author, its id, a host it fetches from or the name of
 * a capability. Matches whose NAME holds the query come first; otherwise the catalogue's own order stays.
 */
export function filterCatalog(entries: readonly PluginCatalogEntry[], query: string): PluginCatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length === 0) return [...entries];
  const hay = (e: PluginCatalogEntry) => [e.name.en, e.name.de ?? "", e.description.en, e.description.de ?? "", e.author ?? "", e.id, ...e.hosts, ...e.capabilities.map((c) => c.id)].join("\n").toLowerCase();
  const inName = (e: PluginCatalogEntry) => { const name = `${e.name.en}\n${e.name.de ?? ""}\n${e.id}`.toLowerCase(); return words.every((w) => name.includes(w)); };
  const hits = entries.filter((e) => { const text = hay(e); return words.every((w) => text.includes(w)); });
  return [...hits.filter(inName), ...hits.filter((e) => !inName(e))];
}

/** A catalogue's date (`YYYY-MM-DD`) as a moment for the date formatter: noon UTC is that day in every time zone a reader is likely in. */
export function catalogDate(day: string | null): string | null {
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00Z` : null;
}
