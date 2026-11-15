import {
  PLUGIN_API_VERSION, PLUGIN_CAPABILITIES, PLUGIN_CARD_API_VERSION, PLUGIN_ID_PATTERN, PLUGIN_SOURCE_MAX_BYTES, PLUGIN_VIEW_ROWS_MAX, Permission, cleanPluginText, displayNameOf, hasPermission,
  type ManifestField, type Message, type PluginActionResult, type PluginAvailable, type PluginCapability, type PluginCatalogResponse, type PluginField, type PluginInfo, type PluginLogResponse,
  type PluginManifest, type PluginSettingsResponse, type PluginSurface, type PluginText, type PluginViewResponse, type PluginsResponse,
} from "@squorli/protocol";
import { and, asc, count, desc, eq, inArray, lt, sql, sum } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MemberContext } from "../auth/session";
import { can, canGrant, canSetRolesOf, canTouchRole, outranks, type Actor } from "../authz";
import type { Config } from "../config";
import type { Db } from "../db";
import { channels, localAccounts, members, messages, pluginJobs, pluginLog, pluginStorage, plugins, roles, users, type PluginScope } from "../db/schema";
import { MAX_EVENT_DEPTH, serverEvents, type Origin, type ServerEventName, type ServerEventOf } from "../events";
import type { Hub } from "../hub";
import { changeMemberRole, type RoleDeps } from "../memberRoles";
import { localJoin, nameColumns } from "../names";
import { WindowCounter } from "../rateLimits";
import { loadMessages } from "../routes/messages";
import { actorOf, loadMembers, loadSettings } from "../state";
import { visibility } from "../visibility";
import { safeGet } from "@squorli/link-preview";
import { readCard, type CardPictures } from "./card";
import { CATALOG_CACHE_MS, CATALOG_MAX_BYTES, CATALOG_REFRESH_MIN_MS, CATALOG_REPOSITORY, catalogAddress, catalogAllowed, catalogStatus, readCatalog, releaseAddress, type CatalogFileEntry } from "./catalog";
import { CAPABILITY_INFO, apiSupported, capabilityText, checkValues, fieldErrorText, readPluginFile, scopeIds, wireField } from "./manifest";
import { HOST_FUNCTIONS, type HostFunction } from "./prelude";
import { PluginFailure, PluginRunner, type InvocationContext } from "./runner";
import { PluginScheduler, type DueJob } from "./scheduler";
import { verifyPluginSignature, type SignatureCheck, type SigningKey } from "./signature";
import { PLUGIN_SIGNING_KEYS, REVOKED_PLUGIN_HASHES } from "./signingKeys";
import { MAX_JSON_CHARS, type FailureKind } from "./wire";

/**
 * Plugins the server runs itself (docs/features/plugins.md, 15 November 2026): what is installed, what each may do, and
 * the functions a plugin can call. Everything a plugin does passes through `onCall` here on the main thread; the worker a
 * plugin runs in (runner.ts, sandbox.ts) holds no handle on anything.
 *
 * **What a plugin may touch** is decided by three things, all checked here on every call:
 * 1. the capabilities its manifest names and the owner granted when enabling it;
 * 2. its scope: the roles and channels an admin picked in its settings (`saveSettings` checks that admin's rank per role,
 *    as a reaction rule does, and keeps the role's permission mask; a role that gained permissions since is refused);
 * 3. its limits per minute.
 * A role that carries ADMINISTRATOR is never in a scope.
 *
 * **The network** (interface version 2, `net.get`) is the one thing an owner's confirmation does not grant alone: the file
 * must carry Squorli's signature (signature.ts), the operator must not have switched it off (`PLUGIN_NET`), and a request
 * goes to the hosts of the manifest only, as one GET through the guarded fetch of the link previews. What stands in the way
 * of a plugin that is installed already (`gates`) is worked out from the file, the keys and the configuration at every start,
 * never stored: a signature Squorli took back stops the plugin with the update that brings the list.
 */

type Row = typeof plugins.$inferSelect;
type Signed = { key: string; kind: string } | null;
type Bundled = { id: string; source: string; fileName: string; manifest: PluginManifest; signature: Signed };
/** Why an installed plugin does not run although it is switched on (its signature, or the operator's `PLUGIN_NET`). */
type Gate = { code: string; message: string };
/** Who is at the door: a signed-in member, or the operator at the machine (`squorli plugin`). */
export type Installer = { userId: string; name: string } | null;

/** A refusal the routes turn into an answer. */
export class PluginError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly extra: Record<string, unknown> = {}) { super(message ?? code); this.name = "PluginError"; }
}

export const PLUGIN_USER_KEY_PREFIX = "plugin:";
/** Is this `users` row a plugin's own (never a member, never told to the directory, never banned)? */
export const isPluginUserKey = (publicKey: string) => publicKey.startsWith(PLUGIN_USER_KEY_PREFIX);

export const STRIKES = 5;
export const STRIKE_WINDOW_MS = 10 * 60_000;
export const STORAGE_KEYS_MAX = 10_000;
export const STORAGE_KEY_MAX = 128;
export const JOBS_MAX = 1000;
export const JOB_PAYLOAD_MAX = 4096;
const JOB_HORIZON_MS = 5 * 365 * 86_400_000;
export const LOG_LINE_MAX = 1000;
export const LOG_KEEP = 2000;
export const LOG_DAYS = 30;
const LOG_PAGE = 100;
export const HISTORY_MAX = 50;
export const MEMBERS_PAGE = 100;
const ANSWER_BUDGET_CHARS = 56 * 1024;
export const MESSAGE_MAX = 4000;
/** Hits per minute and plugin. */
export const RATE = { calls: 300, roles: 60, messages: 20, storageWrites: 120, logLines: 60, net: 30 } as const;
/** `net.get`: the longest address, the time one request may take, the bytes of its answer and the answer as JSON for the sandbox. */
export const NET_URL_MAX = 2000;
export const NET_TIMEOUT_MS = 5000;
export const NET_BODY_MAX = 512 * 1024;
export const NET_ANSWER_MAX_CHARS = 1024 * 1024;
const NET_ACCEPT = "application/json, text/plain;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5";
/** What `net.get` reads: text, JSON and XML (feeds). Anything else is not read at all. */
const NET_TEXT = /^(?:text\/|application\/(?:json|xml|[a-z0-9.-]{1,40}\+(?:json|xml)))/;
const wantsNet = (manifest: { capabilities: readonly string[] }) => manifest.capabilities.includes("net.fetch");

/**
 * What keeps a plugin from being installed or from running because of its signature (pure, tested): a signature Squorli
 * took back stops any plugin; one that asks for the network needs the operator's `PLUGIN_NET` and a valid signature. An
 * unsigned plugin without the network is not concerned.
 */
export function gateCode(manifest: { capabilities: readonly string[] }, status: SignatureCheck["status"], netOn: boolean): keyof typeof GATE_TEXT | null {
  if (status === "revoked") return "plugin_signature_revoked";
  if (!wantsNet(manifest)) return null;
  if (!netOn) return "plugin_net_off";
  return status === "valid" ? null : "plugin_signature_required";
}

/**
 * May `net.get` ask this address (pure, tested; also asked for every redirect)? https on its default port to a host the
 * manifest names, exactly as named. `testOrigin` (LINK_PREVIEW_TEST_ORIGIN, tests only) is one more origin.
 */
export function netAllowed(url: URL, hosts: readonly string[], testOrigin?: string): boolean {
  if (url.username || url.password) return false;
  if (testOrigin !== undefined && url.origin === testOrigin) return true;
  return url.protocol === "https:" && url.port === "" && hosts.includes(url.hostname);
}
export const GATE_TEXT = {
  plugin_signature_revoked: "Squorli took its signature of this plugin version back; it does not run. Install a newer version or remove it.",
  plugin_net_off: "this server lets no plugin fetch from the internet (PLUGIN_NET=false)",
  plugin_signature_required: "a plugin that fetches from the internet needs Squorli's signature (https://squorli.com/en/docs/plugins/#signing); this file carries none this server takes",
} as const;

type Limits = { [K in keyof typeof RATE]: WindowCounter };
type HostHandler = { needs?: readonly PluginCapability[]; run: (row: Row, ctx: InvocationContext, args: Record<string, unknown>) => Promise<unknown> };

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);
const isAdminMask = (mask: number) => (mask & Permission.ADMINISTRATOR) !== 0;
const permissionBit = (name: string): number | null => (Object.prototype.hasOwnProperty.call(Permission, name) ? (Permission as Record<string, number>)[name]! : null);

/** A text a plugin handed over while running: cut, and without control characters or direction marks (the protocol's rule for manifests). */
function textOf(v: unknown, max: number): PluginText | undefined {
  const clean = (x: unknown): string | null => { const t = typeof x === "string" ? cleanPluginText(x).trim().slice(0, max) : ""; return t ? t : null; };
  if (typeof v === "string") { const en = clean(v); return en === null ? undefined : { en }; }
  if (v && typeof v === "object") {
    const o = v as { en?: unknown; de?: unknown };
    const de = clean(o.de);
    const en = clean(o.en) ?? de;
    if (en === null) return undefined;
    return { en, ...(de !== null ? { de } : {}) };
  }
  return undefined;
}

