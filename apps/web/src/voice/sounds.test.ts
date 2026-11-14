import { SoundSettings as SoundSettingsSchema, directorySoundSettingsPayload } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { CUE_TONES, DEFAULT_SOUND_SETTINGS, SHARE_CUE_REST_MS, SOUND_CUES, VOICE_CUES, cueDurationMs, normalizeSoundSettings, shareCueDue, shouldPlayCue } from "./sounds";

describe("join/leave cues", () => {
  it("knows how long a cue sounds, the leave cue well under a second", () => {
    for (const cue of SOUND_CUES) expect(cueDurationMs(cue), cue).toBeGreaterThan(0);
    // The shell waits at most 1.5 s before it closes the window (quitHandoff.ts): the cue has to fit with room to spare.
    expect(cueDurationMs("selfLeave")).toBeLessThan(1000);
    expect(cueDurationMs("selfLeave")).toBe(Math.ceil((0.09 + 0.28 + 0.03) * 1000));
  });

  it("gives every cue its own tone sequence", () => {
    const shapes = SOUND_CUES.map((c) => JSON.stringify(CUE_TONES[c]));
    expect(new Set(shapes).size).toBe(SOUND_CUES.length);
  });

  it("rises when arriving and falls when leaving", () => {
    for (const cue of ["selfJoin", "peerJoin"] as const) {
      const [a, b] = CUE_TONES[cue];
      expect(b!.freq, cue).toBeGreaterThan(a!.freq);
    }
    for (const cue of ["selfLeave", "peerLeave"] as const) {
      const [a, b] = CUE_TONES[cue];
      expect(b!.freq, cue).toBeLessThan(a!.freq);
    }
  });

  it("keeps the cues for other people quieter than your own", () => {
    const loudest = (cue: (typeof SOUND_CUES)[number]) => Math.max(...CUE_TONES[cue].map((t) => t.gain));
    expect(loudest("peerJoin")).toBeLessThan(loudest("selfJoin"));
    expect(loudest("peerLeave")).toBeLessThan(loudest("selfLeave"));
  });

  it("fills in missing and out-of-range stored settings", () => {
    expect(normalizeSoundSettings(undefined)).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(normalizeSoundSettings({ peerJoin: false })).toEqual({ ...DEFAULT_SOUND_SETTINGS, peerJoin: false });
    expect(normalizeSoundSettings({ volume: 5 }).volume).toBe(1);
    expect(normalizeSoundSettings({ volume: -1 }).volume).toBe(0);
    expect(normalizeSoundSettings({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUND_SETTINGS.volume);
  });

  it("plays only switched-on cues, and nothing while deafened or at volume 0", () => {
    const on = DEFAULT_SOUND_SETTINGS;
    expect(shouldPlayCue("selfJoin", on, { deafened: false })).toBe(true);
    expect(shouldPlayCue("selfJoin", on, { deafened: true })).toBe(false);
    expect(shouldPlayCue("selfJoin", { ...on, volume: 0 }, { deafened: false })).toBe(false);
    expect(shouldPlayCue("peerLeave", { ...on, peerLeave: false }, { deafened: false })).toBe(false);
  });

  it("is exactly what the directory account stores, signed over a canonical line", () => {
    expect(SoundSettingsSchema.parse(DEFAULT_SOUND_SETTINGS)).toEqual(DEFAULT_SOUND_SETTINGS);
    expect(SoundSettingsSchema.safeParse({ ...DEFAULT_SOUND_SETTINGS, volume: 1.5 }).success).toBe(false);
    expect(directorySoundSettingsPayload({ ...DEFAULT_SOUND_SETTINGS, peerLeave: false, volume: 0.35 })).toBe("1110\n0.35");
  });

  it("has a cue for a screen share somebody else starts, optional in the account like the message cue", () => {
    expect(VOICE_CUES).toContain("shareStart");
    expect(CUE_TONES.shareStart.length).toBe(3);
    expect(normalizeSoundSettings({}).shareStart).toBe(true);
    expect(normalizeSoundSettings({ shareStart: false }).shareStart).toBe(false);
    expect(SoundSettingsSchema.parse({ selfJoin: true, selfLeave: true, peerJoin: true, peerLeave: true, volume: 0.6 }).shareStart).toBeUndefined();
  });

  it("plays the share cue only for a share that starts while I am there, may be watched, and not in a row", () => {
    const ok = { now: 100_000, cuesFrom: 50_000, afkRoom: false, mayView: true, blocked: false, last: undefined as number | undefined };
    expect(shareCueDue(ok)).toBe(true);
    expect(shareCueDue({ ...ok, cuesFrom: 0 })).toBe(false); // not connected
    expect(shareCueDue({ ...ok, cuesFrom: 100_500 })).toBe(false); // just connected: that share was already there
    expect(shareCueDue({ ...ok, afkRoom: true })).toBe(false);
    expect(shareCueDue({ ...ok, mayView: false })).toBe(false);
    expect(shareCueDue({ ...ok, blocked: true })).toBe(false);
    expect(shareCueDue({ ...ok, last: 100_000 - SHARE_CUE_REST_MS + 1 })).toBe(false);
    expect(shareCueDue({ ...ok, last: 100_000 - SHARE_CUE_REST_MS })).toBe(true);
  });

  it("has a cue for messages that an account without the field leaves to the device", () => {
    expect(SOUND_CUES).toContain("message");
    expect(normalizeSoundSettings({ message: false }).message).toBe(false);
    expect(SoundSettingsSchema.parse({ selfJoin: true, selfLeave: true, peerJoin: true, peerLeave: true, volume: 0.6 }).message).toBeUndefined();
    expect(directorySoundSettingsPayload({ ...DEFAULT_SOUND_SETTINGS, message: false })).toBe("1111\n0.6"); // the signed line of older directories stays
  });

  it("lets the settings preview play a switched-off cue, but not while deafened", () => {
    const off = { ...DEFAULT_SOUND_SETTINGS, peerJoin: false };
    expect(shouldPlayCue("peerJoin", off, { deafened: false, force: true })).toBe(true);
    expect(shouldPlayCue("peerJoin", off, { deafened: true, force: true })).toBe(false);
  });
});
