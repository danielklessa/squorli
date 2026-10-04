/**
 * Shared protocol between client and app server.
 * One source of truth: schemas here, types are derived from them.
 *
 * Media does NOT flow through here, but directly between client and LiveKit.
 */
import { z } from "zod";
import { ImportSource } from "./import";

export * from "./permissions";
export * from "./directory";
import { chatLoginMessage } from "./directory";
export * from "./backup";
export * from "./useragent";
export * from "./friends";
export * from "./dm";
export * from "./mentions";
export * from "./links";
export * from "./import";
export * from "./channels";
export * from "./votekick";
export * from "./channelBlocks";
export * from "./localAccounts";
export * from "./reports";
export { Iso, PublicKey, REPORT_REASONS, REPORT_TEXT_MAX, ReportReason, Signature, Uuid } from "./primitives";
import { Iso, PublicKey, Signature, Uuid } from "./primitives";
import { DeviceProofFields, DisplayName } from "./directory";
import { GamePresence } from "./friends";
import { ChannelNotification, SlowmodeSeconds, UserLimit, VoiceLock } from "./channels";
import { VoteKick, VoteKickResult } from "./votekick";
import { DeleteRecentHours } from "./reports";

/** Increment on incompatible changes. The server rejects older clients. */
export const PROTOCOL_VERSION = 4; // v4: voice.moved/voice.stop, Member.streamBlocked, MODERATE_VOICE

// ---------- REST: auth (challenge-response with Ed25519) ----------

/** Invite code: URL-safe, exactly as it appears in /invite/<code>. */
export const InviteCode = z.string().regex(/^[A-Za-z0-9_-]{6,32}$/);

// ChallengeRequest/ChallengeResponse live in directory.ts (chat server and directory service share the challenge contract).

export const VerifyRequest = z.object({
  challengeId: Uuid,
  publicKey: PublicKey,
  signature: Signature,
  /** Required when the server is not open and the key is not a member yet. */
  invite: InviteCode.optional(),
  /** The device's proof over `challengeMessage` (directory.ts "Devices"); a server from before it drops the fields. */
  ...DeviceProofFields,
  /** With a device: the session is bound to it (below, "Sessions bound to the device"); a server from before drops the field. */
  bindDevice: z.boolean().optional(),
});
export const VerifyResponse = z.object({
  sessionToken: z.string(),
  userId: Uuid,
  expiresAt: Iso,
  /** The session is bound to the device that signed in: every request and every hello need the device's proof. Default for servers from before. */
  deviceBound: z.boolean().default(false),
  /**
   * A member from before server accounts whose key has neither a directory handle nor a server account (docs/features/local-accounts.md):
   * the session works for GET /api/me and POST /api/local/claim only until they register. Default for servers from before it.
   */
  registrationRequired: z.boolean().default(false),
});
/** Error codes from /api/auth/verify that the client handles specially. */
export const VerifyErrorCode = z.enum(["challenge_invalid", "signature_invalid", "invite_required", "invite_invalid", "banned"]);
/**
 * A directory account the directory's operator suspended, on a server that refuses such accounts
 * (`ServerSettings.refuseSuspended`): the sign-in and every request with a session answer 403 `account_suspended` with
 * `until` (the end of the suspension). On the WebSocket the server sends `error` with the code `unauthorized` and
 * `suspendedCloseReason(until)` as its message, then closes with this code: a client from before it stops on
 * `unauthorized` and shows its login, a client that knows it reads the date (`suspendedUntilOf`) and says why.
 */
export const WS_CLOSE_ACCOUNT_SUSPENDED = 4014;
const SUSPENDED_REASON = "account_suspended ";
export const suspendedCloseReason = (until: string): string => `${SUSPENDED_REASON}${until}`;
/** The end of the suspension out of a close reason (or an error body's `until`); null when it names none. */
export function suspendedUntilOf(reason: unknown): string | null {
  const text = typeof reason !== "string" ? "" : reason.startsWith(SUSPENDED_REASON) ? reason.slice(SUSPENDED_REASON.length) : reason;
  return Iso.safeParse(text).success ? text : null;
}

/**
 * A device that is not let in (29 September 2026, directory.ts "Devices"): the sign-in answers 403 and every request with
 * a session 401, both with the code `device_refused`; an open WebSocket closes with 4011 like every ended session and
 * names the cause as its reason. For a directory account the client asks the directory what it says about the device
 * before it wipes anything (a chat server's word alone never wipes a key); for a server account this server decides.
 */
export const DEVICE_REFUSED = "device_refused";
export const WS_CLOSE_SESSION_ENDED = 4011;
/** The reasons of a close with 4011; a server from before them says one of the first two only. */
export const SESSION_END_REASONS = ["session_revoked", "session_expired", "device_revoked"] as const;
export type SessionEndReason = typeof SESSION_END_REASONS[number];
/** The reason out of a close with 4011; an unknown or missing one reads as a revoked session (what such a close meant before). */
export function sessionEndReasonOf(reason: unknown): SessionEndReason {
  return (SESSION_END_REASONS as readonly string[]).includes(reason as string) ? (reason as SessionEndReason) : "session_revoked";
}

/**
 * Sessions bound to the device (4 October 2026, security audit S10, docs/features/devices.md): a sign-in that names its
 * device may ask for a bound session (`bindDevice`); from then on every request with that session and every WebSocket
 * hello carry a fresh proof by the device key, so a copied token is worth nothing without the device. The proof is the
 * device's signature over `deviceProofMessage(accountKey, sessionProofMessage(domain, at, method, path))`: `domain` = the
 * host the client reaches the server at (no port), `at` = the client's clock in ms (good for SESSION_PROOF_MAX_SKEW_MS
 * either way), `method` and `path` of the request (`WS` and `/api/ws` for the hello), so a captured proof opens nothing
 * else. A request without a good proof answers 401 `device_proof_required` with `why` and the server's `serverTime`; for a
 * `stale` one the client learns its clock's offset and tries once more. On the socket the hello gets `error` `unauthorized`
 * with "device proof <why>" and the close 4003. A session without the binding (an older client, or no device) is as before.
 */
