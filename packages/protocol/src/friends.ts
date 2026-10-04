import { z } from "zod";
import { DeviceProofFields, DisplayName, Handle, LibraryGameId } from "./directory";
import { Iso, PublicKey, Signature, Uuid } from "./primitives";

// COPY NOTE: also exists byte-identically in the squorli-directory repo (packages/protocol/src); the source is squorli-server, copy it over after any change.
/**
 * Friends and direct messages (M7): both live at the directory service, because it is the only thing both accounts share.
 * The chat client holds a second WebSocket connection to the directory (GET /api/ws): the directory sends a
 * challenge, the client replies with a signature from its key, and from then on the socket is the identity.
 * Friendship = one row per pair; it only counts once the invited side has accepted (pending_in -> accepted).
 * Messages are end-to-end encrypted (dm.ts); the directory only sees and stores ciphertext and metadata.
 */

/** Version of the directory socket; the service rejects older clients with error `version`. */
export const DIRECTORY_WS_VERSION = 1;

/**
 * AFK detection: no input (and no speaking) for this long = absent. The chat client measures it and reports it to its chat
 * servers (`activity` in index.ts) and to the directory (`activity` below), so friends see it too. Fixed at ten minutes for
 * everyone (user's decision): one state is shown on every server and to friends, so no server sets a time of its own.
 */
export const AFK_AFTER_MS = 10 * 60_000;

/**
 * Game display (21 September 2026, docs/features/games.md): the game a user plays, as their client reports it together with
 * the `activity` state, to the directory (friends see it) and, unless the user keeps it to friends, to their chat servers
 * (members see it). Off until the user switches it on. `id` = the launcher's id when the directory's game library can know
 * it; then viewers take name and icon from the directory and show nothing when it says `show: false`. `name` is what the
 * playing client calls the game: the fallback, and all there is for a game without such an id (Epic, a program the user
 * added); it is the user's own text like a display name. AFK and the game are independent: both may show at once.
 */
export const GameName = z.string().trim().min(1).max(64).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, "eine Zeile ohne Steuerzeichen");
export const GamePresence = z.object({ id: LibraryGameId.optional(), name: GameName });
export type GamePresence = z.infer<typeof GamePresence>;

/** Signature on connect: bound to the directory's host like every other signature. */
export function directoryWsAuthMessage(directoryHost: string, nonce: string): string {
  return `community-directory-ws\n${directoryHost}\n${nonce}`;
}

/** From my point of view: I sent a request (pending_out), I was asked (pending_in), confirmed, blocked by me. */
export const FriendState = z.enum(["pending_out", "pending_in", "accepted", "blocked"]);
export type FriendState = z.infer<typeof FriendState>;
/** A friend or an open request. The global display name is only available for confirmed friends, otherwise just the handle. */
export const Friend = z.object({
  handle: Handle,
  publicKey: PublicKey,
  displayName: DisplayName.nullable(),
  state: FriendState,
  /** Time of the request or of the confirmation. */
  since: Iso,
  /** Presence via the directory (user decision 2026-09-14): at least one socket connected; only for confirmed friends, otherwise false. */
  online: z.boolean().default(false),
  /** Online but absent: every socket of the account has reported `activity` idle. Only for confirmed friends, otherwise false. */
  afk: z.boolean().default(false),
  /** The game the friend plays (any of their sockets reported it), null = none or not shared. Only for confirmed friends. */
  game: GamePresence.nullable().default(null),
  /** Avatar: when the friend last stored an image, null = none (address: `directoryAvatarUrl`). Default for directories from before it. */
  avatarUpdatedAt: Iso.nullable().default(null),
});
export type Friend = z.infer<typeof Friend>;

/** Public handle search (GET /api/handles?q=<prefix>): handle and key only, at most 10 hits. */
export const FriendSearchResult = z.object({ handle: Handle, publicKey: PublicKey });
export const FriendSearchResponse = z.array(FriendSearchResult);
export type FriendSearchResult = z.infer<typeof FriendSearchResult>;

