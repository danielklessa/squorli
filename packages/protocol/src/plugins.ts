import { z } from "zod";
import { Permission } from "./permissions";
import { Iso, Uuid } from "./primitives";

/**
 * Plugins the server runs itself (15 November 2026, docs/features/plugins.md). Not copied to the directory: this file is
 * the chat server's part. Two kinds of schemas live here and must not be mixed up:
 *
 * - **The manifest** (`PluginManifest` and the `Manifest*` parts) is what a plugin's author writes. It is parsed strictly,
 *   once, by the server at installation: an unknown key, field type or capability refuses the plugin, because it would mean
 *   something this server does not do.
 * - **The wire types** (`PluginField`, `PluginCommand`, `PluginMemberAction`, `PluginSurface`, `PluginInfo`, ...) are what
 *   the server sends its clients. They are parsed leniently: types and permissions are plain strings, lists drop the entries
 *   a client cannot read. A plugin is installed by a server's owner at any time, so a client from before a later field type
 *   meets it without an app release: it must show "needs a newer app" for that one field, never lose the welcome.
 *
 * No PROTOCOL_VERSION bump: `ServerState.plugins` (the feature flag, also on `structure`) and `Message.plugin` are optional,
 * and everything a client does goes over REST.
 */

/**
 * The interface version this server offers plugins (`squorli.apiVersion`), and the oldest one it still runs. Version 2
 * (server 0.15.0) added the network (the capability `net.fetch`, the manifest's `network` and `squorli.net.get`), the
 * settings field type `list` and the event `settings.check`. A plugin that uses none of it stays at version 1 and runs on
 * servers from before.
 */
export const PLUGIN_API_VERSION = 2;
export const PLUGIN_API_MIN = 1;

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
/** One plugin file, as uploaded (source text, UTF-8). */
export const PLUGIN_SOURCE_MAX_BYTES = 256 * 1024;
export const PLUGIN_MANIFEST_MAX_BYTES = 32 * 1024;
export const PLUGIN_SETTINGS_FIELDS_MAX = 30;
export const PLUGIN_FORM_FIELDS_MAX = 10;
export const PLUGIN_COMMANDS_MAX = 20;
export const PLUGIN_MEMBER_ACTIONS_MAX = 10;
export const PLUGIN_VIEWS_MAX = 5;
export const PLUGIN_VIEW_ROWS_MAX = 500;
/** How many hosts a manifest's `network` may name. */
export const PLUGIN_NETWORK_HOSTS_MAX = 20;
/** The interface version from which a manifest may name `network` and the capability `net.fetch`. */
export const PLUGIN_NETWORK_API_VERSION = 2;
/** A `list` field (interface version 2): how many columns an entry may have, and how many entries a list holds at most and by default. */
export const PLUGIN_LIST_API_VERSION = 2;
export const PLUGIN_LIST_FIELDS_MAX = 4;
export const PLUGIN_LIST_ITEMS_MAX = 100;
export const PLUGIN_LIST_ITEMS_DEFAULT = 50;
/** What an entry of a `list` field is made of. */
export const PLUGIN_LIST_ITEM_TYPES = ["text", "number", "boolean", "select"] as const;
/** What a slash command's text argument may hold. */
export const PLUGIN_COMMAND_TEXT_MAX = 2000;

/**
 * What a plugin may ask for. Storage, schedules, the log and its own settings need nothing. `net.fetch` (interface version
 * 2) is the only one an owner's confirmation does not grant alone: the server takes it only from a file that carries
 * Squorli's signature (docs/features/plugins.md).
 */
export const PLUGIN_CAPABILITIES = ["members.read", "roles.manage", "messages.read", "messages.write", "net.fetch"] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/**
 * A date as a `date` field yields it: `YYYY-MM-DD`, or `--MM-DD` where the field lets the year be left out (pure, tested;
 * the server checks with it and the client builds its value with it). Returns the parts, or null for anything that is no
 * day of the calendar. Without a year 29 February is a day.
 */
