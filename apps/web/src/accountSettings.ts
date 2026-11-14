/**
 * Settings that follow the directory account (protocol `AccountSettings`): everything the user can set in the client except the
 * device selection (microphone, outputs, camera: device ids belong to one browser). The per-device copy in localStorage
 * (voice/settings.ts, i18n `chat.locale`) stays the working copy, so servers without a directory keep working; store.ts applies the
 * account's copy on load and pushes user changes. Pure functions, no storage access.
 */
import type { AccountSettings } from "@squorli/protocol";
import type { LocalePreference } from "./i18n";
import type { VoiceSettings } from "./voice/settings";

/** The part of this device's settings that belongs to the account. */
export function toAccountSettings(s: VoiceSettings, locale: LocalePreference): AccountSettings {
  return {
    locale,
    voice: { mode: s.mode, pttKey: s.pttKey, vadThreshold: s.vadThreshold, vadHangoverMs: s.vadHangoverMs },
    camera: { quality: s.cameraQuality, blur: s.cameraBlur },
    sounds: { selfJoin: s.sounds.selfJoin, selfLeave: s.sounds.selfLeave, peerJoin: s.sounds.peerJoin, peerLeave: s.sounds.peerLeave, message: s.sounds.message, shareStart: s.sounds.shareStart, volume: s.sounds.volume },
    stage: { featureSelf: s.featureSelfInSpeakerView },
    games: { enabled: s.games.enabled, servers: s.games.servers },
  };
}

/** The account's settings on top of this device's; the device selection stays as it is. The locale is handled by the caller (it needs a reload). */
export function applyAccountSettings(local: VoiceSettings, remote: AccountSettings): VoiceSettings {
  return {
    ...local,
    mode: remote.voice.mode, pttKey: remote.voice.pttKey, vadThreshold: remote.voice.vadThreshold, vadHangoverMs: remote.voice.vadHangoverMs,
    cameraQuality: remote.camera.quality, cameraBlur: remote.camera.blur,
    // An account stored before the message cue existed (or by a directory that does not know it) says nothing about it: this device's value stays.
    sounds: { ...remote.sounds, message: remote.sounds.message ?? local.sounds.message, shareStart: remote.sounds.shareStart ?? local.sounds.shareStart },
    featureSelfInSpeakerView: remote.stage.featureSelf,
    // Like the message cue: an account from before the game display says nothing about it.
    games: remote.games ? { enabled: remote.games.enabled, servers: remote.games.servers } : local.games,
  };
}

/** Same hide list of the game display (sealed settings)? The order plays no part, and no list counts as an empty one. */
export function sameHiddenGames(a: string[] | null, b: string[] | null): boolean {
  const left = new Set(a ?? []); const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * Same settings? Compared in a fixed field order, so the key order of a parsed object does not matter. `tolerateMissing`: a
 * field one side does not have at all (`sounds.message` or `games` from an older account) counts as equal; for "does the account's copy
 * change anything here", not for "must this be pushed".
 */
export function sameAccountSettings(a: AccountSettings, b: AccountSettings, tolerateMissing = false): boolean {
  if (!(tolerateMissing && (a.sounds.message === undefined || b.sounds.message === undefined)) && a.sounds.message !== b.sounds.message) return false;
  if (!(tolerateMissing && (a.sounds.shareStart === undefined || b.sounds.shareStart === undefined)) && a.sounds.shareStart !== b.sounds.shareStart) return false;
  if (!(tolerateMissing && (a.games === undefined || b.games === undefined)) && (a.games?.enabled !== b.games?.enabled || a.games?.servers !== b.games?.servers)) return false;
  const canon = (s: AccountSettings) => JSON.stringify([
    s.locale, s.voice.mode, s.voice.pttKey, s.voice.vadThreshold, s.voice.vadHangoverMs, s.camera.quality, s.camera.blur,
    s.sounds.selfJoin, s.sounds.selfLeave, s.sounds.peerJoin, s.sounds.peerLeave, s.sounds.volume, s.stage.featureSelf,
  ]);
  return canon(a) === canon(b);
}