/** What a handler of a member action or a command returned, as the client's `PluginActionResult` (pure, tested). */
export function actionResult(value: unknown): PluginActionResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value === "string") { const message = textOf(value, 500); return { ok: true, ...(message ? { message } : {}) }; }
  if (typeof value !== "object") return { ok: true };
  const v = value as { ok?: unknown; message?: unknown; fieldErrors?: unknown };
  const out: PluginActionResult = { ok: v.ok !== false };
  const message = textOf(v.message, 500);
  if (message) out.message = message;
  if (v.fieldErrors && typeof v.fieldErrors === "object") {
    const errors: Record<string, PluginText> = {};
    for (const [key, text] of Object.entries(v.fieldErrors as Record<string, unknown>).slice(0, 20)) { const t = textOf(text, 200); if (t) errors[key.slice(0, 32)] = t; }
    if (Object.keys(errors).length) { out.fieldErrors = errors; out.ok = false; }
  }
  return out;
}

/**
 * What a plugin answered to `settings.check` (pure, tested): field errors refuse the save, each with the plugin's sentence;
 * values it handed back replace the admin's for the fields that carry no scope, when they pass the same check. Anything
 * else it says is ignored.
 */
export function settingsCheckAnswer(fields: readonly ManifestField[], values: Record<string, unknown>, answer: unknown): { ok: true; values: Record<string, unknown> } | { ok: false; fieldErrors: Record<string, PluginText> } {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { ok: true, values: {} };
  const a = answer as { fieldErrors?: unknown; values?: unknown };
  const errors: Record<string, PluginText> = {};
  if (a.fieldErrors && typeof a.fieldErrors === "object" && !Array.isArray(a.fieldErrors)) {
    for (const [key, text] of Object.entries(a.fieldErrors as Record<string, unknown>).slice(0, 30)) {
      const t = textOf(text, 500);
      if (t && fields.some((f) => f.key === key)) errors[key] = t;
    }
  }
  if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
  if (!a.values || typeof a.values !== "object" || Array.isArray(a.values)) return { ok: true, values: {} };
  const scoped = (type: string) => type === "role" || type === "roles" || type === "channel" || type === "channels" || type === "member";
  const free = fields.filter((f) => !scoped(f.type) && Object.prototype.hasOwnProperty.call(a.values, f.key));
  const checked = checkValues(free, { ...Object.fromEntries(free.map((f) => [f.key, values[f.key]])), ...(a.values as Record<string, unknown>) });
  // A plugin that hands back something its own manifest does not take has a fault; the admin's values stand.
  if (!checked.ok) return { ok: true, values: {} };
  return { ok: true, values: checked.values };
}

/** May a plugin give or take this role right now? (Pure, tested: the scope's snapshot against the role as it is.) */
export function roleInScope(scope: PluginScope, role: { id: string; isDefault: boolean; permissions: number }): "ok" | "not_in_scope" | "default_role" | "administrator" | "role_changed" {
  if (role.isDefault) return "default_role";
  const snapshot = scope.roles[role.id];
  if (snapshot === undefined) return "not_in_scope";
  if (isAdminMask(role.permissions)) return "administrator";
  if ((role.permissions & ~snapshot) !== 0) return "role_changed";
  return "ok";
}

const ROLE_REFUSALS: Record<Exclude<ReturnType<typeof roleInScope>, "ok">, string> = {
  not_in_scope: "this role is not among the roles picked in the plugin's settings",
  default_role: "the default role cannot be given or taken",
  administrator: "a plugin never gives or takes a role with administrator rights",
  role_changed: "this role gained permissions since the plugin's settings were saved; an admin has to save them again",
};

export type PluginsOptions = {
  db: Db; hub: Hub; deps: RoleDeps; config: Config; log: FastifyBaseLogger;
  workerFile: string;
  execArgv?: string[];
  /** The folder with the plugins that ship with the server; null = none. */
  bundledDir: string | null;
  idleMs?: number;
  /** Tests: the keys whose signature counts and the revoked hashes, instead of signingKeys.ts. */
  signingKeys?: readonly SigningKey[];
  revoked?: readonly string[];
};

export class Plugins {
  readonly mode: "operator" | "owner";
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly log: FastifyBaseLogger;
  private readonly config: Config;
  private readonly runner: PluginRunner;
  private readonly scheduler: PluginScheduler;
  private rows = new Map<string, Row>();
  private bundled = new Map<string, Bundled>();
  private readonly strikes = new Map<string, number[]>();
  private readonly limits = new Map<string, Limits>();
  private surfaceCache: PluginSurface | null = null;
  private stopListening: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly host: Record<HostFunction, HostHandler>;
  private readonly keys: readonly SigningKey[];
  private readonly revoked: readonly string[];
  /** Per installed plugin, worked out in `reload`: whose signature its file carries, and what keeps it from running. */
  private signatures = new Map<string, Signed>();
  private gates = new Map<string, Gate>();
  /** The catalogue of signed plugins as it was last fetched (catalog.ts); fetched only when somebody opens it or installs from it. */
  private catalogCache: { at: number; entries: CatalogFileEntry[] } | null = null;
  private catalogBusy: Promise<void> | null = null;
  /** The last try to fetch the list failed: what is served is an older one. */
  private catalogFailed = false;
  /** Set by index.ts once the link previews exist: the messages of a plugin with the network get previews like a member's. */
  schedulePreview: ((messageId: string) => void) | null = null;
  /** Set by index.ts with them: the pictures of a card are fetched by the server and arrive with a `message.update`. */
  fetchCardPictures: ((messageId: string, pictures: CardPictures) => void) | null = null;

  constructor(private readonly opts: PluginsOptions) {
    this.db = opts.db; this.hub = opts.hub; this.log = opts.log; this.config = opts.config;
    this.mode = opts.config.PLUGINS === "operator" ? "operator" : "owner";
    const testKey = opts.config.PLUGIN_TEST_SIGNING_KEY?.split(":");
    this.keys = opts.signingKeys ?? [...PLUGIN_SIGNING_KEYS, ...(testKey ? [{ id: testKey[0]!, publicKey: testKey[1]! }] : [])];
    this.revoked = opts.revoked ?? REVOKED_PLUGIN_HASHES;
    this.runner = new PluginRunner({
      workerFile: opts.workerFile, ...(opts.execArgv ? { execArgv: opts.execArgv } : {}), cpuMs: opts.config.PLUGIN_CPU_MS, memoryMb: opts.config.PLUGIN_MEMORY_MB, ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
      onCall: (id, ctx, fn, args) => this.onCall(id, ctx, fn, args),
      answerMax: (fn) => (fn === "net.get" ? NET_ANSWER_MAX_CHARS : MAX_JSON_CHARS),
      onFailure: (id, kind, message, event) => { void this.onFailure(id, kind, message, event).catch((err) => this.log.warn({ err }, "Plugin: Fehler nicht vermerkt")); },
      onLifecycle: (id, what, detail) => { if (what === "killed") void this.note(id, "error", `stopped by the watchdog${detail ? ` (${detail})` : ""}`); },
    });
    this.scheduler = new PluginScheduler(this.db, (job) => this.deliverJob(job),
      (job, reason) => void this.note(job.pluginId, "error", `the job "${job.name}" failed four times and was dropped: ${reason}`),
      (err) => this.log.warn({ err }, "Plugin: Zeitplan"));
    this.host = this.hostFunctions();
  }

  // ---------- Start and stop ----------

  async init(): Promise<void> {
    await this.loadBundled();
    await this.reload();
    for (const row of this.rows.values()) if (this.runnable(row)) this.runner.load(row.id, row.code, row.manifest.apiVersion);
    for (const row of this.rows.values()) {
      const gate = this.gates.get(row.id);
      if (!gate || !row.enabled) continue;
      await this.note(row.id, "error", `does not run: ${gate.message}`);
      this.log.warn({ plugin: row.id, reason: gate.code }, "Plugin laeuft nicht");
    }
    this.stopListening = serverEvents.listen((e) => this.onServerEvent(e));
    await this.scheduler.start();
    this.sweepTimer = setInterval(() => { void this.sweepLogs().catch((err) => this.log.warn({ err }, "Plugin: Protokoll aufraeumen")); }, 3_600_000);
    this.sweepTimer.unref();
    const running = [...this.rows.values()].filter((r) => this.runnable(r)).map((r) => r.id);
    this.log.info({ mode: this.mode, installed: this.rows.size, enabled: running }, "Plugins bereit");
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopListening?.();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.scheduler.close();
    await this.runner.close();
  }

  private async reload(): Promise<void> {
    this.rows = new Map((await this.db.select().from(plugins).orderBy(asc(plugins.installedAt))).map((r) => [r.id, r]));
    this.signatures = new Map();
    this.gates = new Map();
    for (const row of this.rows.values()) {
      if (!row.signedBy && !wantsNet(row.manifest)) continue;
      const check = this.check(row.source);
      this.signatures.set(row.id, check.status === "valid" ? { key: check.keyId, kind: check.kind } : null);
      const gate = this.gateOf(row.manifest, check);
      if (gate) this.gates.set(row.id, gate);
    }
    this.surfaceCache = null;
  }

  private check(source: string): SignatureCheck { return verifyPluginSignature(source, this.keys, this.revoked); }

  /** What keeps a plugin with this manifest and this signature from running; null = nothing. An unsigned plugin without the network is not concerned. */
  private gateOf(manifest: PluginManifest, check: SignatureCheck): Gate | null {
    const code = gateCode(manifest, check.status, this.config.PLUGIN_NET);
    return code ? { code, message: GATE_TEXT[code] } : null;
  }

