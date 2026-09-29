import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { LinkPreview, ReportSnapshot } from "@squorli/protocol";

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Identity = public Ed25519 key. No password. A user can exist without being a member (kicked/banned). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicKey: text("public_key").notNull().unique(),
  /** Profile per server (like a server nickname; identity: root AGENTS.md section 6). null = show the short form of the key. */
  displayName: text("display_name"),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
  /** Verified handle from the directory service (M6), looked up at sign-in and cached here. */
  handle: text("handle"),
  handleCheckedAt: ts("handle_checked_at"),
  /**
   * Avatar of the directory account (19 September 2026): address of the image at the directory incl. its cache version, cached here
   * together with handle and name; null = none. The image itself never passes through this server: the clients load it from the directory.
   */
  avatarUrl: text("avatar_url"),
  /**
   * The directory's operator suspended the account until then (docs/features/reports.md, 27 September 2026), as the directory
   * told this server with its token; null or a past date = not suspended. Cached like the handle, so it counts while the
   * directory cannot be reached. What follows from it: users/suspension.ts.
   */
  suspendedUntil: ts("suspended_until"),
  /**
   * Devices of the directory account (docs/features/devices.md, 29 September 2026), as the directory told this server with
   * its token: whether the account lets only enrolled devices in, and the keys of those devices (null = never told). Cached
   * like the handle. A session of an enforced account counts only with one of these keys (users/devices.ts).
   */
  devicesEnforced: boolean("devices_enforced").notNull().default(false),
  deviceKeys: jsonb("device_keys").$type<string[]>(),
});

/**
 * Server account (`~name`, docs/features/local-accounts.md, 25 September 2026): a handle of this server bound to a key, with the
 * key's seed encrypted by the client (the password never reaches the server; `auth_hash` = SHA-256 of the auth key that grants
 * fetching the blob, as at the directory). Also the avatar of such an account, which this server stores itself (DATA_DIR/avatars).
 */
export const localAccounts = pgTable("local_accounts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  handle: text("handle").notNull().unique(),
  backupParams: jsonb("backup_params").$type<{ kdf: "pbkdf2-sha256"; iterations: number; salt: string; iv: string }>().notNull(),
  ciphertext: text("ciphertext").notNull(),
  authHash: text("auth_hash").notNull(),
  avatarMime: text("avatar_mime"),
  avatarUpdatedAt: ts("avatar_updated_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  /** Since then the account lets only enrolled devices in (docs/features/devices.md): set by its first sign-out of another device, null before. */
  devicesEnforcedAt: ts("devices_enforced_at"),
});

/**
 * Devices of a server account (docs/features/devices.md, 29 September 2026): for a server account this server decides
 * which devices are let in (for a directory account the directory does, `users.device_keys`). One row per device key;
 * a device that was signed out keeps its row, so that it stays out until the password enrols it again.
 */
export const localDevices = pgTable("local_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The device's Ed25519 public key (hex). */
  deviceKey: text("device_key").notNull(),
  /** From the user agent and the Origin header at enrolment. */
  label: text("label"),
  origin: text("origin"),
  /** "register", "password" (a key fetch), "claim" or "legacy" (silently, an account that is not enforced). */
  enrolledBy: text("enrolled_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at"),
  revokedAt: ts("revoked_at"),
  /** "user" (signed out from another device), "self", "replaced" (made way for another one), "idle" */
  revokedWhy: text("revoked_why"),
}, (t) => [uniqueIndex("local_devices_user_key_idx").on(t.userId, t.deviceKey)]);

export const sessions = pgTable("sessions", {
  /** SHA-256 (hex) of the session token (auth/session.ts `tokenHash`, since migration 0034); the token itself is never stored. */
  token: text("token").primaryKey(),
  /** Public identifier for device management (M6c); the token stays secret. */
  id: uuid("id").notNull().defaultRandom().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
  /** Derived from the user agent at sign-in, e.g. "Chrome on Windows". */
  label: text("label"),
  /** Updated on every request, throttled to once every 5 minutes. */
  lastUsedAt: ts("last_used_at"),
  /** The key of the device that signed in (docs/features/devices.md); null = a session from before devices, or of a client from before them. */
  deviceKey: text("device_key"),
});

