import { PLUGIN_FIELD_TYPES, PLUGIN_LIST_ITEM_TYPES, Permission, hasPermission, parsePluginDate, type Channel, type Member, type PluginCommand, type PluginField, type PluginMemberAction, type PluginSurface, type Role } from "@squorli/protocol";
import { assignableRoles, outranks, rolesByRank } from "./memberRank";

/**
 * What a plugin adds to this member's client (docs/features/plugins.md), the pure and tested part. The surface
 * (`ServerState.plugins`) is the same for every member; this file decides what is drawn, the server checks everything
 * again. **Lenient by design:** a plugin is installed at any time and may come from a server newer than this app, so a
 * permission name, a target rule, a command's `input` or a field's `type` this client does not know hides the entry or
 * shows "needs a newer app" for that one field. Nothing here throws on what a plugin declares.
 */

type Ranked = Pick<Member, "userId" | "roleIds" | "isOwner">;

/** The bit of a permission's name, or null for a name this app does not know (the entry is hidden then). */
export function permissionBit(name: string): number | null {
  return Object.prototype.hasOwnProperty.call(Permission, name) ? (Permission as Record<string, number>)[name]! : null;
}

const holds = (mask: number, permission: string): boolean => {
  const bit = permissionBit(permission);
  return bit !== null && hasPermission(mask, bit);
};

/** Does a member action's target rule fit? An unknown rule fits nobody. */
export function targetFits(rule: string, me: Ranked, target: Ranked, roles: readonly Role[]): boolean {
  if (rule === "any") return true;
  if (rule === "notSelf") return me.userId !== target.userId;
  if (rule === "manageable") return outranks(me, target, roles);
  return false;
}

/** The member actions `me` may run on `target`: the named server-wide permission and the target rule. */
export function usableMemberActions(surface: PluginSurface | undefined, myPermissions: number, me: Ranked | null, target: Ranked, roles: readonly Role[]): PluginMemberAction[] {
  if (!surface || !me) return [];
  return surface.memberActions.filter((a) => holds(myPermissions, a.permission) && targetFits(a.target, me, target, roles));
}

export const COMMAND_INPUTS = ["none", "text", "form"] as const;
const knownInput = (input: string): boolean => (COMMAND_INPUTS as readonly string[]).includes(input);

/**
 * The slash commands a member may use in one channel: `channelPermissions` is the member's mask IN THAT CHANNEL. A command
 * whose `input` this app does not know cannot be run from here and is left out.
 */
export function usableCommands(surface: PluginSurface | undefined, channelPermissions: number): PluginCommand[] {
  if (!surface) return [];
  return surface.commands.filter((c) => knownInput(c.input) && holds(channelPermissions, c.permission));
}

// ---------- Fields

export function isKnownFieldType(type: string): boolean {
  return (PLUGIN_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * Can this app draw the field? A type it knows, and for a `list` every column of its entries too: a list with a column of
 * a later server is shown as "needs a newer app" as a whole, because an entry drawn without one of its fields would be
 * saved without it.
 */
export function isDrawableField(field: Pick<PluginField, "type" | "fields">): boolean {
  if (!isKnownFieldType(field.type)) return false;
  if (field.type !== "list") return true;
  return !!field.fields?.length && field.fields.every((x) => (PLUGIN_LIST_ITEM_TYPES as readonly string[]).includes(x.type));
}

/** A required field of a type this app cannot draw: the form cannot be sent from here. */
export function blockedByUnknown(fields: readonly PluginField[]): boolean {
  return fields.some((f) => f.required && !isDrawableField(f));
}

/** A new, empty entry of a `list` field: each column's default; a switch starts off. */
export function newListItem(field: Pick<PluginField, "fields">): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const x of field.fields ?? []) {
    if (x.default !== undefined && x.default !== null) item[x.key] = x.default;
    else if (x.type === "boolean") item[x.key] = false;
  }
  return item;
}

/** The entries of a `list` field as the form holds them: objects only, whatever the server stored. */
export function listItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : [];
}

