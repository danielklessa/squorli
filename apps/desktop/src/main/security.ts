import { app, session, shell, type BrowserWindow, type Session, type WebContents } from "electron";
import { isAllowedExternal, isAppNavigation, windowOpenDecision } from "./navigation";
import { PLAYER_ORIGINS } from "./playerAudioScript";

/**
 * What a page may do, in one place. The client is the only content with rights; the embedded players (Twitch, YouTube)
 * get fullscreen and nothing else. Links leave the app through the system's browser.
 */

/** Permissions of the client itself (requests and checks). Everything else is refused. */
const CLIENT_PERMISSIONS = new Set(["media", "display-capture", "fullscreen", "speaker-selection", "idle-detection", "clipboard-sanitized-write", "window-management"]);
const FRAME_PERMISSIONS = new Set(["fullscreen"]);

const originOf = (url: string | undefined): string | null => { if (!url) return null; try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; } };

export function openExternal(url: string): void {
  if (isAllowedExternal(url)) void shell.openExternal(url);
}

/**
 * `playerAudioGrant`: true while the user has the players' sound on an output device of their choice, and while the shell's
 * own script sets it inside a player's frame (playerAudio.ts, which says why it cannot be shorter). Chromium lets a frame see device labels and use another output than the default only while its origin
 * passes the microphone CHECK (and the iframe carries the `microphone` policy, playerWindow.ts `playerFrameAllow`); for that
 * moment, for the two player origins, for audio only. A REQUEST (getUserMedia) from a
 * player is refused as ever, and without a chosen device the players see no labels.
 */
export function applyPermissions(ses: Session, origins: readonly string[], playerAudioGrant: () => boolean = () => false): void {
  const allowed = (permission: string, origin: string | null) => (origin !== null && origins.includes(origin) ? CLIENT_PERMISSIONS : FRAME_PERMISSIONS).has(permission);
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, originOf(details.requestingUrl))));
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const origin = originOf(requestingOrigin);
    if (origin !== null && PLAYER_ORIGINS.includes(origin) && playerAudioGrant() && (permission === "speaker-selection" || (permission === "media" && details.mediaType !== "video"))) return true;
    return allowed(permission, origin);
  });
}

/**
 * Windows the client opened with a name (the stage's own window, `squorli-stage`): the client asks to bring one to the
 * front (`IPC.focusPopout`), which `window.focus()` from another window does not do on Windows.
 */
const namedPopouts = new Map<string, BrowserWindow>();
export function focusPopout(name: unknown): void {
  const win = typeof name === "string" ? namedPopouts.get(name) : undefined;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

/** Every window and frame host: no foreign navigation, no webviews, own windows only. */
export function lockDownContents(origins: readonly string[]): void {
  app.on("web-contents-created", (_event, contents: WebContents) => {
    contents.on("did-create-window", (win, details) => {
      const name = details.frameName;
      if (!name || name === "_blank") return;
      namedPopouts.set(name, win);
      win.on("closed", () => { if (namedPopouts.get(name) === win) namedPopouts.delete(name); });
    });
    contents.setWindowOpenHandler(({ url }) => {
      const decision = windowOpenDecision(url, origins);
      if (decision === "external") openExternal(url);
      return decision === "allow" ? { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#0a0f1e" } } : { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isAppNavigation(url, origins)) return;
      event.preventDefault();
      openExternal(url);
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/**
 * The web radio's two players refuse to run inside a page they do not know: Twitch names the allowed parents in
 * `frame-ancestors` (a host name, which `app://squorli` is not), YouTube wants an http(s) referrer. Only for exactly these
 * two hosts the shell vouches for the client: it drops Twitch's `frame-ancestors` and names squorli.com as the referrer.
 */
export function letPlayersEmbed(ses: Session = session.defaultSession): void {
  ses.webRequest.onHeadersReceived({ urls: ["https://player.twitch.tv/*"] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() !== "content-security-policy") continue;
      headers[name] = (headers[name] ?? []).map((value) => value.split(";").filter((part) => !part.trim().toLowerCase().startsWith("frame-ancestors")).join(";"));
    }
    callback({ responseHeaders: headers });
  });
  ses.webRequest.onBeforeSendHeaders({ urls: ["https://www.youtube-nocookie.com/embed/*"] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, Referer: "https://squorli.com/" } });
  });
}
