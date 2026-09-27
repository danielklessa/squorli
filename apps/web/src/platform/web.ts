import { detectMobile } from "./mobile";
import type { NotifyPermission, Platform, PlatformOs } from "./types";

export function osFromUserAgent(ua: string): PlatformOs {
  if (/Windows NT/.test(ua)) return "windows";
  if (/Android|iPhone|iPad|iPod/.test(ua)) return "other";
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Linux|CrOS/.test(ua)) return "linux";
  return "other";
}

export const popoutFeatures = (size: { width: number; height: number }) => `popup,width=${size.width},height=${size.height},resizable=yes,scrollbars=no`;

/**
 * Notifications through the browser's Notification API (docs/features/notifications.md). Only on a secure page (https,
 * localhost) and never on a phone: mobile browsers show them only from a service worker, which this client has not.
 */
function browserNotifications(mobile: boolean): Platform["notifications"] {
  const listeners = new Set<(tag: string) => void>();
  const api = typeof window !== "undefined" && "Notification" in window && window.isSecureContext && !mobile ? window.Notification : null;
  const permission = (): NotifyPermission => (api ? api.permission : "unsupported");
  return {
    permission,
    request: async () => (api ? await api.requestPermission() : "unsupported"),
    show: ({ title, body, tag }) => {
      if (!api || api.permission !== "granted") return;
      try {
        const n = new api(title, { body, tag, silent: true, icon: "/app-icons/icon-192.png" });
        n.onclick = () => { window.focus(); n.close(); for (const cb of listeners) cb(tag); };
      } catch { /* Chrome on Android throws: notifications need a service worker there */ }
    },
    onClick: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    knowsFullscreen: false,
  };
}

/** The browser: the page is served by a chat server, which is the home server and names the directory. */
export function webPlatform(): Platform {
  // Development only: `VITE_HOMELESS=1 pnpm --filter @squorli/web dev` runs the client as the desktop app would, without a
  // home server and against the local directory, so that mode can be tried in a browser (docs/features/desktop.md).
  const homeless = import.meta.env.DEV && import.meta.env.VITE_HOMELESS === "1";
  const mobile = detectMobile();
  return {
    kind: "web",
    os: osFromUserAgent(navigator.userAgent),
    mobile,
    app: null,
    home: homeless ? null : { host: window.location.host, signDomain: window.location.hostname },
    systemIdle: "permission",
    secretStore: null,
    systemActivity: null,
    games: null,
    hotkeys: null,
    defaultDirectoryUrl: homeless ? (import.meta.env.VITE_DIRECTORY_URL as string | undefined) ?? "http://localhost:3100" : null,
    setLanguage: null,
    notifications: browserNotifications(mobile),
    media: { mobile, blocksInsecureMedia: window.location.protocol === "https:", screenSharePublishOverrides: () => null, takeScreenAudio: async () => null, stopScreenAudio: () => {}, setPlayerOutput: null, setChatPlayerOutput: null },
    links: {
      openExternal: (url) => { window.open(url, "_blank", "noopener"); },
      onDeepLink: () => () => {},
      lookUp: null,
    },
    screen: { setPicker: () => {} },
    window: { popoutFeatures, appearance: null, tray: null, autostart: null, ready: () => {}, attention: null, focusPopout: null, frame: null },
    updates: null,
  };
}
