/**
 * Short synthesized cues for joining and leaving a voice room (no asset files: the tones are generated
 * with Web Audio, so they cost nothing to ship and follow the selected output device).
 *
 * Four cues for voice rooms, each audibly different:
 * - selfJoin / selfLeave: sine, wide interval (C5<->G5), the "you moved" pair.
 * - peerJoin / peerLeave: triangle, narrower interval (E5<->A5), shorter and quieter, the "someone else moved" pair.
 * Rising = arriving, falling = leaving.
 * And one for a new direct message or a message that mentions me (`message`, 20 September 2026): the same high note twice,
 * so it is neither an arrival nor a departure.
 */
import type { SoundSettings as ProtocolSoundSettings } from "@squorli/protocol";
import { contextNeedsResume } from "./gate";

export type SoundCue = "selfJoin" | "selfLeave" | "peerJoin" | "peerLeave" | "message";

/** The cues of a voice room, in the order the settings offer them. */
export const VOICE_CUES: readonly SoundCue[] = ["selfJoin", "selfLeave", "peerJoin", "peerLeave"];
export const SOUND_CUES: readonly SoundCue[] = [...VOICE_CUES, "message"];

/** One scheduled tone of a cue; times in seconds relative to the start of the cue. */
export type Tone = { freq: number; start: number; dur: number; type: OscillatorType; gain: number };

const C5 = 523.25, G5 = 783.99, E5 = 659.25, A5 = 880, E6 = 1318.51;

export const CUE_TONES: Record<SoundCue, readonly Tone[]> = {
  selfJoin: [
    { freq: C5, start: 0, dur: 0.13, type: "sine", gain: 0.5 },
    { freq: G5, start: 0.09, dur: 0.24, type: "sine", gain: 0.55 },
  ],
  selfLeave: [
    { freq: G5, start: 0, dur: 0.13, type: "sine", gain: 0.5 },
    { freq: C5, start: 0.09, dur: 0.28, type: "sine", gain: 0.5 },
  ],
  peerJoin: [
    { freq: E5, start: 0, dur: 0.07, type: "triangle", gain: 0.28 },
    { freq: A5, start: 0.06, dur: 0.15, type: "triangle", gain: 0.3 },
  ],
  peerLeave: [
    { freq: A5, start: 0, dur: 0.07, type: "triangle", gain: 0.28 },
    { freq: E5, start: 0.06, dur: 0.17, type: "triangle", gain: 0.28 },
  ],
  message: [
    { freq: E6, start: 0, dur: 0.09, type: "sine", gain: 0.4 },
    { freq: E6, start: 0.14, dur: 0.26, type: "sine", gain: 0.4 },
  ],
};

/**
 * Confirmation of a global shortcut or a command from outside the window (docs/features/hotkeys.md): the state it left
 * behind, `on` rising and `off` falling, shorter and quieter than the cues. Not a cue of the settings: it follows the common
 * volume only, because whoever pressed the key wants to know what it did, deafened or not.
 */
export const FEEDBACK_TONES: { on: readonly Tone[]; off: readonly Tone[] } = {
  on: [{ freq: A5, start: 0, dur: 0.05, type: "square", gain: 0.1 }, { freq: E6, start: 0.06, dur: 0.09, type: "square", gain: 0.1 }],
  off: [{ freq: E6, start: 0, dur: 0.05, type: "square", gain: 0.1 }, { freq: A5, start: 0.06, dur: 0.11, type: "square", gain: 0.1 }],
};

/** On/off per cue plus one common volume; part of the per-device voice settings and, with an account, stored in the directory (protocol schema). */
export type SoundSettings = Omit<ProtocolSoundSettings, "message"> & { message: boolean };

export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  selfJoin: true,
  selfLeave: true,
  peerJoin: true,
  peerLeave: true,
  message: true,
  volume: 0.6,
};

/** Merge stored (possibly older or partial) settings onto the defaults; out-of-range volumes fall back. */
export function normalizeSoundSettings(raw: Partial<SoundSettings> | undefined | null): SoundSettings {
  const s: SoundSettings = { ...DEFAULT_SOUND_SETTINGS, ...(raw ?? {}) };
  for (const cue of SOUND_CUES) if (typeof s[cue] !== "boolean") s[cue] = DEFAULT_SOUND_SETTINGS[cue];
  const v = Number(s.volume);
  s.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_SOUND_SETTINGS.volume;
  return s;
}

/**
 * Should this cue sound? Deafened means "hear nothing", so it silences the cues too; volume 0 is off as well.
 * `force` is the settings preview: it ignores the on/off switch but still respects deafening and volume.
 */
export function shouldPlayCue(cue: SoundCue, settings: SoundSettings, ctx: { deafened: boolean; force?: boolean }): boolean {
  if (ctx.deafened) return false;
  if (settings.volume <= 0) return false;
  return ctx.force === true || settings[cue];
}

/** How long a cue sounds, in milliseconds: the last tone's end plus the start offset and the tail of its decay (playTones). */
export function cueDurationMs(cue: SoundCue): number {
  const end = Math.max(0, ...CUE_TONES[cue].map((t) => t.start + t.dur));
  return Math.ceil((end + 0.01 + 0.02) * 1000);
}

/**
 * Play a cue on an existing AudioContext. Never throws: a blocked or closed context simply stays silent.
 * The context is shared with the microphone gate, which does not use its destination, so the cues are the only output.
 */
export function playCue(ctx: AudioContext, cue: SoundCue, volume: number): void {
  playTones(ctx, CUE_TONES[cue], volume);
}

/** Play a sequence of tones (a cue, or the feedback of a command) on an existing AudioContext. Never throws. */
export function playTones(ctx: AudioContext, tones: readonly Tone[], volume: number): void {
  try {
    if (ctx.state === "closed") return;
    if (contextNeedsResume(ctx.state)) void ctx.resume().catch(() => {}); // also iOS's "interrupted" (gate.ts)
    const master = ctx.createGain();
    master.gain.value = Math.min(1, Math.max(0, volume));
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.01;
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq, t0 + tone.start);
      // Short attack, exponential decay: a soft blip instead of a click.
      const start = t0 + tone.start;
      const end = start + tone.dur;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, tone.gain), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(end + 0.02);
      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* already gone */ } };
    }
    // Release the master node once the longest tone has finished.
    const total = Math.max(0, ...tones.map((t) => t.start + t.dur)) + 0.1;
    setTimeout(() => { try { master.disconnect(); } catch { /* already gone */ } }, Math.ceil(total * 1000) + 50);
  } catch { /* no Web Audio (test environment, blocked context): stay silent */ }
}

/** Can a context of this browser be given an output device of its own (Chromium's AudioContext.setSinkId)? */
export function contextSinkSupported(): boolean {
  return typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === "function";
}

/** Give a context its own output device (null = the default). Rejects when the browser refuses the device; resolves at once where it cannot choose. */
export function setContextSink(ctx: AudioContext, deviceId: string | null): Promise<void> {
  const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof withSink.setSinkId !== "function") return Promise.resolve();
  return withSink.setSinkId(deviceId ?? "");
}

/** Route the cues to the selected output device where the browser supports it (Chromium's AudioContext.setSinkId). */
export function applyCueOutput(ctx: AudioContext, deviceId: string | null): void {
  void setContextSink(ctx, deviceId).catch(() => { /* device gone or not permitted: keep the default */ });
}