export function parsePluginDate(value: string, yearOptional = false): { year: number | null; month: number; day: number } | null {
  const m = /^(?:(\d{4})|-)-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = m[1] === undefined ? null : Number(m[1]);
  const month = Number(m[2]), day = Number(m[3]);
  if (year === null && !yearOptional) return null;
  if ((year !== null && year < 1) || month < 1 || month > 12 || day < 1) return null;
  // A leap year stands in for "no year": then 29 February is taken.
  const last = new Date(Date.UTC(2000, month, 0));
  if (year !== null) last.setUTCFullYear(year, month, 0);
  return day <= last.getUTCDate() ? { year, month, day } : null;
}

/**
 * The field types (settings, a member action's dialog, a command's form). `list` came with interface version 2 and stands in
 * settings only: entries an admin adds and removes, each made of a few simple fields (`fields`).
 */
export const PLUGIN_FIELD_TYPES = ["text", "number", "boolean", "select", "role", "roles", "channel", "channels", "member", "duration", "date", "list"] as const;
export type PluginFieldType = (typeof PLUGIN_FIELD_TYPES)[number];
export const PLUGIN_VIEW_COLUMN_TYPES = ["text", "member", "role", "channel", "time", "duration"] as const;

// ---------- Text in two languages ----------

/** A text a plugin supplies: English always, German when the author wrote one. Plain text, shown as text, never as markup. */
export const PluginText = z.object({ en: z.string(), de: z.string().optional() });
export type PluginText = z.infer<typeof PluginText>;
/** The text for a client's language; English is the fallback. */
export function pluginText(text: PluginText | undefined, locale: string): string {
  if (!text) return "";
  return (locale === "de" ? text.de : undefined) ?? text.en;
}

/**
 * Control characters and the characters that turn the direction of text around: none of them belongs into a label, and
 * with them a plugin's name could draw over the line it stands in (a terminal's escape sequences in `squorli plugin list`,
 * a reversed file name in a dialog).
 */
export const PLUGIN_TEXT_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** The same, for cleaning a text a plugin hands over while it runs (an answer's message); line breaks stay. */
export function cleanPluginText(text: string): string {
  return text.replace(new RegExp(PLUGIN_TEXT_FORBIDDEN.source, "g"), (c) => (c === "\n" ? c : ""));
}
const line = (max: number) => z.string().trim().min(1).max(max).refine((s) => !PLUGIN_TEXT_FORBIDDEN.test(s), "control characters are not allowed");

/** In a manifest a text is a bare string (English) or `{ en, de }`. One line, no control characters. */
const manifestText = (max: number) => z.union([
  line(max).transform((en): PluginText => ({ en })),
  z.object({ en: line(max), de: line(max).optional() }).strict(),
]);

// ---------- The manifest (strict) ----------

/** The name of a permission (`packages/protocol/src/permissions.ts`), e.g. "MANAGE_ROLES". */
const PermissionName = z.string().refine((name) => Object.prototype.hasOwnProperty.call(Permission, name), "unknown permission");

/** One column of a `list` field's entries: a simple field without a scope (no role, channel or member). */
export const ManifestListItemField = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
  type: z.enum(PLUGIN_LIST_ITEM_TYPES),
  label: manifestText(80),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: line(64), label: manifestText(80) }).strict()).min(1).max(50).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  /** `text`: the longest value (default and cap 200 inside a list). */
  maxLength: z.number().int().min(1).max(200).optional(),
}).strict();
export type ManifestListItemField = z.infer<typeof ManifestListItemField>;