export const SESSION_PROOF_HEADER = "x-squorli-session-proof";
export const SESSION_PROOF_MAX_SKEW_MS = 10 * 60_000;
export const DEVICE_PROOF_REQUIRED = "device_proof_required";
export function sessionProofMessage(domain: string, at: number, method: string, path: string): string {
  return `community-chat-session\n${domain}\n${at}\n${method.toUpperCase()}\n${path}`;
}
/** The header's value: `<domain>:<at>:<signature>` (the domain has no port, so no colon of its own). */
export const sessionProofHeader = (domain: string, at: number, signature: string): string => `${domain}:${at}:${signature}`;
export type SessionProof = { domain: string; at: number; signature: string };
export function parseSessionProofHeader(value: unknown): SessionProof | null {
  if (typeof value !== "string") return null;
  const m = /^([a-z0-9.-]{1,253}):(\d{1,16}):([0-9a-f]{128})$/i.exec(value);
  return m ? { domain: m[1]!.toLowerCase(), at: Number(m[2]), signature: m[3]!.toLowerCase() } : null;
}
/** The hello's proof (the same signature, over method `WS` and path `/api/ws`). */
export const SessionProofSchema = z.object({ domain: z.string().min(1).max(253), at: z.number().int().nonnegative(), signature: Signature });

/** What the client signs. The domain binding prevents reuse on other servers. */
/** The same text as `chatLoginMessage` of directory.ts (the directory checks it as the proof of a sign-in). */
export function challengeMessage(domain: string, nonce: string): string {
  return chatLoginMessage(domain, nonce);
}

// ---------- Profile ----------

// DisplayName lives in directory.ts (the directory uses the same schema).
export const Me = z.object({
  userId: Uuid,
  publicKey: PublicKey,
  displayName: DisplayName.nullable(),
  /** Verified handle from the directory service (M6), null without a service or without a registration. */
  handle: z.string().nullable(),
  /** Avatar from the directory account (address of the image incl. cache version), null = none, no directory or a server from before it. */
  avatarUrl: z.string().url().nullable().default(null),
  /** Handle of the server account (`~name`, docs/features/local-accounts.md), null = none. Default for servers from before it. */
  localHandle: z.string().nullable().default(null),
  /** The member has no account yet and must register before anything else works (see VerifyResponse). */
  registrationRequired: z.boolean().default(false),
});
export const UpdateMeRequest = z.object({ displayName: DisplayName.nullable() });

