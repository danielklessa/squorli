import { AccountSettings } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { applyAccountSettings, sameAccountSettings, sameHiddenGames, toAccountSettings } from "./accountSettings";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "./voice/settings";

const device: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, inputDeviceId: "mic-1", outputDeviceId: "out-1", screenOutputDeviceId: "out-2", radioOutputDeviceId: "out-3", cameraDeviceId: "cam-1", deviceLabels: { output: "Kopfhörer (Arctis)" }, levelMatch: { on: true, level: 0.7 } };

describe("account settings", () => {
  it("leaves the device selection out of the account", () => {
    const s = toAccountSettings(device, "de");
    expect(JSON.stringify(s)).not.toContain("mic-1");
    expect(JSON.stringify(s)).not.toContain("cam-1");
    expect(JSON.stringify(s)).not.toContain("Arctis");
    expect(JSON.stringify(s)).not.toContain("levelMatch");
    expect(AccountSettings.parse(s)).toEqual(s);
  });

  it("matches the protocol defaults for a fresh device", () => {
    expect(sameAccountSettings(toAccountSettings(DEFAULT_VOICE_SETTINGS, "auto"), AccountSettings.parse({}), true)).toBe(true);
  });

  it("applies the account's settings and keeps the devices", () => {
    const remote = AccountSettings.parse({ voice: { mode: "ptt", pttKey: "KeyV" }, camera: { quality: "360p", blur: 20 }, stage: { featureSelf: false }, sounds: { selfJoin: false, selfLeave: true, peerJoin: true, peerLeave: false, volume: 0.2 } });
    const next = applyAccountSettings(device, remote);
    expect(next.mode).toBe("ptt");
    expect(next.pttKey).toBe("KeyV");
    expect(next.cameraQuality).toBe("360p");
    expect(next.cameraBlur).toBe(20);
    expect(next.featureSelfInSpeakerView).toBe(false);
    expect(next.sounds.volume).toBe(0.2);
    expect([next.inputDeviceId, next.outputDeviceId, next.screenOutputDeviceId, next.radioOutputDeviceId, next.cameraDeviceId]).toEqual(["mic-1", "out-1", "out-2", "out-3", "cam-1"]);
    expect(next.deviceLabels).toEqual({ output: "Kopfhörer (Arctis)" });
    expect(next.levelMatch).toEqual({ on: true, level: 0.7 });
    expect(sameAccountSettings(toAccountSettings(next, "auto"), remote, true)).toBe(true);
  });

  it("keeps this device's message cue when the account says nothing about it, and pushes it all the same", () => {
    const silent = { ...device, sounds: { ...device.sounds, message: false } };
    const old = AccountSettings.parse({}); // stored before the cue existed, or by a directory that drops the field
    expect(old.sounds.message).toBeUndefined();
    expect(applyAccountSettings(silent, old).sounds.message).toBe(false);
    expect(sameAccountSettings(toAccountSettings(silent, "auto"), old, true)).toBe(true); // nothing to take over
    expect(sameAccountSettings(toAccountSettings(silent, "auto"), old)).toBe(false);      // but something to push
    const known = AccountSettings.parse({ sounds: { ...old.sounds, message: true } });
    expect(applyAccountSettings(silent, known).sounds.message).toBe(true);
    expect(sameAccountSettings(toAccountSettings(silent, "auto"), known, true)).toBe(false);
  });

  it("keeps this device's game display when the account says nothing about it, takes the account's when it does, and pushes it", () => {
    const local: VoiceSettings = { ...device, games: { enabled: true, servers: false } };
    expect(applyAccountSettings(local, AccountSettings.parse({})).games).toEqual({ enabled: true, servers: false });
    expect(applyAccountSettings(local, AccountSettings.parse({ games: { enabled: false } })).games).toEqual({ enabled: false, servers: true });
    const pushed = toAccountSettings(local, "auto");
    expect(pushed.games).toEqual({ enabled: true, servers: false });
    expect(sameAccountSettings(pushed, AccountSettings.parse({}), true)).toBe(true);
    expect(sameAccountSettings(pushed, AccountSettings.parse({}))).toBe(false);
    expect(sameAccountSettings(pushed, { ...pushed, games: { enabled: true, servers: true } }, true)).toBe(false);
  });

  it("notices every difference, whatever the key order", () => {
    const a = toAccountSettings(DEFAULT_VOICE_SETTINGS, "auto");
    expect(sameAccountSettings(a, { games: a.games, stage: a.stage, sounds: a.sounds, camera: a.camera, voice: a.voice, locale: a.locale })).toBe(true);
    expect(sameAccountSettings(a, { ...a, games: { enabled: true, servers: true } })).toBe(false);
    expect(sameAccountSettings(a, { ...a, locale: "en" })).toBe(false);
    expect(sameAccountSettings(a, { ...a, stage: { featureSelf: false } })).toBe(false);
    expect(sameAccountSettings(a, { ...a, voice: { ...a.voice, vadHangoverMs: 450 } })).toBe(false);
  });
});

describe("hide list of the game display", () => {
  it("compares without the order, and no list counts as an empty one", () => {
    expect(sameHiddenGames(["steam:1", "gog:2"], ["gog:2", "steam:1"])).toBe(true);
    expect(sameHiddenGames(null, [])).toBe(true);
    expect(sameHiddenGames(["steam:1"], null)).toBe(false);
    expect(sameHiddenGames(["steam:1"], ["steam:2"])).toBe(false);
  });
});