const ManifestFieldBase = {
  /** The key of the value in `settings.get()` or in a handler's `values`. */
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
  type: z.enum(PLUGIN_FIELD_TYPES),
  label: manifestText(80),
  help: manifestText(300).optional(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  /** `select`: the choices. */
  options: z.array(z.object({ value: line(64), label: manifestText(80) }).strict()).min(1).max(50).optional(),
  /** `number`: the range of the value. `duration`: the range in seconds. */
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  /** `text`: the longest value (default and cap 2000). */
  maxLength: z.number().int().min(1).max(2000).optional(),
  /** `text`: several lines. */
  multiline: z.boolean().optional(),
  /** `duration`: suggested values in seconds, shown as buttons. */
  presets: z.array(z.number().int().positive()).max(8).optional(),
  /** `channel`, `channels`: which kind may be picked (default: text channels). */
  channelKind: z.enum(["text", "voice"]).optional(),
  /**
   * `date`: the member may leave the year out. The value is then `--MM-DD` (as a vCard writes a birthday without a year)
   * instead of `YYYY-MM-DD`. The app draws a date picker either way.
   */
  yearOptional: z.boolean().optional(),
  /**
   * `list` (settings only, interface version 2): what one entry is made of, one to four simple fields. The value is an array
   * of objects keyed by these fields' keys.
   */
  fields: z.array(ManifestListItemField).min(1).max(PLUGIN_LIST_FIELDS_MAX).optional(),
  /** `list`: how many entries it holds at most (default 50, cap 100). */
  maxItems: z.number().int().min(1).max(PLUGIN_LIST_ITEMS_MAX).optional(),
};
/** A field of the settings. Its `role`/`roles` and `channel`/`channels` values are the plugin's scope (what it may touch). */
export const ManifestSettingsField = z.object(ManifestFieldBase).strict();
/**
 * A field of a member action's dialog or a command's form. A `role`/`channel` field offers only what lies in the plugin's
 * scope and the caller may use; `from` narrows it to the values of one settings field.
 */
export const ManifestFormField = z.object({ ...ManifestFieldBase, from: z.string().max(32).optional() }).strict();

export const ManifestCommand = z.object({
  /** What a member types after the slash. Unique among the enabled plugins of a server. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  description: manifestText(120),
  /** The permission a member needs in the channel to run it. */
  permission: PermissionName.default("SEND_MESSAGES"),
  /** `none` = runs at once, `text` = the rest of the line is its argument, `form` = a dialog with `fields`. */
  input: z.enum(["none", "text", "form"]).default("none"),
  textHint: manifestText(80).optional(),
  fields: z.array(ManifestFormField).max(PLUGIN_FORM_FIELDS_MAX).default([]),
}).strict();

export const ManifestMemberAction = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9-]{0,31}$/),
  label: manifestText(60),
  /** The server-wide permission a member needs to see and run the action. No default: the author decides. */
  permission: PermissionName,
  /** Whom it may be run on: anybody, only members the caller outranks (as a kick), or anybody but oneself. */
  target: z.enum(["any", "manageable", "notSelf"]).default("manageable"),
  fields: z.array(ManifestFormField).max(PLUGIN_FORM_FIELDS_MAX).default([]),
  submitLabel: manifestText(40).optional(),
}).strict();

export const ManifestView = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9-]{0,31}$/),
  title: manifestText(80),
  columns: z.array(z.object({ key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), label: manifestText(60), type: z.enum(PLUGIN_VIEW_COLUMN_TYPES).default("text") }).strict()).min(1).max(8),
}).strict();

const unique = (list: readonly string[]) => new Set(list).size === list.length;

/**
 * A host a plugin may fetch from: a full name in lower case with a top-level domain of letters. No wildcard, no port, no
 * IP address and no bare name such as `localhost`; the server asks these hosts over https only.
 */
export const PluginNetworkHost = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a host is a full name in lower case, e.g. api.example.org");

