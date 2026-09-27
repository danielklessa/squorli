import { describe, expect, it } from "vitest";
import { DM_REPORT_CONTEXT_MAX, DirectoryGame, DmReportRequest, LibraryGameId, directoryDmReportPayload, directoryGameIconUrl, directoryGameUrl, splitGameId } from "./directory";
import {
  ACCOUNT_SETTINGS_MAX_LENGTH, AVATAR_MAX_BYTES, AccountSettings, AccountSettingsUpdateRequest, AvatarUpdateRequest, DirectoryAccount, DirectoryHealth, avatarDigest, directoryAvatarPayload, directoryAvatarUrl, sniffAvatarMime, DirectoryRegisterRequest, Handle, directoryRegisterMessage, parseAccountSettings,
  BLOCKED_USERS_MAX, HIDDEN_GAMES_MAX, HIDDEN_GAME_ID_MAX, SERVER_HOST_MAX, SERVER_ORDER_MAX, SEALED_SETTINGS_MAX_LENGTH, SealedSettings, SoundSettings, deriveSettingsKey, openSettings, parseSealedSettings, sealSettings,
} from "./directory";

describe("registration", () => {
  const base = { publicKey: "a".repeat(64), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "b".repeat(128) };
  it("accepts handles by the rules only", () => {
    expect(Handle.parse("  Daniel.K_1 ")).toBe("daniel.k_1");
    for (const bad of ["ab", "Nicht Erlaubt!", ".dot", "dash-ed", "x".repeat(33)]) expect(Handle.safeParse(bad).success).toBe(false);
  });
  it("signs the message of before without an address and covers the address when there is one", () => {
    expect(directoryRegisterMessage("id.example.org", "daniel", "n1")).toBe("community-directory-register\nid.example.org\ndaniel\nn1");
    expect(directoryRegisterMessage("id.example.org", "daniel", "n1", "d@example.org")).toBe("community-directory-register\nid.example.org\ndaniel\nn1\nd@example.org");
  });
  it("takes an optional address (lowercased) and an 8-digit code", () => {
    expect(DirectoryRegisterRequest.parse({ ...base, handle: "daniel" }).email).toBeUndefined();
    expect(DirectoryRegisterRequest.parse({ ...base, handle: "daniel", email: " Daniel@Example.ORG " }).email).toBe("daniel@example.org");
    expect(DirectoryRegisterRequest.safeParse({ ...base, handle: "daniel", email: "no-address" }).success).toBe(false);
    expect(DirectoryRegisterRequest.safeParse({ ...base, handle: "daniel", email: "d@example.org", emailCode: "1234567" }).success).toBe(false);
    expect(DirectoryRegisterRequest.parse({ ...base, handle: "daniel", email: "d@example.org", emailCode: "12345678" }).emailCode).toBe("12345678");
  });
  it("reads emailRequired as false from a directory that predates it", () => {
    const h = DirectoryHealth.parse({ ok: true, service: "directory", host: "id.example.org", features: { backup: true, totp: true, email: true }, time: new Date().toISOString() });
    expect(h.features.emailRequired).toBe(false);
  });
});

