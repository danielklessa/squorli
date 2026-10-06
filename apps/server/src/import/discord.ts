import { AUDIO_BITRATES, CHANNEL_OVERRIDABLE, DEFAULT_AUDIO_BITRATE, Permission, hasPermission, type ImportCategoryPlan, type ImportChannelPlan, type ImportOverwrite, type ImportPlan, type ImportRolePlan } from "@squorli/protocol";
import { z } from "zod";
import { canGrant, type Actor } from "../authz";

/**
 * A Discord server template as Discord's endpoint GET /guilds/templates/<code> serves it (no authentication needed;
 * checked 22 September 2026: an unknown code answers "Unknown server template" instead of 401). Only what the import
 * reads is parsed; ids inside a template are small placeholder numbers, `permissions` is a decimal string of Discord's
 * 64-bit permission set. Everything unknown is dropped by zod.
 */
const Id = z.union([z.number(), z.string()]).transform(String);
const Perms = z.union([z.string(), z.number()]).optional().default("0");
export const DiscordTemplate = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  serialized_source_guild: z.object({
    afk_channel_id: Id.nullable().optional(),
    roles: z.array(z.object({
      id: Id,
      name: z.string(),
      color: z.number().optional().default(0),
      permissions: Perms,
      position: z.number().optional(),
      managed: z.boolean().optional(),
    })),
    channels: z.array(z.object({
      id: Id,
      type: z.number(),
      name: z.string(),
      position: z.number().optional().default(0),
      topic: z.string().nullable().optional(),
      bitrate: z.number().optional(),
      parent_id: Id.nullable().optional(),
      /** Channel permissions (docs/features/channel-permissions.md): `type` 0 = a role (its template id, 0 = @everyone), 1 = a member. */
      permission_overwrites: z.array(z.object({ id: Id, type: z.union([z.number(), z.string()]).transform(Number), allow: Perms, deny: Perms })).optional().default([]),
    })),
  }),
});
export type DiscordTemplate = z.infer<typeof DiscordTemplate>;

/** Discord channel types (https://discord.com/developers/docs/resources/channel): what becomes what here. Everything else is dropped. */
const TEXT_TYPES = new Set([0, 5, 15, 16]); // text, announcement, forum, media
const VOICE_TYPES = new Set([2, 13]); // voice, stage
const CATEGORY_TYPE = 4;

/** Discord's permission bits as shift amounts (https://discord.com/developers/docs/topics/permissions). */
const D = {
  CREATE_INSTANT_INVITE: 0n, KICK_MEMBERS: 1n, BAN_MEMBERS: 2n, ADMINISTRATOR: 3n, MANAGE_CHANNELS: 4n, MANAGE_GUILD: 5n,
  ADD_REACTIONS: 6n, STREAM: 9n, VIEW_CHANNEL: 10n, SEND_MESSAGES: 11n, MANAGE_MESSAGES: 13n, ATTACH_FILES: 15n, CONNECT: 20n,
  MUTE_MEMBERS: 22n, DEAFEN_MEMBERS: 23n, MOVE_MEMBERS: 24n, MANAGE_ROLES: 28n,
} as const;

/**
 * Discord permission -> Squorli permission. Discord's Administrator becomes ours (which includes everything). Connecting
 * to a voice channel on Discord lets you watch streams, so CONNECT brings VIEW_VIDEO along; muting, deafening or moving
 * members are all our MODERATE_VOICE. Nothing maps to CONTROL_RADIO (no Discord counterpart). Threads, emojis, nicknames,
 * history, webhooks, events and the like have no counterpart and fall away (reactions have one since 6 October 2026).
 */
const PERMISSION_MAP: readonly [bigint, number][] = [
  [D.ADMINISTRATOR, Permission.ADMINISTRATOR],
  [D.MANAGE_GUILD, Permission.MANAGE_SERVER],
  [D.MANAGE_CHANNELS, Permission.MANAGE_CHANNELS],
  [D.MANAGE_ROLES, Permission.MANAGE_ROLES],
  [D.KICK_MEMBERS, Permission.KICK_MEMBERS],
  [D.BAN_MEMBERS, Permission.BAN_MEMBERS],
  [D.CREATE_INSTANT_INVITE, Permission.CREATE_INVITES],
  [D.VIEW_CHANNEL, Permission.VIEW_CHANNELS],
  [D.SEND_MESSAGES, Permission.SEND_MESSAGES],
  [D.MANAGE_MESSAGES, Permission.MANAGE_MESSAGES],
  [D.ATTACH_FILES, Permission.ATTACH_FILES],
  [D.ADD_REACTIONS, Permission.ADD_REACTIONS],
  [D.CONNECT, Permission.CONNECT_VOICE | Permission.VIEW_VIDEO],
  [D.STREAM, Permission.STREAM_VIDEO],
  [D.MUTE_MEMBERS, Permission.MODERATE_VOICE],
  [D.DEAFEN_MEMBERS, Permission.MODERATE_VOICE],
  [D.MOVE_MEMBERS, Permission.MOVE_MEMBERS],
];

