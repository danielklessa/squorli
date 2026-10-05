import type { ControlAction, HotkeyAction, HotkeyBinding, HotkeyBindings } from "./bridge";

/**
 * Global shortcuts of the desktop app and the commands from outside (docs/features/hotkeys.md): the rules both sides share.
 * DOM-free: the Electron main process bundles this file too (package export `./platform/hotkeys`). The client captures a
 * binding from a key event and shows it; the shell turns it into Electron's accelerator and registers it.
 */

export const HOTKEY_ACTIONS: readonly HotkeyAction[] = ["micToggle", "deafenToggle"];
export const CONTROL_ACTIONS: readonly ControlAction[] = ["mic-toggle", "mic-on", "mic-off", "deafen-toggle", "deafen-on", "deafen-off"];
export const NO_HOTKEYS: HotkeyBindings = { micToggle: null, deafenToggle: null };

const CODE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** A stored binding made safe: the key must look like a `KeyboardEvent.code`, the modifiers are booleans; anything else = none. */
export function normalizeHotkey(value: unknown): HotkeyBinding | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "string" || !CODE.test(v.code) || isModifierCode(v.code)) return null;
  const binding: HotkeyBinding = { code: v.code, ctrl: v.ctrl === true, alt: v.alt === true, shift: v.shift === true, meta: v.meta === true };
  if (typeof v.vk === "number" && Number.isInteger(v.vk) && v.vk > 0 && v.vk < 255 && LAYOUT_CODE.test(v.code)) binding.vk = v.vk;
  return binding;
}

export function normalizeHotkeys(value: unknown): HotkeyBindings {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { micToggle: normalizeHotkey(v.micToggle), deafenToggle: normalizeHotkey(v.deafenToggle) };
}

export const sameHotkey = (a: HotkeyBinding | null, b: HotkeyBinding | null): boolean =>
  a === b || (!!a && !!b && a.code === b.code && a.vk === b.vk && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta);

export const sameHotkeys = (a: HotkeyBindings, b: HotkeyBindings): boolean => HOTKEY_ACTIONS.every((action) => sameHotkey(a[action], b[action]));

/** A modifier key by itself (`ControlLeft`, `ShiftRight`, ...): never a binding's key, the capture waits for the next key. */
export const isModifierCode = (code: string): boolean => /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) || code === "AltGraph";

/** The keys whose meaning depends on the keyboard layout: letters, digits and the punctuation keys (German Ö sits where US has `;`). */
const LAYOUT_CODE = /^(Key[A-Z]|Digit[0-9]|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Backslash|IntlBackslash|Comma|Period|Slash)$/;

/**
 * The binding a key event describes; null while only a modifier is down. `withVk` (Windows): a layout key also keeps the
 * virtual key the layout gave it (`keyCode`), because Windows registers a shortcut by virtual key, not by position.
 */
export function hotkeyFromKey(e: { code: string; keyCode?: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }, withVk = false): HotkeyBinding | null {
  if (!CODE.test(e.code) || isModifierCode(e.code)) return null;
  const binding: HotkeyBinding = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
  if (withVk && LAYOUT_CODE.test(e.code) && typeof e.keyCode === "number" && e.keyCode > 0 && e.keyCode < 255) binding.vk = e.keyCode;
  return binding;
}

const NAMED: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Escape: "Escape",
  Enter: "Return", NumpadEnter: "Return", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  NumpadDecimal: "numdec", NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult", NumpadDivide: "numdiv",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\", Comma: ",", Period: ".", Slash: "/",
  CapsLock: "Capslock", NumLock: "Numlock", ScrollLock: "Scrolllock", PrintScreen: "PrintScreen",
  AudioVolumeUp: "VolumeUp", AudioVolumeDown: "VolumeDown", AudioVolumeMute: "VolumeMute", MediaPlayPause: "MediaPlayPause", MediaTrackNext: "MediaNextTrack", MediaTrackPrevious: "MediaPreviousTrack", MediaStop: "MediaStop",
};

/** The key's name in Electron's accelerator; null = a key an accelerator cannot name. */
export function acceleratorKey(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1]!;
  m = /^Digit([0-9])$/.exec(code); if (m) return m[1]!;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code); if (m) return `F${m[1]}`;
  m = /^Numpad([0-9])$/.exec(code); if (m) return `num${m[1]}`;
  return NAMED[code] ?? null;
}

