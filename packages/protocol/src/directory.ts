import { z } from "zod";
import { base64ToBytes, hexToBytes, randomHex } from "./backup";
import { Iso, PublicKey, REPORT_TEXT_MAX, ReportReason, Signature, Uuid } from "./primitives";

// COPY NOTE: this file (like primitives.ts, backup.ts, useragent.ts including their tests) also exists byte-identically in the
// squorli-directory repo under packages/protocol/src. The source is squorli-server; copy it over after every change (see AGENTS.md).

/** Challenge-response sign-in with Ed25519: chat server (/api/auth/challenge) and directory service (/api/challenge) use the same shape. */
export const ChallengeRequest = z.object({ publicKey: PublicKey });
export const ChallengeResponse = z.object({
  challengeId: Uuid,
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: Iso,
});
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;

/**
 * Contract of the directory service (M6, brought forward on 2026-09-14; squorli-server docs/features/directory.md):
 * Handle (@name) -> public key. The service is deliberately narrow; chat servers query it only
 * optionally and tolerate its outage (the key then applies without a handle).
 *
 * M6a: registration and resolution. M6b: encrypted key backup.
 * M6c: TOTP authenticator and recovery codes as a second factor for key retrieval, signed account actions,
 * list of key retrievals. E-mail (17 September 2026): a confirmed address gets a notice on every key retrieval and can
 * request an 8-digit e-mail code as a substitute for the authenticator (only after the correct password or a valid signature).
 */

/** Handle without @: 3-32 characters, lowercase letters, digits, dot, underscore; starts and ends alphanumeric. */
export const Handle = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9_.]*[a-z0-9])?$/, "3-32 Zeichen: a-z, 0-9, Punkt, Unterstrich");

/** E-mail address of an account (lowercased). At most one account per address (18 September 2026). */
export const EmailAddress = z.string().trim().toLowerCase().min(6).max(254).regex(/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/, "E-Mail-Adresse");
/** E-mail code (confirmation of an address, or the second factor by e-mail): 8 digits, valid once for a few minutes. */
export const EmailCode = z.string().trim().regex(/^\d{8}$/, "8 Ziffern");

/**
 * Registration is bound to the service's host (like sign-in is to PUBLIC_DOMAIN) so signatures cannot be moved elsewhere.
 * With an e-mail address (see DirectoryRegisterRequest) the address is part of the message, so it cannot be swapped.
 */
export function directoryRegisterMessage(directoryHost: string, handle: string, nonce: string, email?: string): string {
  return `community-directory-register\n${directoryHost}\n${handle}\n${nonce}${email === undefined ? "" : `\n${email}`}`;
}

/**
 * Registration with a confirmed e-mail address (18 September 2026; mandatory when the service reports `features.emailRequired`,
 * possible whenever it has SMTP): the first request carries `email`, creates nothing and answers 202 `DirectoryRegisterPending`
 * after mailing an 8-digit code; the second one (fresh challenge, same handle and address) carries `emailCode` as well and
 * creates the account with the address confirmed. 400 `email_required` without an address where one is mandatory,
 * 401 `email_code_invalid` for a wrong, expired or never sent code, 409 `email_taken` only after the code was right (so nobody
 * learns without access to the mailbox whether an address has an account: a taken address gets a notice instead of a code).
 */
export const DirectoryRegisterRequest = z.object({
  handle: Handle,
  publicKey: PublicKey,
  challengeId: Uuid,
  signature: Signature,
  email: EmailAddress.optional(),
  emailCode: EmailCode.optional(),
});
/** 202 of POST /api/register: the code was mailed; `sentTo` = the address, masked (d***@example.org). */
export const DirectoryRegisterPending = z.object({ emailPending: z.literal(true), sentTo: z.string() });
export type DirectoryRegisterPending = z.infer<typeof DirectoryRegisterPending>;

/** Display name (chat server: per server; directory: global and per server). Empty = handle or the short form of the key. */
export const DisplayName = z.string().trim().min(1).max(32);
/** Host of a chat server (PUBLIC_DOMAIN, with port if any), the key for per-server display names in the directory. */
export const ServerHost = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/, "Hostname, optional mit Port");

export const DirectoryAccount = z.object({
  handle: Handle,
  publicKey: PublicKey,
  createdAt: Iso,
  /** M6b: a password backup exists (signing in on other devices is possible). */
  hasBackup: z.boolean().default(false),
  /** Global display name; only for registered chat servers (server token, `?server=<host>`), always null publicly. */
  displayName: DisplayName.nullable().default(null),
  /** Display name for exactly the server from `?server=<host>` (only with its token); null if there is no entry. Takes precedence over `displayName`. */
  serverDisplayName: DisplayName.nullable().default(null),
  /** Avatar (19 September 2026): when the account last stored an image, null = none. Public like the handle; the image is at `directoryAvatarUrl`. */
  avatarUpdatedAt: Iso.nullable().default(null),
});

// ---- M6b: password-encrypted key backup (crypto in backup.ts)
const Hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `${bytes * 2} hex chars`);