/** Our permission mask for a Discord permission set (decimal string or number). Unreadable = 0. */
export function mapDiscordPermissions(raw: string | number): number {
  let mask: bigint;
  try { mask = BigInt(typeof raw === "number" ? Math.trunc(raw) : raw.trim() || "0"); } catch { return 0; }
  if (mask < 0n) return 0;
  let out = 0;
  for (const [bit, ours] of PERMISSION_MAP) if (((mask >> bit) & 1n) === 1n) out |= ours;
  return out;
}

/** Discord's bitrate in bit/s -> the nearest of the client's steps in kbit/s (missing or odd = the default). */
export function mapBitrate(bps: number | undefined): number {
  if (bps === undefined || !Number.isFinite(bps) || bps <= 0) return DEFAULT_AUDIO_BITRATE;
  const kbps = bps / 1000;
  let best: number = AUDIO_BITRATES[0];
  for (const step of AUDIO_BITRATES) if (Math.abs(step - kbps) < Math.abs(best - kbps)) best = step;
  return best;
}

/** Discord's color (an integer, 0 = none) -> "#rrggbb" or null. */
export function mapColor(color: number): string | null {
  if (!Number.isInteger(color) || color <= 0 || color > 0xffffff) return null;
  return `#${color.toString(16).padStart(6, "0")}`;
}

const clip = (s: string, max: number) => s.trim().slice(0, max);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Ties in position: by id, numerically where the template uses its placeholder numbers. */
const byId = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b));

/** What of this server the plan must know: names to spot duplicates, the AFK channel to decide whether the template's is offered. */
export type ExistingStructure = {
  categories: { id: string; name: string }[];
  channels: { name: string; kind: "text" | "voice"; categoryId: string | null }[];
  roles: { name: string; isDefault: boolean }[];
  afkChannelId: string | null;
};

/** The template's role keys of Discord's @everyone: the role with id 0 (templates number it so) or the one named so. */
const EVERYONE_KEYS = (g: DiscordTemplate["serialized_source_guild"]) => new Set(g.roles.filter((r) => r.id === "0" || r.name === "@everyone").map((r) => r.id).concat("0"));

/**
 * A channel's or category's overwrites as Squorli understands them (docs/features/channel-permissions.md): the masks
 * through the permission map, then only the channel-overridable bits; @everyone becomes "everyone" (the role "Gast" at
 * the import); overwrites for single accounts are counted and dropped; entries that carry nothing after all fall away.
 */
export function mapOverwrites(rows: { id: string; type: number; allow: string | number; deny: string | number }[], everyone: ReadonlySet<string>): { overwrites: ImportOverwrite[]; memberOverwrites: number } {
  const overwrites: ImportOverwrite[] = [];
  let memberOverwrites = 0;
  for (const o of rows) {
    if (o.type === 1) { memberOverwrites++; continue; }
    const allow = mapDiscordPermissions(o.allow) & CHANNEL_OVERRIDABLE, deny = mapDiscordPermissions(o.deny) & CHANNEL_OVERRIDABLE & ~allow;
    if (!allow && !deny) continue;
    overwrites.push({ roleKey: everyone.has(o.id) ? "everyone" : o.id, allow, deny });
  }
  return { overwrites, memberOverwrites };
}

/**
 * The plan of an import (pure): categories, channels in display order, roles most powerful first, the template's AFK
 * channel and what is dropped. "Ergänzen": what exists by name is skipped, never replaced (user's decision, 22 September
 * 2026); a category of the same name is reused for the template's channels. Discord's @everyone is dropped: the role
 * "Gast" stays as it is (user's decision).
 */
