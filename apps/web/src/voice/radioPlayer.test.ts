import { describe, expect, it } from "vitest";
import { RADIO_DEFAULT_VOLUME, hasOwnVolume, parseRadioSettings, parseRadioVisual, parseRadioVisualFront, shouldLoad, storedRadioSettings } from "./radioPlayer";

describe("radio settings", () => {
  it("falls back to the defaults for missing, broken or foreign data", () => {
    const fallback = { volume: RADIO_DEFAULT_VOLUME, muted: false };
    expect(parseRadioSettings(null)).toEqual(fallback);
    expect(parseRadioSettings("{")).toEqual(fallback);
    expect(parseRadioSettings("null")).toEqual(fallback);
    expect(parseRadioSettings('{"volume":"laut","muted":"ja"}')).toEqual(fallback);
  });

  it("keeps stored values and clamps the volume", () => {
    expect(parseRadioSettings('{"volume":0.8,"muted":true}')).toEqual({ volume: 0.8, muted: true });
    expect(parseRadioSettings('{"volume":0}')).toEqual({ volume: 0, muted: false });
    expect(parseRadioSettings('{"volume":7}').volume).toBe(1);
    expect(parseRadioSettings('{"volume":-1}').volume).toBe(0);
  });

  it("starts at 5 % and stores a volume only once the user has set one", () => {
    expect(RADIO_DEFAULT_VOLUME).toBe(0.05);
    // Turning the radio off and on again without touching the slider must not freeze the default.
    const afterMute = JSON.stringify(storedRadioSettings({ volume: RADIO_DEFAULT_VOLUME, muted: true }, false));
    expect(afterMute).toBe('{"muted":true}');
    expect(hasOwnVolume(afterMute)).toBe(false);
    expect(parseRadioSettings(afterMute)).toEqual({ volume: RADIO_DEFAULT_VOLUME, muted: true });
    const afterSlider = JSON.stringify(storedRadioSettings({ volume: 0.05, muted: false }, true));
    expect(hasOwnVolume(afterSlider)).toBe(true); // also when the chosen value equals the default
    for (const raw of [null, "{", "null", '{"volume":"laut"}']) expect(hasOwnVolume(raw), String(raw)).toBe(false);
  });

  it("stores the equalizer only once the user has chosen", () => {
    expect(parseRadioVisual(null)).toBeNull();
    expect(parseRadioVisual('{"muted":false}')).toBeNull();
    expect(parseRadioVisual('{"visual":"ja"}')).toBeNull();
    expect(parseRadioVisual("{")).toBeNull();
    expect(parseRadioVisual('{"visual":false}')).toBe(false);
    expect(JSON.stringify(storedRadioSettings({ volume: 0.05, muted: false }, false))).toBe('{"muted":false}');
    const stored = JSON.stringify(storedRadioSettings({ volume: 0.4, muted: false }, true, false));
    expect(stored).toBe('{"volume":0.4,"muted":false,"visual":false}');
    expect(parseRadioVisual(stored)).toBe(false);
    expect(parseRadioSettings(stored)).toEqual({ volume: 0.4, muted: false });
  });

  it("loads the stream only with an address and while the user has not turned the radio off", () => {
    expect(shouldLoad("https://stream.example.org/live", { volume: 0.15, muted: false })).toBe(true);
    expect(shouldLoad("https://stream.example.org/live", { volume: 0.3, muted: true })).toBe(false);
    expect(shouldLoad(null, { volume: 0.3, muted: false })).toBe(false);
    // Volume 0 is not "off": the slider must bring the sound back without reconnecting.
    expect(shouldLoad("https://stream.example.org/live", { volume: 0, muted: false })).toBe(true);
  });
});

describe("the equalizer over the tiles", () => {
  it("is behind them unless the device chose otherwise, and only that choice is stored", () => {
    expect(parseRadioVisualFront(null)).toBe(false);
    expect(parseRadioVisualFront('{"visualFront":"ja"}')).toBe(false);
    expect(parseRadioVisualFront("{")).toBe(false);
    expect(parseRadioVisualFront('{"visual":true,"visualFront":true}')).toBe(true);
    expect(JSON.stringify(storedRadioSettings({ volume: 0.05, muted: false }, false, true))).toBe('{"muted":false,"visual":true}');
    expect(JSON.stringify(storedRadioSettings({ volume: 0.05, muted: false }, false, true, true))).toBe('{"muted":false,"visual":true,"visualFront":true}');
  });
});