/** Parameters of the backup, chosen by the client; the service only passes them through (iv is in the blob only, not in the parameter query). */
export const BackupParams = z.object({
  kdf: z.literal("pbkdf2-sha256"),
  iterations: z.number().int().min(100_000).max(10_000_000),
  salt: Hex(16),
  iv: Hex(12),
  /**
   * true = the keys are bound to the host they are kept at (backup.ts `context`; server accounts since 25 September 2026,
   * the client passes the host it connects to, never a value from the server). Missing = unbound, as the directory's own.
   */
  bound: z.literal(true).optional(),
});
/** Auth key derived from the password; grants retrieval of the ciphertext, the service stores only its SHA-256. */
export const BackupAuthKey = Hex(32);
/** Storing is bound to host + challenge like registration and also covers the ciphertext. */
export function directoryBackupMessage(directoryHost: string, nonce: string, ciphertext: string): string {
  return `community-directory-backup\n${directoryHost}\n${nonce}\n${ciphertext}`;
}
// ---- M6c: second factor. 6 digits = TOTP code, 8 digits = e-mail code (sent to the confirmed address), otherwise a recovery
// code (xxxxx-xxxxx); the service decides by shape.
export const SecondFactorCode = z.string().trim().min(6).max(20);

export const BackupUploadRequest = z.object({
  publicKey: PublicKey,
  challengeId: Uuid,
  signature: Signature,
  /** base64, AES-GCM over the 32-byte seed (48 bytes). */
  ciphertext: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(512),
  params: BackupParams,
  authKey: BackupAuthKey,
  /** M6c: mandatory when the authenticator is active (changing the password = replacing the backup). */
  code: SecondFactorCode.optional(),
});
/** First step of recovery: salt and iterations so the client can derive the auth key. */
export const BackupParamsResponse = BackupParams.omit({ iv: true });
/** Second step; `code` is only needed after a 401 totp_required (the response only comes with the correct password). */
export const BackupFetchRequest = z.object({ handle: Handle, authKey: BackupAuthKey, code: SecondFactorCode.optional() });
export const BackupBlob = z.object({ handle: Handle, publicKey: PublicKey, ciphertext: z.string(), params: BackupParams, updatedAt: Iso });

// ---- M6c: signed account actions (authenticator, recovery codes, account status). Same pattern as registration
// and backup: challenge + signature over host, nonce and payload (for actions with a code, the code is the payload).
export const DirectoryAction = z.enum(["totp-setup", "totp-enable", "totp-disable", "recovery-regenerate", "account-status", "profile-update", "friends", "server-leave", "sound-settings", "email-set", "email-verify", "email-code", "settings", "avatar-set", "link-lookup", "dm-blob-put", "settings-sealed", "report"]);
export type DirectoryAction = z.infer<typeof DirectoryAction>;
export function directoryActionMessage(directoryHost: string, action: DirectoryAction, nonce: string, payload = ""): string {
  return `community-directory-${action}\n${directoryHost}\n${nonce}\n${payload}`;
}
export const SignedActionRequest = z.object({ publicKey: PublicKey, challengeId: Uuid, signature: Signature });
export const CodeActionRequest = SignedActionRequest.extend({ code: SecondFactorCode });

// ---- E-mail in the account (17 September 2026, only when the service has SMTP: features.email). The address is stored
// unconfirmed first; `email-set` (payload = address, empty = remove) mails an 8-digit code, `email-verify` (payload = code)
// confirms it. A confirmed address gets a notice on every key retrieval and serves as a fallback second factor: `email-code`
// (signed, no payload) or POST /api/email/code with handle + auth key (i.e. after the correct password) mails a code that
// counts like an authenticator code wherever `SecondFactorCode` is accepted.
// An address belongs to at most one account (18 September 2026): `email-set` for an address another account has confirmed
// mails a notice instead of a code, `email-verify` answers 409 `email_taken` if another account confirmed it in the meantime.
// With `features.emailRequired` a confirmed address can be replaced but not removed (409 `email_required`).
// `EmailAddress` and `EmailCode` are defined above the registration, which uses them too.
export const EmailUpdateRequest = SignedActionRequest.extend({ email: EmailAddress.nullable() });
export const EmailVerifyRequest = SignedActionRequest.extend({ code: EmailCode });
/** Request an e-mail code with the password (sign-in without the authenticator): same proof as BackupFetchRequest. */
export const EmailCodeRequest = z.object({ handle: Handle, authKey: BackupAuthKey });
/** `sentTo` = the address, masked (d***@example.org). */
export const EmailCodeResponse = z.object({ ok: z.literal(true), sentTo: z.string() });
export type EmailCodeResponse = z.infer<typeof EmailCodeResponse>;

// ---- Display names in the directory: global (server = null) or per chat server (server = that server's host). Registered chat servers
// fetch `GET /api/keys/<key>?server=<host>` on sign-in (with their server token) and adopt serverDisplayName ?? displayName.
// The signature's payload is "<server|empty>\n<name|empty>" so that neither server nor name can be swapped out.
export function directoryProfilePayload(server: string | null, displayName: string | null): string {
  return `${server ?? ""}\n${displayName ?? ""}`;
}
export const ProfileUpdateRequest = SignedActionRequest.extend({ server: ServerHost.nullable(), displayName: DisplayName.nullable() });

