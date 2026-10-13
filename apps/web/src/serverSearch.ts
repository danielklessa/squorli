/**
 * The field of the "add a server" dialog (ServerBrowser.tsx, 14 October 2026): the same line takes an address or link and
 * filters the directory's published servers. Pure functions, tested.
 */
import type { DirectoryServer } from "@squorli/protocol";
import { parseServerAddress } from "./clientHome";

/**
 * The server the field names, or null when it is only a search. A bare word ("gaming") is a search even though it would pass
 * as a host name: only a link's scheme, a dot, a port or `localhost` make it an address.
 */
export function typedAddress(input: string): { host: string; invite: string | null } | null {
  const raw = input.trim();
  const target = parseServerAddress(raw);
  if (!target) return null;
  return /^(https?:\/\/|squorli:)/i.test(raw) || /[.:]/.test(target.host) || target.host === "localhost" ? target : null;
}

/** The published servers the field matches: every word in the name, the host or the description; a link matches by its host. */
export function filterServers(list: DirectoryServer[], query: string): DirectoryServer[] {
  const address = typedAddress(query);
  const words = address ? [address.host] : query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return list;
  return list.filter((s) => {
    const text = `${s.name ?? ""} ${s.host} ${s.description ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