export const PluginManifest = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN),
  name: manifestText(60),
  description: manifestText(300),
  /** The plugin's own version, three numbers. */
  version: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/),
  /** The interface version the plugin was written for (`PLUGIN_API_VERSION`). */
  apiVersion: z.number().int().min(1),
  author: line(80).optional(),
  homepage: z.string().max(300).regex(/^https:\/\/[^\s]+$/).optional(),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).max(PLUGIN_CAPABILITIES.length).default([]),
  /**
   * Interface version 2, together with the capability `net.fetch`: the hosts `squorli.net.get` may ask, and no other. The
   * owner reads the list before enabling the plugin, and the signature covers it like the rest of the file.
   */
  network: z.object({ hosts: z.array(PluginNetworkHost).min(1).max(PLUGIN_NETWORK_HOSTS_MAX) }).strict().optional(),
  settings: z.array(ManifestSettingsField).max(PLUGIN_SETTINGS_FIELDS_MAX).default([]),
  commands: z.array(ManifestCommand).max(PLUGIN_COMMANDS_MAX).default([]),
  memberActions: z.array(ManifestMemberAction).max(PLUGIN_MEMBER_ACTIONS_MAX).default([]),
  views: z.array(ManifestView).max(PLUGIN_VIEWS_MAX).default([]),
}).strict().superRefine((m, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (!unique(m.capabilities)) issue("a capability is named twice");
  const wantsNet = m.capabilities.includes("net.fetch");
  if (wantsNet !== (m.network !== undefined)) issue('the capability "net.fetch" and "network" with its hosts go together');
  if ((wantsNet || m.network) && m.apiVersion < PLUGIN_NETWORK_API_VERSION) issue(`the network needs "apiVersion": ${PLUGIN_NETWORK_API_VERSION}`);
  if (m.network && !unique(m.network.hosts)) issue("a host is named twice");
  if (!unique(m.settings.map((f) => f.key))) issue("two settings fields share a key");
  if (!unique(m.commands.map((c) => c.name))) issue("two commands share a name");
  if (!unique(m.memberActions.map((a) => a.id))) issue("two member actions share an id");
  if (!unique(m.views.map((v) => v.id))) issue("two views share an id");
  const scopeKind = (type: string) => (type === "role" || type === "roles" ? "role" : type === "channel" || type === "channels" ? "channel" : null);
  const checkField = (f: z.infer<typeof ManifestFormField>, where: string) => {
    if (f.type === "select" && !f.options) issue(`${where}: a select field needs options`);
    if (f.type !== "select" && f.options) issue(`${where}: only a select field has options`);
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) issue(`${where}: min is above max`);
    if (f.yearOptional !== undefined && f.type !== "date") issue(`${where}: only a date field has yearOptional`);
    if (f.type === "list") {
      if (!f.fields) issue(`${where}: a list field needs fields`);
      else {
        if (!unique(f.fields.map((x) => x.key))) issue(`${where}: two fields of the list share a key`);
        for (const x of f.fields) {
          if (x.type === "select" && !x.options) issue(`${where}.${x.key}: a select field needs options`);
          if (x.type !== "select" && x.options) issue(`${where}.${x.key}: only a select field has options`);
          if (x.min !== undefined && x.max !== undefined && x.min > x.max) issue(`${where}.${x.key}: min is above max`);
        }
      }
      if (m.apiVersion < PLUGIN_LIST_API_VERSION) issue(`${where}: a list field needs "apiVersion": ${PLUGIN_LIST_API_VERSION}`);
      if (!where.startsWith("settings.")) issue(`${where}: a list field stands in the settings only`);
    } else if (f.fields !== undefined || f.maxItems !== undefined) issue(`${where}: only a list field has fields and maxItems`);
    if (f.from !== undefined) {
      const source = m.settings.find((s) => s.key === f.from);
      if (!source || scopeKind(source.type) === null || scopeKind(source.type) !== scopeKind(f.type)) issue(`${where}: "from" must name a settings field of the same kind (roles or channels)`);
    }
  };
  for (const f of m.settings) checkField(f, `settings.${f.key}`);
  for (const [what, list] of [["command", m.commands.map((c) => ({ id: c.name, fields: c.fields }))], ["member action", m.memberActions.map((a) => ({ id: a.id, fields: a.fields }))]] as const) {
    for (const entry of list) {
      if (!unique(entry.fields.map((f) => f.key))) issue(`${what} ${entry.id}: two fields share a key`);
      for (const f of entry.fields) checkField(f, `${what} ${entry.id}.${f.key}`);
    }
  }
  for (const c of m.commands) {
    if (c.input === "form" && c.fields.length === 0) issue(`command ${c.name}: input "form" needs fields`);
    if (c.input !== "form" && c.fields.length > 0) issue(`command ${c.name}: fields need input "form"`);
  }
  for (const v of m.views) if (!unique(v.columns.map((c) => c.key))) issue(`view ${v.id}: two columns share a key`);
});
export type PluginManifest = z.infer<typeof PluginManifest>;
export type ManifestField = z.infer<typeof ManifestFormField>;

// ---------- What clients get (lenient) ----------

