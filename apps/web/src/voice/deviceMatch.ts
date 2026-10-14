/**
 * The chosen devices found again by their name (user's report, 14 October 2026: "nach jedem Update steht das
 * Ausgabegerät wieder auf Standard").
 *
 * A device is stored by the id the browser hands out. That id stays the same across restarts and app updates (checked with
 * Electron 43.1.1, 44.5.1 and 44.7.0 on one profile), but Windows gives a device a new endpoint when it adds it again (a
 * driver or Windows update, another USB port), and with it the browser's id changes; the label often gains a number
 * ("Lautsprecher (2- RODECaster Duo Chat)"). A stored id that is no longer listed then meant the system default, silently.
 * So the label is stored next to the id, and a missing id is replaced by the one device of the same kind with that label.
 *
 * Pure (tested); App.tsx runs `healDevices` at start, on `devicechange` and when the voice status changes, the settings dialog
 * and the camera picker store with `chooseDevice`.
 */
import type { VoiceSettings } from "./settings";

export type DeviceSlot = "input" | "output" | "screenOutput" | "radioOutput" | "camera";
export const DEVICE_SLOTS: readonly DeviceSlot[] = ["input", "output", "screenOutput", "radioOutput", "camera"];
export type DeviceLabels = Partial<Record<DeviceSlot, string>>;

type IdField = "inputDeviceId" | "outputDeviceId" | "screenOutputDeviceId" | "radioOutputDeviceId" | "cameraDeviceId";
const FIELD: Record<DeviceSlot, IdField> = {
  input: "inputDeviceId", output: "outputDeviceId", screenOutput: "screenOutputDeviceId", radioOutput: "radioOutputDeviceId", camera: "cameraDeviceId",
};
type DeviceLike = Pick<MediaDeviceInfo, "deviceId" | "label">;
export type DeviceLists = { inputs: readonly DeviceLike[]; outputs: readonly DeviceLike[]; cameras: readonly DeviceLike[] };
const listOf = (lists: DeviceLists, slot: DeviceSlot): readonly DeviceLike[] =>
  slot === "input" ? lists.inputs : slot === "camera" ? lists.cameras : lists.outputs;

/** Chromium's stand-ins for the system's choice ("Standard - X", "Kommunikation - X"): always listed, never matched by name. */
const PSEUDO = new Set(["default", "communications"]);

/** Stored labels: strings of the known slots only. */
export function normalizeDeviceLabels(raw: unknown): DeviceLabels {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out: DeviceLabels = {};
  for (const slot of DEVICE_SLOTS) { const v = r[slot]; if (typeof v === "string" && v) out[slot] = v; }
  return out;
}

/** The label without the number Windows puts in front of a device added again: "Lautsprecher (2- X)" -> "Lautsprecher (X)". */
export const baseLabel = (label: string): string => label.replace(/\(\d+- /g, "(").trim();

/** One device of the list that carries this label: the same label first, then the same without Windows' number; none or several = null. */
function findByLabel(list: readonly DeviceLike[], label: string): string | null {
  const real = list.filter((d) => !PSEUDO.has(d.deviceId) && d.deviceId);
  const same = real.filter((d) => d.label === label);
  if (same.length === 1) return same[0]!.deviceId;
  if (same.length > 1) return null;
  const base = baseLabel(label);
  const similar = real.filter((d) => baseLabel(d.label) === base);
  return similar.length === 1 ? similar[0]!.deviceId : null;
}

/**
 * What to change so the stored choices name devices that exist: a listed id gets its label (settings from before the labels),
 * a missing id the listed device with its label. Lists without labels (no permission yet) change nothing; null = nothing to do.
 */
export function healDevices(settings: VoiceSettings, lists: DeviceLists): Partial<VoiceSettings> | null {
  const patch: Partial<VoiceSettings> = {};
  const labels: DeviceLabels = { ...settings.deviceLabels };
  let changed = false;
  for (const slot of DEVICE_SLOTS) {
    const id = settings[FIELD[slot]];
    if (!id || PSEUDO.has(id)) continue;
    const list = listOf(lists, slot);
    if (!list.some((d) => d.label)) continue;
    const listed = list.find((d) => d.deviceId === id);
    if (listed) {
      if (listed.label && labels[slot] !== listed.label) { labels[slot] = listed.label; changed = true; }
      continue;
    }
    const label = labels[slot];
    const found = label ? findByLabel(list, label) : null;
    if (!found) continue;
    patch[FIELD[slot]] = found;
    labels[slot] = list.find((d) => d.deviceId === found)!.label;
    changed = true;
  }
  return changed ? { ...patch, deviceLabels: labels } : null;
}

/** A choice of the user: the id with the label it carries now (null = the system's default, the label goes). */
export function chooseDevice(settings: VoiceSettings, slot: DeviceSlot, id: string | null, list: readonly DeviceLike[]): Partial<VoiceSettings> {
  const labels: DeviceLabels = { ...settings.deviceLabels };
  const label = id ? list.find((d) => d.deviceId === id)?.label : undefined;
  if (label && id && !PSEUDO.has(id)) labels[slot] = label;
  else delete labels[slot];
  return { [FIELD[slot]]: id, deviceLabels: labels };
}
