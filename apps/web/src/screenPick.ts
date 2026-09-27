import type { ScreenCodec, ScreenPick, ScreenSource } from "./platform/bridge";
import type { ScreenOffer } from "./platform/types";

/**
 * The rules of the desktop app's share dialog (ScreenPicker.tsx) and of "Quick Share" (VoiceDock.tsx); pure, tested.
 * User's wishes of 21 September 2026: a window's audio goes with it unless the user unticks it (the app's own windows never
 * have any: `audio` false), a screen's does not; a detected game is sent with the codec for moving pictures, everything else
 * with the standing codec. That codec (same day): H.265 where this computer can send it (`VoiceClient.supportsH265()`: the
 * graphics unit encodes it), else H.264, which Chromium encodes in software with LiveKit (docs/features/voice-video.md).
 */
export const movingCodec = (h265: boolean): ScreenCodec => (h265 ? "h265" : "h264");
export const defaultAudio = (source: ScreenSource | null): boolean => source?.kind === "window" && source.audio;
export const defaultCodec = (source: ScreenSource | null, h265: boolean): ScreenCodec => (source?.kind === "window" && source.gameId ? movingCodec(h265) : "vp8");

/** The dialog's order of the windows (user's wish, 21 September 2026): detected games, then windows in full screen, then everything else; by name within each. The shell's own order is the z-order, which "Quick Share" keeps using. */
export function sortWindows(windows: readonly ScreenSource[], locale?: string): ScreenSource[] {
  const rank = (s: ScreenSource) => (s.gameId ? 0 : s.fullscreen ? 1 : 2);
  return [...windows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, locale, { sensitivity: "base", numeric: true }));
}

/** The sources of an offer once the shell listed them (at once when it has); "Quick Share" waits for this and for nothing else, the thumbnails are the dialog's. */
export function whenListed(offer: ScreenOffer): Promise<readonly ScreenSource[]> {
  return new Promise((resolve) => {
    if (!offer.current().listing) { resolve(offer.current().sources); return; }
    const off = offer.subscribe(() => { if (offer.current().listing) return; off(); resolve(offer.current().sources); });
  });
}

/** How many tiles stand in for the list while the shell is still finding out what there is. */
export const PLACEHOLDER_TILES = 6;

/** "Quick Share": the running game's window, topmost first, with its audio and always the codec for moving pictures, without the dialog; null = that window is not on offer (minimized, an older shell), then the dialog opens. */
export function quickSharePick(sources: readonly ScreenSource[], gameId: string, h265: boolean): ScreenPick | null {
  const source = sources.find((s) => s.kind === "window" && s.gameId === gameId);
  return source ? { sourceId: source.id, audio: source.audio, codec: movingCodec(h265) } : null;
}
