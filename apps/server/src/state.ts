import { displayNameOf, hasPermission, twitchChannelOf, youtubeVideoOf, type Category, type Channel, type Member, type RadioStation, type Role, type ServerSettings, type ServerState, Permission } from "@squorli/protocol";
import { asc, eq, inArray } from "drizzle-orm";
import { effectivePermissions, type Actor } from "./authz";
import type { Db } from "./db";
import { categories, channels, localAccounts, memberRoles, members, radioStations, roles, serverSettings, users } from "./db/schema";
import type { Hub } from "./hub";
import { visibility, type PermissionContext } from "./visibility";
import { avatarOf } from "./names";

export const SETTINGS_ID = "server";

/**
 * Server accounts (docs/features/local-accounts.md): without a directory they are always allowed, else LOCAL_ACCOUNTS pins the
 * switch or the admin area decides (index.ts sets both at startup).
 */
let localAccountsForced: boolean | null = null;
/** The server names a directory (DIRECTORY_URL): only then is there anybody whose suspension it could learn of. */
let directoryConfigured = false;
export function setLocalAccountsConfig(opts: { directory: boolean; forced: boolean | null }): void {
  localAccountsForced = opts.directory ? opts.forced : true;
  directoryConfigured = opts.directory;
}

/** Whether this server refuses directory accounts the directory's operator suspended (users/suspension.ts). */
export async function refusesSuspended(db: Db): Promise<boolean> {
  if (!directoryConfigured) return false;
  const [row] = await db.select({ refuse: serverSettings.refuseSuspended }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
  return row?.refuse ?? true;
}

export async function loadSettings(db: Db): Promise<ServerSettings> {
  const [row] = await db.select().from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
  if (!row) throw new Error("server_settings fehlt (Bootstrap nicht gelaufen)");
  return {
    name: row.name, openJoin: row.openJoin, ownerId: row.ownerId,
    // Every sign-in needs an account since 25 September 2026; both stay for clients from before.
    requireAccount: true, requireAccountLocked: true,
    localAccounts: localAccountsForced ?? row.localAccounts, localAccountsLocked: localAccountsForced !== null,
    listed: row.listed, description: row.description, radioAutoStop: row.radioAutoStop,
    afkChannelId: row.afkChannelId,
    iconUrl: row.iconMime && row.iconUpdatedAt ? `/api/server-icon?v=${row.iconUpdatedAt.getTime()}` : null,
    statusApi: row.statusApi, statusApiRoleId: row.statusApiRoleId,
    doctor: true, // the setup check exists (docs/features/doctor.md)
    limits: true, // the operator limits' report exists (GET /api/settings/limits, docs/features/limits.md)
    // Suspended directory accounts (users/suspension.ts): without a directory there is nothing to refuse and no switch.
    ...(directoryConfigured ? { refuseSuspended: row.refuseSuspended } : {}),
    privacyPolicyUrl: row.privacyPolicyUrl,
  };
}

export async function loadCategories(db: Db): Promise<Category[]> {
  return db.select().from(categories).orderBy(asc(categories.position), asc(categories.name));
}

export async function loadChannels(db: Db): Promise<Channel[]> {
  const rows = await db.select({ c: channels, stationName: radioStations.name }).from(channels)
    .leftJoin(radioStations, eq(radioStations.id, channels.radioStationId))
    .orderBy(asc(channels.position), asc(channels.createdAt));
  return rows.map(({ c, stationName }) => ({
    id: c.id, kind: c.kind, name: c.name, topic: c.topic, categoryId: c.categoryId, position: c.position, audioBitrate: c.audioBitrate, audioStereo: c.audioStereo,
    // Channel settings (docs/features/channel-permissions.md); `private` is filled per recipient by visibleChannels().
    sticky: c.sticky, stickyPersist: c.stickyPersist, stickyHideVoice: c.stickyHideVoice, userLimit: c.userLimit, slowmodeSeconds: c.slowmodeSeconds,
    defaultNotify: c.defaultNotification, allowRadio: c.allowRadio, allowVideo: c.allowVideo, allowVoteKick: c.allowVoteKick, private: false,
    // On while there is something to play. The name: the station's (current one), else the one stored for a typed address.
    radio: c.radioStreamUrl ? { stationId: stationName !== null ? c.radioStationId : null, name: stationName ?? c.radioName ?? radioHostOf(c.radioStreamUrl), streamUrl: c.radioStreamUrl, startedBy: c.radioStartedBy, twitchChannel: twitchChannelOf(c.radioStreamUrl), ...youtubeRadio(c.radioStreamUrl, c.radioPlayback), queue: c.radioQueue ? { listId: c.radioQueue.listId, index: c.radioQueue.index, length: c.radioQueue.videoIds.length } : null } : null,
  }));
}

/** A YouTube source carries its video and where that stands for everyone; a source without a stored state (none is written that way) waits at the beginning. */
function youtubeRadio(streamUrl: string, playback: { playing: boolean; position: number; rate: number; at: number } | null) {
  const video = youtubeVideoOf(streamUrl)?.videoId ?? null;
  return { youtubeVideo: video, playback: video ? playback ?? { playing: false, position: 0, rate: 1, at: 0 } : null };
}

/** Short name for an address without a station: its host. */
export function radioHostOf(url: string): string {
  const twitch = twitchChannelOf(url);
  if (twitch) return `twitch.tv/${twitch}`;
  const youtube = youtubeVideoOf(url);
  if (youtube) return `youtu.be/${youtube.videoId}`;
  try { return new URL(url).host; } catch { return url.slice(0, 64); }
}

export async function loadRadioStations(db: Db): Promise<RadioStation[]> {
  return db.select({ id: radioStations.id, name: radioStations.name, url: radioStations.url }).from(radioStations).orderBy(asc(radioStations.name), asc(radioStations.createdAt));
}

export async function loadRoles(db: Db): Promise<Role[]> {
  const rows = await db.select().from(roles).orderBy(asc(roles.position), asc(roles.name));
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, permissions: r.permissions, position: r.position, isDefault: r.isDefault }));
}

