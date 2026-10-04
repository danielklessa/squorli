/**
 * Server accounts (docs/features/local-accounts.md, 25 September 2026): a chat server keeps accounts of its own, shown as
 * `~name`, next to the directory's `@name`. A key without either no longer gets in (no temporary users). Like the directory's
 * key backup (backup.ts), the client encrypts the account's 32-byte seed with a password and the server stores only the
 * ciphertext and the SHA-256 of the auth key; signing in on another device = fetch the blob with handle + password, open it,
 * then sign the usual challenge. Every server account has a key of its own: it never replaces the client's directory key.
 */
import { z } from "zod";
import { AvatarMime, AVATAR_MAX_BYTES, BackupAuthKey, BackupParams, DeviceInfo, DeviceProofFields, Handle } from "./directory";
import { Iso, PublicKey, Signature, Uuid } from "./primitives";

/** Prefix of a server account's handle; directory handles keep `@`. */
export const LOCAL_HANDLE_PREFIX = "~";
export const DIRECTORY_HANDLE_PREFIX = "@";

/** Handle of a server account: the same rules as a directory handle, its own namespace per server. */
export const LocalHandle = Handle;

/** `@name` for a directory account, else `~name` for a server account, null for neither. A directory handle wins. */
export function handleLabel(u: { handle?: string | null; localHandle?: string | null }): string | null {
  if (u.handle) return `${DIRECTORY_HANDLE_PREFIX}${u.handle}`;
  if (u.localHandle) return `${LOCAL_HANDLE_PREFIX}${u.localHandle}`;
  return null;
}

/**
 * What a typed sign-in name means: the prefix decides (`@` = directory, `~` = this server). Without one it is the directory
 * when the server has one, else the server account. `name` is lowercased and trimmed but not validated.
 */
export function parseLoginName(input: string, hasDirectory: boolean): { kind: "directory" | "local"; name: string } {
  const s = input.trim();
  if (s.startsWith(DIRECTORY_HANDLE_PREFIX)) return { kind: "directory", name: s.replace(/^@+/, "").trim().toLowerCase() };
  if (s.startsWith(LOCAL_HANDLE_PREFIX)) return { kind: "local", name: s.replace(/^~+/, "").trim().toLowerCase() };
  return { kind: hasDirectory ? "directory" : "local", name: s.toLowerCase() };
}

/** The encrypted seed as the client made it with `createBackup` (backup.ts). */
export const LocalBackup = z.object({
  /** base64, AES-GCM over the 32-byte seed (48 bytes). */
  ciphertext: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(512),
  params: BackupParams,
  authKey: BackupAuthKey,
});
export type LocalBackup = z.infer<typeof LocalBackup>;

/** Registration is signed like the sign-in: bound to the server's domain and the challenge, and covering handle and ciphertext. */
export function localRegisterMessage(domain: string, nonce: string, handle: string, ciphertext: string): string {
  return `squorli-local-register\n${domain}\n${nonce}\n${handle}\n${ciphertext}`;
}

/** POST /api/local/register: a new key registers a server account and signs in (answers like /api/auth/verify). */
export const LocalRegisterRequest = z.object({
  challengeId: Uuid,
  publicKey: PublicKey,
  signature: Signature,
  handle: LocalHandle,
  backup: LocalBackup,
  invite: z.string().regex(/^[A-Za-z0-9_-]{6,32}$/).optional(),
  /** The server's owner setup code (OWNER_SETUP_CODE): this registration becomes the owner while none exists. */
  ownerCode: z.string().trim().min(1).max(128).optional(),
  /** The account's first device (directory.ts "Devices"): proof over `localRegisterMessage`; with it the account is enforced from birth. */
  ...DeviceProofFields,
  /** The session is bound to the device (index.ts "Sessions bound to the device"). */
  bindDevice: z.boolean().optional(),
});
export type LocalRegisterRequest = z.infer<typeof LocalRegisterRequest>;