/** What a form starts with: each known field's default; switches start off, lists empty. */
export function initialValues(fields: readonly PluginField[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    if (!isDrawableField(f)) continue;
    if (f.default !== undefined && f.default !== null) values[f.key] = f.default;
    else if (f.type === "boolean") values[f.key] = false;
    else if (f.type === "roles" || f.type === "channels" || f.type === "list") values[f.key] = [];
  }
  return values;
}

/**
 * What goes to the server: only the fields this app drew. A field of an unknown type is left out, so in the settings its
 * stored value stays as it is (the server merges what it gets over what it has).
 */
export function submitValues(fields: readonly PluginField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!isDrawableField(f)) continue;
    const v = values[f.key];
    out[f.key] = v === undefined ? (f.type === "roles" || f.type === "channels" || f.type === "list" ? [] : null) : v;
  }
  return out;
}

const idsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : typeof value === "string" && value ? [value] : []);

export type RoleOption = { id: string; role: Role | null };
export type ChannelOption = { id: string; channel: Channel | null };

/**
 * The roles a role field offers, in the owner's order.
 * - In a dialog (a member action, a command's form): `field.allowed` (the plugin's scope) and of those only what the member
 *   may assign by hand (`assignableRoles`); without `allowed` nothing.
 * - In the settings (`settings: true`): every role the admin may assign except one with ADMINISTRATOR, which the server
 *   never takes into a plugin's scope, plus whatever is stored already (somebody above put it there; it may stay, and a
 *   role that is gone shows as such so it can be unticked).
 */
export function roleOptions(field: Pick<PluginField, "allowed">, me: Pick<Member, "roleIds" | "isOwner"> | null, roles: readonly Role[], opts: { settings?: boolean; stored?: unknown } = {}): RoleOption[] {
  const mine = me ? assignableRoles(me, roles) : [];
  if (!opts.settings) {
    const allowed = new Set(field.allowed ?? []);
    return mine.filter((r) => allowed.has(r.id)).map((r) => ({ id: r.id, role: r }));
  }
  const offered = mine.filter((r) => (r.permissions & Permission.ADMINISTRATOR) === 0);
  const stored = idsOf(opts.stored).filter((id) => !offered.some((r) => r.id === id));
  const kept = rolesByRank(roles.filter((r) => stored.includes(r.id))).map((r): RoleOption => ({ id: r.id, role: r }));
  const gone = stored.filter((id) => !roles.some((r) => r.id === id)).map((id): RoleOption => ({ id, role: null }));
  return [...rolesByRank([...offered, ...kept.map((k) => k.role!)]).map((r): RoleOption => ({ id: r.id, role: r })), ...gone];
}

/**
 * The channels a channel field offers: the channels the member sees (`channels` is the client's list, which holds nothing
 * else) of the field's kind (text unless it says otherwise), only those of `allowed` when the server sent that list; in the
 * settings also what is stored already, a channel this member does not see included (as an entry without a name).
 */
export function channelOptions(field: Pick<PluginField, "allowed" | "channelKind">, channels: readonly Channel[], opts: { stored?: unknown } = {}): ChannelOption[] {
  const kind = field.channelKind ?? "text";
  const allowed = field.allowed ? new Set(field.allowed) : null;
  const offered = [...channels].filter((c) => c.kind === kind && (!allowed || allowed.has(c.id))).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const hidden = idsOf(opts.stored).filter((id) => !channels.some((c) => c.id === id) && (!allowed || allowed.has(id)));
  return [...offered.map((c): ChannelOption => ({ id: c.id, channel: c })), ...hidden.map((id): ChannelOption => ({ id, channel: null }))];
}

// ---------- A `date` field
//
// Its value is "YYYY-MM-DD", or "--MM-DD" where the field has `yearOptional` and the member left the year out (the
// protocol's `parsePluginDate` is the one rule for both sides). DateInput.tsx draws it: a date picker, and for a field with
// `yearOptional` a switch "without the year" that swaps the picker for a day and a month, so no year stands anywhere on
// screen while none is given.

/** What the member has picked so far. `year` outlives the switch, so turning it off again brings the whole date back. */
export type DateDraft = { year: number | null; month: number | null; day: number | null; noYear: boolean };