export async function loadMembers(db: Db, hub: Hub): Promise<Member[]> {
  const rows = await db
    .select({ userId: members.userId, joinedAt: members.joinedAt, streamBlocked: members.streamBlocked, isOwner: members.isOwner, publicKey: users.publicKey, displayName: users.displayName, handle: users.handle, avatarUrl: users.avatarUrl, localHandle: localAccounts.handle, localAvatarAt: localAccounts.avatarUpdatedAt })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .leftJoin(localAccounts, eq(localAccounts.userId, members.userId))
    .orderBy(asc(members.joinedAt));
  const links = rows.length
    ? await db.select().from(memberRoles).where(inArray(memberRoles.userId, rows.map((r) => r.userId)))
    : [];
  const byUser = new Map<string, string[]>();
  for (const l of links) byUser.set(l.userId, [...(byUser.get(l.userId) ?? []), l.roleId]);
  return rows.map((r) => ({
    userId: r.userId,
    displayName: displayNameOf(r),
    publicKey: r.publicKey,
    roleIds: byUser.get(r.userId) ?? [],
    joinedAt: r.joinedAt.toISOString(),
    online: hub.isOnline(r.userId),
    afk: hub.isAfk(r.userId),
    game: hub.gameOf(r.userId),
    streamBlocked: r.streamBlocked,
    handle: r.handle,
    avatarUrl: avatarOf(r),
    localHandle: r.localHandle,
    isOwner: r.isOwner,
  }));
}