  private async loadBundled(): Promise<void> {
    const dir = this.opts.bundledDir;
    if (!dir) return;
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const fileName of names.filter((n) => /\.(ts|js)$/.test(n) && !n.endsWith(".d.ts")).sort()) {
      try {
        const source = await readFile(join(dir, fileName), "utf8");
        const r = readPluginFile(source, fileName);
        if (!r.ok) { this.log.warn({ fileName, reason: r.message }, "Plugin: mitgeliefertes Plugin nicht lesbar"); continue; }
        // One that ships is held to the same rule as an upload: without Squorli's signature it gets no network, so it is not offered.
        const check = this.check(source);
        const gate = check.status === "invalid" ? { code: "plugin_signature_invalid", message: check.reason } : this.gateOf(r.manifest, check);
        if (gate) { if (gate.code !== "plugin_net_off") this.log.warn({ fileName, reason: gate.message }, "Plugin: mitgeliefertes Plugin wird nicht angeboten"); continue; }
        this.bundled.set(r.manifest.id, { id: r.manifest.id, source, fileName, manifest: r.manifest, signature: check.status === "valid" ? { key: check.keyId, kind: check.kind } : null });
      } catch (err) { this.log.warn({ err, fileName }, "Plugin: mitgeliefertes Plugin nicht lesbar"); }
    }
  }

  private runnable(row: Row): boolean { return row.enabled && row.state === "ok" && apiSupported(row.manifest.apiVersion) && !this.gates.has(row.id); }
  private stateOf(row: Row): string {
    if (!apiSupported(row.manifest.apiVersion)) return "incompatible";
    // No state of its own: clients from before know "suspended" and show the reason that comes with it (`lastError`).
    if (row.enabled && this.gates.has(row.id)) return "suspended";
    if (row.state === "suspended" || row.state === "needs_approval") return row.state;
    return row.enabled ? "running" : "disabled";
  }
  private rowOf(id: string): Row {
    const row = this.rows.get(id);
    if (!row) throw new PluginError(404, "unknown_plugin");
    return row;
  }

  // ---------- What every member's client gets ----------

  /** The commands and member actions of the plugins that run (the same for every member; `ServerState.plugins`). */
  surface(): PluginSurface {
    if (this.surfaceCache) return this.surfaceCache;
    const out: PluginSurface = { commands: [], memberActions: [] };
    for (const row of this.rows.values()) {
      if (!this.runnable(row)) continue;
      const m = row.manifest;
      const settings = { fields: m.settings, values: row.settings, scope: { roles: Object.keys(row.scope.roles), channels: row.scope.channels } };
      for (const c of m.commands) out.commands.push({ plugin: m.id, pluginName: m.name, name: c.name, description: c.description, permission: c.permission, input: c.input, ...(c.textHint ? { textHint: c.textHint } : {}), fields: c.fields.map((f) => wireField(f, settings)) });
      for (const a of m.memberActions) out.memberActions.push({ plugin: m.id, pluginName: m.name, id: a.id, label: a.label, permission: a.permission, target: a.target, fields: a.fields.map((f) => wireField(f, settings)), ...(a.submitLabel ? { submitLabel: a.submitLabel } : {}) });
    }
    this.surfaceCache = out;
    return out;
  }

  private broadcastSurface(): void {
    this.surfaceCache = null;
    if (!this.closed) this.hub.broadcast({ type: "structure", plugins: this.surface() });
  }

  // ---------- Verwaltung > Plugins and `squorli plugin` ----------

  private capabilityInfos(manifest: PluginManifest, granted: readonly string[]) {
    return manifest.capabilities.map((id) => ({ id, text: capabilityText(id, manifest), risk: CAPABILITY_INFO[id].risk, granted: granted.includes(id) }));
  }

  private info(row: Row, pendingJobs = 0): PluginInfo {
    const m = row.manifest;
    const gate = row.enabled ? this.gates.get(row.id) : undefined;
    return {
      id: m.id, name: m.name, description: m.description, version: m.version, apiVersion: m.apiVersion, author: m.author ?? null, homepage: m.homepage ?? null,
      language: row.language, sourceHash: row.sourceHash, enabled: row.enabled, state: this.stateOf(row), lastError: gate ? gate.message : row.lastError, lastErrorAt: gate ? null : row.lastErrorAt?.toISOString() ?? null,
      capabilities: this.capabilityInfos(m, row.granted), hasSettings: m.settings.length > 0, views: m.views.map((v) => ({ id: v.id, title: v.title })), commands: m.commands.map((c) => c.name),
      pendingJobs, installedVia: row.installedVia, signature: this.signatures.get(row.id) ?? null, blocked: gate?.code ?? null, installedAt: row.installedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(): Promise<PluginsResponse> {
    const jobs = new Map((await this.db.select({ pluginId: pluginJobs.pluginId, n: count() }).from(pluginJobs).groupBy(pluginJobs.pluginId)).map((r) => [r.pluginId, r.n]));
    const available: PluginAvailable[] = [];
    for (const b of this.bundled.values()) {
      const installed = this.rows.get(b.id);
      if (installed && installed.manifest.version === b.manifest.version) continue;
      available.push({ id: b.id, name: b.manifest.name, description: b.manifest.description, version: b.manifest.version, capabilities: this.capabilityInfos(b.manifest, []), installedVersion: installed?.manifest.version ?? null, signature: b.signature });
    }
    return { plugins: [...this.rows.values()].map((r) => this.info(r, jobs.get(r.id) ?? 0)), available, mode: this.mode, max: this.config.PLUGIN_MAX, catalog: this.config.PLUGIN_CATALOG };
  }

  // ---------- The catalogue of signed plugins (catalog.ts)

  private get testOrigin(): string | undefined {
    return this.config.LINK_PREVIEW_TEST_ORIGIN ? new URL(this.config.LINK_PREVIEW_TEST_ORIGIN).origin : undefined;
  }

  /**
   * The list as GitHub has it, at most `CATALOG_CACHE_MS` old (`refresh`: at most `CATALOG_REFRESH_MIN_MS`). When GitHub
   * does not answer, the last list that could be fetched is served as stale; without one the catalogue is unavailable.
   */
  private async catalogEntries(refresh: boolean): Promise<{ at: number; entries: CatalogFileEntry[]; stale: boolean }> {
    if (!this.config.PLUGIN_CATALOG) throw new PluginError(404, "plugin_catalog_off", "this server offers no plugin catalogue (PLUGIN_CATALOG=false)");
    const testOrigin = this.testOrigin;
    const maxAge = testOrigin ? 0 : refresh ? CATALOG_REFRESH_MIN_MS : CATALOG_CACHE_MS;
    if (!this.catalogCache || Date.now() - this.catalogCache.at >= maxAge) {
      // One fetch at a time: whoever asks meanwhile waits for it.
      this.catalogBusy ??= (async () => {
        const got = await safeGet(catalogAddress(testOrigin), { accept: "application/json, text/plain;q=0.9", maxBytes: () => CATALOG_MAX_BYTES, cut: () => false, testOrigin, allowHost: (url) => catalogAllowed(url, "catalog", testOrigin) });
        let entries: CatalogFileEntry[] | null = null;
        if (got) { try { entries = readCatalog(JSON.parse(got.body.toString("utf8"))); } catch { entries = null; } }
        this.catalogFailed = !entries;
        if (entries) this.catalogCache = { at: Date.now(), entries };
        else this.log.warn({ reached: !!got }, "Plugin-Katalog nicht lesbar");
      })().finally(() => { this.catalogBusy = null; });
      await this.catalogBusy;
    }
    const cache = this.catalogCache;
    if (!cache) throw new PluginError(502, "catalog_unavailable", "the plugin catalogue at GitHub did not answer or could not be read");
    return { ...cache, stale: this.catalogFailed };
  }

  /** Verwaltung > Plugins > Katalog: every signed plugin of the public list, with what this server knows about it. */
  async catalog(refresh: boolean): Promise<PluginCatalogResponse> {
    const { at, entries, stale } = await this.catalogEntries(refresh);
    const known = (id: string): id is PluginCapability => (PLUGIN_CAPABILITIES as readonly string[]).includes(id);
    return {
      fetchedAt: new Date(at).toISOString(), stale,
      plugins: entries.map((e) => {
        const installedVersion = this.rows.get(e.id)?.manifest.version ?? null;
        const manifest = e.hosts.length ? { network: { hosts: e.hosts } } : {};
        return {
          id: e.id, name: e.name, description: e.description, author: e.author, homepage: e.homepage, version: e.version,
          // A capability of a later server has no sentence here: its name, marked, and the entry needs a newer server anyway.
          capabilities: e.capabilities.map((id) => (known(id) ? { id, text: capabilityText(id, manifest), risk: CAPABILITY_INFO[id].risk, granted: false } : { id, text: { en: id }, risk: "high", granted: false })),
          hosts: e.hosts, signature: { key: e.key ?? "", kind: e.kind }, signedAt: e.signedAt ?? null, source: `${CATALOG_REPOSITORY}/tree/main/plugins/${e.id}`,
          installedVersion, status: catalogStatus(e, installedVersion),
        };
      }),
    };
  }

  /**
   * The signed file of a catalogue entry, downloaded from the repository's release. It must be the file the list names (the
   * hash of its content) and carry a signature this server takes, of the kind the list says: a list that was tampered
   * with can then at most offer a file Squorli signed anyway.
   */
  private async fromCatalog(id: string): Promise<{ source: string; fileName: string; entry: CatalogFileEntry }> {
    const entry = (await this.catalogEntries(false)).entries.find((e) => e.id === id);
    if (!entry) throw new PluginError(404, "catalog_unknown", "the catalogue lists no plugin with this id");
    if (entry.apiVersion > PLUGIN_API_VERSION) throw new PluginError(409, "plugin_api_too_new", `the plugin needs interface version ${entry.apiVersion}, this server offers ${PLUGIN_API_VERSION}; update the server`);
    const testOrigin = this.testOrigin;
    const got = await safeGet(releaseAddress(entry, testOrigin), { accept: "*/*", maxBytes: () => PLUGIN_SOURCE_MAX_BYTES + 1024, cut: () => false, timeoutMs: 15_000, testOrigin, allowHost: (url) => catalogAllowed(url, "release", testOrigin) });
    if (!got) throw new PluginError(502, "catalog_unavailable", `the file of ${entry.id} ${entry.version} could not be downloaded from GitHub`);
    const source = got.body.toString("utf8");
    const check = this.check(source);
    if (check.status === "revoked") throw new PluginError(409, "plugin_signature_revoked", GATE_TEXT.plugin_signature_revoked);
    if (check.status !== "valid" || check.kind !== entry.kind || check.hash !== entry.sha256) throw new PluginError(502, "catalog_mismatch", "the downloaded file is not the signed file the catalogue names; nothing was installed");
    return { source, fileName: entry.file, entry };
  }

  /**
   * Install a plugin, or replace the one with the same id. A new plugin is installed switched off: enabling is the step
   * that grants its capabilities. An update keeps the settings that still fit, the storage and the jobs; when the new
   * version asks for more than was granted, the plugin stops until an owner confirms.
   */
  async install(input: { source: string; fileName: string } | { bundled: string } | { catalog: string }, by: Installer, via: "upload" | "cli"): Promise<PluginInfo> {
    let source: string, fileName: string, how: string = via;
    let listed: CatalogFileEntry | null = null;
    if ("bundled" in input) {
      const b = this.bundled.get(input.bundled);
      if (!b) throw new PluginError(404, "unknown_plugin");
      ({ source, fileName } = b);
      how = "bundled";
    } else if ("catalog" in input) {
      ({ source, fileName, entry: listed } = await this.fromCatalog(input.catalog));
      how = "catalog";
    } else ({ source, fileName } = input);
    const read = readPluginFile(source, fileName);
    if (!read.ok) throw new PluginError(read.code === "api_too_new" || read.code === "api_too_old" ? 409 : 400, `plugin_${read.code}`, read.message);
    const { manifest, language } = read;
    if (listed && (manifest.id !== listed.id || manifest.version !== listed.version)) throw new PluginError(502, "catalog_mismatch", "the downloaded file is another plugin or version than the catalogue names; nothing was installed");
    // The signature before anything else of the file is looked at: a file changed after it was signed is refused whatever it asks for.
    const check = this.check(source);
    if (check.status === "invalid") throw new PluginError(400, "plugin_signature_invalid", check.reason);
    const gate = this.gateOf(manifest, check);
    if (gate) throw new PluginError(gate.code === "plugin_signature_required" ? 400 : 409, gate.code, gate.message);
    const signed = check.status === "valid" ? { signedBy: check.keyId, signedKind: check.kind } : { signedBy: null, signedKind: null };
    const signedNote = signed.signedBy ? `, signed by Squorli as ${signed.signedKind} with key ${signed.signedBy}` : "";
    const existing = this.rows.get(manifest.id);
    if (!existing && this.rows.size >= this.config.PLUGIN_MAX) throw new PluginError(409, "too_many_plugins", `this server takes at most ${this.config.PLUGIN_MAX} plugins`);
    const prepared = await this.runner.prepare(source, language);
    if (!prepared.ok) throw new PluginError(400, "plugin_bad_code", prepared.message);
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");

    if (existing) {
      // Settings: what the new manifest still declares and still takes; the scope only shrinks here (nobody checked a rank).
      const kept = checkValues(manifest.settings, existing.settings);
      const settings = kept.ok ? kept.values : Object.fromEntries(Object.entries(existing.settings).filter(([key]) => !(key in kept.errors) && manifest.settings.some((f) => f.key === key)));
      const ids = scopeIds(manifest.settings, settings);
      const scope: PluginScope = { roles: Object.fromEntries(ids.roles.filter((id) => existing.scope.roles[id] !== undefined).map((id) => [id, existing.scope.roles[id]!])), channels: ids.channels.filter((id) => existing.scope.channels.includes(id)) };
      const asksMore = manifest.capabilities.some((c) => !existing.granted.includes(c));
      const state = existing.enabled && asksMore ? "needs_approval" : existing.state === "needs_approval" && !asksMore ? "ok" : existing.state === "suspended" ? "ok" : existing.state;
      this.runner.unload(manifest.id);
      await this.db.update(plugins).set({ manifest, source, code: prepared.code, language, sourceHash, settings, scope, state, lastError: null, lastErrorAt: null, installedVia: how, ...signed, updatedAt: new Date() }).where(eq(plugins.id, manifest.id));
      await this.db.update(users).set({ displayName: manifest.name.en }).where(eq(users.publicKey, PLUGIN_USER_KEY_PREFIX + manifest.id));
      this.strikes.delete(manifest.id);
      await this.reload();
      await this.note(manifest.id, "info", `updated to version ${manifest.version} by ${by?.name ?? "the operator"} (${language}, sha256 ${sourceHash.slice(0, 12)}${signedNote})${state === "needs_approval" ? "; it asks for more than was granted and waits for an owner" : ""}`);
      const row = this.rowOf(manifest.id);
      if (this.runnable(row)) { this.runner.load(row.id, row.code, row.manifest.apiVersion); this.tell(row.id, "enable", { reason: "updated" }); this.scheduler.poke(); }
      this.broadcastSurface();
      return this.info(row);
    }

    const userId = await this.pluginUser(manifest);
    await this.db.insert(plugins).values({ id: manifest.id, manifest, source, code: prepared.code, language, sourceHash, userId, installedBy: by?.userId ?? null, installedByName: by?.name ?? null, installedVia: how, ...signed });
    await this.reload();
    await this.note(manifest.id, "info", `installed version ${manifest.version} by ${by?.name ?? "the operator"} (${language}, sha256 ${sourceHash.slice(0, 12)}${signedNote})`);
    return this.info(this.rowOf(manifest.id));
  }

  /** The `users` row that authors a plugin's messages: one per plugin id, kept when the plugin goes (its messages hang on it). */
  private async pluginUser(manifest: PluginManifest): Promise<string> {
    const publicKey = PLUGIN_USER_KEY_PREFIX + manifest.id;
    const [row] = await this.db.insert(users).values({ publicKey, displayName: manifest.name.en }).onConflictDoUpdate({ target: users.publicKey, set: { displayName: manifest.name.en } }).returning({ id: users.id });
    return row!.id;
  }

  /**
   * Switch a plugin on or off. On: `grant` must be exactly what its manifest asks for (the owner saw that list; "all" = the
   * operator's command, which printed it). Two enabled plugins never share a command name.
   */
  async setEnabled(id: string, enabled: boolean, grant: readonly string[] | "all" | undefined, by: Installer): Promise<PluginInfo> {
    const row = this.rowOf(id);
    if (!enabled) {
      if (this.runner.has(id)) await Promise.race([this.runner.invoke(id, "disable", {}, { event: "disable", depth: 0 }).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      this.runner.unload(id);
      await this.db.update(plugins).set({ enabled: false, state: row.state === "suspended" ? "ok" : row.state, updatedAt: new Date() }).where(eq(plugins.id, id));
      await this.reload();
      await this.note(id, "info", `switched off by ${by?.name ?? "the operator"}`);
      this.broadcastSurface();
      return this.info(this.rowOf(id));
    }
    if (!apiSupported(row.manifest.apiVersion)) throw new PluginError(409, "plugin_incompatible", "this server does not run the interface version the plugin was written for");
    const gate = this.gates.get(id);
    if (gate) throw new PluginError(409, gate.code, gate.message);
    const asked = [...row.manifest.capabilities].sort();
    if (grant !== "all" && (grant === undefined || [...new Set(grant)].sort().join("\n") !== asked.join("\n"))) throw new PluginError(409, "capabilities_changed", undefined, { capabilities: this.capabilityInfos(row.manifest, row.granted) });
    for (const other of this.rows.values()) {
      if (other.id === id || !this.runnable(other)) continue;
      const taken = row.manifest.commands.find((c) => other.manifest.commands.some((o) => o.name === c.name));
      if (taken) throw new PluginError(409, "command_taken", `the command /${taken.name} belongs to the plugin "${other.manifest.name.en}" already`, { command: taken.name, plugin: other.id });
    }
    await this.db.update(plugins).set({ enabled: true, state: "ok", granted: asked, lastError: null, lastErrorAt: null, updatedAt: new Date() }).where(eq(plugins.id, id));
    this.strikes.delete(id);
    await this.reload();
    const fresh = this.rowOf(id);
    this.runner.load(id, fresh.code, fresh.manifest.apiVersion);
    await this.note(id, "info", `switched on by ${by?.name ?? "the operator"}${asked.length ? ` with: ${asked.join(", ")}` : ""}`);
    this.tell(id, "enable", { reason: "enabled" });
    this.scheduler.poke();
    this.broadcastSurface();
    return this.info(fresh);
  }

  /** Remove a plugin: its storage, jobs and log go with it; the roles it gave stay; its messages stay unless asked otherwise. */
  async remove(id: string, removeMessages: boolean, by: Installer): Promise<void> {
    const row = this.rowOf(id);
    if (this.runner.has(id)) await Promise.race([this.runner.invoke(id, "disable", {}, { event: "disable", depth: 0 }).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    this.runner.unload(id);
    if (removeMessages && row.userId) {
      const gone = await this.db.delete(messages).where(eq(messages.authorId, row.userId)).returning({ id: messages.id, channelId: messages.channelId });
      const byChannel = new Map<string, string[]>();
      for (const g of gone) byChannel.set(g.channelId, [...(byChannel.get(g.channelId) ?? []), g.id]);
      for (const [channelId, ids] of byChannel) {
        this.hub.broadcastToChannel(channelId, { type: "message.bulkDelete", channelId, ids });
        serverEvents.emit("message.delete", { channelId, messageIds: ids }, { kind: "system" });
      }
    }
    await this.db.delete(plugins).where(eq(plugins.id, id));
    this.strikes.delete(id);
    this.limits.delete(id);
    await this.reload();
    this.log.info({ plugin: id, by: by?.name ?? "operator", removeMessages }, "Plugin entfernt");
    this.broadcastSurface();
  }

  settingsOf(id: string): PluginSettingsResponse {
    const row = this.rowOf(id);
    return { fields: row.manifest.settings.map((f) => wireField(f)), values: row.settings };
  }

  /**
   * Save a plugin's settings. The values of role and channel fields become the plugin's scope, so this is where the
   * saving admin's rank counts: a role may be added only by somebody who may assign it (position and permissions, as a
   * reaction rule), never one with ADMINISTRATOR; a channel only by somebody who sees it. What was in the scope before
   * may stay, with the mask it was saved with.
   */
  async saveSettings(id: string, given: Record<string, unknown>, saver: MemberContext): Promise<{ ok: true; settings: PluginSettingsResponse } | { ok: false; fieldErrors: Record<string, PluginText> }> {
    const row = this.rowOf(id);
    const fields = row.manifest.settings;
    const checked = checkValues(fields, { ...row.settings, ...given });
    if (!checked.ok) return { ok: false, fieldErrors: Object.fromEntries(Object.entries(checked.errors).map(([k, code]) => [k, fieldErrorText(code)])) };
    const values = checked.values;
    const errors: Record<string, PluginText> = {};
    const scope: PluginScope = { roles: {}, channels: [] };
    const ids = scopeIds(fields, values);
    const roleRows = ids.roles.length ? await this.db.select().from(roles).where(inArray(roles.id, ids.roles)) : [];
    const channelRows = ids.channels.length ? await this.db.select({ id: channels.id, kind: channels.kind }).from(channels).where(inArray(channels.id, ids.channels)) : [];
    await visibility.refresh(this.db);
    const memberIds = new Set((await this.db.select({ userId: members.userId }).from(members)).map((m) => m.userId));
    for (const f of fields) {
      const v = values[f.key];
      const list = Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
      if (f.type === "role" || f.type === "roles") {
        for (const roleId of list) {
          const role = roleRows.find((r) => r.id === roleId);
          const before = row.scope.roles[roleId];
          if (!role) { errors[f.key] = fieldErrorText("unknown"); continue; }
          const mayGrant = !role.isDefault && !isAdminMask(role.permissions) && canTouchRole(saver.actor, role.position) && canGrant(saver.actor, role.permissions);
          if (mayGrant) scope.roles[roleId] = role.permissions;
          else if (before !== undefined && !role.isDefault && !isAdminMask(role.permissions)) scope.roles[roleId] = before;
          else errors[f.key] = fieldErrorText("not_allowed");
        }
      } else if (f.type === "channel" || f.type === "channels") {
        for (const channelId of list) {
          const ch = channelRows.find((c) => c.id === channelId);
          if (!ch) { errors[f.key] = fieldErrorText("unknown"); continue; }
          if (ch.kind !== (f.channelKind ?? "text")) { errors[f.key] = fieldErrorText("invalid"); continue; }
          if (!row.scope.channels.includes(channelId) && !visibility.canSee(saver.userId, channelId)) { errors[f.key] = fieldErrorText("not_allowed"); continue; }
          if (!scope.channels.includes(channelId)) scope.channels.push(channelId);
        }
      } else if (f.type === "member" && typeof v === "string" && !memberIds.has(v)) errors[f.key] = fieldErrorText("unknown");
    }
    if (Object.keys(errors).length) return { ok: false, fieldErrors: errors };
    // The plugin's own word on what is about to be saved (interface version 2, `settings.check`): it may refuse fields with a
    // sentence each, and it may hand values back in another form (a typed name resolved to what it stands for). Only a
    // plugin that runs is asked; what it hands back is checked like what the admin sent, and it never changes a field of
    // its scope (roles, channels, members): the saving admin's rank was checked for those above.
    if (this.runnable(row) && this.runner.has(id)) {
      let answer: unknown;
      try { answer = (await this.runner.invoke(id, "settings.check", { values, by: saver.userId }, { event: "settings.check", depth: 0 })).value; }
      catch (err) {
        if (err instanceof PluginFailure) throw new PluginError(err.kind === "timeout" ? 504 : 502, err.kind === "timeout" ? "plugin_timeout" : "plugin_failed");
        throw err;
      }
      const said = settingsCheckAnswer(fields, values, answer);
      if (!said.ok) return { ok: false, fieldErrors: said.fieldErrors };
      Object.assign(values, said.values);
    }
    await this.db.update(plugins).set({ settings: values, scope, updatedAt: new Date() }).where(eq(plugins.id, id));
    await this.reload();
    await this.note(id, "info", `settings saved by ${displayNameOf(saver)}`);
    if (this.runner.has(id)) this.tell(id, "settings.change", {});
    this.broadcastSurface();
    return { ok: true, settings: this.settingsOf(id) };
  }

  async logOf(id: string, before: number | null): Promise<PluginLogResponse> {
    this.rowOf(id);
    const rows = await this.db.select().from(pluginLog).where(before !== null ? and(eq(pluginLog.pluginId, id), lt(pluginLog.id, before)) : eq(pluginLog.pluginId, id)).orderBy(desc(pluginLog.id)).limit(LOG_PAGE + 1);
    return { entries: rows.slice(0, LOG_PAGE).map((r) => ({ id: r.id, at: r.at.toISOString(), level: r.level, source: r.source, text: r.message })), hasMore: rows.length > LOG_PAGE };
  }

  /** A table the plugin fills (Verwaltung > Plugins): the columns from its manifest, the rows from its `view` handler. */
  async view(id: string, viewId: string): Promise<PluginViewResponse> {
    const row = this.rowOf(id);
    const view = row.manifest.views.find((v) => v.id === viewId);
    if (!view) throw new PluginError(404, "unknown_view");
    const r = await this.call(row, "view", { view: viewId }, { event: "view", depth: 0 });
    const raw = Array.isArray(r.value) ? r.value : Array.isArray((r.value as { rows?: unknown } | undefined)?.rows) ? (r.value as { rows: unknown[] }).rows : [];
    const keys = view.columns.map((c) => c.key);
    const rows = raw.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").slice(0, PLUGIN_VIEW_ROWS_MAX).map((x) => Object.fromEntries(keys.map((k) => [k, x[k] ?? null])));
    return { title: view.title, columns: view.columns, rows, truncated: raw.length > PLUGIN_VIEW_ROWS_MAX };
  }

  // ---------- What members do through a plugin ----------

  /** Run a plugin's handler for a member and answer with its result; refusals of the server are `PluginError`s. */
  private async call(row: Row, event: string, payload: unknown, ctx: InvocationContext) {
    if (!this.runnable(row) || !this.runner.has(row.id)) throw new PluginError(409, "plugin_unavailable");
    try {
      const r = await this.runner.invoke(row.id, event, payload, ctx);
      if (!r.handled) throw new PluginError(502, "plugin_failed", `the plugin does not handle "${event}"`);
      return r;
    } catch (err) {
      if (err instanceof PluginFailure) throw new PluginError(err.kind === "timeout" ? 504 : 502, err.kind === "timeout" ? "plugin_timeout" : "plugin_failed");
      throw err;
    }
  }

  /**
   * The values of a dialog's fields against what the caller may use: a role or channel only from the field's `allowed`
   * list, a role only when the caller could assign it by hand (position and permissions; with a target also the rule of
   * `PUT /api/members/:id/roles`). Without this a plugin's role capability would be a way around the role hierarchy.
   */
  private async checkForm(row: Row, fields: readonly ManifestField[], given: Record<string, unknown>, caller: MemberContext, target: Actor | null): Promise<{ ok: true; values: Record<string, unknown> } | { ok: false; fieldErrors: Record<string, PluginText> }> {
    const checked = checkValues(fields, given);
    if (!checked.ok) return { ok: false, fieldErrors: Object.fromEntries(Object.entries(checked.errors).map(([k, code]) => [k, fieldErrorText(code)])) };
    const values = checked.values;
    const errors: Record<string, PluginText> = {};
    const settings = { fields: row.manifest.settings, values: row.settings, scope: { roles: Object.keys(row.scope.roles), channels: row.scope.channels } };
    const ids = scopeIds(fields, values);
    const roleRows = ids.roles.length ? await this.db.select().from(roles).where(inArray(roles.id, ids.roles)) : [];
    const founderId = ids.roles.length && target ? (await loadSettings(this.db)).ownerId : null;
    if (ids.channels.length) await visibility.refresh(this.db);
    for (const f of fields) {
      const v = values[f.key];
      const list = Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : [];
      const allowed = wireField(f, settings).allowed ?? [];
      if (f.type === "role" || f.type === "roles") {
        for (const roleId of list) {
          const role = roleRows.find((r) => r.id === roleId);
          if (!role) { errors[f.key] = fieldErrorText("unknown"); continue; }
          const ok = allowed.includes(roleId) && roleInScope(row.scope, role) === "ok" && canTouchRole(caller.actor, role.position) && canGrant(caller.actor, role.permissions) && (!target || canSetRolesOf(caller.actor, target, founderId));
          if (!ok) errors[f.key] = fieldErrorText("not_allowed");
        }
      } else if (f.type === "channel" || f.type === "channels") {
        for (const channelId of list) if (!allowed.includes(channelId) || !visibility.canSee(caller.userId, channelId)) errors[f.key] = fieldErrorText("not_allowed");
      } else if (f.type === "member" && typeof v === "string") {
        const [m] = await this.db.select({ userId: members.userId }).from(members).where(eq(members.userId, v)).limit(1);
        if (!m) errors[f.key] = fieldErrorText("unknown");
      }
    }
    return Object.keys(errors).length ? { ok: false, fieldErrors: errors } : { ok: true, values };
  }

  async memberAction(id: string, actionId: string, caller: MemberContext, targetId: string, given: Record<string, unknown>): Promise<PluginActionResult> {
    const row = this.rowOf(id);
    const action = row.manifest.memberActions.find((a) => a.id === actionId);
    if (!action || !this.runnable(row)) throw new PluginError(404, "unknown_action");
    const bit = permissionBit(action.permission);
    if (bit === null || !can(caller.actor, bit)) throw new PluginError(403, "forbidden");
    const target = await actorOf(this.db, targetId);
    if (!target) throw new PluginError(404, "not_found");
    if (action.target === "manageable" && !outranks(caller.actor, target)) throw new PluginError(403, "target_above_you");
    if (action.target === "notSelf" && target.userId === caller.userId) throw new PluginError(400, "self");
    const form = await this.checkForm(row, action.fields, given, caller, target);
    if (!form.ok) return { ok: false, fieldErrors: form.fieldErrors };
    const r = await this.call(row, "memberAction", { action: action.id, userId: target.userId, by: caller.userId, values: form.values }, { event: "memberAction", depth: 0, by: caller.userId });
    return actionResult(r.value);
  }

  /** A slash command, run in a text channel the caller sees. `perms` = the caller's permissions in that channel. */
  async command(caller: MemberContext, channel: { id: string }, perms: number, body: { plugin: string; name: string; text?: string | undefined; values?: Record<string, unknown> | undefined }): Promise<PluginActionResult> {
    const row = this.rows.get(body.plugin);
    const command = row?.manifest.commands.find((c) => c.name === body.name);
    if (!row || !command || !this.runnable(row)) throw new PluginError(404, "unknown_command");
    const bit = permissionBit(command.permission);
    if (bit === null || !hasPermission(perms, bit)) throw new PluginError(403, "forbidden");
    let values: Record<string, unknown> = {};
    if (command.input === "form") {
      const form = await this.checkForm(row, command.fields, body.values ?? {}, caller, null);
      if (!form.ok) return { ok: false, fieldErrors: form.fieldErrors };
      values = form.values;
    }
    const text = command.input === "text" ? (body.text ?? "").trim() : "";
    const ctx: InvocationContext = { event: "command", depth: 0, by: caller.userId, command: command.name, ...(hasPermission(perms, Permission.SEND_MESSAGES) ? { channelId: channel.id } : {}) };
    const r = await this.call(row, "command", { command: command.name, channelId: channel.id, by: caller.userId, text, values }, ctx);
    return actionResult(r.value);
  }

  // ---------- Events ----------

  /** Tell a plugin something nobody waits for; a failure is counted and logged by the runner's hook. */
  private tell(id: string, event: string, payload: unknown, depth = 0): void {
    if (this.closed || !this.runner.has(id) || !this.runner.listens(id, event)) return;
    void this.runner.invoke(id, event, payload, { event, depth }).catch(() => {});
  }

  private onServerEvent(e: { [K in ServerEventName]: ServerEventOf<K> }[ServerEventName]): void {
    // Two plugins answering each other end here; a person's or the server's own doing always starts at 0.
    if (e.depth > MAX_EVENT_DEPTH) return;
    for (const row of this.rows.values()) {
      if (!this.runnable(row)) continue;
      // A plugin never gets what it caused itself.
      if (e.origin.kind === "plugin" && e.origin.pluginId === row.id) continue;
      const payload = this.eventFor(row, e);
      if (payload !== null) this.tell(row.id, e.name, payload, e.depth);
    }
  }

  private eventFor(row: Row, e: { [K in ServerEventName]: ServerEventOf<K> }[ServerEventName]): unknown | null {
    const has = (c: PluginCapability) => row.granted.includes(c);
    const cause = (o: Origin) => ({ origin: o.kind, ...(o.kind === "user" || o.kind === "reaction" ? { by: o.userId } : {}) });
    switch (e.name) {
      case "member.join": return has("members.read") ? e.payload : null;
      case "member.leave": return has("members.read") ? e.payload : null;
      case "member.roles": return has("members.read") ? { ...e.payload, ...cause(e.origin) } : null;
      case "role.delete": return has("members.read") || has("roles.manage") ? e.payload : null;
      case "message.create": case "message.update": {
        const m = e.payload.message;
        if (!has("messages.read") || !row.scope.channels.includes(m.channelId) || m.authorId === row.userId) return null;
        return { message: messageFor(m) };
      }
      case "message.delete": return has("messages.read") && row.scope.channels.includes(e.payload.channelId) ? e.payload : null;
    }
  }

  private async deliverJob(job: DueJob): Promise<void> {
    const r = await this.runner.invoke(job.pluginId, "job", { name: job.name, key: job.key, payload: job.payload ?? null, dueAt: job.dueAt.toISOString(), late: Date.now() - job.dueAt.getTime() > 60_000, attempt: job.attempts }, { event: "job", depth: 0 });
    if (!r.handled) void this.note(job.pluginId, "warn", `the job "${job.name}" was due, but the plugin listens to no "job" event; it was dropped`);
  }

  // ---------- Failures and the log ----------

  private async onFailure(id: string, kind: FailureKind, message: string, event: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || kind === "killed" && this.closed) return;
    const line = `${event}: ${message}`.slice(0, LOG_LINE_MAX);
    await this.note(id, "error", `failed (${kind}) in ${line}`);
    const now = Date.now();
    const recent = [...(this.strikes.get(id) ?? []), now].filter((t) => now - t < STRIKE_WINDOW_MS);
    this.strikes.set(id, recent);
    const suspend = recent.length >= STRIKES && row.state === "ok";
    await this.db.update(plugins).set({ lastError: line, lastErrorAt: new Date(), ...(suspend ? { state: "suspended" } : {}) }).where(eq(plugins.id, id));
    row.lastError = line;
    row.lastErrorAt = new Date();
    if (suspend) {
      row.state = "suspended";
      this.runner.unload(id);
      this.strikes.delete(id);
      await this.note(id, "error", `suspended after ${STRIKES} failures within ${STRIKE_WINDOW_MS / 60_000} minutes; an owner can switch it on again`);
      this.log.warn({ plugin: id }, "Plugin nach wiederholten Fehlern angehalten");
      this.broadcastSurface();
    }
  }

  /**
   * A line of the server's own in a plugin's log. Never throws. What an owner or the operator just did (installed, switched
   * on, saved) awaits it, so the log they read next holds the line; what happens in the background does not wait for it.
   */
  private async note(id: string, level: "info" | "warn" | "error", message: string): Promise<void> {
    await this.db.insert(pluginLog).values({ pluginId: id, level, source: "host", message: message.slice(0, LOG_LINE_MAX) }).catch(() => {});
  }

  private async sweepLogs(): Promise<void> {
    if (this.closed) return;
    await this.db.execute(sql`DELETE FROM plugin_log WHERE at < now() - (${LOG_DAYS} * interval '1 day')`);
    for (const id of this.rows.keys()) {
      await this.db.execute(sql`DELETE FROM plugin_log WHERE plugin_id = ${id} AND id < COALESCE((SELECT id FROM plugin_log WHERE plugin_id = ${id} ORDER BY id DESC OFFSET ${LOG_KEEP} LIMIT 1), 0)`);
    }
  }

  // ---------- The functions a plugin calls ----------

  private limitsOf(id: string): Limits {
    let l = this.limits.get(id);
    if (!l) {
      l = { calls: new WindowCounter(RATE.calls), roles: new WindowCounter(RATE.roles), messages: new WindowCounter(RATE.messages), storageWrites: new WindowCounter(RATE.storageWrites), logLines: new WindowCounter(RATE.logLines), net: new WindowCounter(RATE.net) };
      this.limits.set(id, l);
    }
    return l;
  }
  private take(id: string, what: keyof typeof RATE): void {
    if (!this.limitsOf(id)[what].hit("x").ok) throw new Error(`rate limit: at most ${RATE[what]} of these a minute`);
  }

  private async onCall(id: string, ctx: InvocationContext, fn: string, args: unknown): Promise<unknown> {
    const row = this.rows.get(id);
    if (!row || !this.runnable(row)) throw new Error("the plugin is not running");
    if (!Object.prototype.hasOwnProperty.call(this.host, fn)) throw new Error(`unknown function ${fn}`);
    const handler = this.host[fn as HostFunction];
    if (handler.needs && !handler.needs.some((c) => row.granted.includes(c))) throw new Error(`${fn} needs the capability ${handler.needs.join(" or ")}, which this plugin does not have`);
    if (fn !== "log") this.take(id, "calls");
    return handler.run(row, ctx, args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {});
  }

  private origin(row: Row, ctx: InvocationContext): Origin { return { kind: "plugin", pluginId: row.id, depth: ctx.depth }; }

  private async scopedRole(row: Row, roleId: unknown) {
    const id = uuid(roleId);
    if (!id) throw new Error("roleId is not an id");
    const [role] = await this.db.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!role) throw new Error("no such role");
    const verdict = roleInScope(row.scope, role);
    if (verdict !== "ok") throw new Error(ROLE_REFUSALS[verdict]);
    return role;
  }

  private async nameOf(userId: string): Promise<string> {
    const [u] = await this.db.select(nameColumns).from(users).leftJoin(localAccounts, localJoin).where(eq(users.id, userId)).limit(1);
    return u ? displayNameOf(u) : userId;
  }

  private async changeRole(row: Row, ctx: InvocationContext, args: Record<string, unknown>, give: boolean): Promise<boolean> {
    const userId = uuid(args.userId);
    if (!userId) throw new Error("userId is not an id");
    const role = await this.scopedRole(row, args.roleId);
    const [member] = await this.db.select({ userId: members.userId }).from(members).where(eq(members.userId, userId)).limit(1);
    if (!member) { if (!give) return false; throw new Error("no such member"); }
    this.take(row.id, "roles");
    const changed = await changeMemberRole(this.opts.deps, userId, role.id, give, this.origin(row, ctx));
    if (changed) await this.note(row.id, "info", `${give ? "gave" : "took"} the role "${role.name}" ${give ? "to" : "from"} ${await this.nameOf(userId)}`);
    return changed;
  }

  /** May the plugin write into this channel now: one of its scope, or the channel a member just ran its command in. */
  private async writableChannel(row: Row, ctx: InvocationContext, channelId: unknown): Promise<string> {
    const id = uuid(channelId);
    if (!id) throw new Error("channelId is not an id");
    if (!row.scope.channels.includes(id) && !(ctx.event === "command" && ctx.channelId === id)) throw new Error("this channel is not among the channels picked in the plugin's settings");
    const [ch] = await this.db.select({ id: channels.id, kind: channels.kind }).from(channels).where(eq(channels.id, id)).limit(1);
    if (!ch || ch.kind !== "text") throw new Error("no such text channel");
    return ch.id;
  }

  private async ownMessage(row: Row, messageId: unknown) {
    const id = uuid(messageId);
    if (!id) throw new Error("messageId is not an id");
    const [msg] = await this.db.select().from(messages).where(eq(messages.id, id)).limit(1);
    if (!msg || !row.userId || msg.authorId !== row.userId) throw new Error("a plugin changes only its own messages");
    return msg;
  }

  private async wireMessage(row: typeof messages.$inferSelect): Promise<Message> {
    return (await loadMessages(this.db, [row], false))[0]!;
  }

  private hostFunctions(): Record<HostFunction, HostHandler> {
    const db = this.db;
    const fns: Record<HostFunction, HostHandler> = {
      "roles.list": {
        needs: ["members.read", "roles.manage"],
        run: async (row) => (await db.select().from(roles).orderBy(desc(roles.position), asc(roles.name))).map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position, isDefault: r.isDefault, manageable: roleInScope(row.scope, r) === "ok" })),
      },
      "roles.give": { needs: ["roles.manage"], run: (row, ctx, args) => this.changeRole(row, ctx, args, true) },
      "roles.take": { needs: ["roles.manage"], run: (row, ctx, args) => this.changeRole(row, ctx, args, false) },
      "members.list": {
        needs: ["members.read"],
        run: async (_row, _ctx, args) => {
          const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
          const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(MEMBERS_PAGE, Math.floor(args.limit)) : MEMBERS_PAGE;
          const all = await loadMembers(db, this.hub);
          return { total: all.length, members: all.slice(offset, offset + limit).map(memberFor) };
        },
      },
      "members.get": {
        needs: ["members.read"],
        run: async (_row, _ctx, args) => {
          const id = uuid(args.userId);
          if (!id) throw new Error("userId is not an id");
          const m = (await loadMembers(db, this.hub)).find((x) => x.userId === id);
          return m ? memberFor(m) : null;
        },
      },
      "channels.list": {
        needs: ["messages.read", "messages.write"],
        run: async (row) => (row.scope.channels.length ? await db.select({ id: channels.id, name: channels.name, kind: channels.kind }).from(channels).where(inArray(channels.id, row.scope.channels)).orderBy(asc(channels.position)) : []),
      },
      "messages.history": {
        needs: ["messages.read"],
        run: async (row, _ctx, args) => {
          const channelId = uuid(args.channelId);
          if (!channelId || !row.scope.channels.includes(channelId)) throw new Error("this channel is not among the channels picked in the plugin's settings");
          const before = typeof args.before === "number" && Number.isFinite(args.before) ? args.before : null;
          const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(HISTORY_MAX, Math.floor(args.limit)) : 20;
          const rows = await db.select().from(messages).where(before !== null ? and(eq(messages.channelId, channelId), lt(messages.seq, before)) : eq(messages.channelId, channelId)).orderBy(desc(messages.seq)).limit(limit + 1);
          let hasMore = rows.length > limit;
          // Newest first while cutting to what one answer may carry, oldest first in the answer (as the clients' history).
          const out: ReturnType<typeof messageRowFor>[] = [];
          let size = 0;
          for (const r of rows.slice(0, limit)) {
            const m = messageRowFor(r);
            size += m.content.length + 300;
            if (size > ANSWER_BUDGET_CHARS && out.length) { hasMore = true; break; }
            out.push(m);
          }
          return { messages: out.reverse(), hasMore };
        },
      },
      "messages.send": {
        needs: ["messages.write"],
        run: async (row, ctx, args) => {
          const channelId = await this.writableChannel(row, ctx, args.channelId);
          const content = typeof args.content === "string" ? args.content.trim() : "";
          if (!content || content.length > MESSAGE_MAX) throw new Error(`a message has 1 to ${MESSAGE_MAX} characters`);
          if (!row.userId) throw new Error("the plugin has no author; install it again");
          // A card (interface version 2): the message drawn as a framed box. Its texts are stored with the message, its
          // pictures are addresses the server fetches itself. `content` stays what an app from before cards shows.
          let card: ReturnType<typeof readCard> | null = null;
          if (args.card !== undefined && args.card !== null) {
            if (row.manifest.apiVersion < PLUGIN_CARD_API_VERSION) throw new Error(`a card needs "apiVersion": ${PLUGIN_CARD_API_VERSION} in the manifest`);
            card = readCard(args.card, this.testOrigin);
          }
          this.take(row.id, "messages");
          const plugin = { id: row.id, name: row.manifest.name, ...(ctx.by ? { by: ctx.by } : {}), ...(ctx.command ? { command: ctx.command } : {}), ...(card ? { card: card.card } : {}) };
          const [saved] = await db.insert(messages).values({ channelId, authorId: row.userId, content, plugin }).returning();
          const message = await this.wireMessage(saved!);
          this.hub.broadcastToChannel(channelId, { type: "message.create", message });
          // No link previews for a plugin's message: the lookup would be a way to make the server fetch addresses. A plugin
          // that holds the network (signed by Squorli, confirmed by the owner) may do that anyway, and its news read better with them.
          // A card takes the previews' place: its pictures are fetched instead, under the same condition.
          if (row.granted.includes("net.fetch")) {
            if (!card) this.schedulePreview?.(message.id);
            else if (card.pictures.image || card.pictures.thumbnail) this.fetchCardPictures?.(message.id, card.pictures);
          }
          serverEvents.emit("message.create", { message }, this.origin(row, ctx));
          return { id: message.id, seq: message.seq };
        },
      },
      "messages.edit": {
        needs: ["messages.write"],
        run: async (row, ctx, args) => {
          const msg = await this.ownMessage(row, args.messageId);
          const content = typeof args.content === "string" ? args.content.trim() : "";
          if (!content || content.length > MESSAGE_MAX) throw new Error(`a message has 1 to ${MESSAGE_MAX} characters`);
          this.take(row.id, "messages");
          const [updated] = await db.update(messages).set({ content, editedAt: new Date() }).where(eq(messages.id, msg.id)).returning();
          const message = await this.wireMessage(updated!);
          this.hub.broadcastToChannel(msg.channelId, { type: "message.update", message });
          // A message with a card keeps it through an edit of its text, and gets no previews then either.
          if (row.granted.includes("net.fetch") && !msg.plugin?.card) this.schedulePreview?.(message.id);
          serverEvents.emit("message.update", { message }, this.origin(row, ctx));
          return true;
        },
      },
      "messages.delete": {
        needs: ["messages.write"],
        run: async (row, ctx, args) => {
          const msg = await this.ownMessage(row, args.messageId);
          await db.delete(messages).where(eq(messages.id, msg.id));
          this.hub.broadcastToChannel(msg.channelId, { type: "message.delete", channelId: msg.channelId, id: msg.id });
          serverEvents.emit("message.delete", { channelId: msg.channelId, messageIds: [msg.id] }, this.origin(row, ctx));
          return true;
        },
      },
      "storage.get": {
        run: async (row, _ctx, args) => {
          const key = str(args.key, STORAGE_KEY_MAX);
          if (!key) throw new Error(`a storage key has 1 to ${STORAGE_KEY_MAX} characters`);
          const [r] = await db.select({ value: pluginStorage.value }).from(pluginStorage).where(and(eq(pluginStorage.pluginId, row.id), eq(pluginStorage.key, key))).limit(1);
          return r ? r.value : null;
        },
      },
      "storage.set": {
        run: async (row, _ctx, args) => {
          const key = str(args.key, STORAGE_KEY_MAX);
          if (!key) throw new Error(`a storage key has 1 to ${STORAGE_KEY_MAX} characters`);
          if (args.value === undefined || args.value === null) throw new Error("storage.set needs a value; use storage.delete to remove a key");
          this.take(row.id, "storageWrites");
          const bytes = Buffer.byteLength(JSON.stringify(args.value), "utf8") + Buffer.byteLength(key, "utf8");
          const [used] = await db.select({ bytes: sum(pluginStorage.bytes), keys: count() }).from(pluginStorage).where(eq(pluginStorage.pluginId, row.id));
          const [old] = await db.select({ bytes: pluginStorage.bytes }).from(pluginStorage).where(and(eq(pluginStorage.pluginId, row.id), eq(pluginStorage.key, key))).limit(1);
          if (!old && (used?.keys ?? 0) >= STORAGE_KEYS_MAX) throw new Error(`the storage holds ${STORAGE_KEYS_MAX} keys already`);
          if (Number(used?.bytes ?? 0) - (old?.bytes ?? 0) + bytes > this.config.PLUGIN_STORAGE_MB * 1024 * 1024) throw new Error(`the plugin's storage of ${this.config.PLUGIN_STORAGE_MB} MB is full`);
          await db.insert(pluginStorage).values({ pluginId: row.id, key, value: args.value, bytes }).onConflictDoUpdate({ target: [pluginStorage.pluginId, pluginStorage.key], set: { value: args.value, bytes, updatedAt: new Date() } });
          return true;
        },
      },
      "storage.delete": {
        run: async (row, _ctx, args) => {
          const key = str(args.key, STORAGE_KEY_MAX);
          if (!key) throw new Error(`a storage key has 1 to ${STORAGE_KEY_MAX} characters`);
          this.take(row.id, "storageWrites");
          return (await db.delete(pluginStorage).where(and(eq(pluginStorage.pluginId, row.id), eq(pluginStorage.key, key))).returning({ key: pluginStorage.key })).length > 0;
        },
      },
      "storage.list": {
        run: async (row, _ctx, args) => {
          const prefix = typeof args.prefix === "string" ? args.prefix.slice(0, STORAGE_KEY_MAX) : "";
          const rows = await db.select({ key: pluginStorage.key }).from(pluginStorage)
            .where(prefix ? and(eq(pluginStorage.pluginId, row.id), sql`left(${pluginStorage.key}, ${prefix.length}) = ${prefix}`) : eq(pluginStorage.pluginId, row.id)).orderBy(asc(pluginStorage.key)).limit(1000);
          return rows.map((r) => r.key);
        },
      },
      "schedule.at": {
        run: async (row, _ctx, args) => {
          const when = typeof args.when === "number" && Number.isFinite(args.when) ? args.when : NaN;
          const name = str(args.name, 64);
          if (!name || Number.isNaN(when)) throw new Error("schedule.at(when, name, payload?, { key }?) needs a time and a name of up to 64 characters");
          if (when > Date.now() + JOB_HORIZON_MS) throw new Error("a job lies at most five years ahead");
          const key = args.key === undefined || args.key === null ? null : str(args.key, STORAGE_KEY_MAX);
          if (args.key !== undefined && args.key !== null && !key) throw new Error(`a job key has 1 to ${STORAGE_KEY_MAX} characters`);
          const payload = args.payload === undefined ? null : args.payload;
          if (JSON.stringify(payload).length > JOB_PAYLOAD_MAX) throw new Error(`a job's payload is at most ${JOB_PAYLOAD_MAX / 1024} KB; keep more in storage`);
          const dueAt = new Date(Math.max(when, Date.now()));
          if (key) await db.delete(pluginJobs).where(and(eq(pluginJobs.pluginId, row.id), eq(pluginJobs.key, key)));
          const [n] = await db.select({ n: count() }).from(pluginJobs).where(eq(pluginJobs.pluginId, row.id));
          if ((n?.n ?? 0) >= JOBS_MAX) throw new Error(`${JOBS_MAX} jobs wait already`);
          const [job] = await db.insert(pluginJobs).values({ pluginId: row.id, key, name, payload, dueAt }).returning({ id: pluginJobs.id });
          this.scheduler.poke();
          return { id: job!.id, dueAt: dueAt.toISOString() };
        },
      },
      "schedule.cancel": {
        run: async (row, _ctx, args) => {
          const key = str(args.key, STORAGE_KEY_MAX);
          if (!key) throw new Error("schedule.cancel(key) needs the key the job was scheduled with");
          const gone = await db.delete(pluginJobs).where(and(eq(pluginJobs.pluginId, row.id), eq(pluginJobs.key, key))).returning({ id: pluginJobs.id });
          return gone.length > 0;
        },
      },
      "schedule.list": {
        run: async (row) => (await db.select({ key: pluginJobs.key, name: pluginJobs.name, dueAt: pluginJobs.dueAt }).from(pluginJobs).where(eq(pluginJobs.pluginId, row.id)).orderBy(asc(pluginJobs.dueAt)).limit(500))
          .map((j) => ({ key: j.key, name: j.name, dueAt: j.dueAt.toISOString() })),
      },
      "settings.get": { run: async (row) => row.settings },
      "net.get": {
        needs: ["net.fetch"],
        run: async (row, _ctx, args) => {
          const hosts = row.manifest.network?.hosts ?? [];
          // Tests play the source on one local origin (as the link previews' smoke test does); never set on a real server.
          const testOrigin = this.config.LINK_PREVIEW_TEST_ORIGIN ? new URL(this.config.LINK_PREVIEW_TEST_ORIGIN).origin : undefined;
          const allowed = (url: URL) => netAllowed(url, hosts, testOrigin);
          let url: URL;
          try { url = new URL(typeof args.url === "string" && args.url.length <= NET_URL_MAX ? args.url : ""); } catch { throw new Error(`net.get(url) needs an address of up to ${NET_URL_MAX} characters`); }
          if (!allowed(url)) throw new Error(`net.get: ${url.host || url.protocol} is not among the hosts of the plugin's manifest (https, no port): ${hosts.join(", ")}`);
          this.take(row.id, "net");
          const res = await safeGet(url.href, { accept: NET_ACCEPT, maxBytes: (type) => (NET_TEXT.test(type) ? NET_BODY_MAX : 0), cut: () => false, timeoutMs: NET_TIMEOUT_MS, testOrigin, allowHost: allowed });
          if (!res) throw new Error(`net.get: no usable answer from ${url.host} (not reachable, not status 200, neither text nor JSON nor XML, larger than ${NET_BODY_MAX / 1024} KB, slower than ${NET_TIMEOUT_MS / 1000} s, or sent on to another host)`);
          return { url: res.url, contentType: res.contentType, text: res.body.toString("utf8") };
        },
      },
      "log": {
        run: async (row, _ctx, args) => {
          const level = args.level === "warn" || args.level === "error" ? args.level : "info";
          // Past the limit a line is dropped without an error: a plugin that logs in a loop must not fail because of it.
          if (!this.limitsOf(row.id).logLines.hit("x").ok) return false;
          const text = typeof args.text === "string" ? args.text : "";
          await db.insert(pluginLog).values({ pluginId: row.id, level, source: "plugin", message: text.slice(0, LOG_LINE_MAX) });
          return true;
        },
      },
    };
    // Every name the prelude calls has a handler and the other way round (the registry's type says so; this says it at run time).
    for (const name of HOST_FUNCTIONS) if (!fns[name]) throw new Error(`plugins: no handler for ${name}`);
    return fns;
  }

  /** For Verwaltung > Server > Grenzen. */
  usage(): { mode: string; max: number; installed: number; running: number; memoryMb: number } {
    return { mode: this.mode, max: this.config.PLUGIN_MAX, installed: this.rows.size, running: this.runner.runningCount(), memoryMb: this.config.PLUGIN_MEMORY_MB };
  }

  /** Does this id read as a plugin id at all (the routes' parameter check)? */
  static isId(id: string): boolean { return PLUGIN_ID_PATTERN.test(id); }
}

type MemberRow = Awaited<ReturnType<typeof loadMembers>>[number];
/** A member as a plugin sees one: the name, the roles, since when. No key, no presence, no game. */
function memberFor(m: MemberRow) {
  return { userId: m.userId, displayName: m.displayName, handle: m.handle ? `@${m.handle}` : m.localHandle ? `~${m.localHandle}` : null, roleIds: m.roleIds, joinedAt: m.joinedAt, isOwner: m.isOwner };
}
/** A message as a plugin sees one: the text and who wrote it; attachments only as a number. */
function messageFor(m: Message) {
  return { id: m.id, seq: m.seq, channelId: m.channelId, authorId: m.authorId, content: m.content, createdAt: m.createdAt, editedAt: m.editedAt, attachments: m.attachments.length, plugin: m.plugin?.id ?? null };
}
function messageRowFor(r: typeof messages.$inferSelect) {
  return { id: r.id, seq: r.seq, channelId: r.channelId, authorId: r.authorId, content: r.content, createdAt: r.createdAt.toISOString(), editedAt: r.editedAt?.toISOString() ?? null, attachments: null as number | null, plugin: r.plugin?.id ?? null };
}
