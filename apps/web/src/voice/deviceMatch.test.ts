import { describe, expect, it } from "vitest";
import { baseLabel, chooseDevice, healDevices, normalizeDeviceLabels, type DeviceLists } from "./deviceMatch";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "./settings";

const dev = (deviceId: string, label: string) => ({ deviceId, label });
const lists = (outputs: ReturnType<typeof dev>[], inputs: ReturnType<typeof dev>[] = [], cameras: ReturnType<typeof dev>[] = []): DeviceLists => ({ inputs, outputs, cameras });
const settings = (patch: Partial<VoiceSettings>): VoiceSettings => ({ ...DEFAULT_VOICE_SETTINGS, ...patch });
const OUTPUTS = [dev("default", "Standard - Kopfhörer (Arctis)"), dev("communications", "Kommunikation - Kopfhörer (Arctis)"), dev("new-1", "Kopfhörer (Arctis)"), dev("spk", "Lautsprecher (Realtek)")];

describe("healDevices", () => {
  it("finds a device with a new id by its name", () => {
    const s = settings({ outputDeviceId: "old-1", deviceLabels: { output: "Kopfhörer (Arctis)" } });
    expect(healDevices(s, lists(OUTPUTS))).toEqual({ outputDeviceId: "new-1", deviceLabels: { output: "Kopfhörer (Arctis)" } });
  });
  it("finds it when Windows numbered it on adding it again, and keeps the new name", () => {
    const s = settings({ outputDeviceId: "old", deviceLabels: { output: "Lautsprecher (RODECaster Duo Chat) (19f7:0095)" } });
    const out = [dev("x", "Lautsprecher (2- RODECaster Duo Chat) (19f7:0095)")];
    expect(healDevices(s, lists(out))).toEqual({ outputDeviceId: "x", deviceLabels: { output: "Lautsprecher (2- RODECaster Duo Chat) (19f7:0095)" } });
    expect(baseLabel("Mikrofon (12- HD Pro Webcam C920)")).toBe("Mikrofon (HD Pro Webcam C920)");
  });
  it("fills the name of a listed device (settings from before) and leaves a known one alone", () => {
    expect(healDevices(settings({ outputDeviceId: "spk" }), lists(OUTPUTS))).toEqual({ deviceLabels: { output: "Lautsprecher (Realtek)" } });
    expect(healDevices(settings({ outputDeviceId: "spk", deviceLabels: { output: "Lautsprecher (Realtek)" } }), lists(OUTPUTS))).toBeNull();
  });
  it("changes nothing without names (no permission yet), without a match, or with two matches", () => {
    const s = settings({ outputDeviceId: "old", deviceLabels: { output: "Kopfhörer (Arctis)" } });
    expect(healDevices(s, lists(OUTPUTS.map((d) => ({ ...d, label: "" }))))).toBeNull();
    expect(healDevices(s, lists([dev("spk", "Lautsprecher (Realtek)")]))).toBeNull();
    expect(healDevices(s, lists([dev("a", "Kopfhörer (Arctis)"), dev("b", "Kopfhörer (Arctis)")]))).toBeNull();
    expect(healDevices(settings({ outputDeviceId: "old" }), lists(OUTPUTS))).toBeNull();
  });
  it("never picks Chromium's stand-ins and leaves a chosen stand-in alone", () => {
    const s = settings({ outputDeviceId: "old", deviceLabels: { output: "Standard - Kopfhörer (Arctis)" } });
    expect(healDevices(s, lists(OUTPUTS))).toBeNull();
    expect(healDevices(settings({ outputDeviceId: "communications" }), lists(OUTPUTS))).toBeNull();
  });
  it("heals every slot from its own list", () => {
    const s = settings({
      inputDeviceId: "mic-old", screenOutputDeviceId: "spk-old", radioOutputDeviceId: "spk", cameraDeviceId: "cam-old",
      deviceLabels: { input: "Mikrofon (Arctis)", screenOutput: "Lautsprecher (Realtek)", radioOutput: "Lautsprecher (Realtek)", camera: "C920" },
    });
    const patch = healDevices(s, lists(OUTPUTS, [dev("mic", "Mikrofon (Arctis)")], [dev("cam", "C920")]));
    expect(patch).toEqual({ inputDeviceId: "mic", screenOutputDeviceId: "spk", cameraDeviceId: "cam", deviceLabels: s.deviceLabels });
  });
});

describe("chooseDevice", () => {
  it("stores the id with its name, and the default without one", () => {
    const s = settings({ deviceLabels: { input: "Mikrofon (Arctis)" } });
    expect(chooseDevice(s, "output", "spk", OUTPUTS)).toEqual({ outputDeviceId: "spk", deviceLabels: { input: "Mikrofon (Arctis)", output: "Lautsprecher (Realtek)" } });
    expect(chooseDevice(s, "input", null, [])).toEqual({ inputDeviceId: null, deviceLabels: {} });
    expect(chooseDevice(s, "output", "default", OUTPUTS)).toEqual({ outputDeviceId: "default", deviceLabels: { input: "Mikrofon (Arctis)" } });
  });
});

describe("normalizeDeviceLabels", () => {
  it("keeps strings of known slots only", () => {
    expect(normalizeDeviceLabels(undefined)).toEqual({});
    expect(normalizeDeviceLabels({ output: "A", camera: 3, other: "x", input: "" })).toEqual({ output: "A" });
  });
});
