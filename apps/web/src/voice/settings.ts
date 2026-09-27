/**
 * Voice settings per device ("the user chooses per device", a guideline in docs/PLAN.md). Stored in localStorage; this is the "local profile"
 * that always works, also on servers without a directory. One part of it, the join/leave cues (`sounds`), additionally
 * follows the directory account (store.ts): a change here is reported to subscribers with its source, so the store can
 * push user changes to the directory and apply the account's settings without echoing them back.
 */
import type { SoundSettings as ProtocolSoundSettings } from "@squorli/protocol";
import type { HotkeyBindings } from "../platform/bridge";
import { NO_HOTKEYS, normalizeHotkeys } from "../platform/hotkeys";
import { detectMobile } from "../platform/mobile";
import { normalizeServerOrder } from "../serverOrder";
import { DEFAULT_MIC_BOOST, normalizeMicBoost, type MicBoostSettings } from "./micBoost";
import { DEFAULT_SOUND_SETTINGS, normalizeSoundSettings, type SoundSettings } from "./sounds";

export type VoiceMode = "vad" | "ptt";

export type VoiceSettings = {
  mode: VoiceMode;
  /** KeyboardEvent.code, e.g. "Space" or "KeyV". */
  pttKey: string;
  /** Threshold for voice activation, 0..1 (RMS level). */
  vadThreshold: number;
  /** Hangover time in ms so that word endings are not cut off. */
  vadHangoverMs: number;
  inputDeviceId: string | null;
  /**
   * Microphone boost (micBoost.ts): off by default (automatic until 25 September 2026). Per device like the device selection and NOT part of the directory
   * account: how quiet a microphone is belongs to this computer, not to the person.
   */
  micBoost: MicBoostSettings;
  outputDeviceId: string | null;
  /** Separate output device for screen share audio (null = same as voice). Chromium only (setSinkId). */
  screenOutputDeviceId: string | null;
  /** Separate output device for the web radio (null = same as voice). Chromium only (setSinkId). */
  radioOutputDeviceId: string | null;
  cameraDeviceId: string | null;
  /** Send resolution of the camera (simulcast supplies smaller layers automatically). */
  cameraQuality: "360p" | "720p";
  /** Camera background blur: 0 = off, otherwise the radius (10 light, 20 strong). Only in browsers that support it. */
  cameraBlur: number;
  /** Cues when you or someone else joins or leaves the voice room; each one switchable. With a directory account these follow the account. */
  sounds: SoundSettings;
  /** Speaker view of the stage: may you yourself be shown large as the active speaker? Off = only others are featured. */
  featureSelfInSpeakerView: boolean;
  /**
   * Game display (docs/features/games.md): `enabled` = detect running games (desktop app) and show friends what I play, off by
   * default; `servers` = show it to the members of my chat servers too. Follows the directory account.
   */
  games: GameDisplaySettings;
  /** The server rail as the user arranged it (serverOrder.ts): directory hosts, first at the top. Follows the account inside the sealed settings only. */
  serverOrder: string[];
  /** Link previews in direct messages (docs/features/link-previews.md); false = none made for what I send, none shown of what I receive. Follows the account inside the sealed settings only. */
  dmLinkPreviews: boolean;
  /**
   * Global shortcuts of the desktop app (platform/hotkeys.ts, docs/features/hotkeys.md). Per device like the microphone boost
   * and NOT part of the directory account: a key combination that is free on this computer may be taken on another, and
   * a Stream Deck's configuration lives on one computer too.
   */
  hotkeys: HotkeyBindings;
  /** The defaults for a phone or tablet were applied once (`withDeviceDefaults`); what the user chooses afterwards stays. */
  mobileDefaults: boolean;
};

export type GameDisplaySettings = { enabled: boolean; servers: boolean };
export const DEFAULT_GAME_DISPLAY: GameDisplaySettings = { enabled: false, servers: true };
export const normalizeGameDisplay = (value: unknown): GameDisplaySettings => {
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { enabled: stored.enabled === true, servers: stored.servers !== false };
};

/** Who changed the settings: the user on this device, or the directory account (applied from the account, not pushed back). */
export type VoiceSettingsSource = "user" | "directory";

const KEY = "chat.voice.v1";

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  mode: "vad", // Default per the plan: works without explanation
  pttKey: "Space",
  vadThreshold: 0.04,
  vadHangoverMs: 400,
  inputDeviceId: null,
  micBoost: { ...DEFAULT_MIC_BOOST },
  outputDeviceId: null,
  screenOutputDeviceId: null,
  radioOutputDeviceId: null,
  cameraDeviceId: null,
  cameraQuality: "720p",
  cameraBlur: 0,
  sounds: { ...DEFAULT_SOUND_SETTINGS },
  featureSelfInSpeakerView: true,
  games: { ...DEFAULT_GAME_DISPLAY },
  serverOrder: [],
  dmLinkPreviews: true,
  hotkeys: { ...NO_HOTKEYS },
  mobileDefaults: false,
};

/**
 * Defaults that fit a phone or tablet (platform/mobile.ts), applied ONCE per device, also to settings stored before this
 * existed (19 September 2026, user's wish): the camera sends 360p, because three simulcast layers up to 720p cost battery
 * and a mobile connection's upload. The user can set 720p again and it stays. The microphone needs no setting here: its
 * boost gets wider limits on a phone by itself (micBoost.ts).
 */
export function withDeviceDefaults(s: VoiceSettings, mobile: boolean): VoiceSettings {
  if (!mobile || s.mobileDefaults) return s;
  return { ...s, cameraQuality: "360p", mobileDefaults: true };
}

function readStored(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return withDeviceDefaults({ ...DEFAULT_VOICE_SETTINGS }, detectMobile());
    const stored = JSON.parse(raw) as Partial<VoiceSettings>;
    // `sounds` is nested, so it needs its own merge: settings stored before the cues existed have no such field.
    return withDeviceDefaults({ ...DEFAULT_VOICE_SETTINGS, ...stored, sounds: normalizeSoundSettings(stored.sounds), micBoost: normalizeMicBoost(stored.micBoost), games: normalizeGameDisplay(stored.games), serverOrder: normalizeServerOrder(stored.serverOrder), dmLinkPreviews: stored.dmLinkPreviews !== false, hotkeys: normalizeHotkeys(stored.hotkeys) }, detectMobile());
  } catch {
    return withDeviceDefaults({ ...DEFAULT_VOICE_SETTINGS }, detectMobile());
  }
}

let current: VoiceSettings | null = null;
const listeners = new Set<(s: VoiceSettings, source: VoiceSettingsSource) => void>();

/** Current settings (read from localStorage once, then cached; every save updates the cache). */
export function loadVoiceSettings(): VoiceSettings {
  if (!current) current = readStored();
  return current;
}

export function saveVoiceSettings(s: VoiceSettings, source: VoiceSettingsSource = "user"): void {
  current = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode or similar: then simply not */ }
  for (const fn of listeners) fn(s, source);
}

/** Be told about every save (App, VoiceDock and the store share one copy this way). Returns the unsubscribe function. */
export function subscribeVoiceSettings(fn: (s: VoiceSettings, source: VoiceSettingsSource) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Same cue settings? (Order-independent field comparison; volumes compared exactly, the slider steps are 0.05.) */
export function sameSoundSettings(a: ProtocolSoundSettings, b: ProtocolSoundSettings): boolean {
  return a.selfJoin === b.selfJoin && a.selfLeave === b.selfLeave && a.peerJoin === b.peerJoin && a.peerLeave === b.peerLeave && a.message === b.message && a.volume === b.volume;
}