/** Session (device) of the signed-in user on this server (M6c, device management). The token stays secret, `id` is the identifier. */
export const SessionInfo = z.object({
  id: Uuid,
  /** From the user agent at sign-in, e.g. "Chrome on Windows"; null if unknown. */
  label: z.string().nullable(),
  createdAt: Iso,
  lastUsedAt: Iso.nullable(),
  expiresAt: Iso,
  /** The session this request was made with. */
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** Display name with a fallback to the first characters of the key. */
export function displayNameOf(u: { displayName: string | null; publicKey: string; handle?: string | null; localHandle?: string | null }): string {
  return u.displayName ?? (u.handle ? `@${u.handle}` : u.localHandle ? `~${u.localHandle}` : `anon-${u.publicKey.slice(0, 6)}`);
}

// ---------- Server structure ----------

/** Who may read GET /api/status (docs/features/status-api.md): nobody, holders of the server's key, anyone. */
export const StatusApiMode = z.enum(["off", "key", "public"]);
/**
 * What a client shows in its dock (voice.join, voice.status, VoiceMember): microphone muted by hand, sound off (which also
 * mutes the microphone), and since the same day whether its camera or screen share is on. The last two default to false
 * (a client or server from before them says nothing).
 */
export const VoiceStatus = z.object({ micMuted: z.boolean(), deafened: z.boolean(), cameraOn: z.boolean().default(false), screenOn: z.boolean().default(false) });
/** Longest address of a server's privacy policy (`ServerSettings.privacyPolicyUrl`). */
export const PRIVACY_POLICY_URL_MAX = 500;
/** The address of a server's privacy policy: https only, since the client links it before sign-in (docs/features/local-accounts.md). */
export const PrivacyPolicyUrl = z.string().trim().min(1).max(PRIVACY_POLICY_URL_MAX).refine((s) => {
  try { const u = new URL(s); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password; } catch { return false; }
}, { message: "https_url" });

export const ServerSettings = z.object({
  name: z.string().min(1).max(64),
  /** true = anyone with a key may join; false = an invite is required. */
  openJoin: z.boolean(),
  /** First owner (determined at the first sign-in); further owners are marked on the members (isOwner). */
  ownerId: Uuid.nullable(),
  /** Server icon from the admin area (with a version parameter for caching), null = none. The client also uses it as the favicon. */
  iconUrl: z.string().nullable(),
  /**
   * Until 25 September 2026: sign-in only with a directory account. Since server accounts every sign-in needs an account (a
   * directory handle or a server account), so servers send true for both; kept for clients from before.
   */
  requireAccount: z.boolean(),
  requireAccountLocked: z.boolean(),
  /**
   * Server accounts (`~name`, docs/features/local-accounts.md) may be registered here. Always true without a directory.
   * Optional = feature flag: a server from before it does not send the field.
   */
  localAccounts: z.boolean().optional(),
  /** true = fixed (no directory, or LOCAL_ACCOUNTS in the configuration); PATCH answers 409 locked_by_config. */
  localAccountsLocked: z.boolean().optional(),
  /** M6d: list in the directory service's public server directory (with a description); no effect without DIRECTORY_URL. */
  listed: z.boolean(),
  description: z.string().trim().max(200).nullable(),
  /**
   * Web radio: turn a voice channel's radio off once nobody has been in the channel for RADIO_IDLE_STOP_MS (default on).
   * Optional = feature flag: a server from before it does not send the field and the admin area hides the switch.
   */
  radioAutoStop: z.boolean().optional(),
  /**
   * AFK channel: the voice channel absent members are moved to, null = none. Nobody can send, hear or share anything in it
   * (the LiveKit token carries no publish or subscribe grant) and it has no radio. Members are moved the moment they turn
   * absent, i.e. after AFK_AFTER_MS: that time is fixed for every server, because friends see the same state through the
   * directory (user's decision). Optional = feature flag: a server from before the AFK detection does not send the field
   * (one that knows it sends null for "none"); clients then report no activity to it and hide the setting.
   */
  afkChannelId: Uuid.nullable().optional(),
  /**
   * Status API (docs/features/status-api.md): GET /api/status shows the structure and who sits where to the outside. "off" =
   * the route answers 404 (default), "key" = only with the server's key (Verwaltung > Server), "public" = anyone. Optional =
   * feature flag: a server from before it does not send the field; such a server also does not understand `voice.status`.
   */
  statusApi: StatusApiMode.optional(),
  /**
   * Whose view the status API answers with (docs/features/status-api.md, user's wish of 23 September 2026): the id of a role,
   * null = the default role ("Gast"), i.e. what a plain visitor would see. The outside then gets exactly the channels and the
   * seats a member with that role may see; a role carrying ADMINISTRATOR therefore exposes everything. A deleted role falls
   * back to null. Optional = feature flag, like `statusApi` itself.
   */
  statusApiRoleId: Uuid.nullable().optional(),
  /** The setup check exists (GET /api/doctor, POST /api/doctor/rtc-token; docs/features/doctor.md). Optional = feature flag. */
  doctor: z.boolean().optional(),
  /** The operator limits' report exists (GET /api/settings/limits; docs/features/limits.md). Optional = feature flag. */
  limits: z.boolean().optional(),
  /**
   * Suspended directory accounts (docs/features/reports.md, 27 September 2026): an account the directory's operator
   * suspended cannot sign in here until the suspension ends, and its sessions end when the server learns of it (default
   * on; the operator of a server can switch it off). Server accounts (`~name`) are never concerned. Optional = feature
   * flag: a server from before it does not send the field, and one without a directory has nothing to refuse.
   */
  refuseSuspended: z.boolean().optional(),
  /**
   * The server's privacy policy (2 October 2026, docs/features/local-accounts.md): the operator answers for the data of the
   * server accounts, so the form that creates one links this address ("Mit dem Anlegen des Kontos akzeptierst du die
   * Datenschutzerklärung dieses Servers."); /api/health carries it for the login. null = none, the form says nothing.
   * Optional = feature flag: a server from before it does not send the field and the admin area hides it.
   */
  privacyPolicyUrl: PrivacyPolicyUrl.nullable().optional(),
});
export const UpdateSettingsRequest = ServerSettings.pick({ name: true, openJoin: true, localAccounts: true, listed: true, description: true, radioAutoStop: true, afkChannelId: true, statusApi: true, statusApiRoleId: true, refuseSuspended: true, privacyPolicyUrl: true }).partial();
/** The key of the status API in mode "key" (MANAGE_SERVER only); null = none yet (made when the mode is switched to "key"). */
export const StatusApiKeyResponse = z.object({ key: z.string().nullable() });
/**
 * Operator limits (docs/features/limits.md, 30 September 2026; GET /api/settings/limits, MANAGE_SERVER): what the server's
 * configuration bounds it to and how much of that is in use. A limit null = unlimited (its variable is unset).
 */
export const LimitsReport = z.object({
  /** Every file the server keeps for its members (attachments, preview pictures, report copies, avatars, the icon) against STORAGE_QUOTA_MB. */
  storage: z.object({ usedBytes: z.number().int().min(0), quotaMb: z.number().nullable() }),
  /** People sitting in voice channels right now against VOICE_SEATS_MAX. */
  voiceSeats: z.object({ used: z.number().int().min(0), max: z.number().int().nullable() }),
  /** Members against MEMBER_MAX. */
  members: z.object({ count: z.number().int().min(0), max: z.number().int().nullable() }),
  /** MAX_UPLOAD_MB, the size one file may have. */
  maxUploadMb: z.number(),
  /** DB_POOL_MAX, the database connections this server holds. */
  dbPoolMax: z.number().int(),
});
// ---- Setup self-diagnosis (docs/features/doctor.md, 25 September 2026): GET /api/doctor (MANAGE_SERVER, or from the
// machine itself for `squorli doctor`) runs the checks an operator gets wrong most often and names the likely fault.
// The texts come in both languages from the server, so the wrapper on the host and the admin panel say the same thing;
// `id` is stable for scripts. The client's own media connection is checked in the browser (DoctorRtcToken below).
export const DoctorStatus = z.enum(["ok", "warn", "fail", "skip"]);
export const DoctorCheck = z.object({
  id: z.string().min(1).max(64),
  status: DoctorStatus,
  text: z.object({ de: z.string(), en: z.string() }),
  /** The technical detail behind the text (status code, error code), for the operator who wants it. */
  detail: z.string().nullable().default(null),
});
export const DoctorReport = z.object({
  time: Iso,
  domain: z.string(),
  proxyMode: z.enum(["bundled", "external"]),
  /** LiveKit's media ports as the server knows them (LIVEKIT_TCP_PORT/LIVEKIT_UDP_PORT). */
  mediaPorts: z.object({ tcp: z.number().int(), udp: z.number().int() }),
  livekitPublicUrl: z.string(),
  directoryUrl: z.string().nullable(),
  checks: z.array(DoctorCheck),
});
/** How long a voice channel may stay empty before its radio is turned off (ServerSettings.radioAutoStop). */
export const RADIO_IDLE_STOP_MS = 2 * 60_000;

export const Category = z.object({ id: Uuid, name: z.string().min(1).max(64), position: z.number().int() });
export const ChannelKind = z.enum(["text", "voice"]);
/**
 * Voice quality per voice channel (M3). In the browser the codec is always Opus; bitrate (kbit/s) and stereo are configurable.
 * Mono with DTX/RED = speech; stereo without the browser's audio processing = music/instruments.
 */
export const AUDIO_BITRATES = [24, 32, 48, 64, 96, 128, 192, 256] as const;
export const DEFAULT_AUDIO_BITRATE = 64;
const AudioBitrate = z.number().int().min(8).max(320);

/**
 * Web radio: the server keeps a list of stations (admin area); a member with CONTROL_RADIO tunes a voice channel to one of
 * them. The audio never passes through the chat server or LiveKit: every client in the channel plays `streamUrl` itself,
 * at its own volume. A station's address is a direct audio stream or a playlist (.m3u, .m3u8, .pls) naming one; the
 * server resolves a playlist when the radio is started, because browsers cannot.
 */
export const RadioUrl = z.string().trim().max(2048).refine((u) => {
  try { const p = new URL(u).protocol; return p === "http:" || p === "https:"; } catch { return false; }
}, "http(s) url required");
/**
 * Twitch as a radio source: the address of a channel page (`https://www.twitch.tv/<login>`, also without www or with m.).
 * Twitch has no audio stream a browser may play from a foreign page, so such a source is shown with Twitch's official
 * player, as a tile in the voice stage (user's decision). Returns the channel's login in lower case, null = not a channel page.
 */
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "drops", "wallet", "downloads", "jobs", "p", "search", "turbo", "store", "friends", "payments", "prime", "privacy", "legal", "login", "signup", "popout", "embed", "team", "u", "moderator", "broadcast"]);
export function twitchChannelOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !/^(www\.|m\.)?twitch\.tv$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const login = parts[0]?.toLowerCase() ?? "";
    return parts.length === 1 && /^[a-z0-9_]{3,25}$/.test(login) && !TWITCH_RESERVED.has(login) ? login : null;
  } catch { return null; }
}

