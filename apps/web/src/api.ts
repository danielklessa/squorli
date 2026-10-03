import {
  AccountStatus, Ban, ChallengeResponse, DirectoryAccount, DirectoryHealth, DirectoryRegisterPending, EmailAddress, EmailCode, EmailCodeResponse, FriendSearchResponse, ServerLeaveResponse, ServerListResponse, Handle, Invite, InvitePreview, Me, Message, MessagePage, RtcTokenResponse, ServerState, SessionInfo, VerifyResponse,
  AvatarUpdateResponse, avatarDigest, directoryAvatarPayload,
  BackupBlob, BackupParamsResponse, challengeMessage, createBackup, deriveBackupKeys, directoryActionMessage, directoryBackupMessage, directoryDmReportPayload, DmReportResponse, type DmReportContent, directoryProfilePayload,
  directoryRegisterMessage, directorySoundSettingsPayload, openBackup, type AccountSettings, type SealedSettings, type SoundSettings,
  MuteState, ReadStateResponse, StatusApiKeyResponse, DoctorReport, LimitsReport, ReportsResponse, ModLogResponse, type CreateReportRequest, type CloseReportRequest, type DeleteRecentHours, type Attachment, type Category, type Channel, type RadioStation, type Role, type StatusApiMode,
  type DiscordImportRequest, type DiscordImportResult, type ImportPlan,
  LocalBackupBlob, LocalBackupParamsResponse, LocalHandle, LocalHandleResponse, localRegisterMessage,
  DmBlobPutResponse, LinkLookupResponse, directoryDmBlobUrl, directoryLinkLookupPayload, OverwritesResponse, type PermissionOverwrite, type ChannelNotification, type ChannelBlock, type ChannelBlockMinutes,
  localClaimMessage,
  NoticeReadResponse, RefusedServersResponse, directoryRefusedServersUrl, directoryReportPayload, reportKindsOf, suspendedUntilOf, type AccountNotice, type DirectoryReportContent,
  DeviceRevokeResponse, DevicesResponse, type DeviceRevokeTarget, type DirectoryAction,
} from "@squorli/protocol";
import { z } from "zod";
import { toBase64, type AvatarImage } from "./avatarImage";
import { type Identity, type NewDevice, enrolFields, identityFromPrivateKey, sign, signBoth } from "./identity";
import { fmtDateTime, t } from "./i18n";
import { connectedHost } from "./serverHost";

/** How long /api/health and /api/me may take before a server counts as not answering (docs/features/offline.md). */
export const HEALTH_TIMEOUT_MS = 10_000;
export const ME_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(method: string, path: string, readonly status: number, readonly code: string | null, readonly body: Record<string, unknown>) {
    super(`${method} ${path} -> ${status}${code ? ` (${code})` : ""}`);
  }
}

/**
 * Access to one chat server. `base` = "" for the server that serves this client (relative paths, Vite proxy in dev),
 * otherwise the origin of a foreign server (multi-server client: the server rail switches between servers without leaving
 * the page; foreign servers answer thanks to CORS with a bearer token). Each instance has its own session token.
 */
/** PATCH /api/channels/:id: everything the channel dialog edits (the channel settings since 23 September 2026). */
export type ChannelPatch = {
  name?: string; topic?: string | null; categoryId?: string | null; position?: number; audioBitrate?: number; audioStereo?: boolean;
  sticky?: boolean; stickyPersist?: boolean; stickyHideVoice?: boolean; userLimit?: number | null; slowmodeSeconds?: number; defaultNotify?: ChannelNotification; allowRadio?: boolean; allowVideo?: boolean; allowVoteKick?: boolean;
};

export class ServerApi {
  private token: string | null = null;
  /** Called when the server rejects a set token with a 401 (expired, or signed out from another device, M6c), with the answer's code (`device_refused`: docs/features/devices.md). */
  onUnauthorized: ((code: string | null) => void) | null = null;
  constructor(readonly base: string) {}
  /**
   * The host a server account's backup is bound to (backup.ts `context`): the hostname this client reaches the server at,
   * never what the server says about itself; without a port, so browser, desktop app and a dev proxy agree.
   */
  private get bindHost(): string {
    try { return (this.base ? new URL(this.base).hostname : globalThis.location.hostname).toLowerCase(); } catch { return ""; }
  }
  setToken(t: string | null) { this.token = t; }
  getToken() { return this.token; }
  /** Resolve a relative server URL (attachments, server icon) against this server. */
  abs(url: string): string { return this.base && url.startsWith("/") ? `${this.base}${url}` : url; }