// ---- Link previews in direct messages (21 September 2026, dm.ts). Two services for the SENDER's client, both switched on by
// `features.dmPreviews`:
//  - POST /api/link-lookup (signed action `link-lookup`, payload = the address, or "youtube:<video id>"): the directory looks a
//    link up for a client that cannot do it itself (a browser may not read a foreign page). The desktop app asks the linked
//    host itself and never uses this route, so the directory learns links only from senders in a browser.
//  - POST /api/dm-blobs (signed action `dm-blob-put`, payload = SHA-256 hex of the bytes) stores a picture the sender has
//    encrypted (dm.ts `sealDmBlob`); GET /api/dm-blobs/<id> hands it to whoever knows the id, which only travels inside the
//    encrypted message. The directory keeps these bytes as long as direct messages and cannot read them.
export const DM_BLOB_MAX_BYTES = 256 * 1024;
export const LinkLookupRequest = SignedActionRequest.extend({ url: z.string().max(2100).optional(), youtube: z.string().regex(/^[\w-]{11}$/).optional() })
  .refine((r) => (r.url === undefined) !== (r.youtube === undefined), "url or youtube");
export type LinkLookupRequest = z.infer<typeof LinkLookupRequest>;
export const directoryLinkLookupPayload = (r: { url?: string | undefined; youtube?: string | undefined }) => (r.youtube !== undefined ? `youtube:${r.youtube}` : r.url ?? "");
/** `found` false = no preview (not reachable, not public, no title). The picture as it came from the host, base64, at most 2 MB. */
export const LinkLookupResponse = z.object({
  found: z.boolean(),
  kind: z.enum(["page", "youtube"]).optional(),
  siteName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  image: z.object({ mime: z.string(), data: z.string() }).nullable().optional(),
});
export type LinkLookupResponse = z.infer<typeof LinkLookupResponse>;
export const DmBlobPutRequest = SignedActionRequest.extend({ data: z.string().min(4).max(Math.ceil(DM_BLOB_MAX_BYTES / 3) * 4 + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
export type DmBlobPutRequest = z.infer<typeof DmBlobPutRequest>;
export const DmBlobPutResponse = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) });
export type DmBlobPutResponse = z.infer<typeof DmBlobPutResponse>;
export const directoryDmBlobUrl = (directoryUrl: string, id: string) => `${directoryUrl.replace(/\/+$/, "")}/api/dm-blobs/${id}`;

// ---- Reports of direct messages (26 September 2026, stage 4 of docs/PLAN-reports.md; docs/features/reports.md). A direct message
// lives at the directory and is end-to-end encrypted, so the REPORTER's client sends the plain text: the reported message and,
// unless the reporter unticks it (the user's decision 6: up to 20 preceding messages, opt-out), the preceding messages of that
// conversation as context, both sides. Signed action `report` (POST /api/reports); the payload is the whole content in one fixed
// order (directoryDmReportPayload), so nothing can be swapped under the signature. Only offered with `features.reports`: the
// directory keeps the copy encrypted at rest and needs its key for that. What the directory does with a report is its own business
// (not described in the public repository); the reported person never learns who reported.
export const DM_REPORT_CONTEXT_MAX = 20;
/** One message's text: at most what one encrypted message carries (DM_MAX_CIPHERTEXT_CHARS in friends.ts). */
export const DM_REPORT_MESSAGE_TEXT_MAX = 16_000;
export const DmReportMessage = z.object({ id: Uuid, from: PublicKey, sentAt: Iso, text: z.string().max(DM_REPORT_MESSAGE_TEXT_MAX) });
export type DmReportMessage = z.infer<typeof DmReportMessage>;
export const DmReportContent = z.object({
  kind: z.literal("dm"),
  reason: ReportReason,
  text: z.string().max(REPORT_TEXT_MAX).optional(),
  /** The reported account: the other side of the conversation and the author of `message`. */
  peer: PublicKey,
  message: DmReportMessage,
  /** The messages before it, oldest first, from both sides; empty when the reporter unticked it. */
  context: z.array(DmReportMessage).max(DM_REPORT_CONTEXT_MAX),
});
export type DmReportContent = z.infer<typeof DmReportContent>;
export const DmReportRequest = SignedActionRequest.extend(DmReportContent.shape);
export type DmReportRequest = z.infer<typeof DmReportRequest>;
/** What the reporter signs: the content with its fields in one fixed order, so the directory verifies exactly what it stores. */
export function directoryDmReportPayload(r: DmReportContent): string {
  const msg = (m: DmReportMessage) => ({ id: m.id, from: m.from, sentAt: m.sentAt, text: m.text });
  return JSON.stringify({ kind: r.kind, reason: r.reason, text: r.text ?? "", peer: r.peer, message: msg(r.message), context: r.context.map(msg) });
}
export const DmReportResponse = z.object({ ok: z.literal(true), id: Uuid });
export type DmReportResponse = z.infer<typeof DmReportResponse>;