const MAX_PLAYBACK_POSITION = 360_000; // 100 hours
/**
 * YouTube as a radio source: the address of a video or live stream (watch?v=, youtu.be/, /live/, /shorts/, /embed/). Shown
 * with YouTube's official player like a Twitch source, and played in step for everyone: see RadioPlayback. `start` = the
 * address's start offset in seconds (`t=90`, `t=1m30s`, `start=90`), 0 without one. null = not a YouTube video.
 */
export function youtubeVideoOf(url: string): { videoId: string; start: number } | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
    const parts = u.pathname.split("/").filter(Boolean);
    let id: string | null = null;
    if (host === "youtu.be") id = parts.length === 1 ? parts[0]! : null;
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (parts.length === 1 && parts[0] === "watch") id = u.searchParams.get("v");
      else if (parts.length === 2 && ["live", "shorts", "embed", "v"].includes(parts[0]!)) id = parts[1]!;
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    const t = (u.searchParams.get("t") ?? u.searchParams.get("start") ?? "").toLowerCase();
    const clock = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
    const start = clock && t !== "" ? Number(clock[1] ?? 0) * 3600 + Number(clock[2] ?? 0) * 60 + Number(clock[3] ?? 0) : 0;
    return { videoId: id, start: Number.isFinite(start) ? Math.min(start, MAX_PLAYBACK_POSITION) : 0 };
  } catch { return null; }
}

/**
 * A YouTube playlist as a radio source (`/playlist?list=`, or a video's address with `&list=`): its videos are played one
 * after the other as a queue the SERVER keeps, so everyone stays on the same video (RadioQueue). Without an API key the
 * server cannot read a playlist; the client of the member who starts it reads the video ids from YouTube's player and
 * hands them over with the request (`videoIds`). `videoId` = the video the address names (the queue starts there), else null.
 */
export function youtubePlaylistOf(url: string): { listId: string; videoId: string | null } | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");
    if (host !== "youtube.com" && host !== "youtu.be" && host !== "youtube-nocookie.com") return null;
    const listId = u.searchParams.get("list") ?? "";
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(listId)) return null;
    const videoId = youtubeVideoOf(url)?.videoId ?? null;
    const parts = u.pathname.split("/").filter(Boolean);
    const isListPage = host !== "youtu.be" && parts.length === 1 && parts[0] === "playlist";
    return videoId !== null || isListPage ? { listId, videoId } : null;
  } catch { return null; }
}
/** YouTube's player hands out at most 200 videos of a playlist. */
export const RADIO_QUEUE_MAX = 200;
export const YoutubeVideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
/** The queue a channel's radio plays from (a YouTube playlist): which list, where it stands. The video itself is `youtubeVideo`. */
export const RadioQueue = z.object({ listId: z.string(), index: z.number().int().min(0), length: z.number().int().min(1) });
/**
 * POST /api/channels/:id/radio/advance: on to the next video of the queue (`step` -1 = back). `from` = the video the
 * sender means; when the queue has moved on already, nothing happens (every listener's player reports the end). With
 * `ended` a member sitting in the voice channel reports that the video is over; without it a member with CONTROL_RADIO skips.
 */
export const AdvanceRadioRequest = z.object({ from: YoutubeVideoId, step: z.union([z.literal(1), z.literal(-1)]).default(1), ended: z.boolean().default(false) });

/**
 * A radio that has nothing left to play turns itself off (user's wish, 20 September 2026). For YouTube that is the `ended`
 * report above: a single video that is over, or the last video of a queue (a skip by hand still goes around the ends). For
 * Twitch the members' players say when the stream is over (POST /api/channels/:id/radio/offline): `channel` = the Twitch
 * channel the sender means, so a report that arrives after the radio changed does nothing.
 */
export const RadioOfflineRequest = z.object({ channel: z.string().min(1).max(40) });

/**
 * Playing a video in step ("watch together"): where the video stands for everyone. `position` (seconds) was true at the
 * server's time `at` (ms since the epoch); while `playing`, it moves on at `rate` from there (radioPositionAt). The server
 * stamps `at`; members with CONTROL_RADIO set the rest through their player (PUT /api/channels/:id/radio/playback), and every
 * client keeps its own player at that place. Videos only: a live stream is not steered for everyone (user's decision),
 * every viewer's player is their own there; the state then simply goes unused.
 */
const PlaybackRate = z.number().min(0.25).max(2);
export const RadioPlayback = z.object({ playing: z.boolean(), position: z.number().min(0).max(MAX_PLAYBACK_POSITION), rate: PlaybackRate, at: z.number() });
export const SetRadioPlaybackRequest = z.object({ playing: z.boolean(), position: z.number().min(0).max(MAX_PLAYBACK_POSITION), rate: PlaybackRate.default(1) });
/** Where the video stands at the server's time `serverNow` (ms). */
export function radioPositionAt(p: { playing: boolean; position: number; rate: number; at: number }, serverNow: number): number {
  return p.playing ? Math.max(0, p.position + Math.max(0, serverNow - p.at) / 1000 * p.rate) : p.position;
}

export const RadioStation = z.object({ id: Uuid, name: z.string().trim().min(1).max(64), url: RadioUrl });
export const CreateRadioStationRequest = RadioStation.pick({ name: true, url: true });
export const UpdateRadioStationRequest = CreateRadioStationRequest.partial();
/**
 * What a voice channel is tuned to. `stationId` null = an address a member with CONTROL_RADIO typed in instead of choosing a
 * station; `name` is the station's current name (for a typed address: its host), `streamUrl` what clients play.
 */
export const ChannelRadio = z.object({
  stationId: Uuid.nullable(), name: z.string(), streamUrl: z.string(), startedBy: Uuid.nullable(),
  /** Set when the source is a Twitch channel: clients show Twitch's player instead of playing `streamUrl` as audio. */
  twitchChannel: z.string().nullable().default(null),
  /** Set when the source is a YouTube video or live stream: clients show YouTube's player, kept in step through `playback`. */
  youtubeVideo: z.string().nullable().default(null),
  /** Where the video stands for everyone (YouTube sources only). */
  playback: RadioPlayback.nullable().default(null),
  /** Set while the source is a YouTube playlist played as a queue; null also from servers that know no queues. */
  queue: RadioQueue.nullable().default(null),
});
/** PUT /api/channels/:id/radio: one of the server's stations, or any address (same rules as a station's). DELETE turns the radio off. */
/** `videoIds`: the videos of the address's YouTube playlist, read by the sender's client (youtubePlaylistOf); ignored for every other address. */
const QueueVideoIds = z.array(YoutubeVideoId).min(1).max(RADIO_QUEUE_MAX).optional();
export const SetChannelRadioRequest = z.union([z.object({ stationId: Uuid, videoIds: QueueVideoIds }), z.object({ url: RadioUrl, videoIds: QueueVideoIds })]);