describe("account settings", () => {
  it("fills every field from an empty object", () => {
    expect(AccountSettings.parse({})).toEqual({
      locale: "auto",
      voice: { mode: "vad", pttKey: "Space", vadThreshold: 0.04, vadHangoverMs: 400 },
      camera: { quality: "720p", blur: 0 },
      sounds: { selfJoin: true, selfLeave: true, peerJoin: true, peerLeave: true, volume: 0.6 },
      stage: { featureSelf: true },
    });
  });
  it("keeps what an older client stored and defaults the rest", () => {
    const s = AccountSettings.parse({ locale: "de", voice: { mode: "ptt" } });
    expect(s.locale).toBe("de");
    expect(s.voice).toEqual({ mode: "ptt", pttKey: "Space", vadThreshold: 0.04, vadHangoverMs: 400 });
    expect(s.stage.featureSelf).toBe(true);
  });
  it("rejects values outside the ranges", () => {
    expect(AccountSettings.safeParse({ voice: { vadThreshold: 2 } }).success).toBe(false);
    expect(AccountSettings.safeParse({ locale: "fr" }).success).toBe(false);
    expect(AccountSettings.safeParse({ sounds: { selfJoin: true } }).success).toBe(false);
    // The message cue (20 September 2026) is optional: settings stored before it stay valid and say nothing about it.
    expect(AccountSettings.parse({}).sounds.message).toBeUndefined();
    expect(AccountSettings.parse({ sounds: { selfJoin: true, selfLeave: true, peerJoin: true, peerLeave: true, message: false, volume: 0.6 } }).sounds.message).toBe(false);
  });
  it("parses a stored string and survives rubbish", () => {
    expect(parseAccountSettings(JSON.stringify({ stage: { featureSelf: false } }))?.stage.featureSelf).toBe(false);
    expect(parseAccountSettings("{nope")).toBeNull();
    expect(parseAccountSettings(JSON.stringify({ locale: 5 }))).toBeNull();
    expect(parseAccountSettings(null)).toBeNull();
  });
  it("limits the length of the signed string", () => {
    const base = { publicKey: "a".repeat(64), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "b".repeat(128) };
    expect(AccountSettingsUpdateRequest.safeParse({ ...base, settings: "{}" }).success).toBe(true);
    expect(AccountSettingsUpdateRequest.safeParse({ ...base, settings: "x".repeat(ACCOUNT_SETTINGS_MAX_LENGTH + 1) }).success).toBe(false);
  });
  it("rejects a cue volume outside 0..1 (the directory's smoke test leaves this to us)", () => {
    const cues = { selfJoin: true, selfLeave: false, peerJoin: true, peerLeave: false };
    expect(SoundSettings.safeParse({ ...cues, volume: 0.35 }).success).toBe(true);
    expect(SoundSettings.safeParse({ ...cues, volume: 2 }).success).toBe(false);
  });
});