/** Permission context of a user; null = not a member. */
export async function actorOf(db: Db, userId: string): Promise<Actor | null> {
  const [m] = await db.select({ userId: members.userId, streamBlocked: members.streamBlocked, isOwner: members.isOwner }).from(members).where(eq(members.userId, userId)).limit(1);
  if (!m) return null;
  const settings = await loadSettings(db);
  // The first owner via server_settings, further ones via members.is_owner (bootstrap reconciles both).
  const isOwner = settings.ownerId === userId || m.isOwner;
  const mine = await db
    .select({ id: roles.id, permissions: roles.permissions, position: roles.position })
    .from(memberRoles)
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(eq(memberRoles.userId, userId));
  const [def] = await db.select({ id: roles.id, permissions: roles.permissions, position: roles.position }).from(roles).where(eq(roles.isDefault, true)).limit(1);
  const all = def && !mine.some((r) => r.id === def.id) ? [...mine, def] : mine;
  return {
    userId,
    isOwner,
    roleIds: all.map((r) => r.id),
    // A moderator's streaming block removes STREAM_VIDEO regardless of roles (owners exempt).
    permissions: effectivePermissions(isOwner, all.map((r) => r.permissions)) & (m.streamBlocked && !isOwner ? ~Permission.STREAM_VIDEO : ~0),
    topPosition: isOwner ? Number.MAX_SAFE_INTEGER : Math.max(0, ...all.map((r) => r.position)),
  };
}

/** What a user gets as `myChannelPermissions`: only channels and categories they may see (a mask for a hidden one would give its id away). */
export function visibleMasks(masks: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...masks].filter(([, m]) => hasPermission(m, Permission.VIEW_CHANNELS)));
}

/** The channels one user may see, with the lock of the ones set to private here or on their category (docs/features/channel-permissions.md). */
export function visibleChannels(all: Channel[], masks: Map<string, number>, ctx: PermissionContext): Channel[] {
  return all.filter((c) => hasPermission(masks.get(c.id) ?? 0, Permission.VIEW_CHANNELS)).map((c) => ({ ...c, private: ctx.markedPrivate.has(c.id) }));
}

/** Set by index.ts once the reports service exists (state.ts must not import it: reports.ts imports the visibility, which state.ts feeds). */
export let openReportCount: (db: Db) => Promise<number> = async () => 0;
export function setOpenReportCount(fn: (db: Db) => Promise<number>): void { openReportCount = fn; }

/** A category is left out when the user may not see the category itself, whatever it holds (predictable, the admin's explicit choice). */
export function visibleCategories(all: Category[], masks: Map<string, number>): Category[] {
  return all.filter((k) => hasPermission(masks.get(k.id) ?? 0, Permission.VIEW_CHANNELS));
}

/** What a user gets with the welcome and from GET /api/state: only the channels and categories they may see. */
export async function loadState(db: Db, hub: Hub, userId: string): Promise<ServerState> {
  const [settings, cats, chans, rs, mems, stations, actor, ctx] = await Promise.all([
    loadSettings(db), loadCategories(db), loadChannels(db), loadRoles(db), loadMembers(db, hub), loadRadioStations(db), actorOf(db, userId), visibility.refresh(db),
  ]);
  const masks = visibility.masksOf(userId);
  visibility.changedSince(userId, masks);
  // importSources: what the import routes (routes/import.ts) can read a structure from; the client shows the admin tab only for these.
  return {
    settings, categories: visibleCategories(cats, masks), channels: visibleChannels(chans, masks, ctx), roles: rs, members: mems, radioStations: stations,
    importSources: ["discord-template"], myPermissions: actor?.permissions ?? 0,
    myChannelPermissions: visibleMasks(masks), myVoiceLock: visibility.voiceLockOf(userId),
    // Reports (docs/features/reports.md): the open count only for whoever handles them; the field's presence tells the client the server takes reports.
    openReports: actor && hasPermission(actor.permissions, Permission.MANAGE_REPORTS) ? await openReportCount(db) : 0,
  };
}