/** Exactly one row (id = "server"). One deployment = one server. */
export const serverSettings = pgTable("server_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  openJoin: boolean("open_join").notNull().default(false),
  /** Until 25 September 2026 "only with a directory account"; since server accounts an account is always required, the column is unused. */
  requireAccount: boolean("require_account").notNull().default(false),
  /** Server accounts may be registered (always, whatever this says, when there is no directory). */
  localAccounts: boolean("local_accounts").notNull().default(false),
  /** M6d: list in the server directory, with a description (both are sent to the directory at registration). */
  listed: boolean("listed").notNull().default(false),
  description: text("description"),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  /** Server icon (admin): the file lives under DATA_DIR/server-icon, here the MIME type and timestamp (cache version). */
  iconMime: text("icon_mime"),
  iconUpdatedAt: ts("icon_updated_at"),
  /** The server's Ed25519 seed (hex) for registration at the directory (M6); generated on first start, unchanged afterwards. */
  directoryPrivateKey: text("directory_private_key"),
  /** HMAC key (hex) of the signed attachment links (attachmentLinks.ts); generated on first start, unchanged afterwards. */
  linkSecret: text("link_secret"),
  /** Web radio: turn a channel's radio off once the channel has been empty for two minutes (admin area > server). */
  radioAutoStop: boolean("radio_auto_stop").notNull().default(true),
  /** AFK channel (admin area > server): absent members are moved here; no sending, no hearing, no radio in it. A deleted channel clears it. */
  afkChannelId: uuid("afk_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
  /** Status API (docs/features/status-api.md): who may read GET /api/status; "off" (default), "key", "public". */
  statusApi: text("status_api", { enum: ["off", "key", "public"] }).notNull().default("off"),
  /** The key for mode "key" (random, base64url); null until the mode is first switched to "key". Regenerated in the admin area. */
  statusApiKey: text("status_api_key"),
  /** Whose view GET /api/status answers with; null = the default role ("Gast"). A deleted role falls back to it. */
  statusApiRoleId: uuid("status_api_role_id").references((): AnyPgColumn => roles.id, { onDelete: "set null" }),
  /** Refuse directory accounts the directory's operator suspended (admin area > server; users/suspension.ts). On by default. */
  refuseSuspended: boolean("refuse_suspended").notNull().default(true),
});

/** Membership. Anyone missing here sees nothing and can do nothing. */
export const members = pgTable("members", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  joinedAt: ts("joined_at").notNull().defaultNow(),
  /** A moderator has blocked camera/screen (M3). */
  streamBlocked: boolean("stream_blocked").notNull().default(false),
  /** Owner (several possible). The first one is additionally recorded in server_settings.owner_id and cannot be revoked. */
  isOwner: boolean("is_owner").notNull().default(false),
  /** The member has muted this server: their clients show no unread mark for it on the server rail. */
  muted: boolean("muted").notNull().default(false),
  /**
   * A sticky voice channel holds the member (docs/features/channel-permissions.md): no token for any other voice channel
   * until somebody with MOVE_MEMBERS moves them. Cleared with the channel (FK), by a move, and, without `sticky_persist`,
   * when their voice presence ends.
   */
  confinedChannelId: uuid("confined_channel_id").references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
});

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
});