export const Channel = z.object({
  id: Uuid,
  kind: ChannelKind,
  name: z.string().min(1).max(64),
  topic: z.string().max(256).nullable(),
  categoryId: Uuid.nullable(),
  position: z.number().int(),
  /** Opus bitrate in kbit/s (only relevant for voice channels). */
  audioBitrate: AudioBitrate,
  /** Send in stereo (music); turns off echo/noise suppression on the sender. */
  audioStereo: z.boolean(),
  /** Web radio playing in this voice channel, null = none. Default for servers from before the radio. */
  radio: ChannelRadio.nullable().default(null),
  // ---- Channel settings (docs/features/channel-permissions.md, 23 September 2026). All with defaults: servers from before
  // send none, clients from before ignore them. No PROTOCOL_VERSION bump.
  /** Voice: whoever sits here cannot enter another voice channel until somebody with MOVE_MEMBERS moves them (BYPASS_STICKY exempt). */
  sticky: z.boolean().default(false),
  /** Voice, with sticky: the hold outlives the member's voice connection, reload and restart; false = it ends with their presence. */
  stickyPersist: z.boolean().default(false),
  /** Voice, with sticky: while held, the member's channel list carries no other voice channel (text channels stay). */
  stickyHideVoice: z.boolean().default(true),
  /** Voice: how many may sit here; null = no limit. */
  userLimit: UserLimit.default(null),
  /** Text: seconds between two messages of one member; 0 = off. MANAGE_MESSAGES in the channel is exempt. */
  slowmodeSeconds: SlowmodeSeconds.default(0),
  /** The channel's notification suggestion for members who set nothing themselves. */
  defaultNotify: ChannelNotification.default("all"),
  /** Voice: false = no web radio in this channel at all, whatever the permissions say. */
  allowRadio: z.boolean().default(true),
  /** Voice: false = nobody shares camera or screen here, whatever the permissions say. */
  allowVideo: z.boolean().default(true),
  /** Voice: false = no vote kick in this channel (docs/features/votekick.md); default on, a server from before it sends nothing. */
  allowVoteKick: z.boolean().default(true),
  /**
   * Derived, display only: the default role cannot see this channel (it or its category denies VIEW_CHANNELS to "Gast").
   * Never a source of truth: the server filters what every member gets; this only draws the lock.
   */
  private: z.boolean().default(false),
});
export const CreateCategoryRequest = z.object({ name: Category.shape.name });
export const UpdateCategoryRequest = z.object({ name: Category.shape.name.optional(), position: z.number().int().optional() });
const ChannelSettingsFields = {
  sticky: z.boolean().optional(),
  stickyPersist: z.boolean().optional(),
  stickyHideVoice: z.boolean().optional(),
  userLimit: UserLimit.optional(),
  slowmodeSeconds: SlowmodeSeconds.optional(),
  defaultNotify: ChannelNotification.optional(),
  allowRadio: z.boolean().optional(),
  allowVideo: z.boolean().optional(),
  allowVoteKick: z.boolean().optional(),
};
export const CreateChannelRequest = z.object({
  kind: ChannelKind,
  name: Channel.shape.name,
  topic: Channel.shape.topic.optional(),
  categoryId: Uuid.nullable().optional(),
  audioBitrate: AudioBitrate.optional(),
  audioStereo: z.boolean().optional(),
  ...ChannelSettingsFields,
});
export const UpdateChannelRequest = z.object({
  name: Channel.shape.name.optional(),
  topic: Channel.shape.topic.optional(),
  categoryId: Uuid.nullable().optional(),
  position: z.number().int().optional(),
  audioBitrate: AudioBitrate.optional(),
  audioStereo: z.boolean().optional(),
  ...ChannelSettingsFields,
});

