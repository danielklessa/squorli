import { describe, expect, it } from "vitest";
import { checkHotkey, controlLink, formatHotkey, hotkeyAccelerator, hotkeyFromKey, keyLabel, keyName, normalizeHotkeys, parseControlAction, parseControlLink, sameHotkeys } from "./hotkeys";

const names = { ctrl: "Strg", alt: "Alt", shift: "Umschalt", meta: "Win" };
const key = (code: string, mods: Partial<{ keyCode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
// A German keyboard (Windows virtual keys as Chromium reports them in keyCode): Ö on the US semicolon, Y and Z swapped.
const german: Record<string, string> = { Semicolon: "ö", Quote: "ä", BracketLeft: "ü", Minus: "ß", KeyZ: "y", KeyY: "z", Digit1: "1" };

describe("hotkeyFromKey", () => {
  it("takes the key with the modifiers held, and waits while only a modifier is down", () => {
    expect(hotkeyFromKey(key("KeyM", { ctrlKey: true, shiftKey: true }))).toEqual({ code: "KeyM", ctrl: true, alt: false, shift: true, meta: false });
    for (const code of ["ControlLeft", "ShiftRight", "AltLeft", "MetaRight", "AltGraph", "OSLeft"]) expect(hotkeyFromKey(key(code, { ctrlKey: true })), code).toBeNull();
    expect(hotkeyFromKey(key(""))).toBeNull();
    expect(hotkeyFromKey(key("Key M"))).toBeNull();
  });
  it("keeps the layout's virtual key of a letter, digit or punctuation key when asked (Windows)", () => {
    expect(hotkeyFromKey(key("Semicolon", { keyCode: 192, ctrlKey: true }), true)).toEqual({ code: "Semicolon", vk: 192, ctrl: true, alt: false, shift: false, meta: false });
    expect(hotkeyFromKey(key("Semicolon", { keyCode: 192, ctrlKey: true }))).toEqual({ code: "Semicolon", ctrl: true, alt: false, shift: false, meta: false });
    expect(hotkeyFromKey(key("F13", { keyCode: 124 }), true)).toEqual({ code: "F13", ctrl: false, alt: false, shift: false, meta: false });
  });
});

describe("hotkeyAccelerator", () => {
  it("names the keys as Electron does", () => {
    expect(hotkeyAccelerator({ code: "KeyM", ctrl: true, alt: false, shift: true, meta: false })).toBe("Control+Shift+M");
    expect(hotkeyAccelerator({ code: "Digit1", ctrl: false, alt: true, shift: false, meta: false })).toBe("Alt+1");
    expect(hotkeyAccelerator({ code: "F13", ctrl: false, alt: false, shift: false, meta: false })).toBe("F13");
    expect(hotkeyAccelerator({ code: "Numpad5", ctrl: false, alt: false, shift: false, meta: false })).toBe("num5");
    expect(hotkeyAccelerator({ code: "NumpadAdd", ctrl: false, alt: false, shift: false, meta: false })).toBe("numadd");
    expect(hotkeyAccelerator({ code: "AudioVolumeMute", ctrl: false, alt: false, shift: false, meta: false })).toBe("VolumeMute");
    expect(hotkeyAccelerator({ code: "ArrowUp", ctrl: true, alt: false, shift: false, meta: true })).toBe("Control+Super+Up");
    expect(hotkeyAccelerator({ code: "Space", ctrl: true, alt: false, shift: false, meta: false })).toBe("Control+Space");
    expect(hotkeyAccelerator({ code: "Backquote", ctrl: false, alt: true, shift: false, meta: false })).toBe("Alt+`");
  });
  it("names a layout key by its virtual key, which is what Windows registers (checked with Electron on a German keyboard)", () => {
    expect(hotkeyAccelerator({ code: "Semicolon", vk: 192, ctrl: true, alt: false, shift: false, meta: false })).toBe("Control+`");
    expect(hotkeyAccelerator({ code: "KeyZ", vk: 0x59, ctrl: true, alt: false, shift: false, meta: false })).toBe("Control+Y");
    expect(hotkeyAccelerator({ code: "Minus", vk: 219, ctrl: true, alt: false, shift: false, meta: false })).toBe("Control+[");
    expect(hotkeyAccelerator({ code: "Digit1", vk: 0x31, ctrl: false, alt: true, shift: false, meta: false })).toBe("Alt+1");
    expect(checkHotkey({ code: "IntlBackslash", vk: 226, ctrl: true, alt: false, shift: false, meta: false })).toBe("unknownKey");
  });
  it("refuses a key nobody could type without, and keys it cannot name", () => {
    expect(checkHotkey({ code: "KeyM", ctrl: false, alt: false, shift: false, meta: false })).toBe("needsModifier");
    expect(checkHotkey({ code: "Space", ctrl: false, alt: false, shift: false, meta: false })).toBe("needsModifier");
    expect(checkHotkey({ code: "F24", ctrl: false, alt: false, shift: false, meta: false })).toBe("ok");
    expect(checkHotkey({ code: "IntlBackslash", ctrl: true, alt: false, shift: false, meta: false })).toBe("unknownKey");
    expect(checkHotkey({ code: "Pause", ctrl: true, alt: false, shift: false, meta: false })).toBe("unknownKey");
    expect(hotkeyAccelerator({ code: "KeyM", ctrl: false, alt: false, shift: false, meta: false })).toBeNull();
  });
});

describe("normalizeHotkeys", () => {
  it("keeps what is well-formed and drops the rest", () => {
    expect(normalizeHotkeys(undefined)).toEqual({ micToggle: null, deafenToggle: null });
    expect(normalizeHotkeys({ micToggle: { code: "KeyM", ctrl: true }, deafenToggle: { code: "Control Left", ctrl: "yes" } })).toEqual({ micToggle: { code: "KeyM", ctrl: true, alt: false, shift: false, meta: false }, deafenToggle: null });
    expect(normalizeHotkeys({ micToggle: { code: "ShiftLeft", ctrl: true } })).toEqual({ micToggle: null, deafenToggle: null });
    expect(sameHotkeys(normalizeHotkeys({ micToggle: { code: "F13" } }), { micToggle: { code: "F13", ctrl: false, alt: false, shift: false, meta: false }, deafenToggle: null })).toBe(true);
    expect(normalizeHotkeys({ micToggle: { code: "Semicolon", vk: 192, ctrl: true }, deafenToggle: { code: "F13", vk: 124 } })).toEqual({ micToggle: { code: "Semicolon", vk: 192, ctrl: true, alt: false, shift: false, meta: false }, deafenToggle: { code: "F13", ctrl: false, alt: false, shift: false, meta: false } });
    expect(normalizeHotkeys({ micToggle: { code: "KeyM", vk: 999, ctrl: true } }).micToggle).toEqual({ code: "KeyM", ctrl: true, alt: false, shift: false, meta: false });
    expect(sameHotkeys(normalizeHotkeys({ micToggle: { code: "KeyZ", vk: 0x59, ctrl: true } }), normalizeHotkeys({ micToggle: { code: "KeyZ", vk: 0x5A, ctrl: true } }))).toBe(false);
  });
});

describe("formatHotkey and keyLabel", () => {
  it("shows the modifiers in the caller's words and the key by its code", () => {
    expect(formatHotkey({ code: "KeyM", ctrl: true, alt: false, shift: true, meta: false }, names)).toBe("Strg+Umschalt+M");
    expect(formatHotkey({ code: "Numpad5", ctrl: false, alt: true, shift: false, meta: true }, names)).toBe("Alt+Win+Num 5");
    expect(keyLabel("F13")).toBe("F13");
    expect(keyLabel("NumpadAdd")).toBe("Num +");
    expect(keyLabel("ArrowLeft")).toBe("Left");
    expect(keyLabel("PageDown")).toBe("Page Down");
    expect(keyLabel("AudioVolumeMute")).toBe("Volume Mute");
  });
  it("shows a layout key as the user's keyboard writes it", () => {
    const layout = (code: string) => german[code];
    expect(formatHotkey({ code: "Semicolon", vk: 192, ctrl: true, alt: false, shift: false, meta: false }, names, layout)).toBe("Strg+Ö");
    expect(keyName("KeyZ", layout)).toBe("Y");
    expect(keyName("Minus", layout)).toBe("ß");
    expect(keyName("Semicolon")).toBe("Semicolon");
    expect(keyName("Space", () => " ")).toBe("Space");
    expect(keyName("F13", layout)).toBe("F13");
  });
});

describe("parseControlAction", () => {
  it("reads control links, bare actions and nothing else", () => {
    expect(parseControlAction("squorli://control/mic-toggle")).toBe("mic-toggle");
    expect(parseControlAction("SQUORLI://control/Deafen-On/")).toBe("deafen-on");
    expect(parseControlAction("squorli:control/mic-off")).toBe("mic-off");
    expect(parseControlAction("mic-on")).toBe("mic-on");
    expect(parseControlAction(controlLink("deafen-toggle"))).toBe("deafen-toggle");
    for (const raw of ["squorli://control/quit", "squorli://server/example.org", "squorli://control/mic-toggle?x=1", "", "control/mic-toggle", "x".repeat(200)]) expect(parseControlAction(raw), raw).toBeNull();
  });
});

describe("control links with the key", () => {
  it("carry the key for every action (since 5 October 2026 also mic-off and deafen-on), and none without one", () => {
    expect(controlLink("mic-on", "abc_DEF-1")).toBe("squorli://control/mic-on?k=abc_DEF-1");
    expect(controlLink("mic-off", "abc")).toBe("squorli://control/mic-off?k=abc");
    expect(controlLink("deafen-on", "abc")).toBe("squorli://control/deafen-on?k=abc");
    expect(controlLink("deafen-toggle", null)).toBe("squorli://control/deafen-toggle");
  });
  it("are read back with their key", () => {
    expect(parseControlLink("squorli://control/mic-toggle?k=abc_DEF-1")).toEqual({ action: "mic-toggle", key: "abc_DEF-1" });
    expect(parseControlLink("squorli://control/mic-off/")).toEqual({ action: "mic-off", key: null });
    for (const raw of ["mic-on", "squorli://control/mic-on?k=", "squorli://control/mic-on?x=1", "squorli://control/mic-on?k=a&b=1", "squorli://control/quit?k=a"]) expect(parseControlLink(raw), raw).toBeNull();
  });
});