/** Web radio stations an admin offers (admin area > Radio). `url` = a direct audio stream or a playlist (.m3u, .m3u8, .pls). */
export const radioStations = pgTable("radio_stations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["text", "voice"] }).notNull(),
  name: text("name").notNull(),
  topic: text("topic"),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
  position: integer("position").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  /** Voice quality (M3): Opus bitrate in kbit/s and stereo. */
  audioBitrate: integer("audio_bitrate").notNull().default(64),
  audioStereo: boolean("audio_stereo").notNull().default(false),
  /**
   * Web radio playing in this voice channel (`radio_stream_url` null = off; `radio_station_id` null = a typed address). Kept in the database so it survives a restart; clients only play
   * it while they are in the channel. `radio_stream_url` = what clients play (the station's address, or what its playlist named
   * when the radio was started).
   */
  radioStationId: uuid("radio_station_id").references(() => radioStations.id, { onDelete: "set null" }),
  radioStreamUrl: text("radio_stream_url"),
  /** Shown name when the radio plays an address a member typed in (no station): the address's host. */
  radioName: text("radio_name"),
  radioStartedBy: uuid("radio_started_by").references(() => users.id, { onDelete: "set null" }),
  /** Where a video source stands for everyone (protocol RadioPlayback; `at` = server time in ms). null for audio and Twitch. */
  radioPlayback: jsonb("radio_playback").$type<{ playing: boolean; position: number; rate: number; at: number }>(),
  /** A YouTube playlist played as a queue (radio/queue.ts): its videos and which one is on; `radio_stream_url` is that video. null for everything else. */
  radioQueue: jsonb("radio_queue").$type<{ listId: string; videoIds: string[]; index: number }>(),
  // ---- Channel settings (docs/features/channel-permissions.md, 23 September 2026). Defaults = how every channel behaved before.
  /** Voice: whoever sits here is held (members.confined_channel_id) until moved out. */
  sticky: boolean("sticky").notNull().default(false),
  /** Voice, with sticky: the hold outlives the member's voice presence (reload, restart). */
  stickyPersist: boolean("sticky_persist").notNull().default(false),
  /** Voice, with sticky: a held member gets no other voice channel in their channel list. */
  stickyHideVoice: boolean("sticky_hide_voice").notNull().default(true),
  /** Voice: how many may sit here; null = no limit (best effort, presence is advisory). */
  userLimit: integer("user_limit"),
  /** Text: seconds between two messages of one member, 0 = off. */
  slowmodeSeconds: integer("slowmode_seconds").notNull().default(0),
  /** The channel's notification suggestion for members who set nothing (protocol ChannelNotification). */
  defaultNotification: text("default_notification", { enum: ["all", "mentions", "none"] }).notNull().default("all"),
  /** Voice: false = no web radio here, for anybody. */
  allowRadio: boolean("allow_radio").notNull().default(true),
  /** Voice: false = no camera or screen share here, for anybody. */
  allowVideo: boolean("allow_video").notNull().default(true),
  /** Voice: false = no vote kick here (docs/features/votekick.md), whatever sits in the channel. */
  allowVoteKick: boolean("allow_vote_kick").notNull().default(true),
});

/**
 * Permission overwrites of a channel (docs/features/channel-permissions.md): one row per role or member, allow and deny
 * masks over CHANNEL_OVERRIDABLE. Two FK columns instead of a (type, id) pair so Postgres drops the rows with the role or
 * the user; a kicked member's rows are removed by the route (their users row lives on).
 */
export const channelOverwrites = pgTable(
  "channel_overwrites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    allow: integer("allow").notNull().default(0),
    deny: integer("deny").notNull().default(0),
  },
  (t) => ({
    byChannel: index("channel_overwrites_channel_idx").on(t.channelId),
    uqRole: uniqueIndex("channel_overwrites_role_uq").on(t.channelId, t.roleId),
    uqUser: uniqueIndex("channel_overwrites_user_uq").on(t.channelId, t.userId),
    oneTarget: check("channel_overwrites_one_target", sql`(${t.roleId} IS NULL) <> (${t.userId} IS NULL)`),
  }),
);

/** The same for a category: its rows apply to every channel inside, a channel's own rows come on top (live inheritance). */
/**
 * Channel blocks (docs/features/channel-blocks.md, 24 September 2026): who may not enter a voice channel, until when
 * (`until` null = permanent). Set by a moderator or by a passed vote kick (`source`); read into memory at start
 * (voice/channelBlocks.ts), so the token route asks without a query. A deleted channel or user takes its rows along.
 */
