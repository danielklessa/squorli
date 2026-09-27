import { Permission, UpdateSettingsRequest, type StatusApiKeyResponse } from "@squorli/protocol";
import { and, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { requireMember } from "../auth/session";
import { can } from "../authz";
import type { Config } from "../config";
import type { Db } from "../db";
import { channels, roles, serverSettings } from "../db/schema";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import { SETTINGS_ID, broadcastStructure, loadSettings, loadState } from "../state";
import { syncVoiceAccessOf } from "../livekit/sync";
import { visibility } from "../visibility";
import { compact } from "../util";
import type { DirectoryClient } from "../directory";
import type { VoicePresence } from "../voice/presence";
import type { Suspensions } from "../users/suspension";
import { RADIO_OFF } from "./radio";

/** 32 random bytes as base64url (43 characters): fits a query string and a header without escaping. */
function newStatusApiKey(): string { return randomBytes(32).toString("base64url"); }

/** Server icon: raster images only (SVG could contain scripts and would be served same-origin), at most 2 MB. */
const ICON_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const ICON_MAX_BYTES = 2 * 1024 * 1024;

export async function registerSettingsRoutes(app: FastifyInstance, db: Db, hub: Hub, config: Config, directory: DirectoryClient, voice: { presence: VoicePresence; lk: LivekitAdmin; onRadioChange: () => void }, suspensions: Suspensions) {
  /** Directory (M6d): name, listing, description, open join and icon live at the directory; re-register after a change. */
  // Debounced (1.5 s): several changes in quick succession = one registration (the directory's registration limit is 10/min).
  let reregTimer: NodeJS.Timeout | null = null;
  const reregister = () => {
    if (reregTimer) clearTimeout(reregTimer);
    reregTimer = setTimeout(() => { reregTimer = null; void directory.register().catch((err) => app.log.warn({ err }, "Verzeichnis: Neuregistrierung")); }, 1500);
    reregTimer.unref();
  };
  const iconPath = join(config.DATA_DIR, "server-icon");
  await mkdir(config.DATA_DIR, { recursive: true });
  // File gone (DATA_DIR emptied or switched) but an icon is still recorded in the DB: delete the entry, otherwise favicon,
  // sidebar, login and server rail show a broken image. Upload it again under Admin > Server.
  {
    const [row] = await db.select({ iconMime: serverSettings.iconMime }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
    if (row?.iconMime && !existsSync(iconPath)) {
      await db.update(serverSettings).set({ iconMime: null, iconUpdatedAt: null }).where(eq(serverSettings.id, SETTINGS_ID));
      app.log.warn({ iconPath }, "Server-Icon-Datei fehlt, Eintrag entfernt; bitte in der Verwaltung neu hochladen");
    }
  }

  /** Full state over REST (the same as in the WS welcome), e.g. after a reconnect. */
  app.get("/api/state", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    return loadState(db, hub, m.userId);
  });

  app.patch("/api/settings", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const body = UpdateSettingsRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    // Server accounts pinned by configuration or by the missing directory: the admin area may not change it.
    const before = await loadSettings(db);
    if (body.data.localAccounts !== undefined && before.localAccountsLocked) return reply.code(409).send({ error: "locked_by_config" });
    const afkChannelId = body.data.afkChannelId;
    if (afkChannelId) {
      const [ch] = await db.select({ kind: channels.kind, sticky: channels.sticky }).from(channels).where(eq(channels.id, afkChannelId)).limit(1);
      if (ch?.kind !== "voice") return reply.code(400).send({ error: "unknown_channel" });
      // Absent members are pushed there without asking: a sticky one would trap them, a private one is one they may not see.
      if (ch.sticky) return reply.code(409).send({ error: "afk_channel_sticky" });
      if ((await visibility.refresh(db)).privateChannels.has(afkChannelId)) return reply.code(409).send({ error: "afk_channel_private" });
    }
    // The status API's viewpoint: an unknown role would break the foreign key, and null means "the default role".
    if (body.data.statusApiRoleId) {
      const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.id, body.data.statusApiRoleId)).limit(1);
      if (!r) return reply.code(400).send({ error: "unknown_role" });
    }
    // Status API in mode "key" needs a key: made the first time the mode is chosen, kept over later switches (Regenerate = the route below).
    const [keyRow] = body.data.statusApi === "key" ? await db.select({ key: serverSettings.statusApiKey }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1) : [];
    await db.update(serverSettings).set({ ...compact(body.data), ...(keyRow && !keyRow.key ? { statusApiKey: newStatusApiKey() } : {}) }).where(eq(serverSettings.id, SETTINGS_ID));
    if (body.data.statusApi !== undefined && body.data.statusApi !== before.statusApi) req.log.info({ by: m.userId, statusApi: body.data.statusApi }, "Status-API umgestellt");
    const afkChanged = afkChannelId !== undefined && afkChannelId !== (before.afkChannelId ?? null);
    // The new AFK channel loses its radio; LiveKit silences whoever sits in it and gives the old one's members their grants
    // back. Current clients rejoin with a fresh token on the settings change anyway; this holds for all the others.
    if (afkChanged && afkChannelId) {
      const [off] = await db.update(channels).set(RADIO_OFF).where(and(eq(channels.id, afkChannelId), isNotNull(channels.radioStreamUrl))).returning({ id: channels.id });
      if (off) { await broadcastStructure(db, hub, ["channels"]); voice.onRadioChange(); }
      for (const vm of voice.presence.members(afkChannelId)) await voice.lk.silence(afkChannelId, vm.userId);
    }
    if (afkChanged && before.afkChannelId) await syncVoiceAccessOf(db, hub, voice.presence, voice.lk, { channelIds: [before.afkChannelId] });
    // Suspended directory accounts (users/suspension.ts): switched on, the ones this server already knows of are disconnected.
    if (body.data.refuseSuspended !== undefined && body.data.refuseSuspended !== (before.refuseSuspended ?? true)) {
      req.log.info({ by: m.userId, refuseSuspended: body.data.refuseSuspended }, "Umgang mit gesperrten Verzeichniskonten umgestellt");
      if (body.data.refuseSuspended) await suspensions.enforceKnown();
    }
    await broadcastStructure(db, hub, ["settings"]);
    if (body.data.name !== undefined || body.data.listed !== undefined || body.data.description !== undefined || body.data.openJoin !== undefined) reregister();
    return { ok: true };
  });

  // ---- Status API key (Admin > Server, docs/features/status-api.md): never part of ServerSettings, which every member gets.
  app.get("/api/settings/status-api-key", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const [row] = await db.select({ key: serverSettings.statusApiKey }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
    const res: StatusApiKeyResponse = { key: row?.key ?? null };
    return res;
  });

  /** A new key; the old one stops working at once (a leaked key, a widget that should lose access). */
  app.post("/api/settings/status-api-key", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const key = newStatusApiKey();
    await db.update(serverSettings).set({ statusApiKey: key }).where(eq(serverSettings.id, SETTINGS_ID));
    req.log.info({ by: m.userId }, "Status-API-Schlüssel neu erzeugt");
    const res: StatusApiKeyResponse = { key };
    return res;
  });

  // ---- Server icon (Admin > Server): file under DATA_DIR/server-icon, type + timestamp in server_settings.
  // The client shows it in the sidebar and as the favicon; /api/health names the URL even before sign-in.
  app.put("/api/settings/icon", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    const part = await req.file({ limits: { fileSize: ICON_MAX_BYTES } });
    if (!part) return reply.code(400).send({ error: "no_file" });
    if (!ICON_TYPES.has(part.mimetype)) { part.file.resume(); return reply.code(400).send({ error: "bad_type", allowed: [...ICON_TYPES] }); }
    const tmp = `${iconPath}.tmp`;
    try {
      await pipeline(part.file, createWriteStream(tmp));
      if (part.file.truncated) throw new Error("too_large");
    } catch (err) {
      await rm(tmp, { force: true });
      const tooLarge = err instanceof Error && (err.message === "too_large" || (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE");
      return reply.code(tooLarge ? 413 : 500).send({ error: tooLarge ? "too_large" : "upload_failed", maxMb: 2 });
    }
    await rename(tmp, iconPath);
    await db.update(serverSettings).set({ iconMime: part.mimetype, iconUpdatedAt: new Date() }).where(eq(serverSettings.id, SETTINGS_ID));
    await broadcastStructure(db, hub, ["settings"]);
    req.log.info({ by: m.userId, type: part.mimetype }, "Server-Icon gesetzt");
    reregister();
    return { ok: true, iconUrl: (await loadSettings(db)).iconUrl };
  });

  app.delete("/api/settings/icon", async (req, reply) => {
    const m = await requireMember(db, req, reply);
    if (!m) return;
    if (!can(m.actor, Permission.MANAGE_SERVER)) return reply.code(403).send({ error: "forbidden" });
    await rm(iconPath, { force: true });
    await db.update(serverSettings).set({ iconMime: null, iconUpdatedAt: null }).where(eq(serverSettings.id, SETTINGS_ID));
    await broadcastStructure(db, hub, ["settings"]);
    reregister();
    return { ok: true };
  });

  /** Public (favicon, login screen); the URL carries a version parameter, so it is cacheable for a long time. */
  app.get("/api/server-icon", async (_req, reply) => {
    const [row] = await db.select({ iconMime: serverSettings.iconMime }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
    if (!row?.iconMime || !existsSync(iconPath)) return reply.code(404).send({ error: "not_found" });
    return reply
      .type(row.iconMime)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(createReadStream(iconPath));
  });
}