/** Windows virtual keys of the layout keys -> the accelerator character Electron turns back into that virtual key (`;` = VK_OEM_1 ...). */
const VK_KEYS: Record<number, string> = { 186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/", 192: "`", 219: "[", 220: "\\", 221: "]", 222: "'" };
export function vkAcceleratorKey(vk: number): string | null {
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)) return String.fromCharCode(vk);
  return VK_KEYS[vk] ?? null;
}

/** The accelerator key of a binding: by the virtual key where the capture recorded one (Windows), else by the key's position. */
const bindingKey = (binding: HotkeyBinding): string | null => binding.vk !== undefined ? vkAcceleratorKey(binding.vk) : acceleratorKey(binding.code);

/**
 * A key without a modifier is left to the other programs, unless nobody types with it: the function keys (F13 to F24 are
 * what a Stream Deck or G Hub sends), the number pad and the media keys.
 */
export const bareKeyAllowed = (code: string): boolean => /^(F([1-9]|1[0-9]|2[0-4])|Numpad[A-Za-z0-9]+|AudioVolume(Up|Down|Mute)|Media(PlayPause|TrackNext|TrackPrevious|Stop))$/.test(code);

export type HotkeyCheck = "ok" | "needsModifier" | "unknownKey";
export function checkHotkey(binding: HotkeyBinding): HotkeyCheck {
  if (bindingKey(binding) === null) return "unknownKey";
  if (!(binding.ctrl || binding.alt || binding.shift || binding.meta) && !bareKeyAllowed(binding.code)) return "needsModifier";
  return "ok";
}

/** Electron's accelerator for a binding (`Control+Shift+M`, `F13`, `Alt+num5`); null when the binding fails the check. */
export function hotkeyAccelerator(binding: HotkeyBinding): string | null {
  if (checkHotkey(binding) !== "ok") return null;
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Control");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Super");
  parts.push(bindingKey(binding)!);
  return parts.join("+");
}

/** What the keyboard layout writes with a key (`KeyboardEvent.code` -> character, `navigator.keyboard.getLayoutMap()`); undefined = not known. */
export type KeyLayout = (code: string) => string | undefined;

/** A key's label in the user's layout (`Ö` for `Semicolon` on a German keyboard), else from its code. */
export function keyName(code: string, layout?: KeyLayout | null): string {
  const written = LAYOUT_CODE.test(code) ? layout?.(code)?.trim() : undefined;
  if (written && [...written].length === 1) { const upper = written.toUpperCase(); return [...upper].length === 1 ? upper : written; }
  return keyLabel(code);
}

/** A key's short label from its code alone: `M`, `F13`, `Num 5`, `Space`. */
export function keyLabel(code: string): string {
  let m = /^(Key|Digit)(.+)$/.exec(code); if (m) return m[2]!;
  m = /^Numpad(.+)$/.exec(code);
  if (m) return `Num ${({ Decimal: ".", Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Enter: "Enter" } as Record<string, string>)[m[1]!] ?? m[1]}`;
  m = /^Arrow(.+)$/.exec(code); if (m) return m[1]!;
  m = /^AudioVolume(.+)$/.exec(code); if (m) return `Volume ${m[1]}`;
  return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export type ModifierNames = { ctrl: string; alt: string; shift: string; meta: string };
export function formatHotkey(binding: HotkeyBinding, names: ModifierNames, layout?: KeyLayout | null): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push(names.ctrl);
  if (binding.alt) parts.push(names.alt);
  if (binding.shift) parts.push(names.shift);
  if (binding.meta) parts.push(names.meta);
  parts.push(keyName(binding.code, layout));
  return parts.join("+");
}

export const CONTROL_SCHEME_PREFIX = "squorli://control/";
/**
 * Every control link carries the installation's key (`?k=`, made by the desktop app once per installation): any web page
 * can open a `squorli://` link (security review, 25 September 2026), and since 5 October 2026 (security audit L-8, the
 * user's decision) that holds for `mic-off` and `deafen-on` as well, which were keyless until then because they only close
 * things; a page could still have run them in a loop. The command line (`--control=`) needs none. A link without a key is
 * a link from before: it has to be copied again from the tab.
 */
export const controlLink = (action: ControlAction, key: string | null = null): string =>
  `${CONTROL_SCHEME_PREFIX}${action}${key ? `?k=${key}` : ""}`;

/** A control link (`squorli://control/<action>`, optionally `?k=<key>`): its action and key; null for anything else. */
export function parseControlLink(raw: string): { action: ControlAction; key: string | null } | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const m = /^squorli:(?:\/\/)?control\/([a-z-]+)\/?(?:\?k=([A-Za-z0-9_-]{1,64}))?$/i.exec(raw.trim());
  const action = m ? parseControlAction(m[1]!) : null;
  return action ? { action, key: m![2] ?? null } : null;
}

/** The action a control link (`squorli://control/<action>`, also without the slashes) or a bare action name means; null for anything else. */
export function parseControlAction(raw: string): ControlAction | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const m = /^(?:squorli:(?:\/\/)?control\/)?([a-z-]+)\/?$/i.exec(raw.trim());
  if (!m) return null;
  const action = m[1]!.toLowerCase();
  return (CONTROL_ACTIONS as readonly string[]).includes(action) ? action as ControlAction : null;
}
