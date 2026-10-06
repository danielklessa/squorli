/**
 * Permissions as a bitmask. Roles carry a mask, a member has the OR of all their roles.
 * ADMINISTRATOR includes everything. Always append new permissions at the end, never renumber.
 */
export const Permission = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_ROLES: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  BAN_MEMBERS: 1 << 5,
  CREATE_INVITES: 1 << 6,
  VIEW_CHANNELS: 1 << 7,
  SEND_MESSAGES: 1 << 8,
  MANAGE_MESSAGES: 1 << 9,
  CONNECT_VOICE: 1 << 10,
  ATTACH_FILES: 1 << 11,
  STREAM_VIDEO: 1 << 12,
  MODERATE_VOICE: 1 << 13,
  VIEW_VIDEO: 1 << 14,
  CONTROL_RADIO: 1 << 15,
  MOVE_MEMBERS: 1 << 16,
  BYPASS_STICKY: 1 << 17,
  /** Reports (docs/features/reports.md, 26 September 2026): read the queue, close reports, read the moderation log. Server-wide. */
  MANAGE_REPORTS: 1 << 18,
  /**
   * Reactions (docs/features/reactions.md, 6 October 2026): put an emoji on a message. Channel-overridable. Migration 0042
   * gives it to every role with SEND_MESSAGES. An emoji configured as a reaction role on a message needs no right (so a guest
   * can accept the rules); removing an own reaction never does.
   */
  ADD_REACTIONS: 1 << 19,
  /**
   * Notices (docs/features/notices.md, 6 October 2026): show a message of the channel as a notice, without its author, the
   * time where the avatar stands; and back. Channel-overridable. Migration 0044 gives it to every role with MANAGE_MESSAGES.
   */
  MANAGE_NOTICES: 1 << 20,
} as const;

export type PermissionName = keyof typeof Permission;

export const PERMISSION_LABELS: Record<PermissionName, string> = {
  ADMINISTRATOR: "Administrator (alle Rechte)",
  MANAGE_SERVER: "Server verwalten (Name, Beitritt)",
  MANAGE_CHANNELS: "Kanäle und Kategorien verwalten",
  MANAGE_ROLES: "Rollen verwalten und zuweisen",
  KICK_MEMBERS: "Mitglieder kicken",
  BAN_MEMBERS: "Mitglieder bannen",
  CREATE_INVITES: "Einladungen erstellen",
  VIEW_CHANNELS: "Kanäle sehen",
  SEND_MESSAGES: "Nachrichten schreiben",
  MANAGE_MESSAGES: "Fremde Nachrichten löschen",
  CONNECT_VOICE: "Sprachkanäle betreten",
  ATTACH_FILES: "Dateien anhängen",
  STREAM_VIDEO: "Kamera und Bildschirm teilen",
  MODERATE_VOICE: "Sprachkanäle moderieren (Kamera/Bildschirm beenden, Streamen sperren)",
  VIEW_VIDEO: "Kamera- und Bildschirmübertragungen sehen",
  CONTROL_RADIO: "Webradio in Sprachkanälen starten und stoppen",
  MOVE_MEMBERS: "Mitglieder in andere Sprachkanäle verschieben",
  BYPASS_STICKY: "Von festsetzenden Sprachkanälen nicht gehalten werden",
  MANAGE_REPORTS: "Meldungen bearbeiten",
  ADD_REACTIONS: "Reagieren (Emoji-Reaktionen hinzufügen)",
  MANAGE_NOTICES: "Hinweise setzen (Nachrichten ohne Absender anzeigen)",
};

/**
 * How the permissions are shown to an admin (role editor): groups in this order. Administration comes first with
 * ADMINISTRATOR at its top (user decision of 2026-09-17); otherwise a group runs from everyday to powerful.
 * The bit order above is history (append only) and says nothing about meaning, so display order lives here.
 * Every permission belongs to exactly one group (pinned by a test). A new permission is sorted in where it belongs by
 * meaning, never just appended; check on each addition whether the grouping as a whole still reads well.
 */