/** Ciphertext (base64) up to 16 KB; the directory only checks the length. */
export const DM_MAX_CIPHERTEXT_CHARS = 22_000;
const DmIv = z.string().regex(/^[0-9a-f]{24}$/, "24 hex chars");
const DmCiphertext = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(DM_MAX_CIPHERTEXT_CHARS);
/** A stored message: `seq` is assigned by the directory (ordering and cursor), everything else comes from the sender. */
export const DmMessage = z.object({
  id: Uuid,
  seq: z.number().int().nonnegative(),
  from: PublicKey,
  to: PublicKey,
  iv: DmIv,
  ciphertext: DmCiphertext,
  sentAt: Iso,
});
export type DmMessage = z.infer<typeof DmMessage>;
/** Conversation with a friend from the account's point of view: last message and unread count (the read cursor lives at the directory and applies to all devices). */
export const DmConversation = z.object({ peer: PublicKey, lastSeq: z.number().int(), lastAt: Iso, unread: z.number().int().nonnegative() });
export type DmConversation = z.infer<typeof DmConversation>;

// ---- Client -> directory
/** `deviceKey`/`deviceSignature`: the device's proof over `directoryWsAuthMessage` (directory.ts "Devices"); a service from before them drops the fields. */
export const DirectoryClientAuth = z.object({ type: z.literal("auth"), publicKey: PublicKey, signature: Signature, version: z.number().int(), ...DeviceProofFields });
export const DirectoryClientPing = z.object({ type: z.literal("ping"), t: z.number() });
/** Request to a key (the client has resolved handle -> key beforehand). If a request from the other side is already open, this accepts it. */
export const FriendRequest = z.object({ type: z.literal("friends.request"), publicKey: PublicKey });
export const FriendAction = z.object({ type: z.enum(["friends.accept", "friends.decline", "friends.remove", "friends.block", "friends.unblock"]), publicKey: PublicKey });
export const DmSend = z.object({ type: z.literal("dm.send"), to: PublicKey, id: Uuid, iv: DmIv, ciphertext: DmCiphertext, sentAt: Iso });
export const DmHistoryRequest = z.object({ type: z.literal("dm.history"), peer: PublicKey, before: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional() });
export const DmReadRequest = z.object({ type: z.literal("dm.read"), peer: PublicKey, seq: z.number().int().nonnegative() });
/**
 * Delete a message (user decision 2026-09-14): within DM_DELETE_BOTH_MS the sender deletes it for both sides,
 * after that (and the recipient always) only for themselves; the other side then keeps its copy.
 */
export const DM_DELETE_BOTH_MS = 5 * 60_000;
export const DmDeleteRequest = z.object({ type: z.literal("dm.delete"), peer: PublicKey, id: Uuid });
/** Delete a whole conversation for me (the other side keeps its copy). */
export const DmClearRequest = z.object({ type: z.literal("dm.clear"), peer: PublicKey });
/**
 * This socket's user is idle (AFK_AFTER_MS without activity) or back; a socket counts as active until it says otherwise. Only sent
 * when the directory reports `features.afk`. `game`: what this socket's user plays, null = nothing; left out = this message says
 * nothing about it (a client from before the game display). A service from before it drops the field unread.
 */
export const DirectoryClientActivity = z.object({ type: z.literal("activity"), idle: z.boolean(), game: GamePresence.nullable().optional() });
export const DirectoryClientEvent = z.discriminatedUnion("type", [DirectoryClientAuth, DirectoryClientPing, DirectoryClientActivity, FriendRequest, DmSend, DmHistoryRequest, DmReadRequest, DmDeleteRequest, DmClearRequest])
  .or(FriendAction);
export type DirectoryClientEvent = z.infer<typeof DirectoryClientEvent>;

