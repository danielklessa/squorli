/**
 * Which addresses the client's windows may open or go to. Pure (tested); `security.ts` applies it.
 * `origins` = where the client itself lives: `app://squorli`, in development also the Vite server.
 */
const parse = (url: string): URL | null => { try { return new URL(url); } catch { return null; } };

/** Addresses handed to the system (its browser, its mail program). Nothing else ever reaches `shell.openExternal`. */
export function isAllowedExternal(url: string): boolean {
  const u = parse(url);
  return !!u && (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:");
}

const originOf = (u: URL): string => `${u.protocol}//${u.host}`;

/**
 * `window.open`: the client opens `about:blank` for a video pop-out (it fills the window itself) and its own
 * `/player-window.html` for the web radio's player. Web and mail addresses go to the system, everything else is refused.
 */
export function windowOpenDecision(url: string, origins: readonly string[]): "allow" | "external" | "deny" {
  if (url === "about:blank") return "allow";
  const u = parse(url);
  if (!u) return "deny";
  if (origins.includes(originOf(u))) return u.pathname === "/player-window.html" ? "allow" : "deny";
  return isAllowedExternal(url) ? "external" : "deny";
}

/** Navigation of a window's main frame: only inside the client. */
export function isAppNavigation(url: string, origins: readonly string[]): boolean {
  const u = parse(url);
  return !!u && origins.includes(originOf(u));
}

/**
 * Whether a frame is the client itself and may use the shell's bridge (`isClientFrame` in index.ts asks this after it has
 * checked that the frame is a main frame). The origin alone is not enough: a window the client opens (`window.open`, the web
 * radio's `/player-window.html`) lives on the same origin, so a child window that gets the parent's preload would have the
 * whole bridge, the stored keys included (security audit, 2 October 2026, C4). Driven in the unpackaged app that day, a window
 * opened like the pop-out had no bridge at all, so this is a second line and not the fix of a hole seen. Only the client's own
 * page counts: any other HTML file of the app is refused; the client's address may carry a path of its own (`/invite/<code>`
 * in a browser) but never names another document.
 */
export function isClientPage(url: string, origins: readonly string[]): boolean {
  const u = parse(url);
  if (!u || !origins.includes(originOf(u))) return false;
  return !/\.html?$/i.test(u.pathname) || u.pathname === "/index.html";
}
