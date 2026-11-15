import { PLUGIN_API_MIN, PLUGIN_API_VERSION, PLUGIN_MANIFEST_MAX_BYTES, PLUGIN_SOURCE_MAX_BYTES, PluginManifest, parsePluginDate, type ManifestField, type PluginCapability, type PluginField, type PluginText } from "@squorli/protocol";

/**
 * Reading a plugin file and its values without running anything (docs/features/plugins.md); pure and tested.
 *
 * A plugin is one `.js` or `.ts` file. Its manifest is JSON in a block comment at the very top that starts with the word
 * `squorli-plugin`, so the server (and anybody with an editor) reads what a plugin is and asks for before any of its code
 * runs, and the stored manifest can never differ from what a run would have declared.
 */

export type ReadError = { ok: false; code: "too_large" | "no_manifest" | "bad_manifest" | "api_too_new" | "api_too_old" | "bad_file_name"; message: string };
export type ReadResult = { ok: true; manifest: PluginManifest; language: "js" | "ts" } | ReadError;

const HEADER = /^﻿?\s*\/\*+\s*squorli-plugin\b([\s\S]*?)\*\//;

export function readPluginFile(source: string, fileName: string): ReadResult {
  const lower = fileName.toLowerCase();
  const language = lower.endsWith(".ts") ? "ts" : lower.endsWith(".js") ? "js" : null;
  if (!language || lower.endsWith(".d.ts")) return { ok: false, code: "bad_file_name", message: "a plugin is one .js or .ts file" };
  if (Buffer.byteLength(source, "utf8") > PLUGIN_SOURCE_MAX_BYTES) return { ok: false, code: "too_large", message: `the file is larger than ${PLUGIN_SOURCE_MAX_BYTES / 1024} KB` };
  const m = HEADER.exec(source);
  if (!m) return { ok: false, code: "no_manifest", message: "the file does not start with a /* squorli-plugin { ... } */ comment" };
  const text = m[1] ?? "";
  if (Buffer.byteLength(text, "utf8") > PLUGIN_MANIFEST_MAX_BYTES) return { ok: false, code: "bad_manifest", message: `the manifest is larger than ${PLUGIN_MANIFEST_MAX_BYTES / 1024} KB` };
  let json: unknown;
  try { json = JSON.parse(text); } catch (err) { return { ok: false, code: "bad_manifest", message: `the manifest is not JSON: ${String((err as Error).message)}` }; }
  const apiVersion = (json as { apiVersion?: unknown } | null)?.apiVersion;
  // Asked before the strict parse: a plugin written for a later interface would otherwise only read as "unknown key".
  if (typeof apiVersion === "number" && apiVersion > PLUGIN_API_VERSION) return { ok: false, code: "api_too_new", message: `the plugin needs interface version ${apiVersion}, this server offers ${PLUGIN_API_VERSION}; update the server` };
  if (typeof apiVersion === "number" && apiVersion < PLUGIN_API_MIN) return { ok: false, code: "api_too_old", message: `the plugin was written for interface version ${apiVersion}, which this server no longer runs` };
  const parsed = PluginManifest.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, code: "bad_manifest", message: `the manifest is not valid${first ? `: ${first.path.join(".") || "(top)"}: ${first.message}` : ""}` };
  }
  return { ok: true, manifest: parsed.data, language };
}

/** May this server run a plugin of that interface version? (A server downgrade can leave an installed plugin too new.) */
export function apiSupported(apiVersion: number): boolean {
  return apiVersion >= PLUGIN_API_MIN && apiVersion <= PLUGIN_API_VERSION;
}

/**
 * What each capability means, in the words the owner reads before enabling a plugin. They come from the server so that a
 * capability of a later server needs no new app, and so that the command `squorli plugin` says the same thing.
 */
export const CAPABILITY_INFO: Record<PluginCapability, { text: PluginText; risk: "low" | "high" }> = {
  "members.read": {
    risk: "low",
    text: { en: "See the member list (names, roles, when somebody joined) and learn when members join, leave or change roles.", de: "Die Mitgliederliste sehen (Namen, Rollen, Beitrittsdatum) und erfahren, wenn Mitglieder beitreten, gehen oder Rollen wechseln." },
  },
  "roles.manage": {
    risk: "high",
    text: { en: "Give and take the roles you pick in its settings. Never roles with administrator rights.", de: "Die Rollen vergeben und entziehen, die du in seinen Einstellungen auswählst. Nie Rollen mit Administratorrecht." },
  },
  "messages.read": {
    risk: "high",
    text: { en: "Read every message in the channels you pick in its settings.", de: "Alle Nachrichten in den Kanälen lesen, die du in seinen Einstellungen auswählst." },
  },
  "messages.write": {
    risk: "low",
    text: { en: "Write messages under its own name in the channels you pick in its settings, and where a member runs one of its commands.", de: "Unter eigenem Namen Nachrichten schreiben: in den Kanälen, die du in seinen Einstellungen auswählst, und dort, wo ein Mitglied einen seiner Befehle ausführt." },
  },
};

// ---------- Values of fields ----------