describe("sealed settings", () => {
  const seed = "11".repeat(32); const publicKey = "a".repeat(64);
  const content = { settings: AccountSettings.parse({ locale: "de", stage: { featureSelf: false } }), hiddenGames: ["steam:730", "epic:Fortnite"], serverOrder: ["b.example", "a.example"], blockedUsers: ["c".repeat(64), "d".repeat(64)] };
  it("opens what it sealed, on every device that has the seed", async () => {
    const sealed = await sealSettings(await deriveSettingsKey(seed, publicKey), publicKey, content);
    expect(SealedSettings.safeParse(sealed).success).toBe(true);
    expect(await openSettings(await deriveSettingsKey(seed, publicKey), publicKey, sealed)).toEqual(content);
    expect(parseSealedSettings(JSON.stringify(sealed))).toEqual(sealed);
  });
  it("shows nothing of the content and hides its length up to the next step", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const short = await sealSettings(key, publicKey, { settings: content.settings });
    const longer = await sealSettings(key, publicKey, content);
    expect(JSON.stringify(longer)).not.toContain("steam");
    expect(longer.ciphertext.length).toBe(short.ciphertext.length);
    expect(longer.ciphertext).not.toBe(short.ciphertext);
  });
  it("opens nothing with another key, for another account or after a change", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const sealed = await sealSettings(key, publicKey, content);
    expect(await openSettings(await deriveSettingsKey("22".repeat(32), publicKey), publicKey, sealed)).toBeNull();
    expect(await openSettings(key, "b".repeat(64), sealed)).toBeNull();
    const flipped = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
    expect(await openSettings(key, publicKey, { ...sealed, ciphertext: flipped })).toBeNull();
  });
  it("carries the longest hide list the schema allows within the request's limit", async () => {
    const hiddenGames = Array.from({ length: HIDDEN_GAMES_MAX }, (_, i) => `epic:${String(i).padStart(HIDDEN_GAME_ID_MAX - 5, "x")}`);
    const key = await deriveSettingsKey(seed, publicKey);
    const sealed = await sealSettings(key, publicKey, { settings: content.settings, hiddenGames });
    expect(JSON.stringify(sealed).length).toBeLessThanOrEqual(SEALED_SETTINGS_MAX_LENGTH);
    expect((await openSettings(key, publicKey, sealed))?.hiddenGames).toHaveLength(HIDDEN_GAMES_MAX);
  });
  it("carries the longest block list and server order the schema allows within the request's limit", async () => {
    // Every list at its maximum at once would not fit; a real account never hides a thousand games and blocks two hundred people.
    const serverOrder = Array.from({ length: SERVER_ORDER_MAX }, (_, i) => `${String(i).padStart(SERVER_HOST_MAX - 8, "x")}.example`);
    const blockedUsers = Array.from({ length: BLOCKED_USERS_MAX }, (_, i) => i.toString(16).padStart(64, "0"));
    const key = await deriveSettingsKey(seed, publicKey);
    const sealed = await sealSettings(key, publicKey, { settings: content.settings, serverOrder, blockedUsers });
    expect(JSON.stringify(sealed).length).toBeLessThanOrEqual(SEALED_SETTINGS_MAX_LENGTH);
    const opened = await openSettings(key, publicKey, sealed);
    expect(opened?.serverOrder).toHaveLength(SERVER_ORDER_MAX);
    expect(opened?.blockedUsers).toHaveLength(BLOCKED_USERS_MAX);
  });
  it("cleans the block list and says nothing when the blob has none", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const odd = await sealSettings(key, publicKey, { settings: content.settings, blockedUsers: ["C".repeat(64), "", "c".repeat(64), "not a key", "e".repeat(63)] });
    expect((await openSettings(key, publicKey, odd))?.blockedUsers).toEqual(["c".repeat(64)]);
    const none = await sealSettings(key, publicKey, { settings: content.settings });
    expect((await openSettings(key, publicKey, none))?.blockedUsers).toBeUndefined();
  });
  it("drops a hidden id that does not fit and keeps the rest; settings that do not fit open as nothing", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const odd = await sealSettings(key, publicKey, { settings: content.settings, hiddenGames: ["steam:730", "", "x".repeat(HIDDEN_GAME_ID_MAX + 1), "steam:730"] });
    expect((await openSettings(key, publicKey, odd))?.hiddenGames).toEqual(["steam:730"]);
    const broken = await sealSettings(key, publicKey, { settings: { ...content.settings, locale: "fr" as "de" } });
    expect(await openSettings(key, publicKey, broken)).toBeNull();
  });
  it("cleans the server order and says nothing when the blob has none", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const odd = await sealSettings(key, publicKey, { settings: content.settings, serverOrder: ["B.example ", "", "b.example", "x".repeat(SERVER_HOST_MAX + 1), "a.example"] });
    expect((await openSettings(key, publicKey, odd))?.serverOrder).toEqual(["b.example", "a.example"]);
    const none = await sealSettings(key, publicKey, { settings: content.settings });
    expect((await openSettings(key, publicKey, none))?.serverOrder).toBeUndefined();
  });
  it("reads the feature and the status field as absent from a directory that predates them", () => {
    const h = DirectoryHealth.parse({ ok: true, service: "directory", host: "id.example.org", features: { backup: true, totp: true, email: true }, time: new Date().toISOString() });
    expect(h.features.settingsSealed).toBe(false);
    expect(parseSealedSettings("{nope")).toBeNull();
    expect(parseSealedSettings(JSON.stringify({ v: 2, iv: "0".repeat(24), ciphertext: "A".repeat(24) }))).toBeNull();
  });
});