// ---- Avatars (19 September 2026): one image per handle, shown instead of the initials. The clients crop to a square and scale to
// AVATAR_SIZE before the upload, so the service (which has no image library) only checks type and size. The image is public like the
// handle (GET /api/avatars/<key>). Signed action `avatar-set`, payload "<mime>\n<sha256 hex of the image bytes>" (empty = remove),
// so the image cannot be swapped under the signature. `avatar: null` removes it.
export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_SIZE = 256;
export const AvatarMime = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type AvatarMime = z.infer<typeof AvatarMime>;
export function directoryAvatarPayload(mime: AvatarMime | null, sha256Hex: string | null): string {
  return mime && sha256Hex ? `${mime}\n${sha256Hex}` : "";
}
export const AvatarUpdateRequest = SignedActionRequest.extend({
  avatar: z.object({ mime: AvatarMime, data: z.string().min(1).max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64") }).nullable(),
});
export type AvatarUpdateRequest = z.infer<typeof AvatarUpdateRequest>;
export const AvatarUpdateResponse = z.object({ ok: z.literal(true), avatarUpdatedAt: Iso.nullable() });
export type AvatarUpdateResponse = z.infer<typeof AvatarUpdateResponse>;
/** The image type by its first bytes (PNG, JPEG, WebP); null for anything else. The service stores only what it recognizes. */
export function sniffAvatarMime(b: Uint8Array): AvatarMime | null {
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}
/** SHA-256 of the image bytes as hex (WebCrypto: browser and Node), the second line of the `avatar-set` payload. */
export async function avatarDigest(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join("");
}
/** Address of an account's avatar; `updatedAt` (from DirectoryAccount/Friend/AccountStatus) is the cache version, null = no avatar. */
export function directoryAvatarUrl(directoryUrl: string, publicKey: string, updatedAt: string | null): string | null {
  if (!updatedAt) return null;
  return `${directoryUrl.replace(/\/+$/, "")}/api/avatars/${publicKey}?v=${Date.parse(updatedAt)}`;
}

// ---- Game library (21 September 2026, docs/features/games.md): the directory knows games by the id their launcher gives them
// ("steam:730") and answers with name and icon, which it fetched from the launcher's own catalog. A client that detects a
// running game reports this id and nothing else; whoever shows "plays X" asks the directory, never the playing user or a
// foreign chat server (the trust model of avatars and server icons). `show: false` = not a game (a tool, an application, an
// add-on, or the operator said so): the playing client does not report it and viewers do not show it.
/** Launchers whose catalog the directory can ask. Ids of other sources ("epic:...", "custom:...") stay on the client, with a name only. */
export const GAME_LIBRARY_SOURCES = ["steam", "gog", "xbox"] as const;
export type GameLibrarySource = typeof GAME_LIBRARY_SOURCES[number];
/** "steam:<app id>", "gog:<product id>", "xbox:<store id, upper case>". */
export const LibraryGameId = z.string().max(40).regex(/^(steam:[1-9]\d{0,9}|gog:[1-9]\d{0,11}|xbox:[0-9A-Z]{12})$/, "steam:<Zahl>, gog:<Zahl> oder xbox:<Store-ID>");
export const DirectoryGame = z.object({
  id: LibraryGameId,
  name: z.string().min(1).max(200),
  /** false = known, but not to be shown as a game. */
  show: z.boolean(),
  /** Last change of the icon, null = none; part of the icon's address (`directoryGameIconUrl`). */
  iconUpdatedAt: Iso.nullable(),
});
export type DirectoryGame = z.infer<typeof DirectoryGame>;
export const splitGameId = (id: string): { source: string; key: string } => { const cut = id.indexOf(":"); return { source: id.slice(0, cut), key: id.slice(cut + 1) }; };
export const directoryGameUrl = (directoryUrl: string, id: string): string => `${directoryUrl.replace(/\/+$/, "")}/api/games/${encodeURIComponent(id)}`;
/** Address of a game's icon, null = it has none. Carries the change time, so the answer may be cached for good. */
export function directoryGameIconUrl(directoryUrl: string, game: Pick<DirectoryGame, "id" | "iconUpdatedAt">): string | null {
  if (!game.iconUpdatedAt) return null;
  return `${directoryGameUrl(directoryUrl, game.id)}/icon?v=${Date.parse(game.iconUpdatedAt)}`;
}

// ---- Voice cue settings in the account (16 September 2026): the switches for the four join/leave cues plus one volume follow the
// account across chat servers and devices. The chat client keeps a per-device copy (its "local profile") so servers without a
// directory keep working; with an account it reads the settings via /api/account/status and writes them with the signed
// action `sound-settings`. The payload is the canonical line "<selfJoin><selfLeave><peerJoin><peerLeave>\n<volume>" (1/0 per cue).
// `message` (20 September 2026): the cue for a new direct message or a message that mentions me. Optional on purpose, and NOT part
// of the signed line of `sound-settings` (that one stays as older directories check it): a directory that predates the field drops
// it when it stores the settings, and a client that gets settings without it keeps this device's value instead of a default.
export const SoundSettings = z.object({
  selfJoin: z.boolean(), selfLeave: z.boolean(), peerJoin: z.boolean(), peerLeave: z.boolean(),
  message: z.boolean().optional(),
  /** 0..1, applied on top of the per-tone gain. */
  volume: z.number().min(0).max(1),
});
export type SoundSettings = z.infer<typeof SoundSettings>;
export function directorySoundSettingsPayload(s: SoundSettings): string {
  const bit = (b: boolean) => (b ? "1" : "0");
  return `${bit(s.selfJoin)}${bit(s.selfLeave)}${bit(s.peerJoin)}${bit(s.peerLeave)}\n${s.volume}`;
}
export const SoundSettingsUpdateRequest = SignedActionRequest.extend({ soundSettings: SoundSettings });

// ---- All client settings in the account (17 September 2026, user's wish: every user setting follows the directory account and can be
// changed from the client of any chat server). Everything except the device selection (microphone, outputs, camera: device ids are
// per browser) lives here. Every field has a default, so objects stored by older clients stay valid. Written with the signed action
// `settings`: the request carries the settings as a JSON *string* and exactly that string is the signature's payload (no canonical
// form needed); the directory parses it with `AccountSettings` afterwards. `sound-settings` stays for clients that predate this; the
// directory keeps `sounds` here and the older `soundSettings` in step.
export const ACCOUNT_SETTINGS_MAX_LENGTH = 4000;
export const AccountSettings = z.object({
  /** UI language of the chat client ("auto" = follow the browser). */
  locale: z.enum(["auto", "de", "en"]).default("auto"),
  voice: z.object({
    mode: z.enum(["vad", "ptt"]).default("vad"),
    /** KeyboardEvent.code, e.g. "Space". */
    pttKey: z.string().min(1).max(40).default("Space"),
    vadThreshold: z.number().min(0).max(1).default(0.04),
    vadHangoverMs: z.number().int().min(100).max(1500).default(400),
  }).default({}),
  camera: z.object({
    quality: z.enum(["360p", "720p"]).default("720p"),
    /** Background blur radius, 0 = off. */
    blur: z.number().min(0).max(100).default(0),
  }).default({}),
  sounds: SoundSettings.default({ selfJoin: true, selfLeave: true, peerJoin: true, peerLeave: true, volume: 0.6 }),
  stage: z.object({
    /** Speaker view: may you yourself be shown large as the active speaker? */
    featureSelf: z.boolean().default(true),
  }).default({}),
  /**
   * Game display (21 September 2026): `enabled` = detect running games and show friends what I play (off by default),
   * `servers` = show it to the members of my chat servers too (the opt-out inside the feature). Optional without a default on
   * purpose: an account stored before it, or by a directory that does not know it, says nothing, and the device's value stays.
   */
  games: z.object({ enabled: z.boolean().default(false), servers: z.boolean().default(true) }).optional(),
});
export type AccountSettings = z.infer<typeof AccountSettings>;
export const AccountSettingsUpdateRequest = SignedActionRequest.extend({ settings: z.string().min(2).max(ACCOUNT_SETTINGS_MAX_LENGTH) });
/** The settings in a stored or received JSON string; null when it is not valid JSON or does not fit the schema. */
export function parseAccountSettings(json: string | null | undefined): AccountSettings | null {
  if (!json) return null;
  try { const r = AccountSettings.safeParse(JSON.parse(json)); return r.success ? r.data : null; } catch { return null; }
}

// ---- Sealed settings (21 September 2026, user's wish: only the user can read what the account stores about them). The client
// encrypts the settings before they leave it, and the directory keeps a blob it cannot read:
//
//   key  = HKDF-SHA256(the 32-byte seed of the identity key, salt = the public key, info "squorli-settings-v1") -> AES-256-GCM
//   blob = AES-GCM(key, random 12-byte IV, JSON of `SealedSettingsContent` padded with spaces to a multiple of 1024 bytes,
//          AAD = "squorli-settings-v1\n<public key>")
//
// Every device that has the seed (the key backup restores it) derives the same key, so there is no second password. The
// directory can neither read nor change the content; it can only hand out an older blob of the same account. Written with the
// signed action `settings-sealed`: the request carries the blob as a JSON *string* and exactly that string is signed, as with
// `settings`. `features.settingsSealed` tells the client that the route exists. An account that has a sealed blob has no plaintext
// settings any more: the directory deletes `settings` and `soundSettings` with the first sealed write and refuses the two older
// actions with 409 `settings_sealed` from then on (clients that predate this keep their device's settings). A client that finds
// plaintext settings only seals them at once. Because nobody else can read it, the content also carries what must not be stored
// in the open: the games the user never wants shown (launcher ids only, never the path of an added program), the order of
// the server rail (22 September 2026: user settings are always stored encrypted, so it never goes into `AccountSettings`), and
// the people the user has blocked (27 September 2026, reports stage 3: public keys, so a block holds on every server; no server
// and not the directory learns whom somebody blocks, the block is a view of this user's client alone).
export const SEALED_SETTINGS_MAX_LENGTH = 100_000;
export const HIDDEN_GAMES_MAX = 1000;
export const HIDDEN_GAME_ID_MAX = 64;
export const SERVER_ORDER_MAX = 100;
export const BLOCKED_USERS_MAX = 200;
export const SERVER_HOST_MAX = 253;
export const SealedSettings = z.object({ v: z.literal(1), iv: z.string().regex(/^[0-9a-f]{24}$/), ciphertext: z.string().min(24).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
export type SealedSettings = z.infer<typeof SealedSettings>;
export const SealedSettingsContent = z.object({
  settings: AccountSettings,
  /** Games never to show to anybody, by the launcher's id. Left out = the account says nothing (the device's list stays). */
  hiddenGames: z.array(z.string().min(1).max(HIDDEN_GAME_ID_MAX)).max(HIDDEN_GAMES_MAX).optional(),
  /** The server rail as the user arranged it: directory hosts, first at the top. Left out = the account says nothing (the device's order stays). */
  serverOrder: z.array(z.string().min(1).max(SERVER_HOST_MAX)).max(SERVER_ORDER_MAX).optional(),
  /** People this user has blocked, by public key (their messages folded, their voice silent, their mentions not counted). Left out = the account says nothing (the device's list stays). */
  blockedUsers: z.array(PublicKey).max(BLOCKED_USERS_MAX).optional(),
  /** Link previews in direct messages (false = none are made for what this user sends, and none are shown of what they receive). Left out = the account says nothing (the device's choice stays). */
  dmLinkPreviews: z.boolean().optional(),
});
export type SealedSettingsContent = z.infer<typeof SealedSettingsContent>;
export const SealedSettingsUpdateRequest = SignedActionRequest.extend({ sealed: z.string().min(2).max(SEALED_SETTINGS_MAX_LENGTH) });
/** The blob in a stored or received JSON string; null when it is not valid JSON or does not fit the schema. */
export function parseSealedSettings(json: string | null | undefined): SealedSettings | null {
  if (!json) return null;
  try { const r = SealedSettings.safeParse(JSON.parse(json)); return r.success ? r.data : null; } catch { return null; }
}
const SEALED_SETTINGS_INFO = "squorli-settings-v1";
const SEALED_SETTINGS_PAD = 1024;
const sealedUtf8 = (s: string) => new TextEncoder().encode(s);
const sealedAad = (publicKeyHex: string) => sealedUtf8(`${SEALED_SETTINGS_INFO}\n${publicKeyHex}`);
/** The key of an account's sealed settings, from the identity's seed (hex); cache it in the client. */
export async function deriveSettingsKey(seedHex: string, publicKeyHex: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const hk = await subtle.importKey("raw", hexToBytes(seedHex), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sealedUtf8(publicKeyHex), info: sealedUtf8(SEALED_SETTINGS_INFO) }, hk, 256);
  return subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealSettings(key: CryptoKey, publicKeyHex: string, content: SealedSettingsContent): Promise<SealedSettings> {
  const json = JSON.stringify(content);
  // Spaces after the JSON (a parser skips them) hide how long the content is, up to the next step.
  const plain = sealedUtf8(json);
  const padded = new Uint8Array(Math.ceil(plain.length / SEALED_SETTINGS_PAD) * SEALED_SETTINGS_PAD).fill(0x20);
  padded.set(plain);
  const iv = randomHex(12);
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: hexToBytes(iv), additionalData: sealedAad(publicKeyHex) }, key, padded));
  // In steps: `bytesToBase64` spreads the whole array into one call, which a long hide list would overflow.
  let binary = "";
  for (let i = 0; i < ct.length; i += 0x8000) binary += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  return { v: 1, iv, ciphertext: btoa(binary) };
}
/** The content of a blob; null when the key is another one, the blob was changed or the content does not fit. A hidden id, a host or a blocked key that does not fit is dropped alone. */
export async function openSettings(key: CryptoKey, publicKeyHex: string, sealed: SealedSettings): Promise<SealedSettingsContent | null> {
  try {
    const pt = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: hexToBytes(sealed.iv), additionalData: sealedAad(publicKeyHex) }, key, base64ToBytes(sealed.ciphertext));
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as { settings?: unknown; hiddenGames?: unknown; serverOrder?: unknown; blockedUsers?: unknown; dmLinkPreviews?: unknown };
    const settings = AccountSettings.safeParse(parsed.settings);
    if (!settings.success) return null;
    const hiddenGames = Array.isArray(parsed.hiddenGames)
      ? [...new Set(parsed.hiddenGames.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= HIDDEN_GAME_ID_MAX))].slice(0, HIDDEN_GAMES_MAX) : undefined;
    const serverOrder = Array.isArray(parsed.serverOrder)
      ? [...new Set(parsed.serverOrder.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0 && h.length <= SERVER_HOST_MAX))].slice(0, SERVER_ORDER_MAX) : undefined;
    const blockedUsers = Array.isArray(parsed.blockedUsers)
      ? [...new Set(parsed.blockedUsers.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase()).filter((k) => PublicKey.safeParse(k).success))].slice(0, BLOCKED_USERS_MAX) : undefined;
    return { settings: settings.data, ...(hiddenGames ? { hiddenGames } : {}), ...(serverOrder ? { serverOrder } : {}), ...(blockedUsers ? { blockedUsers } : {}), ...(typeof parsed.dmLinkPreviews === "boolean" ? { dmLinkPreviews: parsed.dmLinkPreviews } : {}) };
  } catch { return null; }
}
/** A chat server that has looked up the key (a sign-in there), with the display name that applies there (account page). `verified` = registered with the directory. */
export const AccountServer = z.object({
  host: ServerHost, name: z.string().nullable(), displayName: DisplayName.nullable(), lastSeenAt: Iso, verified: z.boolean().default(false),
  /** The server's icon at the directory (M6d): time it was last taken over, null = none. URL: directoryServerIconUrl(). */
  iconUpdatedAt: Iso.nullable().default(null),
  /** Account deletion on that server requested (server-leave) but not yet confirmed by the server; null = none pending. */
  leaveRequestedAt: Iso.nullable().default(null),
});

