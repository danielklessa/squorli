import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { DirectoryLeaveRequest, DirectoryNotifyRequest, PROTOCOL_VERSION, RADIO_IDLE_STOP_MS } from "@squorli/protocol";
import { and, eq, isNotNull, sum } from "drizzle-orm";
import Fastify from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { registerAuthRoutes } from "./auth/routes";
import { setSessionPolicy, sweepSessions } from "./auth/session";
import { bootstrap } from "./bootstrap";
import { loadConfig, configWarnings } from "./config";
import { webAppManifest } from "./webManifest";
import { createDb, runMigrations } from "./db";
import { attachments, channels } from "./db/schema";
import { StorageMeter } from "./limits";
import { registerLimitsRoutes } from "./routes/limits";
import { registerReadyRoute } from "./routes/ready";
import { Hub } from "./hub";
import { LivekitAdmin } from "./livekit/admin";
import { registerLivekitRoutes } from "./livekit/routes";
import { registerAttachmentRoutes } from "./routes/attachments";
import { registerChannelRoutes } from "./routes/channels";
import { registerImportRoutes } from "./routes/import";
import { registerInviteRoutes } from "./routes/invites";
import { registerMemberRoutes } from "./routes/members";
import { registerVoteKickRoutes } from "./routes/votekick";
import { registerChannelBlockRoutes } from "./routes/channelBlocks";
import { channelBlockStore, dbBlockStorage } from "./voice/channelBlocks";
import { loadMessages, registerMessageRoutes } from "./routes/messages";
import { registerReactionRoutes } from "./routes/reactions";
import { registerOverwriteRoutes } from "./routes/overwrites";
import { registerPreviewRoutes } from "./routes/previews";
import { LinkPreviews } from "./previews/service";
import { registerReadStateRoutes } from "./routes/readState";
import { RADIO_OFF, registerRadioRoutes } from "./routes/radio";
import { RadioIdleStop } from "./radio/idle";
import { RadioMetadata } from "./radio/metadata";
import { registerRoleRoutes } from "./routes/roles";
import { registerSettingsRoutes } from "./routes/settings";
import { registerStatusRoutes } from "./routes/status";
import { registerDoctorRoutes } from "./routes/doctor";
import { registerReportRoutes } from "./routes/reports";
import { ReportsService } from "./reports";
import { sweepModLog } from "./modLog";
import { Doctor } from "./doctor";
import { deleteUserAccount, type DeleteUserResult } from "./users/deleteUser";
import { Suspensions } from "./users/suspension";
import { registerUserRoutes } from "./users/routes";
import { DirectoryClient, SYNC_INTERVAL_MS, registerStartDelayMs } from "./directory";
import { Devices } from "./users/devices";
import { broadcastStructure, loadChannels, loadSettings, refusesSuspended, setLocalAccountsConfig, setOpenReportCount } from "./state";
import { setPublicOrigin } from "./names";
import { visibility } from "./visibility";
import { AfkMover } from "./voice/afk";
import { moveGrants } from "./voice/confine";
import { VoicePresence } from "./voice/presence";
import { registerWs, WS_MAX_PAYLOAD } from "./ws/handler";
import { registerRateLimits } from "./rateLimits";
import { PAGE_HEADERS } from "./webHeaders";
import { registerHardening } from "./httpHardening";
import { registerBodyHash } from "./auth/bodyHash";
import { logOptions } from "./logRedact";
import { loadLinkSecret } from "./attachmentLinks";
import { installShutdown } from "./shutdown";

