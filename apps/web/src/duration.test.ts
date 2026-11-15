import { describe, expect, it } from "vitest";
import { DURATION_MAX_SECONDS, durationParts, durationRange, formatDuration, fromSeconds, parseAmount, toSeconds, usablePresets } from "./duration";

describe("duration", () => {
  it("reads an amount with a point or a comma and nothing else", () => {
    expect(parseAmount("7")).toBe(7);
    expect(parseAmount(" 1,5 ")).toBe(1.5);
    expect(parseAmount("1.5")).toBe(1.5);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-3")).toBeNull();
    expect(parseAmount("1e3")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
  it("turns a number and a unit into whole seconds", () => {
    expect(toSeconds(1, "minutes")).toBe(60);
    expect(toSeconds(2, "hours")).toBe(7200);
    expect(toSeconds(7, "days")).toBe(604_800);
    expect(toSeconds(1, "weeks")).toBe(604_800);
    expect(toSeconds(1.5, "minutes")).toBe(90);
    expect(toSeconds(0.001, "minutes")).toBeNull();
    expect(toSeconds(null, "days")).toBeNull();
    expect(toSeconds(0, "days")).toBeNull();
    expect(toSeconds(Number.NaN, "days")).toBeNull();
    expect(toSeconds(1000, "weeks")).toBeNull();
    expect(toSeconds(DURATION_MAX_SECONDS / 86_400, "days")).toBe(DURATION_MAX_SECONDS);
  });
  it("shows seconds in the largest unit that divides them evenly", () => {
    expect(fromSeconds(3600)).toEqual({ amount: 1, unit: "hours" });
    expect(fromSeconds(86_400)).toEqual({ amount: 1, unit: "days" });
    expect(fromSeconds(604_800)).toEqual({ amount: 1, unit: "weeks" });
    expect(fromSeconds(2_592_000)).toEqual({ amount: 30, unit: "days" });
    expect(fromSeconds(5400)).toEqual({ amount: 90, unit: "minutes" });
    expect(fromSeconds(90)).toEqual({ amount: 1.5, unit: "minutes" });
  });
  it("goes there and back for every even value", () => {
    for (const s of [60, 120, 3600, 7200, 86_400, 172_800, 604_800, 1_209_600, 2_592_000, 5400]) {
      const { amount, unit } = fromSeconds(s);
      expect(toSeconds(amount, unit)).toBe(s);
    }
  });
  it("names a value for a text, seconds below a minute and decimals between units", () => {
    expect(durationParts(604_800)).toEqual({ amount: 1, unit: "weeks" });
    expect(durationParts(45)).toEqual({ amount: 45, unit: "seconds" });
    expect(durationParts(90)).toEqual({ amount: 1.5, unit: "minutes" });
    expect(durationParts(129_600)).toEqual({ amount: 36, unit: "hours" });
    expect(durationParts(100_000)).toEqual({ amount: 1.16, unit: "days" });
    expect(durationParts(-1)).toEqual({ amount: 0, unit: "seconds" });
    expect(formatDuration(259_200, (unit, n) => `${n} ${unit}`)).toBe("3 days");
  });
  it("keeps a field's range inside what the server takes, and offers only presets inside it", () => {
    expect(durationRange(undefined, undefined)).toEqual({ min: 1, max: DURATION_MAX_SECONDS });
    expect(durationRange(60, 3600)).toEqual({ min: 60, max: 3600 });
    expect(durationRange(0, DURATION_MAX_SECONDS * 2)).toEqual({ min: 1, max: DURATION_MAX_SECONDS });
    expect(usablePresets([86_400, 3600, 30, 3600, 1.5, 604_800], 60, 86_400)).toEqual([3600, 86_400]);
    expect(usablePresets(undefined, 60, undefined)).toEqual([]);
  });
});
