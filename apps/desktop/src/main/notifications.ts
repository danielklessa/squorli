import type { BridgeNotification } from "@squorli/web/platform/bridge";

/**
 * Notifications of the operating system for direct messages and mentions (docs/features/notifications.md). The client
 * decides when and what (apps/web/src/notifications.ts); the shell only checks what arrives: strings, cut to what a
 * notification shows, a tag the client recognises again. Pure part, tested.
 */
const TITLE_MAX = 120;
const BODY_MAX = 300;
const TAG_MAX = 300;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** What the client sent, or null when it is not a notification. `inFullscreen` missing = a client from before the setting: false. */
export function readNotification(value: unknown): BridgeNotification | null {
  if (typeof value !== "object" || value === null) return null;
  const { title, body, tag, inFullscreen: allowed } = value as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string" || typeof tag !== "string") return null;
  if (!title.trim() || !tag || tag.length > TAG_MAX) return null;
  return { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), tag, inFullscreen: allowed === true };
}

/**
 * Whether something runs in full screen, from the helper's answer: Windows' notification state 2 (a full screen application),
 * 3 (a Direct3D game in exclusive full screen), 4 (presentation mode) or 7 (a Store app in full screen), or a foreground
 * window that covers its monitor (a game in borderless full screen, which Windows does not always count).
 */
export function inFullscreen(state: number, foregroundCoversMonitor: boolean): boolean {
  return foregroundCoversMonitor || state === 2 || state === 3 || state === 4 || state === 7;
}

/**
 * Where Windows finds the name and the icon of the app's notifications: without a Start menu shortcut for the app's id (the
 * unpackaged app, an installation whose shortcut lacks it) a toast shows "electron" as its sender. The key under
 * HKCU\Software\Classes\AppUserModelId names them for that id (user's report, 27 September 2026). `reg add` arguments.
 */
export function appIdRegistration(appId: string, name: string, iconPath: string): string[][] {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
  return [
    ["add", key, "/v", "DisplayName", "/t", "REG_SZ", "/d", name, "/f"],
    ["add", key, "/v", "IconUri", "/t", "REG_SZ", "/d", iconPath, "/f"],
  ];
}