const two = (n: number) => String(n).padStart(2, "0");

/** The days a month has when no year is given: February has 29 (a birthday on that day exists). */
export function daysWithoutYear(month: number | null): number {
  return month === null ? 31 : new Date(Date.UTC(2000, month, 0)).getUTCDate();
}

/** A field's value (stored, a default, or nothing) as a draft. "--MM-DD" starts with the switch on; anything unreadable is empty. */
export function dateDraftOf(value: unknown, yearOptional: boolean): DateDraft {
  const parsed = typeof value === "string" ? parsePluginDate(value, yearOptional) : null;
  if (!parsed) return { year: null, month: null, day: null, noYear: false };
  return { ...parsed, noYear: parsed.year === null };
}

/** What the date picker holds: the whole date, or "" while a part is missing or the three are no day of the calendar. */
export function pickerValueOf(draft: DateDraft): string {
  if (draft.year === null || draft.month === null || draft.day === null) return "";
  const text = `${String(draft.year).padStart(4, "0")}-${two(draft.month)}-${two(draft.day)}`;
  return parsePluginDate(text) ? text : "";
}

/** The date picker changed: its value is "YYYY-MM-DD" or "" (emptied, or not filled in completely). */
export function withPicked(draft: DateDraft, picked: string): DateDraft {
  const parsed = parsePluginDate(picked);
  return parsed ? { ...draft, ...parsed } : { ...draft, year: null, month: null, day: null };
}

/** The day or the month of a date without a year changed; a day the new month does not have is taken back. */
export function withDayMonth(draft: DateDraft, change: { day?: number | null; month?: number | null }): DateDraft {
  const month = change.month !== undefined ? change.month : draft.month;
  const day = change.day !== undefined ? change.day : draft.day;
  return { ...draft, month, day: day !== null && day > daysWithoutYear(month) ? null : day };
}

/**
 * The value that goes to the server, or undefined for "nothing" (so `required` works as for every other field):
 * with the switch on "--MM-DD" once day and month are picked, the year dropped; otherwise the picker's whole date.
 * A field without `yearOptional` never yields a date without a year.
 */
export function dateValueOf(draft: DateDraft, yearOptional: boolean): string | undefined {
  if (draft.noYear && yearOptional) {
    if (draft.month === null || draft.day === null) return undefined;
    const text = `--${two(draft.month)}-${two(draft.day)}`;
    return parsePluginDate(text, true) ? text : undefined;
  }
  return pickerValueOf(draft) || undefined;
}

// ---------- The composer's "/"

const NAME = /^\/([^\s/][^\s]*)?/;

/**
 * The command name being typed: the draft starts with one "/" (never "//", which is how a message that begins with a slash
 * is written) and the caret stands inside that first word. null = no command list.
 */
export function commandQueryAt(draft: string, caret: number): string | null {
  if (!draft.startsWith("/") || draft.startsWith("//")) return null;
  const token = NAME.exec(draft)![0];
  if (caret < 1 || caret > token.length) return null;
  return token.slice(1).toLowerCase();
}

/** The commands for a typed beginning: those that start with it first, then those that contain it; by name. */
export function matchCommands(commands: readonly PluginCommand[], query: string): PluginCommand[] {
  const byName = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  if (!query) return byName;
  return [...byName.filter((c) => c.name.startsWith(query)), ...byName.filter((c) => !c.name.startsWith(query) && c.name.includes(query))];
}

/**
 * A draft that is being sent: is it a command? Only "/name" or "/name rest" with the exact name of a command the member
 * may use here; everything else ("//…", an unknown name, a slash alone) is an ordinary message, as it always was.
 */
export function parseCommandDraft(draft: string, commands: readonly PluginCommand[]): { command: PluginCommand; text: string } | null {
  if (!draft.startsWith("/") || draft.startsWith("//")) return null;
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trimEnd());
  if (!m) return null;
  const command = commands.find((c) => c.name === m[1]!.toLowerCase());
  return command ? { command, text: (m[2] ?? "").trim() } : null;
}