export const channelBlocks = pgTable(
  "channel_blocks",
  {
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    until: ts("until"),
    source: text("source", { enum: ["moderator", "votekick"] }).notNull(),
    blockedBy: uuid("blocked_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.channelId, t.userId] }) }),
);

export const categoryOverwrites = pgTable(
  "category_overwrites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    allow: integer("allow").notNull().default(0),
    deny: integer("deny").notNull().default(0),
  },
  (t) => ({
    byCategory: index("category_overwrites_category_idx").on(t.categoryId),
    uqRole: uniqueIndex("category_overwrites_role_uq").on(t.categoryId, t.roleId),
    uqUser: uniqueIndex("category_overwrites_user_uq").on(t.categoryId, t.userId),
    oneTarget: check("category_overwrites_one_target", sql`(${t.roleId} IS NULL) <> (${t.userId} IS NULL)`),
  }),
);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  color: text("color"),
  permissions: integer("permissions").notNull().default(0),
  position: integer("position").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
});

export const memberRoles = pgTable(
  "member_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.roleId] }) }),
);

export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  revokedAt: ts("revoked_at"),
});

export const bans = pgTable("bans", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  bannedBy: uuid("banned_by").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonically increasing across all channels: ordering and cursor for the history. */
    seq: bigserial("seq", { mode: "number" }).notNull().unique(),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /**
     * Link previews (previews/service.ts): what the server found for the message's links, in the order of the links, and
     * with `removed` the ones the author took away (kept so that an edit does not bring them back). null = none looked up.
     */
    previews: jsonb("previews").$type<(LinkPreview & { removed?: boolean })[]>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    editedAt: ts("edited_at"),
  },
  (t) => ({ byChannel: index("messages_channel_seq_idx").on(t.channelId, t.seq) }),
);

/**
 * How far a member has read a text channel (`messages.seq`), so unread marks and mention counters are the same on every
 * device. No row = never opened: then the messages since `members.joined_at` count (migration 0015 gave every existing
 * member a row per channel at the newest message, so an update does not mark everything).
 */
export const readStates = pgTable(
  "read_states",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.channelId] }) }),
);

/** Text channels a member has muted (no unread mark; mentions still count). A row = muted. */
export const channelMutes = pgTable(
  "channel_mutes",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.channelId] }) }),
);

/**
 * Reports (docs/features/reports.md, 26 September 2026): a member's report of a message or a member to the server's moderators.
 * `snapshot` = the message or member at that moment (protocol `ReportSnapshot`; attachment copies under DATA_DIR/reports/<id>/),
 * set null by the retention sweep (closed + 30 days, 90 at the latest) while the row stays, so repeats can be counted.
 * `message_id` carries no FK on purpose: the report outlives the message. The reporter's account deletion takes their
 * reports along (cascade); the reported person's leaves the snapshot (it is evidence about them) with the user reference null.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["message", "member"] }).notNull(),
    reason: text("reason").notNull(),
    text: text("text"),
    status: text("status", { enum: ["open", "actioned", "dismissed"] }).notNull().default("open"),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "cascade" }),
    reporterName: text("reporter_name").notNull(),
    reportedUserId: uuid("reported_user_id").references(() => users.id, { onDelete: "set null" }),
    reportedName: text("reported_name").notNull(),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    channelName: text("channel_name"),
    messageId: uuid("message_id"),
    snapshot: jsonb("snapshot").$type<Omit<ReportSnapshot, "attachments"> & { attachments: { n: number; name: string; size: number; mimeType: string }[] }>(),
    createdAt: ts("created_at").notNull().defaultNow(),
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    closedByName: text("closed_by_name"),
    action: text("action"),
    note: text("note"),
  },
  (t) => ({ byStatus: index("reports_status_created_idx").on(t.status, t.createdAt), byMessage: index("reports_message_idx").on(t.messageId), byReported: index("reports_reported_idx").on(t.reportedUserId) }),
);

/**
 * The moderation log (docs/features/reports.md, decision 2 of 25 September 2026): who did what to whom, when, where; never
 * message contents. Names are kept as text so the line stays readable after an account is gone. Rows older than 180 days go.
 */
export const modLog = pgTable(
  "mod_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: ts("at").notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    targetName: text("target_name"),
    action: text("action").notNull(),
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    channelName: text("channel_name"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => ({ byAt: index("mod_log_at_idx").on(t.at) }),
);

/** The file lives under DATA_DIR/attachments/<id>; messageId is set when the message is sent. */
export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
  uploaderId: uuid("uploader_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  size: integer("size").notNull(),
  mimeType: text("mime_type").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