export type FieldError = "required" | "invalid" | "too_long" | "out_of_range";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXT_MAX = 2000;
const LIST_MAX = 50;
/** Ten years: a duration beyond that is a typing mistake. */
export const DURATION_MAX_SECONDS = 10 * 365 * 86_400;

/**
 * Check what a member typed into a form (or an admin into the settings) against the fields the manifest declares. Shape and
 * ranges only: whether a role or channel exists, lies in the plugin's scope and may be used by the caller is the service's
 * question. Unknown keys are dropped. A field left empty takes its default; without one it is absent from the result.
 */
export function checkValues(fields: readonly ManifestField[], given: Record<string, unknown>): { ok: true; values: Record<string, unknown> } | { ok: false; errors: Record<string, FieldError> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, FieldError> = {};
  for (const f of fields) {
    let v = given[f.key];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty && f.default !== undefined) v = f.default;
    const stillEmpty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (stillEmpty) {
      if (f.required) errors[f.key] = "required";
      else if (f.type === "roles" || f.type === "channels") values[f.key] = [];
      else if (f.type === "boolean") values[f.key] = false;
      continue;
    }
    const r = checkOne(f, v);
    if ("error" in r) errors[f.key] = r.error; else values[f.key] = r.value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

function checkOne(f: ManifestField, v: unknown): { value: unknown } | { error: FieldError } {
  switch (f.type) {
    case "text": {
      if (typeof v !== "string") return { error: "invalid" };
      const text = f.multiline ? v.replace(/\r\n/g, "\n").trim() : v.replace(/[\r\n]+/g, " ").trim();
      if (text.length > (f.maxLength ?? TEXT_MAX)) return { error: "too_long" };
      if (!text && f.required) return { error: "invalid" };
      return { value: text };
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: "invalid" };
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return { error: "out_of_range" };
      return { value: v };
    }
    case "boolean": return typeof v === "boolean" ? { value: v } : { error: "invalid" };
    case "select": return typeof v === "string" && f.options?.some((o) => o.value === v) ? { value: v } : { error: "invalid" };
    case "role": case "channel": case "member": return typeof v === "string" && UUID.test(v) ? { value: v.toLowerCase() } : { error: "invalid" };
    case "roles": case "channels": {
      if (!Array.isArray(v) || v.length > LIST_MAX || !v.every((x) => typeof x === "string" && UUID.test(x))) return { error: "invalid" };
      return { value: [...new Set((v as string[]).map((x) => x.toLowerCase()))] };
    }
    case "date": return typeof v === "string" && parsePluginDate(v, f.yearOptional === true) ? { value: v } : { error: "invalid" };
    case "duration": {
      if (typeof v !== "number" || !Number.isInteger(v)) return { error: "invalid" };
      if (v < Math.max(1, f.min ?? 1) || v > Math.min(DURATION_MAX_SECONDS, f.max ?? DURATION_MAX_SECONDS)) return { error: "out_of_range" };
      return { value: v };
    }
  }
}

/** The role ids and channel ids a set of settings names: the plugin's scope before the server's own checks. */
export function scopeIds(fields: readonly ManifestField[], values: Record<string, unknown>): { roles: string[]; channels: string[] } {
  const roles = new Set<string>(), channels = new Set<string>();
  for (const f of fields) {
    const v = values[f.key];
    const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];
    if (f.type === "role" || f.type === "roles") for (const id of ids) roles.add(id);
    if (f.type === "channel" || f.type === "channels") for (const id of ids) channels.add(id);
  }
  return { roles: [...roles], channels: [...channels] };
}

/**
 * A manifest's field as a client gets it. For a role or channel field of a dialog, `allowed` holds the ids the server will
 * take: the plugin's scope, or with `from` the values of that one settings field.
 */
export function wireField(f: ManifestField, settings?: { fields: readonly ManifestField[]; values: Record<string, unknown>; scope: { roles: string[]; channels: string[] } }): PluginField {
  const { from, ...rest } = f;
  const out: PluginField = { ...rest };
  if (settings && (f.type === "role" || f.type === "roles" || f.type === "channel" || f.type === "channels")) {
    const kind = f.type === "role" || f.type === "roles" ? "roles" : "channels";
    if (from) {
      const source = settings.fields.find((s) => s.key === from);
      out.allowed = source ? scopeIds([source], settings.values)[kind].filter((id) => settings.scope[kind].includes(id)) : [];
    } else out.allowed = [...settings.scope[kind]];
  }
  return out;
}

const FIELD_ERROR_TEXT: Record<FieldError | "not_allowed" | "unknown", PluginText> = {
  required: { en: "This field is needed.", de: "Dieses Feld wird gebraucht." },
  invalid: { en: "This value does not fit the field.", de: "Dieser Wert passt nicht zum Feld." },
  too_long: { en: "This text is too long.", de: "Dieser Text ist zu lang." },
  out_of_range: { en: "This value is outside the allowed range.", de: "Dieser Wert liegt außerhalb des erlaubten Bereichs." },
  not_allowed: { en: "You may not pick this here.", de: "Das darfst du hier nicht auswählen." },
  unknown: { en: "This no longer exists.", de: "Das gibt es nicht mehr." },
};
export function fieldErrorText(code: FieldError | "not_allowed" | "unknown"): PluginText { return FIELD_ERROR_TEXT[code]; }