// ---- Delete the account on one chat server (server-leave): the user signs the action with the server's host as the payload
// (from the account page or from the chat client), the directory marks the entry and pushes
// POST <proofUrl base>/api/directory/leave {publicKey} to that server. The server confirms with its bearer token via
// POST /api/servers/leave/confirm (the directory answers 200 only for a pending request of exactly that host and removes the entry),
// then deletes the user locally. A stranger posting to the server's endpoint can therefore only trigger a check.
// Servers that missed the push pick pending requests up with GET /api/servers/leaves during their periodic reconciliation.
export const ServerLeaveRequest = SignedActionRequest.extend({ server: ServerHost });
/** `delivered` = the server confirmed and deleted the account during the request; false = pending (server unreachable) or, for an unregistered server, only the list entry was removed. */
export const ServerLeaveResponse = z.object({ ok: z.literal(true), server: ServerHost, delivered: z.boolean(), registered: z.boolean() });
export const DirectoryLeaveRequest = z.object({ publicKey: PublicKey });
export const ServerLeaveConfirmRequest = z.object({ publicKey: PublicKey });
export const ServerLeavesResponse = z.object({ publicKeys: z.array(PublicKey) });

// ---- Outside probe of a registered chat server (docs/features/doctor.md, 25 September 2026): POST /api/servers/probe with the
// server's token. The directory tries the server's public address from where it stands (the operator's own machine cannot
// tell whether its own ports are open from outside): the health route with the certificate, the WebSocket upgrade, /rtc
// through the proxy and one TCP connect to the media port. UDP cannot be probed this way (nothing answers a bare packet);
// the client's own media connection is the UDP check.
export const ServerProbeRequest = z.object({
  /** LiveKit's TCP media port (LIVEKIT_TCP_PORT, default 7881); empty = no TCP probe. */
  tcpPort: z.number().int().min(1).max(65535).optional(),
});
/** One probe: `error` is a short code or message when it failed (ENOTFOUND, CERT_HAS_EXPIRED, "timeout", "status 502"). */
export const ProbeResult = z.object({ ok: z.boolean(), status: z.number().int().nullable().default(null), error: z.string().nullable().default(null), ms: z.number().int().nonnegative().nullable().default(null) });
export const ServerProbeResponse = z.object({
  host: ServerHost,
  /** The address the host resolved to at the directory (null = did not resolve). */
  address: z.string().nullable(),
  /** GET /api/health: `keyMatches` = the answer carried this server's key (null when there was no JSON answer). */
  health: ProbeResult.extend({ keyMatches: z.boolean().nullable().default(null) }),
  /** A WebSocket to /api/ws opened (the proxy passes the upgrade). */
  websocket: ProbeResult,
  /** GET /rtc/validate answered 401 (the proxy forwards /rtc to LiveKit). */
  rtc: ProbeResult,
  /** One TCP connect to the media port; null when none was asked for or the address is not public. */
  tcp: ProbeResult.extend({ port: z.number().int() }).nullable(),
});
export type ServerLeaveRequest = z.infer<typeof ServerLeaveRequest>;
export type ServerLeaveResponse = z.infer<typeof ServerLeaveResponse>;
export type ServerLeavesResponse = z.infer<typeof ServerLeavesResponse>;

