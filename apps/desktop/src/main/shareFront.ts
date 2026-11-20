import type { FrontWindow } from "./systemWatchLines";

/**
 * Is the window or screen the user shares the one in front of them (docs/features/voice-video.md, 20 November 2026)? The
 * client hides the user's own share from them while it is: they see the shared thing itself then, and the tile would only
 * show it a second time. Pure, tested; the shell feeds it the helper's `front` lines (systemWatch.ts) and the picked source.
 *
 * - A shared window is in front while the foreground window is that window, or another window of the same program (a game
 *   that opens a second window, a launcher that hands over to the game).
 * - A shared screen has no window of its own: it counts as in front while a program other than Squorli covers its whole
 *   monitor (a game or a player in full screen). A window in front on another monitor is not told apart from one on the
 *   shared monitor (the shell does not learn which monitor a source is), so a windowed program never hides the tile.
 * - Squorli's own windows in front never hide it: the user is looking at Squorli.
 */
export type SharedSource = { kind: "screen" | "window"; /** The shared window's handle (decimal), null for a screen. */ hwnd: string | null; /** The shared window's program, "" when unknown. */ path: string };

export function shareInFront(shared: SharedSource | null, front: FrontWindow | null, own: { windows: ReadonlySet<string>; path: string }): boolean {
  if (!shared || !front) return false;
  if (own.windows.has(front.hwnd) || (own.path !== "" && samePath(front.path, own.path))) return false;
  if (shared.kind === "window") return front.hwnd === shared.hwnd || (shared.path !== "" && samePath(front.path, shared.path));
  return front.fullscreen;
}

const samePath = (a: string, b: string): boolean => a !== "" && a.toLowerCase() === b.toLowerCase();
