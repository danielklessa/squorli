/**
 * A length of time as a person types it (a number and a unit) and as a plugin's `duration` field carries it (whole
 * seconds). Pure, tested; DurationInput.tsx is the input, PluginTable.tsx shows `duration` columns with `formatDuration`.
 * docs/features/plugins.md
 */

export const DURATION_UNITS = ["minutes", "hours", "days", "weeks"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
/** What a formatter may name: the input's units and, for a value below a minute, seconds. */
export type DurationLabelUnit = DurationUnit | "seconds";

export const UNIT_SECONDS: Record<DurationLabelUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400, weeks: 604_800 };

/** What the server takes at most (ten years; its own cap, a field's `max` may be lower). */
export const DURATION_MAX_SECONDS = 10 * 365 * 86_400;

/** "1,5" and "1.5" are the same number; anything else that is no plain positive number is null. */
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Whole seconds of an amount in a unit; null for nothing, zero, a negative or an absurd value. */
export function toSeconds(amount: number | null, unit: DurationUnit): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  const seconds = Math.round(amount * UNIT_SECONDS[unit]);
  return seconds >= 1 && seconds <= DURATION_MAX_SECONDS ? seconds : null;
}

const trimmed = (n: number) => Math.round(n * 100) / 100;

/**
 * Seconds as the input shows them: the largest unit that divides them evenly ("1 Woche", not "7 Tage"; "30 Tage", not
 * "4,29 Wochen"), else minutes with decimals (90 s = 1.5 minutes).
 */
export function fromSeconds(seconds: number): { amount: number; unit: DurationUnit } {
  for (let i = DURATION_UNITS.length - 1; i >= 0; i--) {
    const unit = DURATION_UNITS[i]!;
    if (seconds >= UNIT_SECONDS[unit] && seconds % UNIT_SECONDS[unit] === 0) return { amount: seconds / UNIT_SECONDS[unit], unit };
  }
  return { amount: trimmed(seconds / 60), unit: "minutes" };
}

/** The same choice for a text ("3 Tage"); below a minute it says seconds, between units the largest one that fits with decimals. */
export function durationParts(seconds: number): { amount: number; unit: DurationLabelUnit } {
  if (!Number.isFinite(seconds) || seconds < 0) return { amount: 0, unit: "seconds" };
  if (seconds < 60) return { amount: Math.round(seconds), unit: "seconds" };
  const even = fromSeconds(seconds);
  if (seconds % UNIT_SECONDS[even.unit] === 0) return even;
  const unit = [...DURATION_UNITS].reverse().find((u) => seconds >= UNIT_SECONDS[u]) ?? "minutes";
  return { amount: trimmed(seconds / UNIT_SECONDS[unit]), unit };
}

/** `label(unit, amount)` supplies the words (the i18n catalog's, DurationInput.tsx `durationLabel`). */
export function formatDuration(seconds: number, label: (unit: DurationLabelUnit, amount: number) => string): string {
  const { amount, unit } = durationParts(seconds);
  return label(unit, amount);
}

/** A field's range in seconds, inside what the server takes at all. */
export function durationRange(min: number | undefined, max: number | undefined): { min: number; max: number } {
  return { min: Math.max(1, min ?? 1), max: Math.min(DURATION_MAX_SECONDS, max ?? DURATION_MAX_SECONDS) };
}

/** The presets a field may offer: whole, inside its range, each once, shortest first. */
export function usablePresets(presets: readonly number[] | undefined, min: number | undefined, max: number | undefined): number[] {
  const range = durationRange(min, max);
  return [...new Set((presets ?? []).filter((p) => Number.isInteger(p) && p >= range.min && p <= range.max))].sort((a, b) => a - b);
}