describe("avatars", () => {
  const base = { publicKey: "a".repeat(64), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "b".repeat(128) };
  it("recognizes PNG, JPEG and WebP by their first bytes and nothing else", () => {
    expect(sniffAvatarMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(sniffAvatarMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffAvatarMime(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
    for (const bad of ["GIF89a", "<svg xmlns=", "RIFF0000WAVEfmt ", ""]) expect(sniffAvatarMime(new TextEncoder().encode(bad))).toBeNull();
  });
  it("signs type and digest, and nothing for a removal", async () => {
    expect(await avatarDigest(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(directoryAvatarPayload("image/webp", "ab12")).toBe("image/webp\nab12");
    expect(directoryAvatarPayload(null, null)).toBe("");
  });
  it("takes base64 up to the size limit, null to remove, and no other type", () => {
    expect(AvatarUpdateRequest.parse({ ...base, avatar: null }).avatar).toBeNull();
    expect(AvatarUpdateRequest.safeParse({ ...base, avatar: { mime: "image/png", data: "iVBORw0KGgo=" } }).success).toBe(true);
    expect(AvatarUpdateRequest.safeParse({ ...base, avatar: { mime: "image/gif", data: "R0lGODlh" } }).success).toBe(false);
    expect(AvatarUpdateRequest.safeParse({ ...base, avatar: { mime: "image/png", data: "not base64!" } }).success).toBe(false);
    expect(AvatarUpdateRequest.safeParse({ ...base, avatar: { mime: "image/png", data: "A".repeat(Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 4) } }).success).toBe(false);
  });
  it("builds the address with the cache version and none without an avatar", () => {
    expect(directoryAvatarUrl("https://id.example.org/", "a".repeat(64), "2026-09-19T10:00:00.000Z")).toBe(`https://id.example.org/api/avatars/${"a".repeat(64)}?v=${Date.parse("2026-09-19T10:00:00.000Z")}`);
    expect(directoryAvatarUrl("https://id.example.org", "a".repeat(64), null)).toBeNull();
    expect(DirectoryAccount.parse({ handle: "daniel", publicKey: "a".repeat(64), createdAt: "2026-09-19T10:00:00.000Z" }).avatarUpdatedAt).toBeNull();
    expect(DirectoryHealth.parse({ ok: true, service: "directory", host: "h", features: { backup: true, totp: true, email: false }, time: "2026-09-19T10:00:00.000Z" }).features.avatars).toBe(false);
  });
});

describe("game library", () => {
  it("takes the launchers' ids and nothing else", () => {
    for (const id of ["steam:730", "steam:1133870", "gog:1207658924", "xbox:9NHFVWX1V7QJ"]) expect(LibraryGameId.safeParse(id).success).toBe(true);
    for (const id of ["steam:0730", "steam:", "steam:7 30", "epic:Sugar", "custom:d:\\a.exe", "xbox:9nhfvwx1v7qj", "xbox:9NHFVWX1V7QJ/../x", "STEAM:730", "steam:12345678901", ""]) expect(LibraryGameId.safeParse(id).success).toBe(false);
    expect(splitGameId("steam:730")).toEqual({ source: "steam", key: "730" });
  });

  it("builds the addresses, the icon's only when there is one", () => {
    expect(directoryGameUrl("https://directory.example/", "steam:730")).toBe("https://directory.example/api/games/steam%3A730");
    expect(directoryGameIconUrl("https://directory.example", { id: "steam:730", iconUpdatedAt: "2026-09-21T10:00:00.000Z" })).toBe(`https://directory.example/api/games/steam%3A730/icon?v=${Date.parse("2026-09-21T10:00:00.000Z")}`);
    expect(directoryGameIconUrl("https://directory.example", { id: "steam:730", iconUpdatedAt: null })).toBeNull();
    expect(DirectoryGame.safeParse({ id: "steam:730", name: "Counter-Strike 2", show: true, iconUpdatedAt: null }).success).toBe(true);
  });
});

describe("direct message reports", () => {
  const key = (c: string) => c.repeat(64);
  const base = { publicKey: key("a"), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "b".repeat(128) };
  const msg = (n: number, from: string) => ({ id: `6f1c2a4e-1b2c-4d3e-8f90-${String(n).padStart(12, "0")}`, from, sentAt: "2026-09-26T10:00:00.000Z", text: `Nachricht ${n}` });
  it("signs the parsed content exactly as the client built it, whatever else the client's objects carried", () => {
    const sent = { kind: "dm" as const, reason: "harassment" as const, peer: key("c"), message: { ...msg(2, key("c")), seq: 7, extra: true }, context: [{ ...msg(1, key("a")), seq: 6 }] };
    const parsed = DmReportRequest.parse({ ...base, ...sent });
    expect(directoryDmReportPayload(parsed)).toBe(directoryDmReportPayload(sent));
    expect(directoryDmReportPayload(parsed)).toContain('"text":""');
    expect(directoryDmReportPayload({ ...sent, text: "Bitte anschauen" })).not.toBe(directoryDmReportPayload(sent));
  });
  it("refuses more context than the decision allows and a text that is no text", () => {
    const ok = { ...base, kind: "dm", reason: "spam", peer: key("c"), message: msg(99, key("c")), context: Array.from({ length: DM_REPORT_CONTEXT_MAX }, (_, i) => msg(i, key("a"))) };
    expect(DmReportRequest.safeParse(ok).success).toBe(true);
    expect(DmReportRequest.safeParse({ ...ok, context: [...ok.context, msg(50, key("c"))] }).success).toBe(false);
    expect(DmReportRequest.safeParse({ ...ok, reason: "rude" }).success).toBe(false);
    expect(DmReportRequest.safeParse({ ...ok, message: { ...ok.message, text: 5 } }).success).toBe(false);
  });
});