export function planDiscordImport(template: DiscordTemplate, existing: ExistingStructure, actor: Actor): ImportPlan {
  const g = template.serialized_source_guild;
  const dropped: ImportPlan["dropped"] = [];
  const everyone = EVERYONE_KEYS(g);

  // Categories in Discord's order; the template's ids are the keys. Their overwrites come along (live inheritance here = Discord's sync).
  const categories: ImportCategoryPlan[] = g.channels
    .filter((c) => c.type === CATEGORY_TYPE)
    .sort((a, b) => a.position - b.position || byId(a.id, b.id))
    .map((c) => {
      const name = clip(c.name, 64) || "Kategorie";
      return { key: c.id, name, existingId: existing.categories.find((e) => same(e.name, name))?.id ?? null, ...mapOverwrites(c.permission_overwrites, everyone) };
    });
  const categoryKeys = new Set(categories.map((c) => c.key));

  // Channels as Discord shows them: without a category first, then per category; text before voice, each by position.
  const kindOf = (type: number): "text" | "voice" | null => (TEXT_TYPES.has(type) ? "text" : VOICE_TYPES.has(type) ? "voice" : null);
  const plain = g.channels.filter((c) => c.type !== CATEGORY_TYPE);
  const order = (a: (typeof plain)[number], b: (typeof plain)[number]) => {
    const ka = kindOf(a.type) === "voice" ? 1 : 0, kb = kindOf(b.type) === "voice" ? 1 : 0;
    return ka - kb || a.position - b.position || byId(a.id, b.id);
  };
  const groups: { categoryKey: string | null; items: typeof plain }[] = [
    { categoryKey: null, items: plain.filter((c) => c.parent_id == null || !categoryKeys.has(c.parent_id)) },
    ...categories.map((cat) => ({ categoryKey: cat.key, items: plain.filter((c) => c.parent_id === cat.key) })),
  ];
  const channels: ImportChannelPlan[] = [];
  for (const group of groups) {
    const targetCategoryId = group.categoryKey === null ? null : categories.find((c) => c.key === group.categoryKey)?.existingId ?? undefined;
    for (const c of group.items.sort(order)) {
      const kind = kindOf(c.type);
      if (!kind) { dropped.push({ name: clip(c.name, 64) || c.id, kind: "channel", reason: "unsupported" }); continue; }
      const name = clip(c.name, 64) || (kind === "text" ? "kanal" : "Sprachkanal");
      // A duplicate = same name and kind inside the same existing category (or without one). A new category has nothing yet.
      const exists = targetCategoryId === undefined ? false
        : existing.channels.some((e) => e.kind === kind && e.categoryId === targetCategoryId && same(e.name, name));
      const ow = mapOverwrites(c.permission_overwrites, everyone);
      // Private on Discord = @everyone may not view it, on the channel or (unless the channel says otherwise) its category.
      const catEveryone = categories.find((k) => k.key === group.categoryKey)?.overwrites.find((o) => o.roleKey === "everyone");
      const chanEveryone = ow.overwrites.find((o) => o.roleKey === "everyone");
      const priv = chanEveryone && (chanEveryone.deny & Permission.VIEW_CHANNELS) ? true
        : chanEveryone && hasPermission(chanEveryone.allow, Permission.VIEW_CHANNELS) ? false
        : !!catEveryone && (catEveryone.deny & Permission.VIEW_CHANNELS) !== 0;
      channels.push({
        key: c.id, kind, name,
        topic: kind === "text" && c.topic ? clip(c.topic, 256) || null : null,
        audioBitrate: kind === "voice" ? mapBitrate(c.bitrate) : DEFAULT_AUDIO_BITRATE,
        categoryKey: group.categoryKey, ...ow, private: priv, exists,
      });
    }
  }

  // Roles: most powerful first (Discord's position, else the array order; @everyone sits at 0 either way).
  const roles: ImportRolePlan[] = g.roles
    .map((r, i) => ({ r, rank: r.position ?? i }))
    .sort((a, b) => b.rank - a.rank || byId(a.r.id, b.r.id))
    .flatMap(({ r }) => {
      const name = clip(r.name, 32);
      if (r.name === "@everyone" || r.id === "0") { dropped.push({ name: r.name, kind: "role", reason: "default_role" }); return []; }
      if (!name) return [];
      const permissions = mapDiscordPermissions(r.permissions);
      return [{
        key: r.id, name, color: mapColor(r.color), permissions,
        exists: existing.roles.some((e) => same(e.name, name)),
        blocked: canGrant(actor, permissions) ? null : ("cannot_grant" as const),
      }];
    });

  const afk = g.afk_channel_id == null ? null : channels.find((c) => c.key === g.afk_channel_id && c.kind === "voice" && !c.exists);
  return {
    source: { code: template.code, name: template.name, description: template.description?.trim() || null },
    categories, channels, roles,
    afkChannelKey: afk && existing.afkChannelId === null ? afk.key : null,
    dropped,
  };
}