// ---- Server registration: a chat server proves its key (signature over host + nonce) and control over
// its host (the directory reads `proofUrl`, the server's /api/health, and compares `serverKey`). After that it may use the
// token (bearer, 24 h, re-register on a 401) to read the handle and display name of its users; without a token there is only handle + key.
export function directoryServerRegisterMessage(directoryHost: string, host: string, nonce: string): string {
  return `community-directory-server-register\n${directoryHost}\n${host}\n${nonce}`;
}
export const ServerRegisterRequest = z.object({
  host: ServerHost,
  name: z.string().trim().max(80).nullable().default(null),
  publicKey: PublicKey,
  challengeId: Uuid,
  signature: Signature,
  /** The chat server's /api/health; must point at `host` (https; http only for localhost/127.0.0.1) and return `serverKey` = publicKey. */
  proofUrl: z.string().url(),
  /** Server directory (M6d): list publicly? Plus description, open join and member count (display only). */
  listed: z.boolean().default(false),
  description: z.string().trim().max(200).nullable().default(null),
  openJoin: z.boolean().default(false),
  memberCount: z.number().int().min(0).nullable().default(null),
});
/**
 * Entry in the public server directory (M6d, GET /api/servers: only servers with `listed` whose token has not expired).
 * The directory fetches the icon itself from <proofUrl base>/api/server-icon on every registration (the host is proven) and
 * serves it under GET /api/servers/<host>/icon; so clients load icons only from the directory, never from foreign servers.
 */