// ---- Directory -> client
export const DirectoryChallengeEvent = z.object({ type: z.literal("challenge"), nonce: z.string().regex(/^[0-9a-f]{64}$/), host: z.string() });
export const DirectoryWelcomeEvent = z.object({ type: z.literal("welcome"), friends: z.array(Friend), conversations: z.array(DmConversation), serverTime: Iso });
export const DirectoryPongEvent = z.object({ type: z.literal("pong") });
/** Friend or request changed; `friend: null` = entry gone (removed, declined, withdrawn, blocked by the other side). */
export const FriendUpdateEvent = z.object({ type: z.literal("friends.update"), publicKey: PublicKey, friend: Friend.nullable() });
/** Live delivery; also goes to the sender's other devices. */
export const DmMessageEvent = z.object({ type: z.literal("dm.message"), message: DmMessage });
export const DmHistoryEvent = z.object({ type: z.literal("dm.history"), peer: PublicKey, messages: z.array(DmMessage), more: z.boolean() });
/** Read cursor moved on another device. */
export const DmReadEvent = z.object({ type: z.literal("dm.read"), peer: PublicKey, seq: z.number().int() });
/** Message gone: `both` = deleted at the peer as well (sender within the time limit), otherwise only for me (goes to my other devices). */
export const DmDeletedEvent = z.object({ type: z.literal("dm.deleted"), peer: PublicKey, id: Uuid, both: z.boolean() });
export const DmClearedEvent = z.object({ type: z.literal("dm.cleared"), peer: PublicKey });
/** A confirmed friend has come online, gone, or turned absent/active (`afk`, only ever true while online). */
export const FriendPresenceEvent = z.object({ type: z.literal("friends.presence"), publicKey: PublicKey, online: z.boolean(), afk: z.boolean().default(false), game: GamePresence.nullable().default(null) });
/**
 * `account_suspended` (27 September 2026): the directory's operator suspended the account, it gets no socket until `until`.
 * The directory sends it right before an `unauthorized`: a client from before it drops the code it does not know and stops
 * on the second one, a client that knows it stops on the first and shows the suspension.
 * `device_revoked`, `device_unknown`, `device_required` (29 September 2026, directory.ts "Devices"): the device is not let
 * in; sent the same way before an `unauthorized`, and the socket closes with DIRECTORY_WS_CLOSE_DEVICE. The same codes
 * reach a socket that is open while its device is signed out.
 */
export const DIRECTORY_WS_CLOSE_DEVICE = 4015;
export const DirectoryErrorCode = z.enum(["version", "unauthorized", "bad_message", "unknown_account", "self", "not_friends", "blocked", "declined_recently", "rate_limited", "too_large", "duplicate", "not_found", "account_suspended", "device_revoked", "device_unknown", "device_required"]);
export type DirectoryErrorCode = z.infer<typeof DirectoryErrorCode>;
/** `ref` = id of the message (dm.send) or key (friends.*) the error refers to; `until` = the end of a suspension (`account_suspended`). */
export const DirectoryErrorEvent = z.object({ type: z.literal("error"), code: DirectoryErrorCode, message: z.string(), ref: z.string().nullable().default(null), until: Iso.nullable().optional() });
/**
 * The account's notices changed (a measure of the operator's, directory.ts "Notices"): the client reads its status again.
 * Nothing in it: what changed is read with the account's signature. A client from before it drops the event.
 */
export const NoticesChangedEvent = z.object({ type: z.literal("notices.changed") });
/**
 * The account's server list changed (4 October 2026, user's wish: the rail follows at once on every device): a server of the
 * list got a new icon, an entry came (a sign-in on a new server) or went (leave, its confirmation), or the sealed settings
 * (the rail's order, the hidden servers) were written, from this or another device. Nothing in it: the client reads its
 * status again, like after `notices.changed`. A client from before it drops the event.
 */
export const ServersChangedEvent = z.object({ type: z.literal("servers.changed") });
export const DirectoryServerEvent = z.discriminatedUnion("type", [
  DirectoryChallengeEvent, DirectoryWelcomeEvent, DirectoryPongEvent, FriendUpdateEvent, FriendPresenceEvent, DmMessageEvent, DmHistoryEvent, DmReadEvent, DmDeletedEvent, DmClearedEvent, DirectoryErrorEvent, NoticesChangedEvent,
  ServersChangedEvent,
]);
export type DirectoryServerEvent = z.infer<typeof DirectoryServerEvent>;

// ---- Account page (without a socket): the same friend actions as a signed account action "friends" (POST /api/friends), response = the
// list afterwards. The signature's payload is "<op>\n<publicKey|empty>" so that neither action nor target can be swapped out.
export const FriendOp = z.enum(["list", "request", "accept", "decline", "remove", "block", "unblock"]);
export type FriendOp = z.infer<typeof FriendOp>;
export function directoryFriendsPayload(op: FriendOp, publicKey: string | null): string {
  return `${op}\n${publicKey ?? ""}`;
}
export const FriendsActionRequest = z.object({ publicKey: PublicKey, challengeId: Uuid, signature: Signature, ...DeviceProofFields, op: FriendOp, target: PublicKey.nullable() });
export const FriendsListResponse = z.array(Friend);