  /**
   * `timeoutMs` (docs/features/offline.md): a machine that is off or a firewall that swallows packets lets a fetch hang for
   * minutes; the requests that decide whether a server answers at all give up after this long (a `TimeoutError`, not an
   * `ApiError`, so the session is kept and tried again).
   */
  private async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; form?: FormData; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    const init: RequestInit = { method, headers };
    if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
    if (opts.form) init.body = opts.form;
    else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const withAuth = opts.auth !== false && !!this.token;
    if (withAuth) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.base}${path}`, init);
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.status === 401 && withAuth) this.onUnauthorized?.(typeof b.error === "string" ? b.error : null);
      throw new ApiError(method, path, res.status, typeof b.error === "string" ? b.error : null, b);
    }
    return (await res.json()) as T;
  }

  // ---------- Auth
  /** Sign in: the signature is bound to `domain` (the server's PUBLIC_DOMAIN; own server = the hostname in the address bar). */
  async login(id: Identity, domain: string, invite?: string): Promise<VerifyResponse> {
    const challenge = ChallengeResponse.parse(await this.request("POST", "/api/auth/challenge", { publicKey: id.publicKey }, { auth: false }));
    // The device signs along (docs/features/devices.md); a server from before devices drops its two fields.
    const signed = await signBoth(id, challengeMessage(domain, challenge.nonce));
    return VerifyResponse.parse(await this.request("POST", "/api/auth/verify",
      { challengeId: challenge.challengeId, publicKey: id.publicKey, ...signed, ...(invite ? { invite } : {}) }, { auth: false }));
  }
  getHealth() { return this.request<Health>("GET", "/api/health", undefined, { auth: false, timeoutMs: HEALTH_TIMEOUT_MS }); }

  // ---------- Server accounts (`~name`, docs/features/local-accounts.md): the key is encrypted here with the password, the
  // server keeps only the ciphertext and the SHA-256 of the auth key, as the directory does (backup.ts).
  async localHandleFree(rawHandle: string): Promise<boolean> {
    const handle = LocalHandle.parse(rawHandle);
    return LocalHandleResponse.parse(await this.request("GET", `/api/local/handles/${encodeURIComponent(handle)}`, undefined, { auth: false })).available;
  }
  /** Register a server account for `id` (a fresh key) and sign in with it; the signature binds handle and ciphertext to `domain`. */
  async localRegister(id: Identity, domain: string, rawHandle: string, password: string, invite?: string, ownerCode?: string): Promise<VerifyResponse> {
    const handle = LocalHandle.parse(rawHandle);
    const backup = await createBackup(password, id.privateKey, undefined, this.bindHost);
    const challenge = ChallengeResponse.parse(await this.request("POST", "/api/auth/challenge", { publicKey: id.publicKey }, { auth: false }));
    const signed = await signBoth(id, localRegisterMessage(domain, challenge.nonce, handle, backup.ciphertext));
    return VerifyResponse.parse(await this.request("POST", "/api/local/register",
      { challengeId: challenge.challengeId, publicKey: id.publicKey, ...signed, handle, backup, ...(invite ? { invite } : {}), ...(ownerCode ? { ownerCode } : {}) }, { auth: false }));
  }
  /**
   * The keys of a password, derived with the account's stored salt and iterations and bound to the host this client reaches the
   * server at. Parameters that do not say `bound` are refused (security audit C2, 3 October 2026): the server chooses salt and
   * iterations, and an unbound derivation with the ones the directory shows for a handle is the very auth key of the directory
   * account, which a foreign server could collect from whoever reuses that password. Backups of before 25 September 2026 were
   * unbound (and this client used to bind them at the next sign-in); they no longer sign in.
   */
  private async localKeys(handle: string, password: string) {
    const p = LocalBackupParamsResponse.parse(await this.request("GET", `/api/local/backup/${encodeURIComponent(handle)}/params`, undefined, { auth: false }));
    if (!p.bound) throw new Error(t("err.backupNotBound"));
    return deriveBackupKeys(password, p.salt, p.iterations, this.bindHost);
  }
  /**
   * Signing in on another device: fetch the account's key with handle + password and open it.
   * `enrol`: this installation's new device, enrolled with the fetch (docs/features/devices.md; its proof is bound to
   * `domain`, the host this client signs for). At the limit of devices the server answers 409 `too_many_devices` with the
   * list; the call comes again with `replaceDevice`, the device the user picked to make way.
   */
  async localRestore(rawHandle: string, password: string, enrol?: { device: NewDevice; domain: string; replaceDevice?: string | undefined }): Promise<Identity> {
    const handle = LocalHandle.parse(rawHandle);
    const keys = await this.localKeys(handle, password);
    const device = enrol ? { ...(await enrolFields(enrol.device, enrol.domain, handle)), ...(enrol.replaceDevice ? { replaceDevice: enrol.replaceDevice } : {}) } : {};
    const blob = LocalBackupBlob.parse(await this.request("POST", "/api/local/backup/fetch", { handle, authKey: keys.authKey, ...device }, { auth: false }));
    let seed: string;
    try { seed = await openBackup(keys, blob.params.iv, blob.ciphertext); }
    catch { throw new Error(t("err.backupUndecryptable")); }
    const restored = await identityFromPrivateKey(seed);
    if (restored.publicKey !== blob.publicKey) throw new Error(t("err.backupMismatch"));
    return { ...restored, device: enrol?.device.stored ?? null };
  }
  /**
   * A member from before server accounts (`registrationRequired`) registers a server account on `fresh`, a new key for this
   * server only; `old` (the session's key) and `fresh` both sign the move, and only `fresh` is encrypted and kept by the server.
   */
  async localClaim(old: Identity, fresh: Identity, domain: string, rawHandle: string, password: string): Promise<void> {
    const handle = LocalHandle.parse(rawHandle);
    const backup = await createBackup(password, fresh.privateKey, undefined, this.bindHost);
    const challenge = ChallengeResponse.parse(await this.request("POST", "/api/auth/challenge", { publicKey: old.publicKey }, { auth: false }));
    const message = localClaimMessage(domain, challenge.nonce, handle, fresh.publicKey, backup.ciphertext);
    // The new account's first device signs along with the new key (docs/features/devices.md).
    const { signature: newSignature, ...device } = await signBoth(fresh, message);
    await this.request("POST", "/api/local/claim", {
      handle, backup, challengeId: challenge.challengeId, newPublicKey: fresh.publicKey,
      signature: await sign(old, message), newSignature, ...device,
    });
  }
  /** A new password: the same key, encrypted anew; the old password proves the change. */
  async localChangePassword(id: Identity, handle: string, oldPassword: string, newPassword: string): Promise<void> {
    const old = await this.localKeys(handle, oldPassword);
    await this.request("PUT", "/api/local/backup", { oldAuthKey: old.authKey, backup: await createBackup(newPassword, id.privateKey, undefined, this.bindHost) });
  }
  /** Delete the server account (the password proves it; the first owner cannot). */
  async localDelete(handle: string, password: string): Promise<void> {
    const keys = await this.localKeys(handle, password);
    await this.request("DELETE", "/api/me", { authKey: keys.authKey });
  }
  /** The avatar of a server account (null = remove); the image is already cropped and encoded (avatarImage.ts). */
  setLocalAvatar(image: AvatarImage | null) {
    return image ? this.request("PUT", "/api/me/avatar", { mime: image.mime, data: toBase64(image.bytes) }) : this.request("DELETE", "/api/me/avatar");
  }

  getMe() { return this.request<Me>("GET", "/api/me", undefined, { timeoutMs: ME_TIMEOUT_MS }).then((m) => Me.parse(m)); }
  updateMe(displayName: string | null) { return this.request<Me>("PATCH", "/api/me", { displayName }).then((m) => Me.parse(m)); }
  // ---------- Devices of a server account (docs/features/devices.md; `Health.devices` says that the server has the routes).
  // Signing other devices out needs the password; the asking device signs itself out without it.
  getDevices() { return this.request("GET", "/api/me/devices").then((d) => DevicesResponse.parse(d)); }
  async revokeDevice(handle: string, password: string, target: string): Promise<DevicesResponse> {
    const keys = await this.localKeys(handle, password);
    const path = target === "others" ? "/api/me/devices/others" : `/api/me/devices/${encodeURIComponent(target)}`;
    const res = await this.request<{ devices: unknown }>("DELETE", path, { authKey: keys.authKey });
    return DevicesResponse.parse(res.devices);
  }
  /** The client's own "Abmelden" on a server with a server account: the device is signed out with its session; best effort. */
  signOutDevice() { return this.request("DELETE", "/api/me/devices/current"); }

  // ---------- Sessions / devices (M6c)
  getSessions() { return this.request<SessionInfo[]>("GET", "/api/me/sessions").then((s) => z.array(SessionInfo).parse(s)); }
  revokeSession(id: string) { return this.request("DELETE", `/api/me/sessions/${id}`); }
  revokeOtherSessions() { return this.request<{ ok: true; revoked: number }>("DELETE", "/api/me/sessions/others"); }
  /** End your own session server-side (when signing out); best effort. */
  logoutSession() { return this.request("DELETE", "/api/me/sessions/current"); }
  getState() { return this.request<ServerState>("GET", "/api/state").then((s) => ServerState.parse(s)); }
  getInvitePreview(code: string) { return this.request<InvitePreview>("GET", `/api/invites/${encodeURIComponent(code)}`, undefined, { auth: false }).then((p) => InvitePreview.parse(p)); }

  // ---------- Messages
  /** Read states kept by the server (all my devices). Older servers answer 404: the caller falls back to the per-device state. */
  getReadState() { return this.request<ReadStateResponse>("GET", "/api/read-state").then((p) => ReadStateResponse.parse(p)); }
  /** Mute a text channel or this whole server for myself; the answer is my complete mute state. */
  setChannelMuted(channelId: string, muted: boolean) { return this.request<MuteState>("PUT", `/api/channels/${channelId}/mute`, { muted }).then((p) => MuteState.parse(p)); }
  setServerMuted(muted: boolean) { return this.request<MuteState>("PUT", "/api/me/mute", { muted }).then((p) => MuteState.parse(p)); }
  markRead(channelId: string, seq: number) { return this.request<{ lastReadSeq: number }>("POST", `/api/channels/${channelId}/read`, { seq }); }
  getMessages(channelId: string, before?: number) {
    return this.request<MessagePage>("GET", `/api/channels/${channelId}/messages?limit=50${before ? `&before=${before}` : ""}`).then((p) => MessagePage.parse(p));
  }
  sendMessage(channelId: string, content: string, attachmentIds: string[]) {
    return this.request<Message>("POST", `/api/channels/${channelId}/messages`, { content, attachmentIds }).then((m) => Message.parse(m));
  }
  editMessage(id: string, content: string) { return this.request<Message>("PATCH", `/api/messages/${id}`, { content }).then((m) => Message.parse(m)); }
  deleteMessage(id: string) { return this.request("DELETE", `/api/messages/${id}`); }
  /** The author takes one link preview of their message away; the change arrives as `message.update`. */
  removePreview(id: string, url: string) { return this.request("POST", `/api/messages/${id}/previews/remove`, { url }); }
  async uploadAttachment(file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    try {
      return await this.request<Attachment>("POST", "/api/attachments", undefined, { form });
    } catch (err) {
      // A refused upload as a sentence (docs/features/limits.md): the file, or the server's storage, is too big.
      if (err instanceof ApiError && err.code === "too_large") throw new Error(t("upload.tooLarge", { name: file.name, maxMb: typeof err.body.maxMb === "number" ? err.body.maxMb : "?" }));
      if (err instanceof ApiError && err.code === "storage_full") throw new Error(t("upload.storageFull", { name: file.name }));
      throw err;
    }
  }

  // ---------- Voice
  rtcToken(channelId: string) { return this.request<RtcTokenResponse>("POST", "/api/rtc-token", { channelId }).then((r) => RtcTokenResponse.parse(r)); }

  // ---------- Admin
  updateSettings(patch: { name?: string; openJoin?: boolean; localAccounts?: boolean; listed?: boolean; description?: string | null; radioAutoStop?: boolean; afkChannelId?: string | null; statusApi?: StatusApiMode; statusApiRoleId?: string | null; refuseSuspended?: boolean; privacyPolicyUrl?: string | null }) { return this.request("PATCH", "/api/settings", patch); }
  /** Status API (docs/features/status-api.md): the key for mode "key" (MANAGE_SERVER), and a fresh one that replaces it. */
  getStatusApiKey() { return this.request<StatusApiKeyResponse>("GET", "/api/settings/status-api-key").then((r) => StatusApiKeyResponse.parse(r)); }
  regenerateStatusApiKey() { return this.request<StatusApiKeyResponse>("POST", "/api/settings/status-api-key").then((r) => StatusApiKeyResponse.parse(r)); }
  /** Setup check (docs/features/doctor.md, MANAGE_SERVER): the server's report, and a token for the browser's media test. */
  doctor() { return this.request<DoctorReport>("GET", "/api/doctor").then((r) => DoctorReport.parse(r)); }
  doctorRtcToken() { return this.request<RtcTokenResponse>("POST", "/api/doctor/rtc-token").then((r) => RtcTokenResponse.parse(r)); }
  /** Operator limits (docs/features/limits.md, MANAGE_SERVER): what the configuration bounds this server to and what is in use. */
  limits() { return this.request<LimitsReport>("GET", "/api/settings/limits").then((r) => LimitsReport.parse(r)); }
  /** Server icon (PNG/JPEG/WebP/GIF, 2 MB); appears in the sidebar and as the favicon. */
  async uploadServerIcon(file: File): Promise<{ ok: true; iconUrl: string | null }> {
    const form = new FormData();
    form.append("file", file, file.name);
    return this.request("PUT", "/api/settings/icon", undefined, { form });
  }
  deleteServerIcon() { return this.request("DELETE", "/api/settings/icon"); }
  /** Owner status (owners only; the first owner cannot be revoked). */
  setOwner(userId: string, owner: boolean) { return this.request("PUT", `/api/members/${userId}/owner`, { owner }); }
  createCategory(name: string) { return this.request<Category>("POST", "/api/categories", { name }); }
  updateCategory(id: string, patch: { name?: string; position?: number }) { return this.request("PATCH", `/api/categories/${id}`, patch); }
  deleteCategory(id: string) { return this.request("DELETE", `/api/categories/${id}`); }
  createChannel(data: { kind: "text" | "voice"; name: string; topic?: string | null; categoryId?: string | null }) { return this.request<Channel>("POST", "/api/channels", data); }
  updateChannel(id: string, patch: ChannelPatch) { return this.request("PATCH", `/api/channels/${id}`, patch); }
  deleteChannel(id: string) { return this.request("DELETE", `/api/channels/${id}`); }
  // ---------- Channel permissions (docs/features/channel-permissions.md): the whole list per channel or category, MANAGE_CHANNELS there.
  getOverwrites(scope: "channels" | "categories", id: string) { return this.request<OverwritesResponse>("GET", `/api/${scope}/${id}/overwrites`).then((r) => OverwritesResponse.parse(r)); }
  setOverwrites(scope: "channels" | "categories", id: string, overwrites: PermissionOverwrite[]) { return this.request<OverwritesResponse>("PUT", `/api/${scope}/${id}/overwrites`, { overwrites }).then((r) => OverwritesResponse.parse(r)); }
  // ---------- Web radio (stations: MANAGE_SERVER; a channel's radio: CONTROL_RADIO). The result arrives via the structure event.
  /** Import of a Discord server template (docs/features/import.md): the plan for a typed link or code, then the import of the chosen entries. */
  discordImportPreview(code: string) { return this.request<ImportPlan>("POST", "/api/import/discord/preview", { code }); }
  discordImport(body: DiscordImportRequest) { return this.request<DiscordImportResult>("POST", "/api/import/discord", body); }
  createRadioStation(data: { name: string; url: string }) { return this.request<RadioStation>("POST", "/api/radio/stations", data); }
  updateRadioStation(id: string, patch: { name?: string; url?: string }) { return this.request<RadioStation>("PATCH", `/api/radio/stations/${id}`, patch); }
  deleteRadioStation(id: string) { return this.request("DELETE", `/api/radio/stations/${id}`); }
  /** `videoIds`: the videos of the address's YouTube playlist, read by this client (youtubePlaylist.ts); the server plays them as a queue. */
  startRadio(channelId: string, stationId: string, videoIds?: string[]) { return this.request("PUT", `/api/channels/${channelId}/radio`, { stationId, ...(videoIds ? { videoIds } : {}) }); }
  /** Any address instead of a station (also CONTROL_RADIO). */
  startRadioUrl(channelId: string, url: string, videoIds?: string[]) { return this.request("PUT", `/api/channels/${channelId}/radio`, { url, ...(videoIds ? { videoIds } : {}) }); }
  /** A queue's next or previous video (CONTROL_RADIO), or with `ended` a listener's report that `from` is over. */
  advanceRadio(channelId: string, move: { from: string; step?: 1 | -1; ended?: boolean }) { return this.request("POST", `/api/channels/${channelId}/radio/advance`, move); }
  /** A listener's report that the Twitch stream `channel` is over: the radio turns off (an older server does not know the route). */
  radioOffline(channelId: string, channel: string) { return this.request("POST", `/api/channels/${channelId}/radio/offline`, { channel }); }
  stopRadio(channelId: string) { return this.request("DELETE", `/api/channels/${channelId}/radio`); }
  /** Play, pause, move a video for everyone (CONTROL_RADIO); the result arrives as `radio.playback`. */
  setRadioPlayback(channelId: string, playback: { playing: boolean; position: number; rate: number }) { return this.request("PUT", `/api/channels/${channelId}/radio/playback`, playback); }
  createRole(data: { name: string; color?: string | null; permissions?: number }) { return this.request<Role>("POST", "/api/roles", data); }
  updateRole(id: string, patch: { name?: string; color?: string | null; permissions?: number; position?: number }) { return this.request("PATCH", `/api/roles/${id}`, patch); }
  deleteRole(id: string) { return this.request("DELETE", `/api/roles/${id}`); }
  setMemberRoles(userId: string, roleIds: string[]) { return this.request("PUT", `/api/members/${userId}/roles`, { roleIds }); }
  kickMember(userId: string) { return this.request("DELETE", `/api/members/${userId}`); }
  moveMember(userId: string, channelId: string | null) { return this.request("POST", `/api/members/${userId}/move`, { channelId }); }
  /** Channel blocks (docs/features/channel-blocks.md): the running ones where I may move members; set (minutes null = permanent) and lift. */
  channelBlocks() { return this.request<ChannelBlock[]>("GET", "/api/channel-blocks"); }
  setChannelBlock(channelId: string, userId: string, minutes: ChannelBlockMinutes | null) { return this.request<ChannelBlock>("PUT", `/api/channels/${channelId}/blocks`, { userId, minutes }); }
  liftChannelBlock(channelId: string, userId: string) { return this.request("DELETE", `/api/channels/${channelId}/blocks/${userId}`); }
  stopMemberStreams(userId: string, what: { camera: boolean; screen: boolean }) { return this.request("POST", `/api/members/${userId}/stream/stop`, what); }
  setStreamBlocked(userId: string, blocked: boolean) { return this.request("PUT", `/api/members/${userId}/stream`, { blocked }); }
  /** Vote kick (docs/features/votekick.md): start a vote about somebody in the voice channel one sits in; the result arrives over the WebSocket. */
  startVoteKick(channelId: string, targetId: string) { return this.request("POST", `/api/channels/${channelId}/votekick`, { targetId }); }
  castVoteKick(channelId: string, yes: boolean) { return this.request("POST", `/api/channels/${channelId}/votekick/vote`, { yes }); }
  /** `deleteMessagesHours` (docs/features/reports.md): also delete the member's messages of the last hour, day or week. */
  banMember(userId: string, reason: string | null, deleteMessagesHours?: DeleteRecentHours) { return this.request<{ ok: true; deleted?: number }>("POST", "/api/bans", { userId, reason, ...(deleteMessagesHours ? { deleteMessagesHours } : {}) }); }
  // ---------- Reports (docs/features/reports.md)
  createReport(body: CreateReportRequest) { return this.request<{ id: string }>("POST", "/api/reports", body); }
  listReports(status: "open" | "closed") { return this.request<ReportsResponse>("GET", `/api/reports?status=${status}`).then((r) => ReportsResponse.parse(r)); }
  closeReport(id: string, body: CloseReportRequest) { return this.request<{ ok: true; deleted: number }>("POST", `/api/reports/${id}/close`, body); }
  listModLog(before: string | null) { return this.request<ModLogResponse>("GET", `/api/mod-log${before ? `?before=${encodeURIComponent(before)}` : ""}`).then((r) => ModLogResponse.parse(r)); }
  unban(userId: string) { return this.request("DELETE", `/api/bans/${userId}`); }
  listBans() { return this.request<Ban[]>("GET", "/api/bans").then((b) => z.array(Ban).parse(b)); }
  createInvite(data: { expiresInHours?: number | null; maxUses?: number | null }) { return this.request<Invite>("POST", "/api/invites", data).then((i) => Invite.parse(i)); }
  listInvites() { return this.request<Invite[]>("GET", "/api/invites").then((i) => z.array(Invite).parse(i)); }
  revokeInvite(code: string) { return this.request("DELETE", `/api/invites/${encodeURIComponent(code)}`); }
}

/**
 * The end of the suspension out of a refusal `account_suspended` (a chat server refusing a directory account the directory's
 * operator suspended, docs/features/reports.md); null for any other error.
 */
export function suspendedUntilOfError(err: unknown): string | null {
  return err instanceof ApiError && err.code === "account_suspended" ? suspendedUntilOf(err.body.until) ?? "" : null;
}
/** The sentence for a suspended account on a chat server; without a date (a server that names none) the sentence without one. */
export const suspendedText = (until: string | null): string => (until ? t("err.accountSuspended", { until: fmtDateTime(until) }) : t("err.accountSuspendedNoDate"));

/** Turns sign-in errors into a sentence that says what to do. */
export async function explainLoginError(err: unknown, api: ServerApi, here: string): Promise<string> {
  if (err instanceof TypeError) return api.base ? t("err.serverUnreachableCors", { base: api.base }) : t("err.serverUnreachable");
  if (!(err instanceof ApiError)) return String(err);
  switch (err.code) {
    case "signature_invalid": {
      const health = await api.getHealth().catch(() => null);
      if (health?.domain && health.domain !== here) return t("err.domainMismatch", { expected: health.domain, here });
      return t("err.signatureInvalid", { here });
    }
    case "challenge_invalid": return t("err.challengeInvalid");
    case "rate_limited": return t("err.rateLimited");
    case "invite_required": return t("err.inviteRequired");
    case "invite_invalid": return t("err.inviteInvalid");
    case "server_full": return t("err.serverFull");
    case "account_required": return t("err.accountRequired");
    case "registration_required": return t("err.registrationRequired");
    case "account_suspended": return suspendedText(suspendedUntilOfError(err) || null);
    case "device_refused": return t("err.deviceRefused");
    case "device_signature_invalid": return t("err.deviceProof");
    case "banned": return `${t("err.banned")}${typeof err.body.reason === "string" && err.body.reason ? `: ${err.body.reason}` : "."}`;
    default: return err.message;
  }
}

export type Health = {
  /** The server knows devices (docs/features/devices.md): server accounts have a device list; missing = a server from before them. */
  devices?: boolean;
  /** The claim moves to a fresh key (servers since 25 September 2026); missing = an older server, no claim offered. */
  localClaimRekey?: boolean;
  ok: boolean; domain: string; protocolVersion: number; directoryUrl: string | null; serverName: string | null; iconUrl: string | null;
  /** Until server accounts: sign-in only with a directory account. Servers since then always report true. */
  requireAccount: boolean;
  /** Server accounts (`~name`) may be registered here. Missing on servers from before them. */
  localAccounts?: boolean;
  /** New members need an invite code (the server is not open). Missing on servers older than 19 September 2026. */
  inviteRequired?: boolean;
  /** No owner yet, and the owner registers as a server account with the setup code from the installation (OWNER_SETUP_CODE). */
  ownerSetup?: boolean;
  /** The server's privacy policy (https), linked under the form that creates a server account; null or missing = none. */
  privacyPolicyUrl?: string | null;
  /** Server version (package.json), shown at the bottom of the login next to the Squorli note. */
  version: string;
};

// ---------- Directory service (M6): runs under its own URL and is called directly from the browser
async function directoryFetch<T>(dirUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body !== undefined ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method };
  const res = await fetch(`${dirUrl}${path}`, init);
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(method, path, res.status, typeof b.error === "string" ? b.error : null, b);
  }
  return (await res.json()) as T;
}
/**
 * The directory's health for a signed action. Signatures are bound to the host this client connects to, never to the host the
 * directory reports: a directory naming another host is refused (security review, 25 September 2026; the chat servers'
 * counterpart is `connectedHost` in store.ts `signDomainOf`). Since then `health.host` is the connected host.
 */
async function signingHealth(dirUrl: string): Promise<DirectoryHealth> {
  const health = DirectoryHealth.parse(await directoryFetch(dirUrl, "GET", "/api/health"));
  const here = connectedHost(dirUrl);
  if (health.host.toLowerCase() !== here) throw new Error(t("dir.hostMismatch", { base: dirUrl, host: health.host }));
  return health;
}
/**
 * One request the account's key signs at the directory. Every one goes through here (docs/features/devices.md; until 29
 * September 2026 each function built its own), so every one carries the device's proof next to the account's signature:
 * the challenge, then both signatures over `message`, which is bound to the host this client connects to.
 */
async function directorySigned<T>(dirUrl: string, id: Identity, method: string, path: string, message: (host: string, nonce: string) => string, body: Record<string, unknown> = {}, health?: DirectoryHealth): Promise<T> {
  const host = (health ?? await signingHealth(dirUrl)).host;
  const ch = ChallengeResponse.parse(await directoryFetch(dirUrl, "POST", "/api/challenge", { publicKey: id.publicKey }));
  return directoryFetch<T>(dirUrl, method, path, { publicKey: id.publicKey, challengeId: ch.challengeId, ...(await signBoth(id, message(host, ch.nonce))), ...body });
}
/** A signed account action of the protocol (`directoryActionMessage`) with its payload. */
const directoryAction = <T>(dirUrl: string, id: Identity, action: DirectoryAction, path: string, payload = "", body: Record<string, unknown> = {}, health?: DirectoryHealth): Promise<T> =>
  directorySigned<T>(dirUrl, id, "POST", path, (host, nonce) => directoryActionMessage(host, action, nonce, payload), body, health);
/** The auth key of a directory account's password: what proves the password to the directory. */
async function directoryAuthKey(dirUrl: string, handle: string, password: string): Promise<string> {
  const p = BackupParamsResponse.parse(await directoryFetch(dirUrl, "GET", `/api/backup/${handle}/params`));
  return (await deriveBackupKeys(password, p.salt, p.iterations)).authKey;
}

/** Handle for a key; null = not registered. */
export async function directoryLookup(dirUrl: string, publicKey: string): Promise<DirectoryAccount | null> {
  try { return DirectoryAccount.parse(await directoryFetch(dirUrl, "GET", `/api/keys/${publicKey}`)); }
  catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
}
/**
 * Register a handle: proof of ownership via a signature over a challenge, bound to the service's host. A directory that reports
 * `features.emailRequired` wants a confirmed e-mail address: the call with `email` mails an 8-digit code and returns
 * `{ sentTo }` (the masked address), the call with `email` and `emailCode` creates the account.
 */
export async function directoryRegister(dirUrl: string, id: Identity, rawHandle: string, rawEmail?: string, rawCode?: string): Promise<DirectoryAccount | DirectoryRegisterPending> {
  const handle = Handle.parse(rawHandle);
  const email = rawEmail === undefined ? undefined : EmailAddress.parse(rawEmail);
  const emailCode = rawCode === undefined ? undefined : EmailCode.parse(rawCode);
  const res = await directorySigned<Record<string, unknown>>(dirUrl, id, "POST", "/api/register", (host, nonce) => directoryRegisterMessage(host, handle, nonce, email), { handle, ...(email ? { email } : {}), ...(emailCode ? { emailCode } : {}) });
  return res.emailPending === true ? DirectoryRegisterPending.parse(res) : DirectoryAccount.parse(res);
}
/**
 * M6b: store a password backup of your own key (ciphertext signed, the password stays in the client). `old`: the account
 * and its password so far, which a directory with devices asks for when a backup exists (a new password needs the old one).
 */
export async function directoryBackupUpload(dirUrl: string, id: Identity, password: string, old?: { handle: string; password: string }): Promise<void> {
  const b = await createBackup(password, id.privateKey);
  const oldAuthKey = old ? await directoryAuthKey(dirUrl, old.handle, old.password) : undefined;
  await directorySigned(dirUrl, id, "PUT", "/api/backup", (host, nonce) => directoryBackupMessage(host, nonce, b.ciphertext), { ciphertext: b.ciphertext, params: b.params, authKey: b.authKey, ...(oldAuthKey ? { oldAuthKey } : {}) });
}
/** At the limit of devices: the device the user picked to make way, and the ticket that stands for the second factor. */
export type DeviceChoice = { replaceDevice: string; ticket: string | null };
/**
 * M6b: fetch the key from the directory via handle + password and decrypt it. M6c: `code` after a 401 totp_required
 * (authenticator or recovery code). `device`: this installation's new device, enrolled with the fetch
 * (docs/features/devices.md); the identity that comes back names it. A 409 `too_many_devices` carries the account's
 * devices and a ticket; the call comes again with `choice`.
 */
export async function directoryRestore(dirUrl: string, rawHandle: string, password: string, code?: string, device?: NewDevice, choice?: DeviceChoice): Promise<Identity> {
  const handle = Handle.parse(rawHandle);
  const p = BackupParamsResponse.parse(await directoryFetch(dirUrl, "GET", `/api/backup/${handle}/params`));
  const keys = await deriveBackupKeys(password, p.salt, p.iterations);
  // Bound to the host this client connects to, like every signature for the directory.
  const enrol = device ? await enrolFields(device, connectedHost(dirUrl), handle) : {};
  const picked = choice ? { replaceDevice: choice.replaceDevice, ...(choice.ticket ? { ticket: choice.ticket } : {}) } : {};
  const blob = BackupBlob.parse(await directoryFetch(dirUrl, "POST", "/api/backup/fetch", { handle, authKey: keys.authKey, ...(code && !choice?.ticket ? { code } : {}), ...enrol, ...picked }));
  let seed: string;
  try { seed = await openBackup(keys, blob.params.iv, blob.ciphertext); }
  catch { throw new Error(t("err.backupUndecryptable")); }
  const id = await identityFromPrivateKey(seed);
  if (id.publicKey !== blob.publicKey) throw new Error(t("err.backupMismatch"));
  return { ...id, device: device?.stored ?? null };
}
/**
 * Sign devices of the directory account out (signed `device-revoke`, docs/features/devices.md): a device's id or "others"
 * with the password (and a code while the authenticator is on), "self" without. The answer is the list afterwards.
 */
export async function directoryRevokeDevice(dirUrl: string, id: Identity, target: DeviceRevokeTarget, auth?: { handle: string; password: string; code?: string | undefined }): Promise<DeviceRevokeResponse> {
  const proof = auth ? { authKey: await directoryAuthKey(dirUrl, auth.handle, auth.password), ...(auth.code ? { code: auth.code } : {}) } : {};
  return DeviceRevokeResponse.parse(await directoryAction(dirUrl, id, "device-revoke", "/api/devices/revoke", target, { target, ...proof }));
}
/**
 * Code by e-mail as the second factor (after a 401 totp_required whose body says `email: true`): proves the password again
 * (handle + auth key) and the directory mails an 8-digit code to the confirmed address; it then goes into `code` of directoryRestore.
 */
export async function directoryEmailCode(dirUrl: string, rawHandle: string, password: string): Promise<EmailCodeResponse> {
  const handle = Handle.parse(rawHandle);
  const p = BackupParamsResponse.parse(await directoryFetch(dirUrl, "GET", `/api/backup/${handle}/params`));
  const keys = await deriveBackupKeys(password, p.salt, p.iterations);
  return EmailCodeResponse.parse(await directoryFetch(dirUrl, "POST", "/api/email/code", { handle, authKey: keys.authKey }));
}
/** Display name in the directory: server = null -> global (all servers), otherwise only for this chat server (host = its PUBLIC_DOMAIN). */
export async function directorySetDisplayName(dirUrl: string, id: Identity, server: string | null, displayName: string | null): Promise<void> {
  await directoryAction(dirUrl, id, "profile-update", "/api/profile", directoryProfilePayload(server, displayName), { server, displayName });
}
/**
 * Avatar of the directory account (signed over the type and the SHA-256 of the image bytes; null = remove). The image is already
 * normalized (avatarImage.ts). A directory from before the avatars has no such route: said in words instead of a bare 404.
 */
export async function directorySetAvatar(dirUrl: string, id: Identity, image: AvatarImage | null): Promise<AvatarUpdateResponse> {
  const health = await signingHealth(dirUrl);
  if (!health.features.avatars) throw new Error(t("dir.avatars_unsupported"));
  const payload = directoryAvatarPayload(image?.mime ?? null, image ? await avatarDigest(image.bytes) : null);
  return AvatarUpdateResponse.parse(await directoryAction(dirUrl, id, "avatar-set", "/api/avatar", payload, { avatar: image ? { mime: image.mime, data: toBase64(image.bytes) } : null }, health));
}
/**
 * Link previews in direct messages, for a sender whose client cannot look a link up itself (a browser): the directory does it
 * (signed, so only accounts ask, and limited per account). The desktop app never calls this: it asks the linked host itself.
 */
export async function directoryLinkLookup(dirUrl: string, id: Identity, request: { url: string } | { youtube: string }): Promise<LinkLookupResponse> {
  return LinkLookupResponse.parse(await directoryAction(dirUrl, id, "link-lookup", "/api/link-lookup", directoryLinkLookupPayload(request), request));
}
/** Store a picture the client has encrypted (dm.ts `sealDmBlob`) in the directory's blob store; the signature covers the hash of the bytes. */
/**
 * Report something to the directory's operator (docs/features/reports.md): a direct message (its plain text travels with the
 * report), a directory account, or a chat server (with a message of it as evidence when the report is passed on). Signed as
 * a whole, per kind in its own fixed order. A directory that does not take the kind is told in words.
 */
export async function directoryReport(dirUrl: string, id: Identity, content: DirectoryReportContent): Promise<DmReportResponse> {
  const health = await signingHealth(dirUrl);
  if (!reportKindsOf(health.features).includes(content.kind)) throw new Error(t("dir.reports_unsupported"));
  return DmReportResponse.parse(await directoryAction(dirUrl, id, "report", "/api/reports", directoryReportPayload(content), content, health));
}
export const directoryReportDm = (dirUrl: string, id: Identity, content: DmReportContent): Promise<DmReportResponse> => directoryReport(dirUrl, id, content);
/** A notice about a measure was read (signed `notice-read`, the notice's id is the payload); the answer is the list afterwards. */
export async function directoryReadNotice(dirUrl: string, id: Identity, noticeId: string): Promise<AccountNotice[]> {
  return NoticeReadResponse.parse(await directoryAction(dirUrl, id, "notice-read", "/api/notices/read", noticeId, { id: noticeId })).notices;
}
/**
 * The chat servers the directory's operator refused, as hashes of their hosts (refusedServers.ts checks a host against them).
 * `fresh` = past the browser's cache (the directory serves the list cacheable for an hour): asked when the account's own
 * status contradicts the list at hand.
 */
export async function directoryRefusedServers(dirUrl: string, fresh = false): Promise<string[]> {
  const res = await fetch(directoryRefusedServersUrl(dirUrl), fresh ? { cache: "reload" } : {});
  if (!res.ok) throw new ApiError("GET", "/api/servers/refused", res.status, null, {});
  return RefusedServersResponse.parse(await res.json()).hashes;
}
export async function directoryPutDmBlob(dirUrl: string, id: Identity, ciphertext: Uint8Array): Promise<string> {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");
  return DmBlobPutResponse.parse(await directoryAction(dirUrl, id, "dm-blob-put", "/api/dm-blobs", digest, { data: toBase64(ciphertext) })).id;
}
/** The ciphertext of a blob; whoever has the id (it travels inside the encrypted message) may fetch it. */
export async function directoryDmBlob(dirUrl: string, blobId: string): Promise<Uint8Array> {
  const res = await fetch(directoryDmBlobUrl(dirUrl, blobId));
  if (!res.ok) throw new ApiError("GET", "/api/dm-blobs", res.status, null, {});
  return new Uint8Array(await res.arrayBuffer());
}
/** Voice cue settings in the account (signed): follow the account across chat servers and devices; read back via directoryAccountStatus(). */
export async function directorySetSoundSettings(dirUrl: string, id: Identity, soundSettings: SoundSettings): Promise<void> {
  await directoryAction(dirUrl, id, "sound-settings", "/api/sound-settings", directorySoundSettingsPayload(soundSettings), { soundSettings });
}
/** All client settings in the account (signed; the JSON string itself is the signed payload): follow the account like the cue settings, which they include. */
export async function directorySetSettings(dirUrl: string, id: Identity, accountSettings: AccountSettings): Promise<void> {
  const settings = JSON.stringify(accountSettings);
  await directoryAction(dirUrl, id, "settings", "/api/settings", settings, { settings });
}
/** The settings as a blob only the user can read (directory `features.settingsSealed`; signed like `settings`: the JSON string itself is the payload). */
export async function directorySetSealedSettings(dirUrl: string, id: Identity, blob: SealedSettings): Promise<void> {
  const sealed = JSON.stringify(blob);
  await directoryAction(dirUrl, id, "settings-sealed", "/api/settings/sealed", sealed, { sealed });
}
/** Delete your account on one chat server (host = its PUBLIC_DOMAIN): signed at the directory, which notifies the server; it confirms and deletes the user. */
export async function directoryLeaveServer(dirUrl: string, id: Identity, server: string): Promise<ServerLeaveResponse> {
  return ServerLeaveResponse.parse(await directoryAction(dirUrl, id, "server-leave", "/api/servers/leave", server, { server }));
}
/** Handle search for the friends list (M7, public, prefix, at most 10 hits). */
export const directorySearchHandles = (dirUrl: string, q: string) => directoryFetch(dirUrl, "GET", `/api/handles?q=${encodeURIComponent(q)}`).then((r) => FriendSearchResponse.parse(r));
export const directoryHealth = (dirUrl: string) => directoryFetch(dirUrl, "GET", "/api/health").then((r) => DirectoryHealth.parse(r));
/** Public server directory (M6d): all servers that opt into being listed. */
export const directoryServers = (dirUrl: string) => directoryFetch(dirUrl, "GET", "/api/servers").then((r) => ServerListResponse.parse(r));
/** Account status (signed): among other things, the servers the handle has signed in on (server rail, M6d). */
export async function directoryAccountStatus(dirUrl: string, id: Identity): Promise<AccountStatus> {
  return AccountStatus.parse(await directoryAction(dirUrl, id, "account-status", "/api/account/status"));
}
/** Errors of the server accounts' routes as a sentence (`local.*` keys); anything else like a sign-in error. */
export function explainLocalError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "handle_taken": case "local_accounts_off": case "has_account": case "auth_invalid": case "unknown_account": case "rate_limited": case "founder": case "bad_handle": case "use_directory": case "too_large": case "bad_type": case "owner_code_invalid":
      case "too_many_devices": case "no_device":
        return t(`local.${err.code}`);
      case "device_refused": return t("err.deviceRefused");
      case "device_signature_invalid": return t("err.deviceProof");
      case "invite_required": return t("err.inviteRequired");
      case "invite_invalid": return t("err.inviteInvalid");
      case "server_full": return t("err.serverFull");
      case "storage_full": return t("local.storage_full");
      case "banned": return `${t("err.banned")}${typeof err.body.reason === "string" && err.body.reason ? `: ${err.body.reason}` : "."}`;
      default: return err.message;
    }
  }
  if (err instanceof Error && err.name === "ZodError") return t("dir.zod");
  if (err instanceof TypeError) return t("err.serverUnreachable");
  return err instanceof Error ? err.message : String(err);
}

export function explainDirectoryError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "auth_invalid": case "no_backup": case "no_account": case "not_found": case "bad_handle": case "handle_taken": case "rate_limited":
      case "signature_invalid": case "challenge_invalid": case "totp_required": case "totp_invalid": case "totp_reused": case "server_unknown": case "totp_unavailable":
      case "founder": case "server_refused": case "email_unavailable": case "no_email": case "mail_failed": case "totp_disabled":
      case "email_required": case "email_code_invalid": case "email_taken": case "avatar_too_large": case "avatar_invalid":
      case "own_account": case "own_message": case "already_reported": case "notice_unknown":
      case "device_revoked": case "device_unknown": case "device_required": case "no_device": case "device_unknown_id": case "device_revoke_unavailable": case "too_many_devices": case "ticket_invalid":
        return t(`dir.${err.code}`);
      case "device_signature_invalid": return t("err.deviceProof");
      // The directory's operator suspended the account: the action works again when the suspension ends.
      case "account_suspended": return typeof err.body.until === "string" && suspendedUntilOf(err.body.until) ? t("dir.account_suspended", { until: fmtDateTime(err.body.until) }) : t("dir.account_suspendedNoDate");
      case "key_registered": return t("dir.key_registered", { handle: String(err.body.handle ?? "?") });
      case "bad_request": return t("dir.bad_request", { detail: String(err.body.detail ?? t("dir.handleRules")) });
      default: return err.message;
    }
  }
  if (err instanceof Error && err.name === "ZodError") return t("dir.zod");
  if (err instanceof TypeError) return t("dir.unreachable");
  return String(err);
}