export const DirectoryServer = z.object({
  host: ServerHost,
  name: z.string().nullable(),
  description: z.string().nullable(),
  openJoin: z.boolean(),
  memberCount: z.number().int().nullable(),
  iconUpdatedAt: Iso.nullable(),
  registeredAt: Iso,
});
export const ServerListResponse = z.array(DirectoryServer);
/** URL of the server icon at the directory (with a version parameter, cacheable for a long time); null = no icon. */
export function directoryServerIconUrl(dirUrl: string, host: string, iconUpdatedAt: string | null): string | null {
  return iconUpdatedAt ? `${dirUrl}/api/servers/${encodeURIComponent(host)}/icon?v=${Date.parse(iconUpdatedAt)}` : null;
}
/** Link to the chat server: https, except for localhost/127.0.0.1 (dev). */
export function directoryServerUrl(host: string): string {
  return `${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"}://${host}`;
}
export const ServerRegisterResponse = z.object({ host: ServerHost, token: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: Iso });
/** Bulk query by a registered server (bearer token): handle + names for many keys at once (periodic reconciliation). Unknown keys are absent from the response. */
export const ServerResolveRequest = z.object({ publicKeys: z.array(PublicKey).min(1).max(200) });
export const ServerResolveResponse = z.array(DirectoryAccount);
/**
 * Push from the directory to a registered chat server (POST <proofUrl base>/api/directory/notify) after a name change:
 * only the key, no data. The server fetches the state itself with its token (which is why the push needs no signature;
 * a stranger can at most trigger a superfluous fetch).
 */
