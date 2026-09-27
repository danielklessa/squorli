import { InviteCode, ServerHost, type AccountServer } from "@squorli/protocol";
import { parseDeepLink } from "./platform/deepLink";

/**
 * A client without a home server (the desktop app, docs/features/desktop.md): what it remembers per device, which server
 * it opens at start, and how it reads a server address the user typed or pasted. Pure functions plus localStorage.
 */

/** Past the app's own login, the servers added by address (not on the account's list), and the server viewed last. */
export type ClientData = { signedIn: boolean; hosts: string[]; lastHost: string | null };

const CLIENT_KEY = "chat.client.v1";
const EMPTY: ClientData = { signedIn: false, hosts: [], lastHost: null };

const hostOrNull = (v: unknown): string | null => { const r = ServerHost.safeParse(v); return r.success ? r.data : null; };

export function parseClientData(raw: string | null): ClientData {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof ClientData, unknown>> | null;
    if (typeof v !== "object" || v === null) return EMPTY;
    const hosts = Array.isArray(v.hosts) ? [...new Set(v.hosts.map(hostOrNull).filter((h): h is string => h !== null))].slice(0, 100) : [];
    return { signedIn: v.signedIn === true, hosts, lastHost: hostOrNull(v.lastHost) };
  } catch { return EMPTY; }
}

export function loadClientData(): ClientData {
  try { return parseClientData(localStorage.getItem(CLIENT_KEY)); } catch { return EMPTY; }
}
export function saveClientData(data: ClientData): void {
  try { localStorage.setItem(CLIENT_KEY, JSON.stringify(data)); } catch { /* never mind */ }
}

/**
 * The server to show at start: the one viewed last while it is still the user's (on the account's list without a pending
 * account deletion, or added by address), otherwise the one the account was seen on most recently, otherwise the first
 * added one. `accountServers` null = the directory did not answer (offline): then the remembered server stands.
 * A server the directory's operator refused is the one to start on only when there is no other: the rail marks it, and
 * its page says why it is closed, which is more than "no server yet" would.
 */
export function chooseInitialServer(o: { last: string | null; accountServers: readonly AccountServer[] | null; localHosts: readonly string[] }): string | null {
  const listed = (o.accountServers ?? []).filter((s) => !s.leaveRequestedAt);
  const mine = listed.filter((s) => !s.refused);
  const newestOf = (list: readonly AccountServer[]) => list.slice().sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0))[0]?.host.toLowerCase() ?? null;
  const known = (host: string) => o.localHosts.includes(host) || o.accountServers === null || mine.some((s) => s.host.toLowerCase() === host);
  if (o.last && known(o.last)) return o.last;
  return newestOf(mine) ?? o.localHosts[0] ?? newestOf(listed.filter((s) => s.refused));
}

/**
 * What the user typed or pasted to add a server: a host (`chat.example.org`, with a port for development), its address
 * (`https://chat.example.org/...`), an invite link (`https://chat.example.org/invite/<code>`) or a `squorli://` link.
 * The host must pass the protocol's `ServerHost`; the address is always rebuilt from it (`directoryServerUrl`).
 */
export function parseServerAddress(input: string): { host: string; invite: string | null } | null {
  const raw = input.trim();
  if (!raw || raw.length > 400) return null;
  if (/^squorli:/i.test(raw)) {
    const link = parseDeepLink(raw);
    return link ? { host: link.host, invite: link.kind === "invite" ? link.code : null } : null;
  }
  const m = /^(?:https?:\/\/)?([^/?#\s@]+)(\/[^?#\s]*)?(?:[?#]\S*)?$/i.exec(raw);
  if (!m) return null;
  const host = hostOrNull(m[1]);
  if (!host) return null;
  const path = /^\/invite\/([^/]+)\/?$/.exec(m[2] ?? "");
  if (!path) return { host, invite: null };
  const code = InviteCode.safeParse(path[1]);
  return code.success ? { host, invite: code.data } : null;
}
