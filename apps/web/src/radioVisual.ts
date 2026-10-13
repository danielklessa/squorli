/**
 * The radio equalizer's arithmetic (RadioVisualizer.tsx draws it; docs/features/radio.md, 14 October 2026): which
 * frequency bins make a bar, how a bar follows the sound (quick up, slow down, scaled by a peak that slowly forgets),
 * and the particles that rise from the louder bars. Pure: no DOM, no clock of its own; the drawing passes dt in seconds.
 */

/** Bars across the stage, low to high. */
export const VISUAL_BARS = 40;
/** At most this many particles at once. */
export const MAX_PARTICLES = 70;
const LOW_HZ = 40, HIGH_HZ = 14000;

export type Band = { from: number; to: number };

/** `count` bands spaced logarithmically from 40 Hz to 14 kHz as bin ranges [from, to) of an analyser; each holds a bin at least. */
export function bandsOf(binCount: number, sampleRate: number, fftSize: number, count = VISUAL_BARS): Band[] {
  const binOf = (hz: number) => Math.round(hz * fftSize / sampleRate);
  const last = Math.max(1, binCount);
  const bands: Band[] = [];
  let prev = Math.min(last - 1, Math.max(1, binOf(LOW_HZ)));
  for (let i = 1; i <= count; i++) {
    const edge = Math.min(last, binOf(LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / count)));
    const from = Math.min(prev, last - 1);
    const to = Math.max(from + 1, edge);
    bands.push({ from, to });
    prev = to;
  }
  return bands;
}

/** One value per band (0..1) from the analyser's byte spectrum: the loudest bin of the band. */
export function bandLevels(spectrum: ArrayLike<number>, bands: Band[]): number[] {
  return bands.map(({ from, to }) => {
    let max = 0;
    for (let i = from; i < to && i < spectrum.length; i++) max = Math.max(max, spectrum[i] ?? 0);
    return max / 255;
  });
}

export type BarState = { bars: number[]; peak: number };

export function freshBars(count = VISUAL_BARS): BarState {
  return { bars: new Array<number>(count).fill(0), peak: PEAK_FLOOR };
}

/** The scale never goes below this: near silence must stay low instead of being blown up to full height. */
const PEAK_FLOOR = 0.35;
const PEAK_FORGET_PER_S = 0.25;
const RISE_PER_S = 16;
const FALL_PER_S = 0.9;

/**
 * The next frame's bars: each rises quickly towards its level and falls slowly (at most FALL_PER_S of the height per
 * second), the levels scaled by a peak that follows the loudest band at once and forgets slowly, so a quiet and a loud
 * station both use the height. `calm` (reduced motion) halves the speeds.
 */
export function stepBars(prev: BarState, levels: number[], dt: number, calm = false): BarState {
  const t = Math.max(0, Math.min(dt, 0.1));
  const loudest = levels.reduce((m, v) => Math.max(m, v), 0);
  const peak = Math.max(PEAK_FLOOR, loudest, prev.peak - PEAK_FORGET_PER_S * t);
  const speed = calm ? 0.5 : 1;
  const bars = prev.bars.map((bar, i) => {
    const target = Math.min(1, ((levels[i] ?? 0) / peak) ** 1.4);
    if (target > bar) return bar + (target - bar) * Math.min(1, RISE_PER_S * speed * t);
    return Math.max(target, bar - FALL_PER_S * speed * t);
  });
  return { bars, peak };
}

/** Every bar has come down: what turning the equalizer off waits for before it fades out. */
export function allDown(state: BarState): boolean {
  return state.bars.every((b) => b < 0.01);
}

/** x, y as fractions of the canvas (y from the bottom), speeds per second, `age`/`life` in seconds, `size` in CSS pixels. */
export type Particle = { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number };

/** How often a full-height bar sends a particle up, per second. */
const SPAWN_PER_S = 0.9;

/**
 * Ages and moves the particles (gone when their life is over or they leave the top) and lets new ones rise from the bars'
 * tops, more often the higher the bar, never more than MAX_PARTICLES. `rand` returns 0..1 (Math.random, or a fixed
 * sequence in tests).
 */
export function stepParticles(list: Particle[], bars: number[], dt: number, rand: () => number): Particle[] {
  const t = Math.max(0, Math.min(dt, 0.1));
  const next: Particle[] = [];
  for (const p of list) {
    const age = p.age + t;
    const y = p.y + p.vy * t;
    if (age >= p.life || y > 1.05) continue;
    next.push({ ...p, age, x: p.x + p.vx * t, y });
  }
  const n = bars.length;
  for (let i = 0; i < n && next.length < MAX_PARTICLES; i++) {
    const bar = bars[i] ?? 0;
    if (rand() >= bar * bar * SPAWN_PER_S * t) continue;
    next.push({ x: (i + 0.2 + rand() * 0.6) / n, y: bar * 0.95, vx: (rand() - 0.5) * 0.02, vy: 0.06 + rand() * 0.1, age: 0, life: 2.5 + rand() * 2.5, size: 1 + rand() * 1.6 });
  }
  return next;
}

/** A particle's opacity factor: fades in over its first tenth and out over the rest. */
export function particleAlpha(p: Particle): number {
  const f = p.age / p.life;
  return f < 0.1 ? f / 0.1 : Math.max(0, 1 - (f - 0.1) / 0.9);
}