export const DirectoryNotifyRequest = z.object({ publicKey: PublicKey });
export type ServerResolveRequest = z.infer<typeof ServerResolveRequest>;
export type ServerRegisterRequest = z.infer<typeof ServerRegisterRequest>;
export type ServerRegisterResponse = z.infer<typeof ServerRegisterResponse>;
export type DirectoryServer = z.infer<typeof DirectoryServer>;

/** Response to totp-setup: secret (base32, 20 bytes) for the QR code and for typing in; it only becomes active with totp-enable. */
export const TotpSetupResponse = z.object({ secret: z.string().regex(/^[A-Z2-7]{32}$/), otpauth: z.string().url(), issuer: z.string() });
/** Recovery codes are shown in plain text exactly once; the service stores hashes only. */
export const RecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()).length(10) });
/** One key retrieval via backup (M6c, display only): when, which browser, from which site, with which factor. */
export const KeyFetch = z.object({
  at: Iso,
  label: z.string().nullable(),
  origin: z.string().nullable(),
  factor: z.enum(["password", "totp", "recovery", "email"]),
});
export const AccountStatus = DirectoryAccount.extend({
  totpEnabled: z.boolean(),
  /** Secret generated but not yet confirmed with a code. */
  totpPending: z.boolean(),
  recoveryCodesLeft: z.number().int().min(0),
  fetches: z.array(KeyFetch),
  servers: z.array(AccountServer),
  /** Voice cue settings stored in the account; null = never set (the client keeps its per-device settings). */
  soundSettings: SoundSettings.nullable().default(null),
  /** All client settings stored in the account (action `settings`); null = never set or a directory that predates them. */
  settings: AccountSettings.nullable().default(null),
  /** The settings as a blob only the user can read (action `settings-sealed`); null = none. An account that has one has no `settings` and no `soundSettings`. */
  settingsSealed: SealedSettings.nullable().default(null),
  /** Confirmed e-mail address (null = none) and an address waiting for its confirmation code (null = none). */
  email: EmailAddress.nullable().default(null),
  emailPending: EmailAddress.nullable().default(null),
});

export const DirectoryHealth = z.object({
  ok: z.literal(true),
  service: z.literal("directory"),
  /** Host that registration signatures are bound to. */
  host: z.string(),
  /** `friends` (M7): friends and direct messages over the WebSocket /api/ws. `email`: SMTP configured (address, notices, e-mail code). `settings`: the account stores all client settings (action `settings`). `afk`: the socket takes `activity` and friends carry `afk` (AFK detection). `emailRequired`: new handles need a confirmed e-mail address (REQUIRE_EMAIL; registration in two steps, see DirectoryRegisterRequest). `avatars`: the account stores one avatar image (action `avatar-set`, GET /api/avatars/<key>). `settingsSealed`: the account stores the settings as a blob the client encrypts (action `settings-sealed`). `probe`: POST /api/servers/probe exists (a registered server's setup check from outside, docs/features/doctor.md). `reports`: POST /api/reports takes a report of a direct message (action `report`; docs/features/reports.md). */
  features: z.object({ backup: z.boolean(), totp: z.boolean(), email: z.boolean(), friends: z.boolean().default(false), settings: z.boolean().default(false), settingsSealed: z.boolean().default(false), afk: z.boolean().default(false), emailRequired: z.boolean().default(false), avatars: z.boolean().default(false), gameLibrary: z.boolean().default(false), dmPreviews: z.boolean().default(false), probe: z.boolean().default(false), reports: z.boolean().default(false) }),
  time: Iso,
});

export type DirectoryRegisterRequest = z.infer<typeof DirectoryRegisterRequest>;
export type DirectoryAccount = z.infer<typeof DirectoryAccount>;
export type DirectoryHealth = z.infer<typeof DirectoryHealth>;
export type BackupParams = z.infer<typeof BackupParams>;
export type BackupUploadRequest = z.infer<typeof BackupUploadRequest>;
export type BackupBlob = z.infer<typeof BackupBlob>;
export type TotpSetupResponse = z.infer<typeof TotpSetupResponse>;
export type RecoveryCodesResponse = z.infer<typeof RecoveryCodesResponse>;
export type KeyFetch = z.infer<typeof KeyFetch>;
export type AccountStatus = z.infer<typeof AccountStatus>;
export type AccountServer = z.infer<typeof AccountServer>;
export type ServerProbeRequest = z.infer<typeof ServerProbeRequest>;
export type ServerProbeResponse = z.infer<typeof ServerProbeResponse>;
export type ProbeResult = z.infer<typeof ProbeResult>;

/**
 * The chat server's sign-in message (index.ts `challengeMessage` is this): what a user signs for a server's domain when
 * signing in there. The chat server passes the nonce and that signature to the directory as the proof that the user really
 * signed in there (security review of 25 September 2026: until then any registered server could add itself to any
 * account's server list by looking the key up). Query parameters `nonce` and `sig` on GET /api/keys/:key.
 */
export function chatLoginMessage(domain: string, nonce: string): string {
  return `community-chat-login\n${domain}\n${nonce}`;
}
export const LoginProofNonce = z.string().regex(/^[0-9a-f]{64}$/);