/** A list in which an entry this version cannot read is left out alone (the pattern of `AccountNotices`). */
const lenientList = <T extends z.ZodTypeAny>(item: T) => z.array(z.unknown()).default([]).transform((list) => list.flatMap((entry) => {
  const r = item.safeParse(entry);
  return r.success ? [r.data as z.infer<T>] : [];
}));

/** One field as a client draws it. `type` is a string on purpose: an unknown one is shown as "needs a newer app". */
export const PluginField = z.object({
  key: z.string(),
  type: z.string(),
  label: PluginText,
  help: PluginText.optional(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  options: z.array(z.object({ value: z.string(), label: PluginText })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().optional(),
  multiline: z.boolean().optional(),
  presets: z.array(z.number()).optional(),
  channelKind: z.string().optional(),
  yearOptional: z.boolean().optional(),
  /** `list`: the columns of an entry. A column of a type this app cannot draw makes the whole field "needs a newer app". */
  fields: z.array(z.object({
    key: z.string(), type: z.string(), label: PluginText, required: z.boolean().default(false), default: z.unknown().optional(),
    options: z.array(z.object({ value: z.string(), label: PluginText })).optional(), min: z.number().optional(), max: z.number().optional(), maxLength: z.number().optional(),
  })).optional(),
  maxItems: z.number().optional(),
  /**
   * `role`/`roles`/`channel`/`channels` in a dialog or form: the ids the server takes for this field (the plugin's scope).
   * The client offers these and nothing else, and of the roles only those the member may assign (memberRank.ts).
   */
  allowed: z.array(z.string()).optional(),
});
export type PluginField = z.infer<typeof PluginField>;

export const PluginCommand = z.object({
  plugin: z.string(),
  pluginName: PluginText,
  name: z.string(),
  description: PluginText,
  /** A permission's name; a client that does not know it hides the command. */
  permission: z.string(),
  input: z.string(),
  textHint: PluginText.optional(),
  fields: z.array(PluginField).default([]),
});
export type PluginCommand = z.infer<typeof PluginCommand>;

export const PluginMemberAction = z.object({
  plugin: z.string(),
  pluginName: PluginText,
  id: z.string(),
  label: PluginText,
  permission: z.string(),
  target: z.string(),
  fields: z.array(PluginField).default([]),
  submitLabel: PluginText.optional(),
});
export type PluginMemberAction = z.infer<typeof PluginMemberAction>;

/**
 * What the enabled plugins add to every member's client: the same for all members. Each entry names the permission it
 * needs; the client hides what the member may not use and the server checks again.
 */
export const PluginSurface = z.object({ commands: lenientList(PluginCommand), memberActions: lenientList(PluginMemberAction) });
export type PluginSurface = z.infer<typeof PluginSurface>;

/**
 * A card: a plugin's message drawn as a framed box instead of a line of text (interface version 2, docs/features/plugins.md).
 * Everything in it is data the client draws with its own components: a small line above the title (`kicker`, a game's
 * name), the title (a link when `url` is given), a text in the Markdown of messages, a small picture in the corner and a
 * large one below. The pictures are files of this server (the server fetched them, as it does for link previews), never
 * addresses of a foreign host. A message with a card still has its `content`: an app from before cards shows that.
 */
export const PLUGIN_CARD_API_VERSION = 2;
export const PLUGIN_CARD_KICKER_MAX = 80;
export const PLUGIN_CARD_TITLE_MAX = 200;
export const PLUGIN_CARD_TEXT_MAX = 2000;
export const PLUGIN_CARD_URL_MAX = 500;
export const MessageCard = z.object({
  kicker: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  text: z.string().optional(),
  /** Paths on this server (`/api/previews/<file>`); they arrive with a `message.update` shortly after the message. */
  image: z.string().optional(),
  thumbnail: z.string().optional(),
});
export type MessageCard = z.infer<typeof MessageCard>;

/** On a message a plugin wrote: which plugin, who caused it (a command's caller), by which command, and its card if it sent one. */
export const MessagePlugin = z.object({
  id: z.string(), name: PluginText, by: Uuid.optional(), command: z.string().optional(),
  // A card of a later server that this client cannot read costs the card, never the message: the text is still there.
  card: MessageCard.optional().catch(undefined),
});
export type MessagePlugin = z.infer<typeof MessagePlugin>;

/** What a member action, a command or a settings change answers. `message` is shown to the caller only. */
export const PluginActionResult = z.object({
  ok: z.boolean(),
  message: PluginText.optional(),
  fieldErrors: z.record(z.string(), PluginText).optional(),
});
export type PluginActionResult = z.infer<typeof PluginActionResult>;

/** POST /api/plugins/:id/member-actions/:actionId */
export const PluginMemberActionRequest = z.object({ userId: Uuid, values: z.record(z.string(), z.unknown()).default({}) });
/** POST /api/channels/:id/commands */
export const PluginCommandRequest = z.object({
  plugin: z.string().regex(PLUGIN_ID_PATTERN),
  name: z.string().min(1).max(32),
  text: z.string().max(PLUGIN_COMMAND_TEXT_MAX).optional(),
  values: z.record(z.string(), z.unknown()).optional(),
});

// ---------- Verwaltung > Plugins ----------

export const PluginCapabilityInfo = z.object({
  id: z.string(),
  /** What it means, in plain words, from the server (so a capability of a later server needs no app release). */
  text: PluginText,
  /** "low" or "high": how the confirmation marks it. */
  risk: z.string(),
  granted: z.boolean(),
});
export const PluginViewInfo = z.object({ id: z.string(), title: PluginText });
/**
 * Whose signature a plugin file carries: the name of Squorli's key and the kind, "official" (Squorli's own plugin) or
 * "reviewed" (somebody else's that Squorli read). A plain string like the other wire fields; null = not signed.
 */
export const PluginSignatureInfo = z.object({ key: z.string(), kind: z.string() });
export type PluginSignatureInfo = z.infer<typeof PluginSignatureInfo>;

export const PluginInfo = z.object({
  id: z.string(),
  name: PluginText,
  description: PluginText,
  version: z.string(),
  apiVersion: z.number(),
  author: z.string().nullable().default(null),
  homepage: z.string().nullable().default(null),
  /** "js" or "ts". */
  language: z.string(),
  /** SHA-256 of the uploaded file, hex. */
  sourceHash: z.string(),
  enabled: z.boolean(),
  /** "disabled", "running", "suspended" (too many failures), "incompatible" (the interface version), "needs_approval" (an update asks for more). */
  state: z.string(),
  lastError: z.string().nullable().default(null),
  lastErrorAt: Iso.nullable().default(null),
  capabilities: z.array(PluginCapabilityInfo).default([]),
  hasSettings: z.boolean().default(false),
  views: z.array(PluginViewInfo).default([]),
  commands: z.array(z.string()).default([]),
  /** Jobs that wait for their time. */
  pendingJobs: z.number().int().nonnegative().default(0),
  /** "upload", "cli" or "bundled". */
  installedVia: z.string(),
  signature: PluginSignatureInfo.nullable().default(null).catch(null),
  /**
   * Why a plugin that is switched on does not run, when the reason is its signature or the operator's switch and not its
   * failures: "plugin_signature_revoked", "plugin_net_off" or "plugin_signature_required". The state is "suspended" then
   * (clients from before know that one) and `lastError` holds the reason in the server's words.
   */
  blocked: z.string().nullable().default(null).catch(null),
  installedAt: Iso,
  updatedAt: Iso,
});
export type PluginInfo = z.infer<typeof PluginInfo>;

/** A plugin that ships with the server and is not installed (the list "Verfügbar"). */
export const PluginAvailable = z.object({
  id: z.string(), name: PluginText, description: PluginText, version: z.string(),
  capabilities: z.array(PluginCapabilityInfo).default([]),
  /** Installed already, in an older version: installing replaces it. */
  installedVersion: z.string().nullable().default(null),
  signature: PluginSignatureInfo.nullable().default(null).catch(null),
});
export type PluginAvailable = z.infer<typeof PluginAvailable>;

/** GET /api/plugins */
export const PluginsResponse = z.object({
  plugins: lenientList(PluginInfo),
  available: lenientList(PluginAvailable),
  /** `PLUGINS`: "operator" = only the `squorli plugin` command installs, "owner" = an owner may upload here too. */
  mode: z.string(),
  max: z.number().int(),
  /** Does this server offer the catalogue of signed plugins (`GET /api/plugins/catalog`, `PLUGIN_CATALOG`)? Missing on a server from before. */
  catalog: z.boolean().default(false).catch(false),
});

/**
 * One plugin of the catalogue of signed plugins, as this server offers it: the entry of the public list (its texts are the
 * author's, shown as text) with the capabilities in the server's own words and what the server knows about it.
 */
export const PluginCatalogEntry = z.object({
  id: z.string(),
  name: PluginText,
  description: PluginText,
  author: z.string().nullable().default(null),
  homepage: z.string().nullable().default(null),
  version: z.string(),
  capabilities: z.array(PluginCapabilityInfo).default([]),
  /** The hosts it fetches from; empty for a plugin without the network. */
  hosts: z.array(z.string()).default([]),
  /** Whose plugin it is, as its signature will say: the server checks the downloaded file, not this field. */
  signature: PluginSignatureInfo.nullable().default(null).catch(null),
  /** `YYYY-MM-DD`. */
  signedAt: z.string().nullable().default(null),
  /** Where its source can be read. */
  source: z.string().nullable().default(null),
  installedVersion: z.string().nullable().default(null),
  /** "new", "update" (the catalogue's version is above the installed one), "installed", "needs_server" (a later plugin interface). */
  status: z.string(),
});
export type PluginCatalogEntry = z.infer<typeof PluginCatalogEntry>;

/** GET /api/plugins/catalog[?refresh=1]. `stale` = the list could not be fetched just now; this is the last one that could. */
export const PluginCatalogResponse = z.object({ plugins: lenientList(PluginCatalogEntry), fetchedAt: Iso, stale: z.boolean().default(false) });
export type PluginCatalogResponse = z.infer<typeof PluginCatalogResponse>;
export type PluginsResponse = z.infer<typeof PluginsResponse>;

/**
 * POST /api/plugins: the file's text, or the id of a plugin that ships with the server. The schema lets through more than
 * a plugin may weigh (up to what one request body carries), so that a file that is too large gets the answer that says so
 * (`plugin_too_large`, from the byte count) instead of a bare `bad_request`.
 */
export const PluginInstallRequest = z.union([
  z.object({ source: z.string().min(1).max(PLUGIN_SOURCE_MAX_BYTES * 3), fileName: z.string().min(1).max(200) }).strict(),
  z.object({ bundled: z.string().regex(PLUGIN_ID_PATTERN) }).strict(),
  /** The id of a plugin of the catalogue: the server downloads its signed file itself. */
  z.object({ catalog: z.string().regex(PLUGIN_ID_PATTERN) }).strict(),
]);
/** PUT /api/plugins/:id/enabled. `grant` = the capabilities the owner saw and confirmed; it must be what the plugin asks for. */
export const PluginEnableRequest = z.object({ enabled: z.boolean(), grant: z.array(z.string().max(64)).max(32).optional() });
/** GET and PUT /api/plugins/:id/settings */
export const PluginSettingsResponse = z.object({ fields: z.array(PluginField), values: z.record(z.string(), z.unknown()) });
export type PluginSettingsResponse = z.infer<typeof PluginSettingsResponse>;
export const PluginSettingsRequest = z.object({ values: z.record(z.string(), z.unknown()) });
/** GET /api/plugins/:id/log?before=<id> */
export const PluginLogEntry = z.object({ id: z.number().int(), at: Iso, level: z.string(), source: z.string(), text: z.string() });
export type PluginLogEntry = z.infer<typeof PluginLogEntry>;
export const PluginLogResponse = z.object({ entries: z.array(PluginLogEntry), hasMore: z.boolean() });
export type PluginLogResponse = z.infer<typeof PluginLogResponse>;
/** GET /api/plugins/:id/views/:viewId: rows the plugin returned, columns from its manifest. */
export const PluginViewResponse = z.object({
  title: PluginText,
  columns: z.array(z.object({ key: z.string(), label: PluginText, type: z.string() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean().default(false),
});
export type PluginViewResponse = z.infer<typeof PluginViewResponse>;

/** DELETE /api/plugins/:id?messages=keep|delete */
export const PluginRemoveMessages = z.enum(["keep", "delete"]);