/**
 * The claim of a member from before (25 September 2026, security review): the member gets a fresh key for this server and
 * the membership moves to it. Both keys sign this over one challenge (requested for the old key): the old one proves it is
 * the member, the new one that the client holds it. Until then the claim uploaded the old key itself, often the main
 * identity used everywhere, encrypted only with the password and kept by this server.
 */
export function localClaimMessage(domain: string, nonce: string, handle: string, newPublicKey: string, ciphertext: string): string {
  return `squorli-local-claim\n${domain}\n${nonce}\n${handle}\n${newPublicKey}\n${ciphertext}`;
}

/** POST /api/local/claim (session of a member from before without any account): register a server account on a fresh key. */
export const LocalClaimRequest = z.object({
  handle: LocalHandle,
  /** The backup of the NEW key. */
  backup: LocalBackup,
  /** Challenge of the old key (the session's), both signatures over `localClaimMessage`. */
  challengeId: Uuid,
  newPublicKey: PublicKey,
  signature: Signature,
  newSignature: Signature,
  /** The new account's first device: proof over `deviceProofMessage(newPublicKey, localClaimMessage(...))`; the session kept is that device's from then on. */
  ...DeviceProofFields,
  /** The session kept is bound to the device from now on (index.ts "Sessions bound to the device"). */
  bindDevice: z.boolean().optional(),
});
export type LocalClaimRequest = z.infer<typeof LocalClaimRequest>;

/** GET /api/local/handles/:handle */
export const LocalHandleResponse = z.object({ available: z.boolean() });
/** GET /api/local/backup/:handle/params: salt and iterations, so the client can derive the auth key. */
export const LocalBackupParamsResponse = BackupParams.omit({ iv: true });
/**
 * POST /api/local/backup/fetch. `deviceKey` enrols the asking device (`deviceSignature` over `deviceEnrolMessage` with the
 * server's domain). At DEVICE_MAX devices the answer is 409 `too_many_devices` with the list (`TooManyDevicesResponse`,
 * no ticket: there is no second factor here), and the request is repeated with `replaceDevice`.
 */
export const LocalBackupFetchRequest = z.object({ handle: LocalHandle, authKey: BackupAuthKey, ...DeviceProofFields, replaceDevice: Uuid.optional() });
export const LocalBackupBlob = z.object({ handle: LocalHandle, publicKey: PublicKey, ciphertext: z.string(), params: BackupParams, updatedAt: Iso });
export type LocalBackupBlob = z.infer<typeof LocalBackupBlob>;
/** PUT /api/local/backup (session): a new password = a new backup of the same seed; the old auth key proves the old password. */
export const LocalPasswordChangeRequest = z.object({ oldAuthKey: BackupAuthKey, backup: LocalBackup });
/** DELETE /api/me (session) for a server account: the auth key proves the password. */
export const LocalDeleteRequest = z.object({ authKey: BackupAuthKey });
/**
 * Devices of a server account (directory.ts "Devices"; `devices: true` in GET /api/health is the feature flag): GET /api/me/devices
 * answers `DevicesResponse`; DELETE /api/me/devices/:id and /others sign other devices out and need the password's auth
 * key (the first one makes the account enforced), DELETE /api/me/devices/current signs the asking device out without one.
 */
export const LocalDeviceRevokeRequest = z.object({ authKey: BackupAuthKey });
export const DevicesResponse = z.array(DeviceInfo);
export type DevicesResponse = z.infer<typeof DevicesResponse>;

/** PUT /api/me/avatar (session, server accounts only): the picture as the client cropped and scaled it (like the directory's). */
export const LocalAvatarRequest = z.object({
  mime: AvatarMime,
  data: z.string().min(1).max(Math.ceil(AVATAR_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64"),
});
export type LocalAvatarRequest = z.infer<typeof LocalAvatarRequest>;

/** Error codes of the server accounts and the account rule (REST only). */
export const LocalAccountErrorCode = z.enum([
  "registration_required", "handle_taken", "local_accounts_off", "has_account", "auth_invalid", "unknown_account", "use_directory", "rate_limited",
  "device_refused", "too_many_devices",
]);
