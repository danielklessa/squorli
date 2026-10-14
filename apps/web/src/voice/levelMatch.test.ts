import { describe, expect, it } from "vitest";
import { AutoGain, DESKTOP_BOOST_LIMITS, MIC_BOOST_TARGET } from "./micBoost";
import { DEFAULT_LEVEL_MATCH, LEVEL_SLIDER_MAX, LEVEL_SLIDER_MIN, REMOTE_LEVEL_MAX, REMOTE_LEVEL_MIN, levelToSlider, normalizeLevelMatch, playbackGain, remoteLevelLimits, sliderToLevel, targetOf } from "./levelMatch";

/** `seconds` of frames (50 ms each): speech at `speech` with short pauses at `noise`, like talking. */
function talk(g: AutoGain, seconds: number, speech: number, noise: number): number {
  let gain = g.gain;
  for (let i = 0; i < seconds * 20; i++) gain = g.update(i % 10 < 7 ? speech * (0.8 + 0.4 * ((i * 7) % 10) / 10) : noise);
  return gain;
}
const output = (speech: number, level = 1) => talk(new AutoGain(1, remoteLevelLimits(level)), 12, speech, speech / 30) * speech;

describe("levelling speakers", () => {
  it("brings a quiet and a loud speaker to the same level", () => {
    const quiet = output(0.03), loud = output(0.3);
    expect(quiet / loud).toBeGreaterThan(0.85);
    expect(quiet / loud).toBeLessThan(1.15);
    expect(loud).toBeGreaterThan(MIC_BOOST_TARGET * 0.7);
    expect(loud).toBeLessThan(MIC_BOOST_TARGET * 1.3);
  });
  it("the slider scales the common level", () => {
    expect(output(0.05, 1.5) / output(0.05, 1)).toBeCloseTo(1.5, 1);
    expect(output(0.05, 0.5) / output(0.05, 1)).toBeCloseTo(0.5, 1);
    expect(targetOf(9)).toBeCloseTo(MIC_BOOST_TARGET * 1.5, 9);
  });
  it("stays within its limits for a whisper and a shout", () => {
    expect(talk(new AutoGain(1, remoteLevelLimits(1)), 20, 0.004, 0.0003)).toBeLessThanOrEqual(REMOTE_LEVEL_MAX);
    expect(talk(new AutoGain(1, remoteLevelLimits(1)), 20, 1.5, 0.01)).toBeGreaterThanOrEqual(REMOTE_LEVEL_MIN);
  });
  it("a cough is no speech level", () => {
    const g = new AutoGain(1, remoteLevelLimits(1));
    for (let i = 0; i < 6; i++) g.update(0.6);
    expect(g.gain).toBe(1);
  });
  it("the microphone's automatic still only raises", () => {
    expect(talk(new AutoGain(1, DESKTOP_BOOST_LIMITS), 8, 0.4, 0.002)).toBe(1);
  });
  it("the per-person volume works on top: one speaker at 150 % ends 1.5x the other", () => {
    const a = output(0.03), b = output(0.3);
    const gainA = playbackGain(true, a / 0.03, 1.5), gainB = playbackGain(true, b / 0.3, 1);
    expect((0.03 * gainA) / (0.3 * gainB)).toBeGreaterThan(1.5 * 0.85);
    expect((0.03 * gainA) / (0.3 * gainB)).toBeLessThan(1.5 * 1.15);
    expect(playbackGain(false, 4, 0.5)).toBe(0.5);
  });
});

describe("the setting", () => {
  it("is off by default, also for settings stored before", () => {
    expect(DEFAULT_LEVEL_MATCH).toEqual({ on: false, level: 1 });
    expect(normalizeLevelMatch(undefined)).toEqual({ on: false, level: 1 });
    expect(normalizeLevelMatch({ on: "yes", level: 3 })).toEqual({ on: false, level: 1.5 });
    expect(normalizeLevelMatch({ on: true, level: 0.8 })).toEqual({ on: true, level: 0.8 });
  });
  it("the slider runs from 50 to 150 in whole percent", () => {
    expect([LEVEL_SLIDER_MIN, LEVEL_SLIDER_MAX]).toEqual([50, 150]);
    expect(sliderToLevel(120)).toBe(1.2);
    expect(sliderToLevel(10)).toBe(0.5);
    expect(levelToSlider(0.75)).toBe(75);
  });
});