export const PERMISSION_GROUPS = [
  { id: "admin", permissions: ["ADMINISTRATOR", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_SERVER"] },
  { id: "text", permissions: ["VIEW_CHANNELS", "ADD_REACTIONS", "SEND_MESSAGES", "ATTACH_FILES", "MANAGE_NOTICES", "MANAGE_MESSAGES"] },
  { id: "voice", permissions: ["CONNECT_VOICE", "VIEW_VIDEO", "STREAM_VIDEO", "CONTROL_RADIO", "MOVE_MEMBERS", "MODERATE_VOICE", "BYPASS_STICKY"] },
  { id: "members", permissions: ["CREATE_INVITES", "KICK_MEMBERS", "BAN_MEMBERS", "MANAGE_REPORTS"] },
] as const satisfies readonly { id: string; permissions: readonly PermissionName[] }[];
// ADD_REACTIONS (6 October 2026) sits between seeing and writing: reacting is lighter than writing a message.
// MANAGE_NOTICES (6 October 2026) sits before MANAGE_MESSAGES: changing how a message shows is lighter than deleting it.

export type PermissionGroupId = (typeof PERMISSION_GROUPS)[number]["id"];

/**
 * Channel permissions (docs/features/channel-permissions.md, 23 September 2026): a channel or category carries overwrites
 * (allow/deny masks per role or member) that change these bits for that channel; everything else stays server-wide and an
 * overwrite naming it is refused. The server-wide mask of the roles is the base every overwrite starts from.
 */
export const CHANNEL_OVERRIDABLE =
  Permission.VIEW_CHANNELS | Permission.SEND_MESSAGES | Permission.ATTACH_FILES | Permission.MANAGE_MESSAGES | Permission.MANAGE_CHANNELS |
  Permission.CONNECT_VOICE | Permission.STREAM_VIDEO | Permission.VIEW_VIDEO | Permission.CONTROL_RADIO | Permission.MODERATE_VOICE |
  Permission.MOVE_MEMBERS | Permission.BYPASS_STICKY | Permission.ADD_REACTIONS | Permission.MANAGE_NOTICES;

/**
 * How the channel dialog shows them: groups per channel kind (a category shows the union). Not PERMISSION_GROUPS: the
 * server-wide order puts MANAGE_CHANNELS next to ADMINISTRATOR and mixes text and voice, half of each group would be empty here.
 */
export const CHANNEL_PERMISSION_GROUPS = [
  { id: "general", kinds: ["text", "voice"], permissions: ["VIEW_CHANNELS", "MANAGE_CHANNELS"] },
  { id: "text", kinds: ["text"], permissions: ["ADD_REACTIONS", "SEND_MESSAGES", "ATTACH_FILES", "MANAGE_NOTICES", "MANAGE_MESSAGES"] },
  { id: "voice", kinds: ["voice"], permissions: ["CONNECT_VOICE", "VIEW_VIDEO", "STREAM_VIDEO", "CONTROL_RADIO", "MOVE_MEMBERS", "MODERATE_VOICE", "BYPASS_STICKY"] },
] as const satisfies readonly { id: string; kinds: readonly ("text" | "voice")[]; permissions: readonly PermissionName[] }[];

export type ChannelPermissionGroupId = (typeof CHANNEL_PERMISSION_GROUPS)[number]["id"];

/** The overridable bits that matter for a channel of this kind (what the dialog offers). */
export function channelOverridableFor(kind: "text" | "voice"): number {
  return CHANNEL_PERMISSION_GROUPS.filter((g) => (g.kinds as readonly string[]).includes(kind))
    .flatMap((g) => [...g.permissions]).reduce((m, n) => m | Permission[n], 0);
}

/**
 * Default role "guest" (everyone gets it on joining): only view channels and enter voice channels.
 * User decision of 2026-09-13. Everything else via the "member" role, which admins grant.
 * Guests hear a voice channel but do not see camera or screen (no VIEW_VIDEO, user decision of 2026-09-17).
 */
export const DEFAULT_EVERYONE_PERMISSIONS = Permission.VIEW_CHANNELS | Permission.CONNECT_VOICE;

/** Role "member" (created on first start, not granted automatically): post, react, attach, invite, share and watch camera/screen. */
export const DEFAULT_MEMBER_PERMISSIONS =
  DEFAULT_EVERYONE_PERMISSIONS | Permission.SEND_MESSAGES | Permission.ADD_REACTIONS | Permission.ATTACH_FILES | Permission.CREATE_INVITES | Permission.STREAM_VIDEO | Permission.VIEW_VIDEO;

export const ALL_PERMISSIONS = Object.values(Permission).reduce((a, b) => a | b, 0);

export function hasPermission(mask: number, perm: number): boolean {
  return (mask & Permission.ADMINISTRATOR) !== 0 || (mask & perm) === perm;
}

export function permissionNames(mask: number): PermissionName[] {
  return (Object.keys(Permission) as PermissionName[]).filter((k) => (mask & Permission[k]) !== 0);
}
