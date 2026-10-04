import { describe, expect, it } from "vitest";
import { DM_REPORT_CONTEXT_MAX, DirectoryGame, DmReportRequest, LibraryGameId, directoryDmReportPayload, directoryGameIconUrl, directoryGameUrl, splitGameId } from "./directory";
import { AccountStatus, DirectoryAction, DirectoryReportRequest, NoticeReadRequest, RefusedServersResponse, SERVER_REPORT_EVIDENCE_TEXT_MAX, directoryReportPayload, refusedHostHash, reportKindsOf } from "./directory";
import { DIRECTORY_WS_CLOSE_DEVICE, DirectoryClientEvent, DirectoryServerEvent, FriendsActionRequest } from "./friends";
import { BackupFetchRequest, BackupUploadRequest, DESKTOP_APP_ORIGIN, DEVICE_IDLE_MS, DEVICE_MAX, DEVICE_PAGE_MAX, DEVICE_REFUSALS, DeviceRevokeRequest, SignedActionRequest, TooManyDevicesResponse, chatLoginMessage, deviceEnrolMessage, deviceProofMessage, directoryActionMessage, isDeviceRefusal, signInOrigin } from "./directory";
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
  const content = { settings: AccountSettings.parse({ locale: "de", stage: { featureSelf: false } }), hiddenGames: ["steam:730", "epic:Fortnite"], serverOrder: ["b.example", "a.example"], blockedUsers: ["c".repeat(64), "d".repeat(64)], dmLinkPreviews: false };
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
  it("cleans the list of hidden servers and says nothing when the blob has none", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const odd = await sealSettings(key, publicKey, { settings: content.settings, hiddenServers: ["Bad.example ", "", "bad.example", "x".repeat(SERVER_HOST_MAX + 1), "worse.example:8443"] });
    expect((await openSettings(key, publicKey, odd))?.hiddenServers).toEqual(["bad.example", "worse.example:8443"]);
    const empty = await sealSettings(key, publicKey, { settings: content.settings, hiddenServers: [] });
    expect((await openSettings(key, publicKey, empty))?.hiddenServers).toEqual([]);
    const none = await sealSettings(key, publicKey, { settings: content.settings });
    expect((await openSettings(key, publicKey, none))?.hiddenServers).toBeUndefined();
  });
  it("carries the switch for direct message previews only as a boolean", async () => {
    const key = await deriveSettingsKey(seed, publicKey);
    const on = await sealSettings(key, publicKey, { settings: content.settings, dmLinkPreviews: true });
    expect((await openSettings(key, publicKey, on))?.dmLinkPreviews).toBe(true);
    const none = await sealSettings(key, publicKey, { settings: content.settings });
    expect((await openSettings(key, publicKey, none))?.dmLinkPreviews).toBeUndefined();
    const odd = await sealSettings(key, publicKey, { settings: content.settings, dmLinkPreviews: "no" as unknown as boolean });
    expect((await openSettings(key, publicKey, odd))?.dmLinkPreviews).toBeUndefined();
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

describe("reports of accounts and chat servers", () => {
  const key = (c: string) => c.repeat(64);
  const base = { publicKey: key("a"), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "b".repeat(128) };
  const evidence = { text: "Das hier", authorName: "Mallory", authorKey: key("c"), channelName: "allgemein", sentAt: "2026-09-27T10:00:00.000Z" };
  it("takes the three kinds through one schema and keeps a direct message's payload as it was", () => {
    const dm = { kind: "dm" as const, reason: "spam" as const, peer: key("c"), message: { id: "6f1c2a4e-1b2c-4d3e-8f90-000000000001", from: key("c"), sentAt: "2026-09-26T10:00:00.000Z", text: "x" }, context: [] };
    const parsed = DirectoryReportRequest.parse({ ...base, ...dm });
    expect(parsed.kind).toBe("dm");
    expect(directoryReportPayload(dm)).toBe(directoryDmReportPayload(dm));
    expect(DirectoryReportRequest.parse({ ...base, kind: "account", reason: "hate", account: key("c") }).kind).toBe("account");
    expect(DirectoryReportRequest.safeParse({ ...base, kind: "member", reason: "hate", account: key("c") }).success).toBe(false);
  });
  it("signs an account's report over the reported key, reason and text", () => {
    const sent = { kind: "account" as const, reason: "sexual" as const, account: key("c") };
    expect(directoryReportPayload(sent)).toBe(`{"kind":"account","reason":"sexual","text":"","account":"${key("c")}"}`);
    expect(directoryReportPayload({ ...sent, account: key("d") })).not.toBe(directoryReportPayload(sent));
    expect(directoryReportPayload({ ...sent, text: "Bild" })).not.toBe(directoryReportPayload(sent));
  });
  it("signs a server's report with its evidence in one order, whatever order the client's object had", () => {
    const parsed = DirectoryReportRequest.parse({ ...base, kind: "server", reason: "illegal", host: " Chat.Example.org:8443 ", evidence: { sentAt: evidence.sentAt, channelName: evidence.channelName, extra: 1, authorKey: evidence.authorKey, authorName: evidence.authorName, text: evidence.text } });
    if (parsed.kind !== "server") throw new Error("kind");
    expect(parsed.host).toBe("chat.example.org:8443");
    expect(directoryReportPayload(parsed)).toBe(directoryReportPayload({ kind: "server", reason: "illegal", host: "chat.example.org:8443", evidence }));
    expect(directoryReportPayload({ kind: "server", reason: "illegal", host: "chat.example.org:8443", evidence: { ...evidence, text: "anders" } })).not.toBe(directoryReportPayload(parsed));
    const bare = DirectoryReportRequest.parse({ ...base, kind: "server", reason: "illegal", host: "chat.example.org" });
    if (bare.kind !== "server") throw new Error("kind");
    expect(bare.evidence).toBeNull();
    expect(directoryReportPayload(bare)).toContain('"evidence":null');
  });
  it("refuses a host that is none and evidence longer than a message", () => {
    expect(DirectoryReportRequest.safeParse({ ...base, kind: "server", reason: "spam", host: "https://chat.example.org/" }).success).toBe(false);
    expect(DirectoryReportRequest.safeParse({ ...base, kind: "server", reason: "spam", host: "chat.example.org", evidence: { ...evidence, text: "x".repeat(SERVER_REPORT_EVIDENCE_TEXT_MAX + 1) } }).success).toBe(false);
    expect(DirectoryReportRequest.safeParse({ ...base, kind: "server", reason: "spam", host: "chat.example.org", evidence: { ...evidence, authorKey: null } }).success).toBe(true);
  });
  it("reads the kinds from a directory's health: direct messages only from one that names none", () => {
    expect(reportKindsOf({ reports: false, reportKinds: ["dm", "account"] })).toEqual([]);
    expect(reportKindsOf({ reports: true, reportKinds: [] })).toEqual(["dm"]);
    expect(reportKindsOf({ reports: true, reportKinds: ["server", "later-kind", "dm"] })).toEqual(["dm", "server"]);
    const h = DirectoryHealth.parse({ ok: true, service: "directory", host: "id.example.org", features: { backup: true, totp: true, email: true, reports: true }, time: new Date().toISOString() });
    expect(h.features.reportKinds).toEqual([]);
    expect(h.features.refusedServers).toBe(false);
    expect(h.features.notices).toBe(false);
  });
});

describe("refused chat servers", () => {
  it("hashes a host the same whatever its case, and another host differently", async () => {
    const a = await refusedHostHash("Chat.Example.org");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await refusedHostHash(" chat.example.org ")).toBe(a);
    expect(await refusedHostHash("chat.example.org:8443")).not.toBe(a);
    expect(RefusedServersResponse.safeParse({ hashes: [a] }).success).toBe(true);
    expect(RefusedServersResponse.safeParse({ hashes: ["chat.example.org"] }).success).toBe(false);
  });
});

describe("refused chat servers on an account's list", () => {
  const status = { handle: "daniel", publicKey: "a".repeat(64), createdAt: "2026-09-01T10:00:00.000Z", totpEnabled: false, totpPending: false, recoveryCodesLeft: 0, fetches: [] };
  const server = { host: "chat.example.org", name: "Beispiel", displayName: null, lastSeenAt: "2026-09-20T10:00:00.000Z" };
  it("reads a status from a directory that predates the list as nothing refused", () => {
    const s = AccountStatus.parse({ ...status, servers: [server] });
    expect(s.refusedServers).toEqual([]);
    expect(s.servers[0]?.refused).toBe(false);
  });
  it("keeps the refused servers apart from the ones a client connects to", () => {
    const s = AccountStatus.parse({ ...status, servers: [server], refusedServers: [{ ...server, host: "bad.example.org", refused: true }] });
    expect(s.servers.map((x) => x.host)).toEqual(["chat.example.org"]);
    expect(s.refusedServers.map((x) => [x.host, x.refused])).toEqual([["bad.example.org", true]]);
  });
});

describe("suspension and notices", () => {
  const key = "a".repeat(64);
  const account = { handle: "daniel", publicKey: key, createdAt: "2026-09-01T10:00:00.000Z" };
  const status = { ...account, totpEnabled: false, totpPending: false, recoveryCodesLeft: 0, fetches: [], servers: [] };
  const notice = { id: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", kind: "suspend", reason: "harassment", until: "2026-10-04T10:00:00.000Z", createdAt: "2026-09-27T10:00:00.000Z", readAt: null };
  it("reads an account from a directory that predates the suspension as not suspended", () => {
    expect(DirectoryAccount.parse(account).suspendedUntil).toBeNull();
    expect(DirectoryAccount.parse({ ...account, suspendedUntil: notice.until }).suspendedUntil).toBe(notice.until);
    const s = AccountStatus.parse(status);
    expect(s.notices).toEqual([]);
    expect(s.suspendedUntil).toBeNull();
    expect(s.suspendedReason).toBeNull();
  });
  it("keeps the notices it can read and drops one of a kind or reason it does not know", () => {
    const s = AccountStatus.parse({ ...status, suspendedUntil: notice.until, suspendedReason: "harassment", notices: [notice, { ...notice, kind: "later-kind" }, { ...notice, reason: "later-reason" }, "rubbish"] });
    expect(s.notices).toEqual([notice]);
    expect(s.suspendedReason).toBe("harassment");
    expect(AccountStatus.parse({ ...status, suspendedReason: "later-reason" }).suspendedReason).toBeNull();
  });
  it("knows the action that marks a notice as read", () => {
    expect(DirectoryAction.safeParse("notice-read").success).toBe(true);
    expect(NoticeReadRequest.safeParse({ publicKey: key, challengeId: notice.id, signature: "b".repeat(128), id: notice.id }).success).toBe(true);
    expect(NoticeReadRequest.safeParse({ publicKey: key, challengeId: notice.id, signature: "b".repeat(128), id: "1" }).success).toBe(false);
  });
  it("tells a suspended account's socket why, with the date, and says when the notices changed", () => {
    const e = DirectoryServerEvent.parse({ type: "error", code: "account_suspended", message: "gesperrt", until: notice.until });
    expect(e.type === "error" && e.until).toBe(notice.until);
    expect(DirectoryServerEvent.parse({ type: "error", code: "unauthorized", message: "x" }).type).toBe("error");
    expect(DirectoryServerEvent.parse({ type: "notices.changed" }).type).toBe("notices.changed");
  });
});

describe("devices", () => {
  it("keeps where a sign-in came from: a site's host, the desktop app as itself, nothing else", () => {
    expect(signInOrigin("https://chat.example.org")).toBe("chat.example.org");
    expect(signInOrigin("http://localhost:3000")).toBe("localhost:3000");
    expect(signInOrigin("app://squorli")).toBe(DESKTOP_APP_ORIGIN);
    // A web site named like the app is a host, never the app.
    expect(signInOrigin("http://squorli")).toBe("squorli");
    expect(signInOrigin("https://squorli")).not.toBe(DESKTOP_APP_ORIGIN);
    for (const other of ["app://other", "file://", "null", "", "chrome-extension://abc", undefined, null, 7, ["https://a.example"]]) expect(signInOrigin(other)).toBeNull();
  });
  const key = "a".repeat(64);
  const device = "c".repeat(64);
  const id = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";
  const signed = { publicKey: key, challengeId: id, signature: "b".repeat(128) };
  const proof = { deviceKey: device, deviceSignature: "d".repeat(128) };
  const account = { handle: "daniel", publicKey: key, createdAt: "2026-09-01T10:00:00.000Z" };
  const status = { ...account, totpEnabled: false, totpPending: false, recoveryCodesLeft: 0, fetches: [], servers: [] };
  const info = { id, label: "Chrome auf Windows", createdAt: "2026-09-29T10:00:00.000Z", lastSeenAt: null };

  it("binds the device's proof to the account and to the very message the account's key signs", () => {
    const message = directoryActionMessage("id.example.org", "account-status", "n1");
    expect(deviceProofMessage(key, message)).toBe(`squorli-device\n${key}\ncommunity-directory-account-status\nid.example.org\nn1\n`);
    expect(deviceProofMessage(key, chatLoginMessage("chat.example.org", "n1"))).toBe(`squorli-device\n${key}\ncommunity-chat-login\nchat.example.org\nn1`);
    expect(deviceEnrolMessage("id.example.org", "daniel", device)).toBe(`squorli-device-enrol\nid.example.org\ndaniel\n${device}`);
  });
  it("carries the proof on every signed request and stays valid without it", () => {
    expect(SignedActionRequest.parse(signed).deviceKey).toBeUndefined();
    expect(SignedActionRequest.parse({ ...signed, ...proof }).deviceKey).toBe(device);
    expect(NoticeReadRequest.parse({ ...signed, ...proof, id }).deviceSignature).toBe(proof.deviceSignature);
    expect(FriendsActionRequest.parse({ ...signed, ...proof, op: "list", target: null }).deviceKey).toBe(device);
    expect(DirectoryRegisterRequest.parse({ ...signed, ...proof, handle: "daniel", deviceKind: "page" }).deviceKind).toBe("page");
    expect(DirectoryClientEvent.parse({ type: "auth", publicKey: key, signature: signed.signature, version: 1, ...proof })).toMatchObject(proof);
    expect(SignedActionRequest.safeParse({ ...signed, deviceKey: "short" }).success).toBe(false);
  });
  it("reads an account from a directory that predates devices as not enforced, without keys and without a list", () => {
    const a = DirectoryAccount.parse(account);
    expect([a.devicesEnforced, a.deviceKeys]).toEqual([false, []]);
    expect(DirectoryAccount.parse({ ...account, devicesEnforced: true, deviceKeys: [device] }).deviceKeys).toEqual([device]);
    expect(AccountStatus.parse(status).devices).toEqual([]);
    const s = AccountStatus.parse({ ...status, devicesEnforced: true, devices: [{ ...info, current: true }, { ...info, kind: "page", origin: "id.example.org" }] });
    expect(s.devices.map((d) => [d.kind, d.origin, d.current])).toEqual([["client", null, true], ["page", "id.example.org", false]]);
    const h = DirectoryHealth.parse({ ok: true, service: "directory", host: "id.example.org", features: { backup: true, totp: true, email: true }, time: new Date().toISOString() });
    expect([h.features.devices, h.features.deviceRevoke]).toEqual([false, false]);
  });
  it("signs out one device, all others or the asking one", () => {
    expect(DirectoryAction.safeParse("device-revoke").success).toBe(true);
    for (const target of [id, "others", "self"]) expect(DeviceRevokeRequest.safeParse({ ...signed, ...proof, target }).success).toBe(true);
    expect(DeviceRevokeRequest.safeParse({ ...signed, target: "all" }).success).toBe(false);
    expect(DeviceRevokeRequest.parse({ ...signed, target: "others", authKey: "e".repeat(64), code: "123456" }).authKey).toBe("e".repeat(64));
  });
  it("enrols with the key fetch and repeats it with a ticket and the device that makes way", () => {
    const fetch = { handle: "daniel", authKey: "e".repeat(64) };
    expect(BackupFetchRequest.parse(fetch).deviceKey).toBeUndefined();
    expect(BackupFetchRequest.parse({ ...fetch, ...proof, deviceKind: "page", remember: true }).remember).toBe(true);
    expect(BackupFetchRequest.parse({ ...fetch, ...proof, ticket: "f".repeat(64), replaceDevice: id }).replaceDevice).toBe(id);
    expect(BackupFetchRequest.safeParse({ ...fetch, ticket: "short" }).success).toBe(false);
    const full = TooManyDevicesResponse.parse({ error: "too_many_devices", devices: [info], ticket: "f".repeat(64) });
    expect(full.devices[0]?.kind).toBe("client");
    expect(TooManyDevicesResponse.parse({ error: "too_many_devices", devices: [] }).ticket).toBeNull();
  });
  it("takes the password so far with a new backup", () => {
    const upload = { ...signed, ciphertext: "Y3Q=", params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: "00".repeat(16), iv: "00".repeat(12) }, authKey: "e".repeat(64) };
    expect(BackupUploadRequest.parse(upload).oldAuthKey).toBeUndefined();
    expect(BackupUploadRequest.parse({ ...upload, ...proof, oldAuthKey: "1".repeat(64) }).oldAuthKey).toBe("1".repeat(64));
  });
  it("names the refusals, on REST and on the socket", () => {
    expect([isDeviceRefusal("device_revoked"), isDeviceRefusal("device_unknown"), isDeviceRefusal("device_required"), isDeviceRefusal("unauthorized"), isDeviceRefusal(null)]).toEqual([true, true, true, false, false]);
    for (const code of DEVICE_REFUSALS) expect(DirectoryServerEvent.parse({ type: "error", code, message: "x" }).type).toBe("error");
    expect(DIRECTORY_WS_CLOSE_DEVICE).toBe(4015);
    expect([DEVICE_MAX, DEVICE_PAGE_MAX, DEVICE_IDLE_MS]).toEqual([10, 5, 90 * 86_400_000]);
  });
});

describe("direct message reports: the stored ciphertext as proof (security audit D10, measure 3.8)", () => {
  const key = (c: string) => c.repeat(64);
  const base = { publicKey: key("a"), challengeId: "6f1c2a4e-1b2c-4d3e-8f90-123456789abc", signature: "b".repeat(128) };
  const msg = (n: number, from: string) => ({ id: `6f1c2a4e-1b2c-4d3e-8f90-${String(n).padStart(12, "0")}`, from, sentAt: "2026-09-26T10:00:00.000Z", text: `Nachricht ${n}` });
  it("carries iv and ciphertext inside the signed payload when the client sends them, and nothing when it does not", () => {
    const proof = { iv: "ab".repeat(12), ciphertext: "QUJD" };
    const sent = { kind: "dm" as const, reason: "spam" as const, peer: key("c"), message: { ...msg(2, key("c")), ...proof }, context: [msg(1, key("a"))] };
    const parsed = DmReportRequest.parse({ ...base, ...sent });
    expect(parsed.message.iv).toBe(proof.iv);
    expect(parsed.context[0]?.iv).toBeUndefined();
    expect(directoryDmReportPayload(parsed)).toBe(directoryDmReportPayload(sent));
    expect(directoryDmReportPayload(parsed)).toContain('"ciphertext":"QUJD"');
    const without = { ...sent, message: msg(2, key("c")) };
    expect(directoryDmReportPayload(without)).not.toContain("ciphertext");
    expect(directoryDmReportPayload(without)).toBe(directoryDmReportPayload(DmReportRequest.parse({ ...base, ...without })));
    // One of the two alone counts as none (the payload names both or neither); a malformed iv is refused.
    expect(directoryDmReportPayload({ ...sent, message: { ...msg(2, key("c")), iv: proof.iv } })).not.toContain("iv");
    expect(DmReportRequest.safeParse({ ...base, ...sent, message: { ...msg(2, key("c")), iv: "zz", ciphertext: "QUJD" } }).success).toBe(false);
  });
});