export const Role = z.object({
  id: Uuid,
  name: z.string().min(1).max(32),
  color: z.string().regex(/^#[0-9a-f]{6}$/).nullable(),
  permissions: z.number().int().nonnegative(),
  /** Higher = more powerful. Whoever manages roles/members may only act below their own highest position. */
  position: z.number().int(),
  /** The @everyone role: every member has it and it cannot be deleted. */
  isDefault: z.boolean(),
});
export const CreateRoleRequest = z.object({ name: Role.shape.name, color: Role.shape.color.optional(), permissions: Role.shape.permissions.optional() });
export const UpdateRoleRequest = z.object({
  name: Role.shape.name.optional(),
  color: Role.shape.color.optional(),
  permissions: Role.shape.permissions.optional(),
  position: z.number().int().optional(),
});

export const Member = z.object({
  userId: Uuid,
  displayName: z.string(),
  publicKey: PublicKey,
  roleIds: z.array(Uuid),
  joinedAt: Iso,
  online: z.boolean(),
  /** Absent: online, but no activity on any connection for AFK_AFTER_MS (reported by the clients, event `activity`). Default for servers from before it. */
  afk: z.boolean().default(false),
  /** The game the member plays, as one of their connections reported it (`activity`), null = none or not shared with servers. The server only relays it: viewers ask the directory's game library about `id`. Default for servers from before it. */
  game: GamePresence.nullable().default(null),
  /** A moderator has blocked camera/screen for this member (overrides STREAM_VIDEO from roles). */
  streamBlocked: z.boolean(),
  /** Verified handle from the directory service (M6), otherwise null. */
  handle: z.string().nullable(),
  /** Avatar from the directory account (address of the image incl. cache version), null = none; shown instead of the initials. Default for servers from before it. */
  avatarUrl: z.string().url().nullable().default(null),
  /** Handle of the server account (`~name`), null = none. Default for servers from before it. */
  localHandle: z.string().nullable().default(null),
  /** Owner (several possible): always has every permission, sits at the very top, cannot be kicked or banned. */
  isOwner: z.boolean(),
});
export const SetMemberRolesRequest = z.object({ roleIds: z.array(Uuid) });
/** Set owner status (only by owners; the first owner cannot be revoked). */
export const SetOwnerRequest = z.object({ owner: z.boolean() });
/** Move a member to another voice channel; null = remove them from the voice channel. */
export const MoveMemberRequest = z.object({ channelId: Uuid.nullable() });
/** Stop a member's camera and/or screen. */
export const StopStreamRequest = z.object({ camera: z.boolean().default(true), screen: z.boolean().default(true) });
export const SetStreamBlockedRequest = z.object({ blocked: z.boolean() });
/** `deleteMessagesHours` (docs/features/reports.md): also delete the member's messages of the last hour, day or week. */
export const BanRequest = z.object({ userId: Uuid, reason: z.string().max(256).nullable().optional(), deleteMessagesHours: DeleteRecentHours.optional() });
export const Ban = z.object({ userId: Uuid, displayName: z.string(), reason: z.string().nullable(), bannedBy: Uuid.nullable(), createdAt: Iso });

export const Invite = z.object({
  code: InviteCode,
  createdBy: Uuid.nullable(),
  createdAt: Iso,
  expiresAt: Iso.nullable(),
  maxUses: z.number().int().positive().nullable(),
  uses: z.number().int().nonnegative(),
});
export const CreateInviteRequest = z.object({
  expiresInHours: z.number().int().positive().max(24 * 365).nullable().optional(),
  maxUses: z.number().int().positive().max(10_000).nullable().optional(),
});
/** Public preview of an invite (retrievable without signing in). */
export const InvitePreview = z.object({ serverName: z.string(), memberCount: z.number().int(), valid: z.boolean() });

// ---------- Messages ----------

export const MessageContent = z.string().trim().min(1).max(4000);
export const Attachment = z.object({
  id: Uuid,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  /** Relative path for downloading. */
  url: z.string(),
});
/**
 * Preview of a link in a message (docs/features/link-previews.md), made by the server: it fetches the page's title,
 * description and picture once, and clients load the picture from this server only (`image` is a relative path here,
 * never a foreign host: a remote picture would show every reader's address to that host). `url` is the link as the author
 * wrote it and names the preview when the author removes it. `youtube` = a video that plays in the chat: `videoId` and
 * `start` (seconds) feed the player, which a client loads only when the reader presses play.
 */
export const LinkPreview = z.object({
  url: z.string().max(2100),
  kind: z.enum(["page", "youtube"]),
  siteName: z.string().max(100).nullable(),
  title: z.string().max(300).nullable(),
  description: z.string().max(500).nullable(),
  image: z.string().nullable(),
  videoId: z.string().regex(/^[\w-]{11}$/).optional(),
  start: z.number().int().nonnegative().optional(),
});
/** The author removes one preview of their message (POST /api/messages/:id/previews/remove); it stays away when the message is edited. */
export const RemovePreviewRequest = z.object({ url: z.string().min(1).max(2100) });
export const Message = z.object({
  id: Uuid,
  /** Monotonically increasing per server, for ordering and cursors. */
  seq: z.number().int(),
  channelId: Uuid,
  authorId: Uuid,
  content: z.string(),
  attachments: z.array(Attachment),
  /**
   * Optional = feature flag: a server from before link previews, or one that has them turned off, does not send the field.
   * They arrive after the message itself, with a `message.update` once the server has looked the links up.
   */
  previews: z.array(LinkPreview).optional(),
  createdAt: Iso,
  editedAt: Iso.nullable(),
});
export const CreateMessageRequest = z.object({
  content: z.string().trim().max(4000),
  attachmentIds: z.array(Uuid).max(10).optional(),
}).refine((m) => m.content.length > 0 || (m.attachmentIds?.length ?? 0) > 0, "content or attachment required");
export const UpdateMessageRequest = z.object({ content: MessageContent });
export const MessagePage = z.object({ messages: z.array(Message), hasMore: z.boolean() });

/**
 * Read state of one text channel for the signed-in member, kept by the server so it holds on every device
 * (GET /api/read-state). `lastReadSeq` null = never opened: then everything since joining counts. `unread` and `mentions`
 * are computed by the server over messages of other people newer than the read state; `mentions` counts messages whose
 * text mentions the member (`<@userId>` outside code, `mentionedUserIds` in mentions.ts).
 */
export const ChannelReadState = z.object({
  channelId: Uuid,
  lastReadSeq: z.number().int().nullable(),
  /** Newest message in the channel, null = empty. */
  latestSeq: z.number().int().nullable(),
  unread: z.boolean(),
  mentions: z.number().int().min(0),
  /** The member has muted this channel: clients show no unread mark for it (mentions still count). Default for servers from before mutes. */
  muted: z.boolean().default(false),
});
export const ReadStateResponse = z.object({
  channels: z.array(ChannelReadState),
  /** The member has muted this whole server: no unread mark on the server rail (mentions still count). */
  serverMuted: z.boolean().default(false),
});
/** PUT /api/channels/:id/mute and PUT /api/me/mute. */
export const MuteRequest = z.object({ muted: z.boolean() });
export const MuteState = z.object({ serverMuted: z.boolean(), channelIds: z.array(Uuid) });
/** POST /api/channels/:id/read: everything up to `seq` has been seen. The server never moves a read state backwards. */
export const MarkReadRequest = z.object({ seq: z.number().int().min(0) });

/** The complete state a client needs after the handshake. */
export const ServerState = z.object({
  settings: ServerSettings,
  categories: z.array(Category),
  channels: z.array(Channel),
  roles: z.array(Role),
  members: z.array(Member),
  /** The server's web radio stations. Missing = a server from before the radio: clients then offer no radio at all. */
  radioStations: z.array(RadioStation).optional(),
  /** Where this server can import a structure from (import.ts). Missing = a server from before the import: clients show none. */
  importSources: z.array(ImportSource).optional(),
  /** Effective permissions of the signed-in user. */
  myPermissions: z.number().int(),
  /**
   * The user's permissions in every channel and category they can see, resolved through the overwrites (channels.ts).
   * Present = this server does channel permissions (the feature flag: the client offers the channel dialog and the context
   * menu entries only then); missing = a server from before, the client falls back to myPermissions everywhere.
   */
  myChannelPermissions: z.record(Uuid, z.number().int()).optional(),
  /** Where a sticky voice channel holds the user right now; null = nowhere (missing = a server from before). */
  myVoiceLock: VoiceLock.nullable().optional(),
  /**
   * Reports (docs/features/reports.md): the number of open reports for a member with MANAGE_REPORTS, 0 for everybody else.
   * Present = the server takes reports (the client offers "Melden" only then); missing = a server from before.
   */
  openReports: z.number().int().nonnegative().optional(),
});

// ---------- REST: status API (docs/features/status-api.md) ----------

/**
 * What GET /api/status shows to the outside (a website widget, a bot, a stream overlay): the server, its channels in the
 * order the client shows them, and the members with where they sit. No permissions, no keys, no messages. `iconUrl` and
 * `avatarUrl` are absolute (the avatar is the directory account's picture, public there like the handle; user's decision).
 */
export const StatusChannel = z.object({
  id: Uuid, kind: ChannelKind, name: z.string(), topic: z.string().nullable(),
  /** null = outside every category (shown first). */
  categoryId: Uuid.nullable(),
  /** Order inside the category (ascending), as in the client. */
  position: z.number().int(),
});
/** A member sitting in a voice channel; members outside every voice channel are not part of the status (user's decision). */
export const StatusMember = z.object({
  userId: Uuid, displayName: z.string(), handle: z.string().nullable(), avatarUrl: z.string().url().nullable(),
  /** Handle of the server account (`~name`), null = none. */
  localHandle: z.string().nullable().default(null),
  afk: z.boolean(), isOwner: z.boolean(),
  /** The voice channel the member sits in with their mute state. */
  voice: VoiceStatus.extend({ channelId: Uuid }),
});
export const ServerStatus = z.object({
  name: z.string(), iconUrl: z.string().url().nullable(), time: Iso,
  categories: z.array(Category), channels: z.array(StatusChannel), members: z.array(StatusMember),
});

// ---------- REST: joining LiveKit ----------

/** The client may only request rooms that exist as a voice channel; the server checks channel and permission. */
export const RtcTokenRequest = z.object({ channelId: Uuid });
export const RtcTokenResponse = z.object({
  /** Base URL for livekit-client (`Room.connect`), without a path. The SDK appends /rtc itself. */
  url: z.string().url(),
  token: z.string(),
});

// ---------- WebSocket: events ----------

/**
 * Somebody sitting in a voice channel. `micMuted`/`deafened` (23 September 2026) is what their client reported with
 * `voice.join` and `voice.status`, so everyone sees it, not only the people in the same LiveKit room; defaults for
 * servers from before it (clients then fall back to what LiveKit shows them).
 */
/**
 * `viewVideo` (25 September 2026, docs/features/channel-permissions.md): whether the member may watch camera and screen in
 * this channel (VIEW_VIDEO resolved through the channel's overwrites by the server). Senders restrict their video to those
 * members. Missing = a server from before, the client falls back to the server-wide roles. No version bump.
 */
export const VoiceMember = z.object({ userId: Uuid, displayName: z.string(), micMuted: z.boolean().default(false), deafened: z.boolean().default(false), cameraOn: z.boolean().default(false), screenOn: z.boolean().default(false), viewVideo: z.boolean().optional() });

export const ClientHello = z.object({ type: z.literal("hello"), protocolVersion: z.number().int(), sessionToken: z.string(), deviceProof: SessionProofSchema.optional() });
export const ClientPing = z.object({ type: z.literal("ping"), t: z.number() });
/** Channel state is intent, not media state: "I want to be listed as a member". */
/** The mute state travels with the join so nobody shows as unmuted for a moment; a server from before it drops the fields unread. */
export const ClientVoiceJoin = z.object({ type: z.literal("voice.join"), channelId: Uuid, micMuted: z.boolean().optional(), deafened: z.boolean().optional(), cameraOn: z.boolean().optional(), screenOn: z.boolean().optional() });
export const ClientVoiceLeave = z.object({ type: z.literal("voice.leave") });
/**
 * Mute or deafen changed while in the channel. Sent only to servers whose settings carry `statusApi` (older servers would
 * answer `bad_message`); the server ignores it from a connection that sits in no voice channel.
 */
export const ClientVoiceStatus = VoiceStatus.extend({ type: z.literal("voice.status") });
export const ClientTyping = z.object({ type: z.literal("typing"), channelId: Uuid });
/**
 * AFK detection: this connection's user has given no input (and has not spoken) for AFK_AFTER_MS (`idle: true`) or is back.
 * A connection counts as active until it says otherwise; a member is AFK once all their connections are idle. Sent only to
 * servers whose settings carry `afkChannelId` (older servers would answer `bad_message`).
 */
export const ClientActivity = z.object({
  type: z.literal("activity"), idle: z.boolean(),
  /** Game display (friends.ts `GamePresence`): what this connection's user plays, null = nothing; left out = says nothing about it. A server from before it drops the field unread. */
  game: GamePresence.nullable().optional(),
});

export const ClientEvent = z.discriminatedUnion("type", [ClientHello, ClientPing, ClientVoiceJoin, ClientVoiceLeave, ClientVoiceStatus, ClientTyping, ClientActivity]);

export const ServerWelcome = z.object({
  type: z.literal("welcome"),
  userId: Uuid,
  serverTime: Iso,
  protocolVersion: z.number().int(),
  state: ServerState,
});
export const ServerPong = z.object({ type: z.literal("pong"), t: z.number() });
/** Complete member state of a voice channel. Not a delta: simple, and correct after a reconnect. */
export const ServerVoiceState = z.object({
  type: z.literal("voice.state"), channelId: Uuid, members: z.array(VoiceMember),
  /**
   * A vote kick could be started here right now (docs/features/votekick.md): the channel allows it, at least
   * VOTEKICK_MIN_MEMBERS sit in it, nobody present may throw anybody out, and no vote is running. Default false, so a
   * server from before it offers nothing; the server checks again when a vote is started.
   */
  voteKick: z.boolean().default(false),
});
/** Structure changes arrive as the complete state of the respective part. Small enough, and never inconsistent. */
export const ServerStructure = z.object({
  type: z.literal("structure"),
  settings: ServerSettings.optional(),
  categories: z.array(Category).optional(),
  channels: z.array(Channel).optional(),
  roles: z.array(Role).optional(),
  members: z.array(Member).optional(),
  radioStations: z.array(RadioStation).optional(),
});
/** Your own permissions changed (role assigned/revoked, role edited, an overwrite, a hold in a sticky channel). */
export const ServerMe = z.object({
  type: z.literal("me"), myPermissions: z.number().int(),
  myChannelPermissions: ServerState.shape.myChannelPermissions, myVoiceLock: ServerState.shape.myVoiceLock,
});
export const ServerMessageCreate = z.object({ type: z.literal("message.create"), message: Message });
export const ServerMessageUpdate = z.object({ type: z.literal("message.update"), message: Message });
export const ServerMessageDelete = z.object({ type: z.literal("message.delete"), channelId: Uuid, id: Uuid });
/** Many messages of one channel at once (a ban with "delete messages of the last ...", a report closed that way); older clients drop the event and catch up on reload. */
export const ServerMessageBulkDelete = z.object({ type: z.literal("message.bulkDelete"), channelId: Uuid, ids: z.array(Uuid) });
/** The open reports changed; only members with MANAGE_REPORTS get it (a count, never content). */
export const ServerReportsCount = z.object({ type: z.literal("reports.count"), open: z.number().int().nonnegative() });
/** A moderator removed something of the recipient's after a report (decision 4): the reason, never the reporter. */
export const ServerModerationNotice = z.object({ type: z.literal("moderation.notice"), kind: z.enum(["message_removed", "messages_removed"]), channelName: z.string().nullable(), count: z.number().int().nonnegative().default(1) });
export const ServerTyping = z.object({ type: z.literal("typing"), channelId: Uuid, userId: Uuid });
/**
 * You have read a channel on one of your devices (sent only to your own connections, so the others drop their marks).
 * Added without a PROTOCOL_VERSION bump: clients drop events they cannot parse, and nothing depends on receiving it.
 */
export const ServerReadUpdate = z.object({ type: z.literal("read.update"), channelId: Uuid, lastReadSeq: z.number().int() });
/** Your mutes changed on one of your devices: the complete state (sent only to your own connections; no version bump, as above). */
export const ServerMuteUpdate = z.object({ type: z.literal("mute.update"), serverMuted: z.boolean(), channelIds: z.array(Uuid) });
/**
 * What the radio of a voice channel is playing right now (the station's ICY "StreamTitle", usually "Artist - Title"); null = unknown
 * or nothing beyond the station's name. Sent to everyone on a change and after the welcome for channels with a title. No
 * PROTOCOL_VERSION bump: older clients drop the event and simply keep showing the station's name.
 */
export const ServerRadioMeta = z.object({ type: z.literal("radio.meta"), channelId: Uuid, title: z.string().max(300).nullable() });
/**
 * A member with CONTROL_RADIO played, paused or moved the channel's video (RadioPlayback): everyone's player follows. The
 * channel list carries the same state for whoever connects later. No PROTOCOL_VERSION bump: older clients drop the event.
 */
export const ServerRadioPlayback = z.object({ type: z.literal("radio.playback"), channelId: Uuid, playback: RadioPlayback });
/**
 * A moderator moves you to another voice channel (null = out of the channel); the client joins there or leaves.
 * `reason: "afk"` = moved by the server into the AFK channel for inactivity (`by` is then the server's name; older clients
 * ignore the field and show the usual notice).
 */
export const ServerVoiceMoved = z.object({ type: z.literal("voice.moved"), channelId: Uuid.nullable(), by: z.string(), reason: z.enum(["afk", "elsewhere", "blocked"]).optional(), until: Iso.nullable().optional() });
// reason "blocked" (24 September 2026, docs/features/channel-blocks.md): removed and kept out of the channel; `until` = when the
// block ends, null = permanent. A client from before drops the event; LiveKit ends its media anyway (routes/channelBlocks.ts).
// reason "elsewhere" (22 September 2026): the same account joined a voice channel of this server from another device or tab,
// this connection ends (channelId null). A client from before drops the event; LiveKit ends its media anyway (ws/handler.ts).
/** A moderator stops your camera and/or screen share (LiveKit has already muted the tracks). */
export const ServerVoiceStop = z.object({ type: z.literal("voice.stop"), camera: z.boolean(), screen: z.boolean(), by: z.string() });
/**
 * A vote kick in the voice channel: the running vote (null = none any more) with what this recipient did about it.
 * Sent to everybody sitting in the channel. Added without a PROTOCOL_VERSION bump: a client from before drops the event.
 */
export const ServerVoteKick = z.object({
  type: z.literal("votekick"), channelId: Uuid, vote: VoteKick.nullable(),
  /** What this recipient voted, null = not yet or not allowed to. */
  myVote: z.enum(["yes", "no"]).nullable().default(null),
  /** This recipient is one of the voters fixed at the start and has not voted yet. */
  canVote: z.boolean().default(false),
});
/** How a vote ended; everybody in the channel shows it for VOTEKICK_RESULT_MS, the member it was about included. */
export const ServerVoteKickResult = z.object({ type: z.literal("votekick.result"), result: VoteKickResult });
/** The server removed you (kick/ban); it closes the connection afterwards. */
export const ServerRemoved = z.object({ type: z.literal("removed"), reason: z.enum(["kicked", "banned"]), message: z.string().nullable() });
export const ServerError = z.object({
  type: z.literal("error"),
  code: z.enum(["protocol_version", "unauthorized", "bad_message", "unknown_channel", "forbidden"]),
  message: z.string(),
});

export const ServerEvent = z.discriminatedUnion("type", [
  ServerWelcome, ServerPong, ServerVoiceState, ServerStructure, ServerMe,
  ServerMessageCreate, ServerMessageUpdate, ServerMessageDelete, ServerMessageBulkDelete, ServerTyping, ServerReadUpdate, ServerMuteUpdate, ServerRadioMeta, ServerRadioPlayback, ServerVoiceMoved, ServerVoiceStop, ServerVoteKick, ServerVoteKickResult, ServerReportsCount, ServerModerationNotice, ServerRemoved, ServerError,
]);

export type ClientEvent = z.infer<typeof ClientEvent>;
export type ServerEvent = z.infer<typeof ServerEvent>;
export type VerifyResponse = z.infer<typeof VerifyResponse>;
export type RtcTokenResponse = z.infer<typeof RtcTokenResponse>;
export type Me = z.infer<typeof Me>;
export type ServerSettings = z.infer<typeof ServerSettings>;
export type StatusApiMode = z.infer<typeof StatusApiMode>;
export type StatusApiKeyResponse = z.infer<typeof StatusApiKeyResponse>;
export type LimitsReport = z.infer<typeof LimitsReport>;
export type DoctorStatus = z.infer<typeof DoctorStatus>;
export type DoctorCheck = z.infer<typeof DoctorCheck>;
export type DoctorReport = z.infer<typeof DoctorReport>;
export type VoiceStatus = z.infer<typeof VoiceStatus>;
export type ServerStatus = z.infer<typeof ServerStatus>;
export type StatusMember = z.infer<typeof StatusMember>;
export type StatusChannel = z.infer<typeof StatusChannel>;
export type Category = z.infer<typeof Category>;
export type Channel = z.infer<typeof Channel>;
export type RadioStation = z.infer<typeof RadioStation>;
export type ChannelRadio = z.infer<typeof ChannelRadio>;
export type RadioPlayback = z.infer<typeof RadioPlayback>;
export type RadioQueue = z.infer<typeof RadioQueue>;
export type Role = z.infer<typeof Role>;
export type Member = z.infer<typeof Member>;
export type Ban = z.infer<typeof Ban>;
export type Invite = z.infer<typeof Invite>;
export type InvitePreview = z.infer<typeof InvitePreview>;
export type Message = z.infer<typeof Message>;
export type Attachment = z.infer<typeof Attachment>;
export type LinkPreview = z.infer<typeof LinkPreview>;
export type MessagePage = z.infer<typeof MessagePage>;
export type ChannelReadState = z.infer<typeof ChannelReadState>;
export type ReadStateResponse = z.infer<typeof ReadStateResponse>;
export type MuteState = z.infer<typeof MuteState>;
export type ServerState = z.infer<typeof ServerState>;
export type VoiceMember = z.infer<typeof VoiceMember>;