export type StructurePart = "settings" | "categories" | "channels" | "roles" | "members" | "radioStations" | "overwrites";

/**
 * After a change, send the affected part to everyone who is online. Since channel permissions (docs/features/channel-permissions.md)
 * the channel and category lists are per recipient: whoever may not see a channel does not get it. The lists are loaded
 * once and filtered per user over the visibility snapshot, which this reloads first (the one place every change of
 * roles, members, channels, categories and overwrites passes). The channel list only goes out when it was asked for or the
 * user's visible set changed: the hub's presence hook broadcasts "members" on every connect, disconnect and AFK change,
 * and the full list on each of those would multiply the traffic.
 */
/**
 * Called after a structure change that may change permissions (roles, members, overwrites, channels): the WebSocket part
 * sends every occupied voice channel's state again, whose `viewVideo` may have changed (ws/handler.ts).
 */
export const permissionListeners = new Set<() => void>();

export async function broadcastStructure(db: Db, hub: Hub, parts: StructurePart[]) {
  visibility.invalidate();
  const has = (p: StructurePart) => parts.includes(p);
  const explicitLists = has("channels") || has("categories");
  const mayChangeVisibility = explicitLists || has("roles") || has("members") || has("overwrites");
  const [settings, rs, mems, stations, cats, chans, ctx] = await Promise.all([
    has("settings") ? loadSettings(db) : undefined, has("roles") ? loadRoles(db) : undefined, has("members") ? loadMembers(db, hub) : undefined,
    has("radioStations") ? loadRadioStations(db) : undefined,
    mayChangeVisibility ? loadCategories(db) : undefined, mayChangeVisibility ? loadChannels(db) : undefined, visibility.refresh(db),
  ]);
  for (const userId of hub.onlineUserIds()) {
    const masks = visibility.masksOf(userId);
    const e: Extract<import("@squorli/protocol").ServerEvent, { type: "structure" }> = { type: "structure" };
    if (settings) e.settings = settings;
    if (rs) e.roles = rs;
    if (mems) e.members = mems;
    if (stations) e.radioStations = stations;
    if (cats && chans && (explicitLists || visibility.changedSince(userId, masks))) {
      if (!explicitLists) visibility.changedSince(userId, masks);
      e.channels = visibleChannels(chans, masks, ctx);
      e.categories = visibleCategories(cats, masks);
    } else if (explicitLists) visibility.changedSince(userId, masks);
    hub.sendToUser(userId, e);
    if (mayChangeVisibility || has("settings")) {
      const a = visibility.actorOf(userId);
      hub.sendToUser(userId, { type: "me", myPermissions: a?.permissions ?? 0, myChannelPermissions: visibleMasks(masks), myVoiceLock: visibility.voiceLockOf(userId) });
    }
  }
  if (mayChangeVisibility) for (const fn of permissionListeners) fn();
}

/**
 * One user's channel lists and permissions afresh (after a move or a hold changed what they see), without touching anybody
 * else. `onlyIfChanged`: nothing goes out while the visible set is what the user last got.
 */
export async function sendStructureTo(db: Db, hub: Hub, userId: string, onlyIfChanged = false) {
  visibility.forgetUser(userId);
  if (!hub.isOnline(userId)) return;
  const [cats, chans, ctx] = await Promise.all([loadCategories(db), loadChannels(db), visibility.refresh(db)]);
  const masks = visibility.masksOf(userId);
  if (!visibility.changedSince(userId, masks) && onlyIfChanged) return;
  hub.sendToUser(userId, { type: "structure", channels: visibleChannels(chans, masks, ctx), categories: visibleCategories(cats, masks) });
  const a = visibility.actorOf(userId);
  hub.sendToUser(userId, { type: "me", myPermissions: a?.permissions ?? 0, myChannelPermissions: visibleMasks(masks), myVoiceLock: visibility.voiceLockOf(userId) });
}
