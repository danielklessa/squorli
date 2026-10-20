import type { Platform } from "./types";
import { popoutFeatures } from "./web";

/**
 * The mobile app (apps/mobile, docs/features/mobile.md): the same build in a Capacitor shell on iOS and Android, served
 * from capacitor://localhost (iOS) or https://localhost (Android). Like the desktop app it has no home server and a fixed
 * directory; unlike it, the shell offers no bridge of its own: the page reaches the system through Capacitor's plugins.
 */

/** What Capacitor's native bridge puts on the page before any of the client's scripts runs. */
export type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string };

/** The page runs in the app's shell. In a browser there is no such global (the client never loads @capacitor/core there). */
export const inMobileApp = (cap: CapacitorGlobal | undefined): cap is CapacitorGlobal =>
  typeof cap?.isNativePlatform === "function" && cap.isNativePlatform() === true;

/** The app's directory, the desktop app's (apps/desktop/src/main/index.ts). */
export const MOBILE_DIRECTORY_URL = "https://directory.squorli.com";

/**
 * Which directory the app uses: the fixed one, except for a page from the Vite dev server (`cap run --live-reload`,
 * apps/mobile/AGENTS.md), which names its own (`VITE_DIRECTORY_URL`, else the local one on 3100).
 */
export function mobileDirectoryUrl(env: { DEV: boolean; VITE_DIRECTORY_URL?: string | undefined }): string {
  return env.DEV ? env.VITE_DIRECTORY_URL ?? "http://localhost:3100" : MOBILE_DIRECTORY_URL;
}

export function mobileAppPlatform(cap: CapacitorGlobal): Platform {
  const android = cap.getPlatform?.() === "android";
  // The plugins' JavaScript (and @capacitor/core with it) is a chunk of its own that only the app loads. Never resolve a
  // promise WITH a plugin (`.then((m) => m.App)`): a plugin is a proxy that answers every property, `then` too, so the
  // promise would call `App.then()`, which throws "not implemented" (found in the harness, 20 October 2026).
  const appPlugin = import("@capacitor/app");
  return {
    kind: "mobile",
    // PlatformOs names desktop systems; the phone's is told by `mobile` and, inside this file, by Capacitor.
    os: "other",
    mobile: true,
    app: null,
    home: null,
    defaultDirectoryUrl: mobileDirectoryUrl({ DEV: import.meta.env.DEV, VITE_DIRECTORY_URL: import.meta.env.VITE_DIRECTORY_URL as string | undefined }),
    setLanguage: null,
    // A web view has no Idle Detection API; idleDetection.ts finds that out and shows no switch.
    systemIdle: "permission",
    // The key of the sealed secrets stays in IndexedDB as in a browser (browserSecrets.ts) until the Keychain/Keystore plugin
    // (docs/PLAN-mobile.md 6.3).
    secretStore: null,
    keyVault: null,
    systemActivity: null,
    games: null,
    hotkeys: null,
    // Notifications come with the push of docs/PLAN-mobile.md (stage 4); a web view has no Notification API.
    notifications: { permission: () => "unsupported", request: async () => "unsupported", show: () => {}, onClick: () => () => {}, knowsFullscreen: false },
    // The app's page is a secure one (https://localhost, capacitor://localhost), only a live-reload page is http.
    media: { mobile: true, blocksInsecureMedia: window.location.protocol !== "http:", screenSharePublishOverrides: () => null, takeScreenAudio: async () => null, stopScreenAudio: () => {}, setPlayerOutput: null, setChatPlayerOutput: null },
    links: {
      // Both shells hand a new window to the system's browser (iOS: WKUIDelegate, Android: the navigation leaves the app's
      // host), the same way they treat a link with target _blank.
      openExternal: (url) => { window.open(url, "_blank", "noopener"); },
      // squorli:// and the invite links on squorli.com come with docs/PLAN-mobile.md stage 5.
      onDeepLink: () => () => {},
      lookUp: null,
    },
    screen: { setPicker: () => {} },
    window: {
      popoutFeatures, appearance: null, tray: null, autostart: null, ready: () => {}, attention: null, focusPopout: null, frame: null, beforeQuit: null,
      // Android's back: Capacitor would go back in the page's history and end the app at its start, a voice connection with it.
      back: android ? (cb) => {
        const listener = appPlugin.then(({ App }) => App.addListener("backButton", () => { if (!cb()) void App.minimizeApp(); }));
        return () => { void listener.then((l) => l.remove()); };
      } : null,
    },
    updates: null,
  };
}
