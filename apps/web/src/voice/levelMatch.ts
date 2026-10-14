/**
 * Levelling the others (user's wish, 14 October 2026: "alle Sprecher in einem Raum auf einen gewünschten Pegel stellen, alle
 * sind bei 100 % gleich laut"): every remote microphone gets an `AutoGain` of its own that learns that speaker's speech level
 * and brings it to one common level, raising quiet speakers and lowering loud ones. The common level is the user's slider
 * (50..150 %, linear, 100 % marked); the per-person volume of the right-click menu multiplies on top, so one speaker can still
 * be lifted above the others or put below them.
 *
 * Voices only (the user's rule): a leveller hangs on a remote MICROPHONE's meter, so a share's audio, the web radio and the embedded
 * players are never levelled; keep it that way. Off by default and per device, like the per-person volume (the user's choices).
 * Pure (tested); voiceClient.ts runs it.
 */
import { MIC_BOOST_TARGET, type MicBoostLimits } from "./micBoost";

export type LevelMatchSettings = {
  /** Level the speakers at all; off unless the user switches it on. */
  on: boolean;
  /** The common level, LEVEL_MATCH_MIN..LEVEL_MATCH_MAX (1 = a normal speaking level). */
  level: number;
};
export const DEFAULT_LEVEL_MATCH: LevelMatchSettings = { on: false, level: 1 };
export const LEVEL_MATCH_MIN = 0.5;
export const LEVEL_MATCH_MAX = 1.5;

export const clampLevel = (level: unknown): number =>
  typeof level === "number" && Number.isFinite(level) ? Math.min(LEVEL_MATCH_MAX, Math.max(LEVEL_MATCH_MIN, level)) : 1;
export function normalizeLevelMatch(raw: unknown): LevelMatchSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LevelMatchSettings>;
  return { on: r.on === true, level: clampLevel(r.level) };
}

/**
 * How far one speaker's gain may go: down to 0.1 (-20 dB) for someone far too loud, up to x8 (+18 dB) for someone far too
 * quiet; speech from the same raw level on as the microphone's automatic. The received audio is mostly processed by the
 * sender's browser already, so most speakers end near x1; the clipping guard behind it catches the peaks of a raised one.
 */
export const REMOTE_LEVEL_MIN = 0.1;
export const REMOTE_LEVEL_MAX = 8;
export const remoteLevelLimits = (level: number): MicBoostLimits => ({ min: REMOTE_LEVEL_MIN, max: REMOTE_LEVEL_MAX, minSpeech: 0.003, target: targetOf(level) });
/** The speech level a speaker is brought to: the microphone's target, scaled by the slider. */
export const targetOf = (level: number): number => MIC_BOOST_TARGET * clampLevel(level);

/** The slider in whole percent, 50..150. */
export const LEVEL_SLIDER_MIN = Math.round(LEVEL_MATCH_MIN * 100);
export const LEVEL_SLIDER_MAX = Math.round(LEVEL_MATCH_MAX * 100);
export const levelToSlider = (level: number): number => Math.round(clampLevel(level) * 100);
export const sliderToLevel = (pos: number): number => clampLevel(Math.round(pos) / 100);

/** The gain a speaker plays with: their levelled gain (1 while off) times the user's volume for them. */
export const playbackGain = (on: boolean, levelGain: number, userVolume: number): number => (on ? levelGain : 1) * userVolume;
