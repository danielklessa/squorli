import { describe, expect, it } from "vitest";
import { MAX_PARTICLES, VISUAL_BARS, allDown, bandLevels, bandsOf, freshBars, particleAlpha, stepBars, stepParticles, type Particle } from "./radioVisual";

describe("radio equalizer", () => {
  it("spreads the bands from low to high without gaps, each with a bin", () => {
    const bands = bandsOf(256, 48000, 512);
    expect(bands).toHaveLength(VISUAL_BARS);
    for (const [i, b] of bands.entries()) {
      expect(b.to, `band ${i}`).toBeGreaterThan(b.from);
      if (i > 0) expect(b.from).toBe(bands[i - 1]!.to);
    }
    expect(bands[0]!.from).toBeGreaterThanOrEqual(1); // no DC bin
    expect(bands[VISUAL_BARS - 1]!.to).toBeLessThanOrEqual(256);
  });

  it("takes the loudest bin of a band", () => {
    expect(bandLevels([0, 51, 255, 0], [{ from: 0, to: 2 }, { from: 2, to: 4 }])).toEqual([0.2, 1]);
  });

  it("rises quickly, falls slowly", () => {
    let s = freshBars(1);
    s = stepBars(s, [1], 0.05);
    expect(s.bars[0]).toBeGreaterThan(0.5);
    let up = s;
    for (let i = 0; i < 10; i++) up = stepBars(up, [1], 0.05);
    expect(up.bars[0]).toBeCloseTo(1, 2);
    const down = stepBars(up, [0], 0.1);
    expect(down.bars[0]).toBeGreaterThan(0.85); // at most 0.09 in a tenth of a second
  });

  it("scales by the peak, but leaves near silence low", () => {
    let quiet = freshBars(2);
    for (let i = 0; i < 40; i++) quiet = stepBars(quiet, [0.6, 0.3], 0.05);
    expect(quiet.bars[0]).toBeCloseTo(1, 2); // the loudest band of a quiet station still uses the height
    let silent = freshBars(1);
    for (let i = 0; i < 40; i++) silent = stepBars(silent, [0.05], 0.05);
    expect(silent.bars[0]).toBeLessThan(0.1);
  });

  it("knows when every bar has come down", () => {
    let s = freshBars(3);
    expect(allDown(s)).toBe(true);
    for (let i = 0; i < 20; i++) s = stepBars(s, [1, 0.5, 0.2], 1 / 60);
    expect(allDown(s)).toBe(false);
    let frames = 0;
    while (!allDown(s) && frames < 600) { s = stepBars(s, [], 1 / 60); frames++; }
    expect(frames).toBeGreaterThan(30); // the bars fall at their own pace ...
    expect(frames).toBeLessThan(120); // ... within two seconds
  });

  it("caps, ages and removes particles", () => {
    const always = () => 0;
    let list: Particle[] = [];
    for (let i = 0; i < 50; i++) list = stepParticles(list, new Array(VISUAL_BARS).fill(1), 0.1, always);
    expect(list.length).toBe(MAX_PARTICLES);
    const old: Particle = { x: 0.5, y: 0.2, vx: 0, vy: 0.1, age: 2.95, life: 3, size: 1 };
    const high: Particle = { ...old, y: 1.048, age: 0 };
    const young: Particle = { ...old, age: 1 };
    const moved = stepParticles([old, high, young], [], 0.1, () => 0.99);
    expect(moved).toHaveLength(1); // life over, left the top
    expect(moved[0]!.age).toBeCloseTo(1.1);
    expect(moved[0]!.y).toBeCloseTo(0.21);
    expect(stepParticles([], new Array(VISUAL_BARS).fill(0), 0.1, always)).toEqual([]); // silent bars send nothing
  });

  it("fades particles in and out", () => {
    const p = { x: 0, y: 0, vx: 0, vy: 0, life: 10, size: 1 };
    expect(particleAlpha({ ...p, age: 0 })).toBe(0);
    expect(particleAlpha({ ...p, age: 1 })).toBeCloseTo(1);
    expect(particleAlpha({ ...p, age: 10 })).toBeCloseTo(0);
  });
});