const here = dirname(fileURLToPath(import.meta.url));
/** Version from the server's package.json (dev: apps/server, container: /app); the client shows it on the login screen. */
const VERSION = ((): string => {
  try { return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0"; } catch { return "0"; }
})();

/**
 * Load an optional .env next to the package (apps/server/.env), without an extra dependency.
 * Environment variables that are already set take precedence. If the file is missing, nothing happens.
 * In the container the configuration comes exclusively from the environment.
 */
function loadDotEnv() {
  const file = join(here, "..", ".env");
  if (!existsSync(file)) return;
  try { process.loadEnvFile(file); } catch (err) { console.warn(`Konnte ${file} nicht laden:`, err); }
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  for (const w of configWarnings(config)) console.warn(`WARNUNG: ${w}`);
  // Sessions (auth/session.ts): the idle timeout and the host a bound session's proof may name (security audit S10).
  setSessionPolicy({ idleDays: config.SESSION_IDLE_DAYS, domain: config.PUBLIC_DOMAIN });

  const app = Fastify({
    // No line per request and no addresses unless LOG_REQUESTS; query secrets never reach the log (logRedact.ts).
    ...logOptions(config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug"), config.LOG_REQUESTS),
    // In external mode we trust X-Forwarded-* only from the configured proxies.
    // In bundled mode the only proxy is our own Caddy inside the Docker network.
    trustProxy: config.trustedProxies,
  });

  // PostgreSQL's notices as lines of the log, at debug level: the migrator's "already exists, skipping" comes on every start.
  const { db, client } = createDb(config.DATABASE_URL, (notice) => app.log.debug({ code: notice.code, severity: notice.severity }, `PostgreSQL: ${notice.message ?? ""}`), config.DB_POOL_MAX);
  // Migrations folder: in dev relative to src, in the build relative to dist -> both point at ../drizzle
  await runMigrations(db, join(here, "..", "drizzle"));
  // GET /api/ready: 200 only while the database answers (docs/features/limits.md); /api/health stays up without it.
  registerReadyRoute(app, () => client`select 1`);
  // The operator limits (docs/features/limits.md): every file the server keeps for its members against STORAGE_QUOTA_MB.
  const meter = new StorageMeter(config.STORAGE_QUOTA_MB, {
    attachmentsBytes: async () => Number((await db.select({ bytes: sum(attachments.size) }).from(attachments))[0]?.bytes ?? 0),
    dirs: [join(config.DATA_DIR, "previews"), join(config.DATA_DIR, "reports"), join(config.DATA_DIR, "avatars")],
    files: [join(config.DATA_DIR, "server-icon")],
  });
  if (config.STORAGE_QUOTA_MB !== undefined || config.VOICE_SEATS_MAX !== undefined || config.MEMBER_MAX !== undefined) {
    app.log.info({ storageQuotaMb: config.STORAGE_QUOTA_MB ?? null, voiceSeatsMax: config.VOICE_SEATS_MAX ?? null, memberMax: config.MEMBER_MAX ?? null, dbPoolMax: config.DB_POOL_MAX }, "Betreiber-Limits aktiv");
  }

  // CORS for all origins: the web client of another Squorli server talks to this server directly (multi-server client,
  // server rail). Auth runs exclusively through the bearer token in the header (no cookies), and the login signature stays bound to
  // PUBLIC_DOMAIN; so a foreign origin cannot do anything on the user's behalf without holding their token.
  await app.register(cors, { origin: true });
  // HSTS over https, nosniff, and a server error that says nothing of itself (httpHardening.ts).
  registerHardening(app, config.PUBLIC_DOMAIN);
  // Every JSON body's hash for the bound sessions' proofs of version 2 (auth/bodyHash.ts, security audit L-6).
  registerBodyHash(app);
  // While the server closes, the members' connections end one after the other. What reacts to that in the background
  // (member list, AFK move, radio) would ask a database that is closing and log a warning per member. Registered before
  // the WebSocket plugin, whose own hook is the one that ends the connections.
  let closing = false;
  app.addHook("preClose", async () => { closing = true; });
  // No message from a client is anywhere near 64 KiB; the library's default (100 MiB) let a socket without a session make the
  // server parse huge frames before any hello (security audit, 2 October 2026, S6).
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  // Before every route: a refused request costs no database work (docs/features/rate-limits.md).
  const wsLimit = registerRateLimits(app, config.RATE_LIMIT_FACTOR);

  // Directory integration (M6): server key + token; init() after bootstrap (settings), register() after app.listen.
  let directory: DirectoryClient | null = null;
  // Push from the directory after a name change (DirectoryNotifyRequest): reload the user. Set as soon as the reconciliation is running.
  let notifyHandler: ((publicKey: string) => Promise<void>) | null = null;
  app.post("/api/directory/notify", async (req, reply) => {
    const body = DirectoryNotifyRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!notifyHandler) return reply.code(404).send({ error: "no_directory" });
    void notifyHandler(body.data.publicKey).catch((err) => req.log.warn({ err }, "Verzeichnis-Push"));
    return reply.code(204).send();
  });
  // Push from the directory: the user asked (signed, at the directory) to delete their account on this server. The push carries
  // only the key; the server confirms with its own token (the directory answers 200 only for a pending request of this host),
  // so a stranger can at most trigger a check. Handled synchronously: the directory reports `delivered` to the user.
  let leaveHandler: ((publicKey: string) => Promise<DeleteUserResult>) | null = null;
  app.post("/api/directory/leave", async (req, reply) => {
    const body = DirectoryLeaveRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    if (!leaveHandler) return reply.code(404).send({ error: "no_directory" });
    const r = await leaveHandler(body.data.publicKey);
    if (r === "deleted" || r === "not_found") return reply.code(204).send();
    return reply.code(r === "unavailable" ? 502 : 409).send({ error: r });
  });
  // Web app manifest for "add to home screen": the name carries the server's name, so it cannot be a static file (webManifest.ts).
  app.get("/api/manifest.webmanifest", async (_req, reply) => {
    const name = await loadSettings(db).then((st) => st.name).catch(() => null);
    return reply.header("cache-control", "no-cache").type("application/manifest+json; charset=utf-8").send(JSON.stringify(webAppManifest(name)));
  });
  app.get("/api/health", async () => ({
    ok: true,
    proxyMode: config.PROXY_MODE,
    /** Public server key; the directory checks it during server registration (host proof). */
    serverKey: directory?.serverKey ?? null,
    /** Server name and icon for the page title and favicon even before sign-in (both are also visible in the invite preview). */
    /** `inviteRequired`: new members need an invite code (the server is not open), so the login shows the field from the start. No secret: a sign-in without a code answers `invite_required` anyway. */
    /** `localAccounts`: server accounts (`~name`) may be registered here; `requireAccount` is always true since then (every sign-in needs an account). */
    /** `ownerSetup`: no owner yet and OWNER_SETUP_CODE is set, so the registration of a server account asks for that code (local-accounts.md). */
    /** `privacyPolicyUrl`: the server's privacy policy (Verwaltung > Server), linked under the form that creates a server account; null = none. */
    ...(await loadSettings(db).then((st) => ({ serverName: st.name, iconUrl: st.iconUrl, requireAccount: true, inviteRequired: !st.openJoin, localAccounts: st.localAccounts === true, ownerSetup: st.ownerId === null && config.OWNER_SETUP_CODE !== undefined, privacyPolicyUrl: st.privacyPolicyUrl ?? null }))
      .catch(() => ({ serverName: null, iconUrl: null, requireAccount: true, inviteRequired: false, localAccounts: false, ownerSetup: false, privacyPolicyUrl: null }))),
    version: VERSION,
    /** Directory service (M6) that this server recognizes; the client registers handles there. null = none. */
    directoryUrl: config.DIRECTORY_URL ?? null,
    /** Domain that login signatures are bound to; the client compares it against its hostname. */
    domain: config.PUBLIC_DOMAIN,
    /** The claim of a member from before moves to a fresh key (25 September 2026); a client offers the claim only where this is true. */
    localClaimRekey: true,
    /** This server knows devices (docs/features/devices.md): a sign-in may name its device, server accounts have the routes under /api/me/devices. */
    devices: true,
    /** A bound session's proof may sign the body too (version 2, protocol index.ts "Sessions bound to the device"); a client sends it only where this is true. */
    sessionProofV2: true,
    /** A server account's backup may use Argon2id parameters (protocol backup.ts, 5 October 2026); a client makes PBKDF2 backups for a server from before, which would refuse them. */
    backupArgon2: true,
    protocolVersion: PROTOCOL_VERSION,
    time: new Date().toISOString(),
  }));

  setLocalAccountsConfig({ directory: !!config.DIRECTORY_URL, forced: config.LOCAL_ACCOUNTS ?? null });
  setPublicOrigin(config.publicOrigin);
  if (config.REQUIRE_ACCOUNT !== undefined) app.log.warn("REQUIRE_ACCOUNT ist veraltet und wirkungslos: jede Anmeldung braucht seit den Serverkonten ein Konto (Verzeichnis-Handle oder ~Serverkonto)");
  if (config.LOCAL_ACCOUNTS === false && !config.DIRECTORY_URL) app.log.warn("LOCAL_ACCOUNTS=false ohne DIRECTORY_URL wirkungslos: ohne Verzeichnis sind Serverkonten der einzige Weg hinein");
  await bootstrap(db, config, app.log);
  // No owner yet and nothing names one: whoever signs in first with an account becomes the owner (security audit, 2 October 2026,
  // S8). The installer's default is a setup code; this is the way of an installation that chose "whoever signs in first" or
  // that was set up by hand. Said at every start until the owner exists, so the operator signs in before anybody else does.
  const ownerState = await loadSettings(db);
  if (ownerState.ownerId === null && config.OWNER_PUBLIC_KEY === undefined && config.OWNER_SETUP_CODE === undefined) {
    app.log.warn("Noch kein Besitzer, und weder OWNER_PUBLIC_KEY noch OWNER_SETUP_CODE sind gesetzt: wer sich als Erster mit einem Konto anmeldet, wird Besitzer. Melde dich jetzt selbst an, oder setze OWNER_SETUP_CODE (z. B. `openssl rand -hex 12`) und starte neu.");
  }
  await loadLinkSecret(db);
  directory = new DirectoryClient(db, config, app.log);
  await directory.init();
  app.addHook("onClose", async () => directory?.close());

  const hub = new Hub();
  const presence = new VoicePresence<WebSocket>();
  // Channel permissions (docs/features/channel-permissions.md): the visibility snapshot decides who gets which channel
  // and its events; it needs to know who sits where and whom a moderator just moved.
  visibility.setSources({ seatOf: (userId) => presence.channelOfUser(userId), grantOf: (userId) => moveGrants.grantOf(userId) });
  hub.setVisibility((userId, channelId) => visibility.canSee(userId, channelId));
  await visibility.refresh(db);
  // Online and AFK status change everyone's member list.
  hub.onPresence(() => { if (!closing) void broadcastStructure(db, hub, ["members"]).catch((err) => app.log.warn({ err }, "presence broadcast")); });
  const lk = new LivekitAdmin(config, app.log);
  // Suspended directory accounts (users/suspension.ts): whoever is connected when the directory tells of a suspension is
  // disconnected; the sign-in, the requests and the WebSocket refuse by themselves.
  const suspensions = new Suspensions(db, hub, presence, lk, () => refusesSuspended(db), app.log);
  directory.onSuspended = (userId, until) => { void suspensions.enforce(userId, until).catch((err) => app.log.warn({ err }, "Sperre durchsetzen")); };
  // Devices (users/devices.ts, docs/features/devices.md): a session counts only while its device is let in. For directory
  // accounts the directory says which devices those are; when it told, the sessions of the others end. Server accounts'
  // devices that were not used for 90 days are signed out once an hour.
  const devices = new Devices(db, hub, presence, lk, app.log);
  directory.onDevices = (userId) => { void devices.endRefused(userId).catch((err) => app.log.warn({ err }, "Geraete: Sitzungen beenden")); };
  const deviceSweep = setInterval(() => { if (!closing) void devices.sweep().catch((err) => app.log.warn({ err }, "Geraete: Fristen")); }, 3_600_000);
  deviceSweep.unref();
  app.addHook("onClose", async () => clearInterval(deviceSweep));
  void devices.sweep().catch((err) => app.log.warn({ err }, "Geraete: Fristen"));
  // Sessions past their TTL or idle for SESSION_IDLE_DAYS go (auth/session.ts; a lookup refuses them anyway, this keeps the table small).
  const sessionSweep = () => { if (!closing) void sweepSessions(db).then((n) => { if (n) app.log.info({ n }, "Sitzungen: abgelaufene entfernt"); }).catch((err) => app.log.warn({ err }, "Sitzungen: Fristen")); };
  const sessionSweepTimer = setInterval(sessionSweep, 3_600_000);
  sessionSweepTimer.unref();
  app.addHook("onClose", async () => clearInterval(sessionSweepTimer));
  sessionSweep();

  // AFK channel: absent members of a voice channel are moved there (voice/afk.ts), right when they turn absent (below) and
  // every few seconds, because a video that kept its channel's members from being moved ends without any event here.
  const afkMover = new AfkMover();
  const afkSweep = async () => {
    const afk = hub.afkUsers();
    const settings = afk.length ? await loadSettings(db) : null;
    const afkChannelId = settings?.afkChannelId ?? null;
    const exemptChannels = new Set(afkChannelId ? (await loadChannels(db)).filter((c) => c.radio?.twitchChannel || c.radio?.youtubeVideo).map((c) => c.id) : []);
    // Members a sticky channel holds stay (voice/sticky.ts); the move itself is a placement, so the AFK channel takes them whatever their rights there.
    if (afk.length) await visibility.refresh(db);
    const confined = new Set(afk.filter((userId) => visibility.voiceLockOf(userId) !== null));
    const due = afkMover.due({ afkChannelId, afk, channelOf: (userId) => presence.channelOfUser(userId), exemptChannels, confined });
    for (const { userId, from } of due) {
      moveGrants.grant(userId, afkChannelId!);
      hub.sendToUser(userId, { type: "voice.moved", channelId: afkChannelId, by: settings!.name, reason: "afk" });
      app.log.info({ userId, from }, "Mitglied in den AFK-Kanal verschoben");
    }
  };
  const afkTimer = setInterval(() => { void afkSweep().catch((err) => app.log.warn({ err }, "afk sweep")); }, 5_000);
  app.addHook("onClose", async () => clearInterval(afkTimer));
  hub.onPresence(() => { if (!closing) void afkSweep().catch((err) => app.log.warn({ err }, "afk sweep")); }); // right away when somebody turns absent

  // Web radio "now playing": the server reads a station's titles only while somebody sits in a voice channel playing it.
  const radioMeta = new RadioMetadata((channelId, title) => hub.broadcastToChannel(channelId, { type: "radio.meta", channelId, title }), app.log);
  // Nobody left in the channel: its radio goes off after two minutes (setting radioAutoStop). Checked again when the time is up.
  const radioIdle = new RadioIdleStop((channelId) => {
    void (async () => {
      if (presence.members(channelId).length > 0 || !(await loadSettings(db)).radioAutoStop) return;
      const [row] = await db.update(channels).set(RADIO_OFF).where(and(eq(channels.id, channelId), isNotNull(channels.radioStreamUrl))).returning({ id: channels.id });
      if (!row) return;
      app.log.info({ channelId }, "Radio beendet: Kanal leer");
      await broadcastStructure(db, hub, ["channels"]);
      syncRadioMeta();
    })().catch((err) => app.log.warn({ err }, "radio idle stop"));
  }, config.RADIO_IDLE_STOP_MS ?? RADIO_IDLE_STOP_MS);
  const syncRadioMeta = () => {
    if (closing) return;
    void Promise.all([loadChannels(db), loadSettings(db)]).then(([all, settings]) => {
      const playing = all.filter((c) => c.radio);
      radioMeta.sync(playing.flatMap((c) => (!c.radio!.twitchChannel && !c.radio!.youtubeVideo && presence.members(c.id).length > 0 ? [{ channelId: c.id, streamUrl: c.radio!.streamUrl, stationName: c.radio!.name }] : [])));
      radioIdle.sync(settings.radioAutoStop ? playing.filter((c) => presence.members(c.id).length === 0).map((c) => c.id) : []);
    }).catch((err) => app.log.warn({ err }, "radio sync"));
  };
  const offRadioPresence = presence.onChange(syncRadioMeta);
  const radioMetaTimer = setInterval(syncRadioMeta, 30_000); // safety net for changes that pass no hook (a deleted channel, the setting)
  syncRadioMeta(); // a radio left running before a restart
  app.addHook("onClose", async () => { offRadioPresence(); clearInterval(radioMetaTimer); radioMeta.close(); radioIdle.close(); });

  // Uploads (attachments, server icon): one file per request, size per MAX_UPLOAD_MB.
  await app.register(multipart, { limits: { fileSize: Math.round(config.MAX_UPLOAD_MB * 1024 * 1024), files: 1 } });
  await registerAuthRoutes(app, db, config, hub, directory, presence, devices, meter, lk);
  await registerUserRoutes(app, db, directory, hub, presence);
  await registerSettingsRoutes(app, db, hub, config, directory, { presence, lk, onRadioChange: syncRadioMeta }, suspensions, meter);
  await registerLimitsRoutes(app, db, config, meter, presence, lk);
  await registerStatusRoutes(app, db, hub, presence, config);
  // Setup self-diagnosis (docs/features/doctor.md): GET /api/doctor with MANAGE_SERVER or from the machine itself (`squorli doctor`).
  await registerDoctorRoutes(app, db, config, new Doctor(config, directory, lk, VERSION, app.log));
  await registerChannelRoutes(app, db, hub, presence, lk);
  await registerOverwriteRoutes(app, db, hub, presence, lk);
  await registerRoleRoutes(app, db, hub, presence, lk);
  await registerMemberRoutes(app, db, hub, presence, lk);
  await registerVoteKickRoutes(app, db, hub, presence, lk);
  await channelBlockStore.attach(dbBlockStorage(db)); // channel blocks survive a restart (docs/features/channel-blocks.md)
  await registerChannelBlockRoutes(app, db, hub, presence, lk);
  await registerInviteRoutes(app, db);
  await registerImportRoutes(app, db, hub);
  // Link previews: looked up after a message is stored; the result goes out as the message itself, once more. The pages'
  // heads are read in a worker thread whose bundle lies next to this one (dist/preview-worker.js; src/preview-worker.ts under tsx).
  const previews = new LinkPreviews(db, config, app.log, async (row) => {
    const [message] = await loadMessages(db, [row]);
    if (message) hub.broadcastToChannel(message.channelId, { type: "message.update", message });
  }, join(here, import.meta.url.endsWith(".ts") ? "preview-worker.ts" : "preview-worker.js"));
  previews.meter = meter;
  await previews.init();
  app.addHook("onClose", async () => previews.close());
  await registerMessageRoutes(app, db, hub, previews);
  // Reactions and reaction roles (docs/features/reactions.md): routes about one message, same visibility rules as the messages'.
  await registerReactionRoutes(app, db, hub, presence, lk);
  await registerPreviewRoutes(app, previews);
  await registerReadStateRoutes(app, db, hub);
  await registerRadioRoutes(app, db, hub, presence, syncRadioMeta);
  await registerAttachmentRoutes(app, db, config, meter);
  // Reports and the moderation log (docs/features/reports.md): after the attachments (the snapshot copies their files).
  const reportsService = new ReportsService(app, db, hub, config, app.log, meter);
  await reportsService.init();
  setOpenReportCount(() => reportsService.openCount());
  app.addHook("onClose", async () => reportsService.dispose());
  await registerReportRoutes(app, db, hub, reportsService);
  const modLogTimer = setInterval(() => { void sweepModLog(db).catch((err) => app.log.warn({ err }, "mod log sweep")); }, 6 * 60 * 60_000);
  modLogTimer.unref();
  app.addHook("onClose", async () => clearInterval(modLogTimer));
  await registerLivekitRoutes(app, db, config, presence, lk);
  await registerWs(app, db, hub, presence, radioMeta, lk, wsLimit, { voiceSeatsMax: config.VOICE_SEATS_MAX });

  // The built web client is served by the same process (one container less).
  const staticDir = config.STATIC_DIR ?? join(here, "..", "public");
  if (existsSync(join(staticDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: staticDir,
      // wildcard: true (the default) resolves files on every request. With false, one route per existing file would be
      // registered at startup; after `pnpm build` without a restart, new asset hashes would only produce 404s.
      wildcard: true,
      cacheControl: false, // we set cache-control ourselves (see setHeaders)
      // Hashed assets may be cached for a long time, the pages (index.html, player-window.html) never: otherwise, after a
      // deploy, a browser would point at asset names that no longer exist.
      // (@fastify/static 10 hands this callback the Fastify reply; until 2 October 2026, version 8, the raw response.)
      setHeaders: (reply, path) => {
        const page = path.endsWith(".html");
        reply.header("cache-control", page ? "no-cache" : "public, max-age=31536000, immutable");
        if (page) for (const [k, v] of Object.entries(PAGE_HEADERS)) reply.header(k, v);
        else reply.header("x-content-type-options", "nosniff");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "";
      if (path.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      // Missing files (with an extension) get a 404, not the app shell. Otherwise a stale asset link
      // returns text/html and the browser reports "Expected a JavaScript module ... MIME type text/html".
      if (/\.[a-z0-9]{1,8}$/i.test(path)) return reply.code(404).type("text/plain").send("not found");
      return reply.headers(PAGE_HEADERS).header("cache-control", "no-cache").sendFile("index.html");
    });
  } else {
    // Without a built web client only the API runs. Instead of a bare 404 on "/", say what is missing.
    app.log.warn({ staticDir }, "Web-Client nicht gefunden (kein index.html). Nur die API ist erreichbar. " +
      "Abhilfe: `pnpm build` im Repo (kopiert apps/web/dist nach apps/server/public), Docker-Image neu bauen, oder STATIC_DIR setzen.");
    // Bilingual (German/English) by Accept-Language, English by default: the same rule the web client applies.
    const expected = join(staticDir, "index.html");
    const texts = {
      de: [
        "Squorli: API läuft, aber der Web-Client fehlt.",
        `Erwartet wurde ${expected}.`,
        "Abhilfe: im Repo `pnpm build` ausführen (legt apps/server/public an) oder das Docker-Image neu bauen;",
        "alternativ STATIC_DIR auf ein Verzeichnis mit dem gebauten Client zeigen lassen.",
        "Prüfen: GET /api/health",
      ],
      en: [
        "Squorli: the API is running, but the web client is missing.",
        `Expected ${expected}.`,
        "Fix: run `pnpm build` in the repo (creates apps/server/public) or rebuild the Docker image;",
        "alternatively point STATIC_DIR at a directory with the built client.",
        "Check: GET /api/health",
      ],
    };
    app.get("/", async (req, reply) => reply.code(503).type("text/plain; charset=utf-8").send([...texts[preferredLanguage(req.headers["accept-language"])], ""].join("\n")));
  }

  app.addHook("onClose", async () => { await client.end(); });

  // Common mistake: the dev value for LiveKit's client URL on a public server.
  const lkUrl = new URL(config.livekitPublicUrl);
  const lkHost = lkUrl.hostname;
  if (lkUrl.protocol === "wss:" && lkUrl.port && lkUrl.port !== "443") {
    app.log.warn({ livekitPublicUrl: config.livekitPublicUrl },
      "LIVEKIT_PUBLIC_URL nennt einen Port: Clients erwarten LiveKit hinter dem Proxy unter wss://PUBLIC_DOMAIN (Port 443, Pfad /rtc). " +
      "Port 7880 spricht kein TLS und ist von außen nicht erreichbar. Variable entfernen, wenn der Proxy /rtc weiterleitet.");
  }
  if (config.PUBLIC_DOMAIN !== "localhost" && (lkHost === "localhost" || lkHost === "127.0.0.1")) {
    app.log.warn({ livekitPublicUrl: config.livekitPublicUrl, domain: config.PUBLIC_DOMAIN },
      "LIVEKIT_PUBLIC_URL zeigt auf localhost, PUBLIC_DOMAIN aber nicht: fremde Clients können LiveKit so nicht erreichen. " +
      "Variable entfernen (Standard wss://PUBLIC_DOMAIN) oder auf die öffentliche Adresse setzen.");
  }

  await app.listen({ port: config.PORT, host: config.LISTEN_HOST });
  installShutdown(app);
  app.log.info({ proxyMode: config.PROXY_MODE, domain: config.PUBLIC_DOMAIN }, "app-server up");
  if (directory.enabled) {
    // Register, then reconcile all users' names every 5 minutes (changes on the account page arrive without a reload this way).
    // Account deletion requested through the directory: founder check, confirm there (token), then delete locally.
    leaveHandler = async (publicKey) => {
      const r = await deleteUserAccount(app, db, hub, presence, publicKey, () => directory!.confirmLeave(publicKey), lk);
      // "founder" is decided before the directory is asked (so the request stays pending for the user to see). To a push
      // anyone can send it would tell which key founded the server: only when the user's request is really pending
      // (security review, 25 September 2026).
      if (r === "founder" && !(await directory!.pendingLeaves()).includes(publicKey)) return "not_pending";
      return r;
    };
    const sync = async () => {
      for (const key of await directory!.pendingLeaves()) await leaveHandler!(key);
      const changed = await directory!.syncAll((u) => presence.rename(u.userId, { displayName: u.displayName, publicKey: u.publicKey, handle: u.handle }));
      if (changed) await broadcastStructure(db, hub, ["members"]);
    };
    // A random moment first (registerStartDelayMs): many servers starting at once behind one address would otherwise
    // register together and hit the directory's limit; in development at once. A failure tries again by itself (directory.ts).
    const startTimer = setTimeout(() => { void directory!.register().then(() => sync()).catch((err) => app.log.warn({ err }, "Verzeichnis-Abgleich")); },
      registerStartDelayMs(config.PUBLIC_DOMAIN === "localhost" ? 0 : Math.random()));
    startTimer.unref();
    notifyHandler = async (publicKey) => {
      const changed = await directory!.syncOne(publicKey, (u) => presence.rename(u.userId, { displayName: u.displayName, publicKey: u.publicKey, handle: u.handle }));
      if (changed) await broadcastStructure(db, hub, ["members"]);
    };
    const timer = setInterval(() => { void sync().catch((err) => app.log.warn({ err }, "Verzeichnis-Abgleich")); }, SYNC_INTERVAL_MS);
    timer.unref(); // does not keep the process alive (no more hooks are possible after app.listen)
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

/** "de" when German ranks before English in the Accept-Language header (or is the only known language), otherwise "en". */
export function preferredLanguage(header: string | string[] | undefined): "de" | "en" {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  const ranked = raw.split(",").map((part, i) => {
    const [tag = "", ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { lang: tag.trim().toLowerCase().split("-")[0], q: q ? Number(q.slice(2)) || 0 : 1, i };
  }).filter((e) => e.lang === "de" || e.lang === "en").sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked[0]?.lang === "de" ? "de" : "en";
}
