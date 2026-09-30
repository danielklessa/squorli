// Smoke test against a running server on :3000 (pnpm dev or node dist/index.js).
// Covers: auth, owners, invites, structure (categories/channels/roles), permission hierarchy,
// messages with history and attachment, WebSocket (welcome/state, voice, typing), kick, ban, protocol version.
//
// The owner key is remembered in scripts/.smoke-owner.json (gitignored) so the test
// is repeatable against the same database. On the very first run it automatically becomes the owner.
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PROTOCOL_VERSION = 4; // must match packages/protocol
const BASE = process.env.SMOKE_URL ?? "http://localhost:3000";
const OWNER_FILE = join(dirname(fileURLToPath(import.meta.url)), ".smoke-owner.json");
const hex = (b) => Buffer.from(b).toString("hex");
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " " + detail : ""}`); if (!ok) failures++; };
const P = { ADMINISTRATOR: 1, MANAGE_CHANNELS: 4, KICK_MEMBERS: 16, VIEW_CHANNELS: 128, SEND_MESSAGES: 256, MANAGE_MESSAGES: 512, CONNECT_VOICE: 1024, ATTACH_FILES: 2048, STREAM_VIDEO: 4096, MODERATE_VOICE: 8192, VIEW_VIDEO: 16384, CONTROL_RADIO: 32768, MOVE_MEMBERS: 65536, BYPASS_STICKY: 131072, MANAGE_REPORTS: 262144 };

async function api(method, path, body, token, raw = false, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  if (raw) return r;
  return [r.status, await r.json().catch(() => ({}))];
}

async function newKey() {
  const priv = ed.utils.randomPrivateKey();
  return { priv, publicKey: hex(await ed.getPublicKeyAsync(priv)) };
}
// Domain the server binds signatures to (PUBLIC_DOMAIN), taken from /api/health instead of a hardcoded "localhost".
const [, health] = await api("GET", "/api/health");
const DOMAIN = health.domain ?? "localhost";

/** The plain sign-in (challenge + signature); since server accounts a key without an account gets 403 registration_required. */
async function verify(key, invite, userAgent) {
  const [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
  const msg = `community-chat-login\n${DOMAIN}\n${ch.nonce}`;
  const signature = hex(await ed.signAsync(new TextEncoder().encode(msg), key.priv));
  const [status, body] = await api("POST", "/api/auth/verify", { challengeId: ch.challengeId, publicKey: key.publicKey, signature, ...(invite ? { invite } : {}) },
    undefined, false, userAgent ? { "user-agent": userAgent } : {});
  return { status, body, token: body.sessionToken, userId: body.userId };
}
// Server accounts (docs/features/local-accounts.md): the test's backup is no real encryption, the server never opens it anyway.
const localHandleOf = (key) => `s${key.publicKey.slice(0, 12)}`;
const authKeyOf = (key, salt = "") => createHash("sha256").update(`auth:${salt}${key.publicKey}`).digest("hex");
const backupOf = (key, salt = "") => ({ ciphertext: Buffer.from(key.priv).toString("base64"), params: { kdf: "pbkdf2-sha256", iterations: 100_000, salt: "00".repeat(16), iv: "00".repeat(12) }, authKey: authKeyOf(key, salt) });
async function register(key, invite, userAgent, handle = localHandleOf(key)) {
  const [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
  const backup = backupOf(key);
  const msg = `squorli-local-register\n${DOMAIN}\n${ch.nonce}\n${handle}\n${backup.ciphertext}`;
  const signature = hex(await ed.signAsync(new TextEncoder().encode(msg), key.priv));
  const [status, body] = await api("POST", "/api/local/register", { challengeId: ch.challengeId, publicKey: key.publicKey, signature, handle, backup, ...(invite ? { invite } : {}) },
    undefined, false, userAgent ? { "user-agent": userAgent } : {});
  return { status, body, token: body.sessionToken, userId: body.userId };
}
/** Sign in; a key without an account registers a server account first (a new member of this test). */
async function login(key, invite, userAgent) {
  const r = await verify(key, invite, userAgent);
  if (r.status === 403 && r.body.error === "registration_required") return register(key, invite, userAgent);
  return r;
}

// WebSocket client with an event buffer
/**
 * Waits for an event that arrives *after* this call. `waitFor()` also matches what is already in the buffer, so a check
 * that repeats an earlier action (the same member joining the same voice channel a second time) would be served the old
 * event at once — and would then go on before the server has even seen the new one (that raced `voice.status` past the
 * seat on 23 September 2026 and failed three checks that had nothing wrong with them).
 */
const waitNew = (ws, pred, ms) => { const mark = ws.events.length; return ws.waitFor((e) => pred(e) && ws.events.indexOf(e) >= mark, ms); };

async function connectWs(token) {
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/ws");
  const events = [];
  const waiters = [];
  ws.on("message", (m) => { const e = JSON.parse(m.toString()); events.push(e); for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); } });
  await new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms = 4000) => new Promise((resolve, reject) => {
    const hit = events.find(pred); if (hit) return resolve(hit);
    const w = { pred, resolve }; waiters.push(w);
    // Only a waiter that is still waiting times out: for one already served indexOf is -1, and splice(-1) would remove somebody else's.
    setTimeout(() => { const i = waiters.indexOf(w); if (i < 0) return; waiters.splice(i, 1); reject(new Error("timeout waiting for event")); }, ms);
  });
  let isClosed = false, closeCode = null;
  ws.on("close", (code) => { isClosed = true; closeCode = code; });
  const send = (e) => ws.send(JSON.stringify(e));
  const close = () => new Promise((r) => { if (isClosed) return r(); ws.once("close", r); ws.close(); });
  /** Waits for the close and returns the close code (null on timeout). */
  const closed = (ms = 4000) => new Promise((r) => { if (isClosed) return r(closeCode); ws.once("close", (code) => r(code)); setTimeout(() => r(null), ms); });
  send({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionToken: token });
  const welcome = await waitFor((e) => e.type === "welcome" || e.type === "error");
  return { ws, events, waitFor, send, close, closed, welcome };
}

// ---------- Owner
let ownerKey;
if (existsSync(OWNER_FILE)) {
  const j = JSON.parse(readFileSync(OWNER_FILE, "utf8"));
  ownerKey = { priv: Uint8Array.from(Buffer.from(j.priv, "hex")), publicKey: j.publicKey };
} else {
  ownerKey = await newKey();
  writeFileSync(OWNER_FILE, JSON.stringify({ priv: hex(ownerKey.priv), publicKey: ownerKey.publicKey }));
}
// Directory service (M6): if the server names one, give the owner key a handle there (201, or 409 if it already exists).
{
  const [, h] = await api("GET", "/api/health");
  // This test registers accounts at the server's directory. Never at a real one: a test server started next to a `.env`
  // with a production DIRECTORY_URL inherits it (happened on 17 September 2026). Start it with `DIRECTORY_URL=` instead.
  if (h.directoryUrl && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(h.directoryUrl) && process.env.SMOKE_ALLOW_REMOTE_DIRECTORY !== "1") {
    console.error(`FAIL Der Server nennt das Verzeichnis ${h.directoryUrl}: der Rauchtest legt dort Konten an und laeuft deshalb nur gegen ein lokales Verzeichnis. Server mit DIRECTORY_URL= (leer) oder einem lokalen Verzeichnis starten; bewusst trotzdem: SMOKE_ALLOW_REMOTE_DIRECTORY=1.`);
    process.exit(1);
  }
  if (h.directoryUrl) {
    const dir = h.directoryUrl;
    const dj = async (method, path, body) => { const r = await fetch(dir + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json().catch(() => ({}))]; };
    const [, dh] = await dj("GET", "/api/health");
    const [, ch] = await dj("POST", "/api/challenge", { publicKey: ownerKey.publicKey });
    const handle = `smokeowner_${ownerKey.publicKey.slice(0, 6)}`;
    const sig = Buffer.from(await ed.signAsync(new TextEncoder().encode(`community-directory-register
${dh.host}
${handle}
${ch.nonce}`), ownerKey.priv)).toString("hex");
    const [sr, rr] = await dj("POST", "/api/register", { handle, publicKey: ownerKey.publicKey, challengeId: ch.challengeId, signature: sig });
    check("directory: owner handle registered or already present", sr === 201 || (sr === 409 && rr.error === "key_registered"), `${sr} ${rr.handle ?? handle}`);
  }
}

const owner = await login(ownerKey);
if (owner.status !== 200) {
  console.error(`FAIL Eigentuemer-Login: ${owner.status} ${JSON.stringify(owner.body)}. Wenn ${OWNER_FILE} fehlt und der Server schon einen Eigentuemer hat, Datei aus dem echten Eigentuemer-Schluessel anlegen oder DB zuruecksetzen.`);
  process.exitCode = 1;
  throw new Error("abgebrochen");
}
// With a directory the other keys of this test register server accounts, which are off there by default.
if (health.directoryUrl) await api("PATCH", "/api/settings", { localAccounts: true }, owner.token);
const [, ownerState] = await api("GET", "/api/state", undefined, owner.token);
check("owner login + state", ownerState.settings?.ownerId === owner.userId && (ownerState.myPermissions & P.ADMINISTRATOR) !== 0, `owner ${owner.userId.slice(0, 8)}`);
const [, health0] = await api("GET", "/api/health");
check("health names directory (null or url)", "directoryUrl" in health0 && ("handle" in ownerState.members.find((m) => m.userId === owner.userId)), `directory ${health0.directoryUrl ?? "keins"}`);
// With a directory service (M6): the owner's handle was looked up at sign-in (registered further above).
if (health0.directoryUrl) check("owner handle resolved via directory", typeof ownerState.members.find((m) => m.userId === owner.userId)?.handle === "string", ownerState.members.find((m) => m.userId === owner.userId)?.handle);
check("health publishes serverKey (directory registration)", /^[0-9a-f]{64}$/.test(health0.serverKey ?? ""));
// Display name from the directory: the server is registered there (token) and adopts the global/per-server name at sign-in; without an entry the local one stays.
if (health0.directoryUrl) {
  const dir = health0.directoryUrl;
  const dj = async (method, path, body) => { const r = await fetch(dir + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json().catch(() => ({}))]; };
  const [, dh] = await dj("GET", "/api/health");
  const setName = async (server, displayName) => {
    const [, ch] = await dj("POST", "/api/challenge", { publicKey: ownerKey.publicKey });
    const msg = `community-directory-profile-update\n${dh.host}\n${ch.nonce}\n${server ?? ""}\n${displayName ?? ""}`;
    const signature = Buffer.from(await ed.signAsync(new TextEncoder().encode(msg), ownerKey.priv)).toString("hex");
    return dj("POST", "/api/profile", { publicKey: ownerKey.publicKey, challengeId: ch.challengeId, signature, server, displayName });
  };
  const nameAfterLogin = async () => { const o = await login(ownerKey); const [, st] = await api("GET", "/api/state", undefined, o.token); return st.members.find((m) => m.userId === owner.userId)?.displayName; };
  const [sg] = await setName(null, "Smoke Global");
  check("directory: global display name applied at login", sg === 200 && (await nameAfterLogin()) === "Smoke Global");
  const [ss] = await setName(health0.domain.toLowerCase(), "Smoke Hier");
  check("directory: server display name wins at login", ss === 200 && (await nameAfterLogin()) === "Smoke Hier");
  const [spush] = await setName(health0.domain.toLowerCase(), "Smoke Push");
  await new Promise((r) => setTimeout(r, 800));
  const [, stPush] = await api("GET", "/api/state", undefined, owner.token);
  check("directory: name change is pushed to the server without a new login", spush === 200 && stPush.members.find((m) => m.userId === owner.userId)?.displayName === "Smoke Push", stPush.members.find((m) => m.userId === owner.userId)?.displayName);
  // Avatar of the directory account (signed avatar-set there, payload "<mime>\n<sha256>"): the directory pushes the change like a
  // name change, the member then carries the address of the image at the directory (with its cache version); removed -> null again.
  if (dh.features?.avatars) {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const setAvatar = async (bytes) => {
      const [, ch] = await dj("POST", "/api/challenge", { publicKey: ownerKey.publicKey });
      const payload = bytes ? `image/png\n${createHash("sha256").update(bytes).digest("hex")}` : "";
      const signature = Buffer.from(await ed.signAsync(new TextEncoder().encode(`community-directory-avatar-set\n${dh.host}\n${ch.nonce}\n${payload}`), ownerKey.priv)).toString("hex");
      return dj("POST", "/api/avatar", { publicKey: ownerKey.publicKey, challengeId: ch.challengeId, signature, avatar: bytes ? { mime: "image/png", data: bytes.toString("base64") } : null });
    };
    const avatarOfOwner = async () => { const [, st] = await api("GET", "/api/state", undefined, owner.token); return st.members.find((m) => m.userId === owner.userId)?.avatarUrl; };
    check("directory: no avatar -> member.avatarUrl null", (await avatarOfOwner()) === null);
    const [sav, rav] = await setAvatar(png);
    await new Promise((r) => setTimeout(r, 800));
    const url = await avatarOfOwner();
    const expected = `${dir}/api/avatars/${ownerKey.publicKey}?v=${Date.parse(rav.avatarUpdatedAt)}`;
    check("directory: avatar change is pushed, member carries its address", sav === 200 && url === expected, `${sav} ${url}`);
    const img = url ? await fetch(url) : null;
    check("directory: the address serves the image", img?.status === 200 && img.headers.get("content-type") === "image/png" && Buffer.from(await img.arrayBuffer()).equals(png));
    const [, meAv] = await api("GET", "/api/me", undefined, owner.token);
    check("directory: /api/me carries the avatar", meAv.avatarUrl === expected, meAv.avatarUrl);
    const [srm] = await setAvatar(null);
    await new Promise((r) => setTimeout(r, 800));
    check("directory: avatar removed -> null again", srm === 200 && (await avatarOfOwner()) === null);
  }
  await setName(health0.domain.toLowerCase(), null);
  await setName(null, null);
  await new Promise((r) => setTimeout(r, 800)); // wait for the pushes before clearing the local name
  await api("PATCH", "/api/me", { displayName: null }, owner.token);
  const handleName = ownerState.members.find((m) => m.userId === owner.userId)?.handle;
  check("directory: names cleared -> local null stays, handle shown", (await nameAfterLogin()) === `@${handleName}`);
}
check("bootstrap created channels", ownerState.channels?.some((c) => c.kind === "text") && ownerState.channels?.some((c) => c.kind === "voice"));
const defaultRole = ownerState.roles.find((r) => r.isDefault);
check("default role exists", !!defaultRole);
check("default role = Gast: nur sehen + Sprache", defaultRole?.name === "Gast" && defaultRole.permissions === (P.VIEW_CHANNELS | P.CONNECT_VOICE));
const memberRole = ownerState.roles.find((r) => r.name === "Mitglied" && !r.isDefault);
check("role Mitglied exists", !!memberRole && (memberRole.permissions & P.SEND_MESSAGES) !== 0 && (memberRole.permissions & P.STREAM_VIDEO) !== 0 && (memberRole.permissions & P.VIEW_VIDEO) !== 0);

// server not open (default) so the invite logic applies
await api("PATCH", "/api/settings", { openJoin: false, name: "Rauchtest-Server" }, owner.token);
const [, s2] = await api("GET", "/api/state", undefined, owner.token);
check("settings patch", s2.settings.name === "Rauchtest-Server" && s2.settings.openJoin === false);
// /api/health tells the login whether new members need an invite, so it can show the code field from the start
await api("PATCH", "/api/settings", { openJoin: true }, owner.token);
const [, hOpen] = await api("GET", "/api/health");
await api("PATCH", "/api/settings", { openJoin: false }, owner.token);
const [, hClosed] = await api("GET", "/api/health");
check("health inviteRequired follows openJoin", hOpen.inviteRequired === false && hClosed.inviteRequired === true);

// ---------- Structure
const [sc, cat] = await api("POST", "/api/categories", { name: "Smoke" }, owner.token);
const [st, textCh] = await api("POST", "/api/channels", { kind: "text", name: "smoke-text", categoryId: cat.id }, owner.token);
const [sv, voiceCh] = await api("POST", "/api/channels", { kind: "voice", name: "smoke-voice", categoryId: cat.id, audioBitrate: 96, audioStereo: true }, owner.token);
check("voice channel audio profile", voiceCh?.audioBitrate === 96 && voiceCh?.audioStereo === true);
const [sva] = await api("PATCH", `/api/channels/${voiceCh.id}`, { audioBitrate: 48, audioStereo: false }, owner.token);
const [, stAudio] = await api("GET", "/api/state", undefined, owner.token);
const chAudio = stAudio.channels.find((c) => c.id === voiceCh.id);
check("voice channel audio profile update", sva === 200 && chAudio?.audioBitrate === 48 && chAudio?.audioStereo === false);
const [svBad] = await api("PATCH", `/api/channels/${voiceCh.id}`, { audioBitrate: 9999 }, owner.token);
check("audio bitrate validated", svBad === 400);
check("create category + channels", sc === 200 && st === 200 && sv === 200);
const [sr, modRole] = await api("POST", "/api/roles", { name: "Smoke-Mod", permissions: P.KICK_MEMBERS | P.MANAGE_MESSAGES, color: "#3498db" }, owner.token);
check("create role", sr === 200 && modRole.position === 1);

// ---------- Import of a Discord template (routes/import.ts, docs/features/import.md). The preview of a real, public
// template of Discord's needs the internet; when Discord does not answer (502/429) those checks are skipped, not failed.
// SMOKE_TEMPLATE = another template link to run them against.
const [, stImp0] = await api("GET", "/api/state", undefined, owner.token);
check("import: the state names the source", Array.isArray(stImp0.importSources) && stImp0.importSources.includes("discord-template"));
const [sImpBad, impBad] = await api("POST", "/api/import/discord/preview", { code: "https://discord.gg/nope" }, owner.token);
check("import: a link that is no template link -> 400 bad_code", sImpBad === 400 && impBad.error === "bad_code", `${sImpBad} ${impBad.error ?? ""}`);
const TEMPLATE = process.env.SMOKE_TEMPLATE ?? "https://discord.new/JfppTU3CNvuD";
const [sImpPrev, plan] = await api("POST", "/api/import/discord/preview", { code: TEMPLATE }, owner.token);
if (sImpPrev === 502 || sImpPrev === 429) console.log(`skip import: Discord answered ${sImpPrev} (${plan.error ?? ""})`);
else {
  const [sUnknown, unknown] = await api("POST", "/api/import/discord/preview", { code: "https://discord.new/nopenopenope" }, owner.token);
  check("import: an unknown template -> 404 unknown_template", sUnknown === 404 && unknown.error === "unknown_template", `${sUnknown} ${unknown.error ?? ""}`);
  check("import: preview of a real template", sImpPrev === 200 && plan.categories?.length > 0 && plan.channels?.length > 0 && plan.roles?.length > 0
    && plan.dropped?.some((d) => d.reason === "default_role"), `${sImpPrev} ${plan.categories?.length} categories ${plan.channels?.length} channels ${plan.roles?.length} roles`);
  const cat0 = plan.categories[0];
  const chans0 = plan.channels.filter((c) => c.categoryKey === cat0.key && !c.exists);
  const roles0 = plan.roles.filter((r) => !r.exists && !r.blocked).slice(0, 2);
  const pick = { code: TEMPLATE, categories: [cat0.key], channels: chans0.map((c) => c.key), roles: roles0.map((r) => r.key) };
  const [sImp, imp] = await api("POST", "/api/import/discord", pick, owner.token);
  const [, stImp] = await api("GET", "/api/state", undefined, owner.token);
  const impCat = stImp.categories.find((c) => c.name === cat0.name);
  check("import: creates the chosen category, its channels and roles", sImp === 200 && imp.categories === 1 && imp.channels === chans0.length && imp.roles === roles0.length && !!impCat
    && chans0.every((c) => stImp.channels.some((x) => x.name === c.name && x.kind === c.kind && x.categoryId === impCat?.id && x.topic === c.topic && x.audioBitrate === c.audioBitrate))
    && roles0.every((r) => stImp.roles.some((x) => x.name === r.name && x.permissions === r.permissions && x.color === r.color)), `${sImp} ${JSON.stringify(imp)}`);
  const newPositions = roles0.map((r) => stImp.roles.find((x) => x.name === r.name)?.position);
  check("import: new roles sit below the existing ones, in the template's order", stImp.roles.find((r) => r.id === modRole.id)?.position === 1 + roles0.length
    && newPositions.every((p) => p >= 1 && p <= roles0.length) && newPositions[0] > newPositions[1], `mod ${stImp.roles.find((r) => r.id === modRole.id)?.position} new ${newPositions.join(",")}`);
  const [, plan2] = await api("POST", "/api/import/discord/preview", { code: TEMPLATE }, owner.token);
  check("import: a second preview marks what exists now", plan2.categories.find((c) => c.key === cat0.key)?.existingId === impCat?.id
    && chans0.every((c) => plan2.channels.find((x) => x.key === c.key)?.exists === true) && roles0.every((r) => plan2.roles.find((x) => x.key === r.key)?.exists === true));
  const [sImp2, imp2] = await api("POST", "/api/import/discord", pick, owner.token);
  check("import: the same import again creates nothing", sImp2 === 200 && imp2.categories === 0 && imp2.channels === 0 && imp2.roles === 0, `${sImp2} ${JSON.stringify(imp2)}`);
  for (const c of stImp.channels.filter((x) => x.categoryId === impCat?.id)) await api("DELETE", `/api/channels/${c.id}`, undefined, owner.token);
  if (impCat) await api("DELETE", `/api/categories/${impCat.id}`, undefined, owner.token);
  for (const r of roles0) { const x = stImp.roles.find((y) => y.name === r.name); if (x) await api("DELETE", `/api/roles/${x.id}`, undefined, owner.token); }
  const [, stImpClean] = await api("GET", "/api/state", undefined, owner.token);
  check("import: cleaned up", !stImpClean.categories.some((c) => c.name === cat0.name) && !roles0.some((r) => stImpClean.roles.some((x) => x.name === r.name)));
}

// ---------- Invites
const [si, invite] = await api("POST", "/api/invites", { maxUses: 2 }, owner.token);
check("create invite", si === 200 && /^[A-Za-z0-9_-]{6,32}$/.test(invite.code));
const [sp, preview] = await api("GET", `/api/invites/${invite.code}`);
check("invite preview (public)", sp === 200 && preview.valid === true && preview.serverName === "Rauchtest-Server");

const keyB = await newKey();
const noInvite = await login(keyB);
check("join without invite rejected", noInvite.status === 403 && noInvite.body.error === "invite_required");
const badInvite = await login(keyB, "nope-nope-nope");
check("bad invite rejected", badInvite.status === 403 && badInvite.body.error === "invite_invalid");
const B = await login(keyB, invite.code);
check("join with invite", B.status === 200);
const B2 = await login(keyB); // Member: no longer needs an invite
check("member re-login without invite", B2.status === 200);
const [sImpB] = await api("POST", "/api/import/discord/preview", { code: "https://discord.new/abc" }, B.token);
check("import: needs the rights to manage channels and roles", sImpB === 403, `${sImpB}`);

// ---------- Server accounts (docs/features/local-accounts.md): no temporary users; `~name` with an encrypted key backup.
const [, hra] = await api("GET", "/api/health");
const [, stLa] = await api("GET", "/api/state", undefined, owner.token);
check("server accounts: on in health and state, requireAccount true for old clients, version present", hra.localAccounts === true && hra.requireAccount === true
  && stLa.settings.localAccounts === true && stLa.settings.localAccountsLocked === !hra.directoryUrl && typeof hra.version === "string" && hra.version.length > 0);
if (!hra.directoryUrl) {
  const [sLock, lock] = await api("PATCH", "/api/settings", { localAccounts: false }, owner.token);
  check("server accounts: cannot be switched off without a directory", sLock === 409 && lock.error === "locked_by_config", `${sLock} ${lock.error ?? ""}`);
  const [sOwnAv, ownAv] = await api("PUT", "/api/me/avatar", { mime: "image/png", data: Buffer.from("89504e470d0a1a0a0000", "hex").toString("base64") }, owner.token);
  check("server accounts: the owner registered a server account (no directory) and may set an avatar", sOwnAv === 200, `${sOwnAv} ${ownAv.error ?? ""}`);
  await api("DELETE", "/api/me/avatar", undefined, owner.token);
  const [sFounder, founder] = await api("DELETE", "/api/me", { authKey: authKeyOf(ownerKey) }, owner.token);
  check("server accounts: the first owner cannot delete their account", sFounder === 409 && founder.error === "founder", `${sFounder} ${founder.error ?? ""}`);
} else {
  const [sOwnAv, ownAv] = await api("PUT", "/api/me/avatar", { mime: "image/png", data: Buffer.from("89504e470d0a1a0a0000", "hex").toString("base64") }, owner.token);
  check("server accounts: a directory account sets its avatar at the directory", sOwnAv === 409 && ownAv.error === "use_directory");
  await api("PATCH", "/api/settings", { localAccounts: false }, owner.token);
  const off = await register(await newKey(), undefined, undefined, `off.${Date.now().toString(36)}`);
  check("server accounts: switched off -> 403 local_accounts_off", off.status === 403 && off.body.error === "local_accounts_off", `${off.status} ${off.body.error ?? ""}`);
  await api("PATCH", "/api/settings", { localAccounts: true }, owner.token);
}
const keyL = await newKey();
const [, invL] = await api("POST", "/api/invites", { maxUses: 3 }, owner.token);
const plain = await verify(keyL, invL.code);
check("server accounts: a key without an account -> 403 registration_required", plain.status === 403 && plain.body.error === "registration_required" && plain.body.localAccounts === true, `${plain.status} ${plain.body.error ?? ""}`);
const handleL = `smoke.${keyL.publicKey.slice(0, 8)}`;
const [, free1] = await api("GET", `/api/local/handles/${handleL}`);
const L = await register(keyL, invL.code, undefined, handleL);
const [, free2] = await api("GET", `/api/local/handles/~${handleL}`);
check("server accounts: register -> session, the handle is taken afterwards", L.status === 200 && typeof L.token === "string" && free1.available === true && free2.available === false, `${L.status} ${JSON.stringify(L.body)}`);
const dup = await register(await newKey(), invL.code, undefined, handleL);
check("server accounts: the same handle again -> 409 handle_taken", dup.status === 409 && dup.body.error === "handle_taken", `${dup.status} ${dup.body.error ?? ""}`);
const again = await register(keyL, invL.code, undefined, `x${handleL}`);
check("server accounts: a key with an account cannot register another", again.status === 409 && again.body.error === "has_account", `${again.status} ${again.body.error ?? ""}`);
const [, meL] = await api("GET", "/api/me", undefined, L.token);
const [, stL] = await api("GET", "/api/state", undefined, owner.token);
const memL = stL.members.find((m) => m.userId === L.userId);
check("server accounts: ~handle in /api/me and the member list, the name falls back to it", meL.localHandle === handleL && meL.registrationRequired === false
  && memL?.localHandle === handleL && memL?.displayName === `~${handleL}` && memL?.handle === null, JSON.stringify(memL));
const Lv = await verify(keyL);
check("server accounts: signing in again with the key alone", Lv.status === 200 && Lv.body.registrationRequired === false, `${Lv.status}`);
// Signing in on another device: the parameters, then the blob for the auth key.
const [sPar, par] = await api("GET", `/api/local/backup/${handleL}/params`);
const [sBad, bad] = await api("POST", "/api/local/backup/fetch", { handle: handleL, authKey: "00".repeat(32) });
const [sBlob, blob] = await api("POST", "/api/local/backup/fetch", { handle: handleL, authKey: authKeyOf(keyL) });
check("server accounts: backup parameters, wrong password 401, the blob for the right one", sPar === 200 && par.iterations === 100000 && !("iv" in par) && sBad === 401 && bad.error === "auth_invalid"
  && sBlob === 200 && blob.publicKey === keyL.publicKey && blob.ciphertext === backupOf(keyL).ciphertext && blob.params.iv === "00".repeat(12), `${sPar} ${sBad} ${sBlob}`);
const [sUnk] = await api("GET", "/api/local/backup/nobody.here/params");
check("server accounts: an unknown handle -> 404", sUnk === 404, `${sUnk}`);
const [sPw1] = await api("PUT", "/api/local/backup", { oldAuthKey: "11".repeat(32), backup: backupOf(keyL, "new") }, L.token);
const [sPw2] = await api("PUT", "/api/local/backup", { oldAuthKey: authKeyOf(keyL), backup: backupOf(keyL, "new") }, L.token);
const [sOld] = await api("POST", "/api/local/backup/fetch", { handle: handleL, authKey: authKeyOf(keyL) });
const [sNew] = await api("POST", "/api/local/backup/fetch", { handle: handleL, authKey: authKeyOf(keyL, "new") });
check("server accounts: a new password needs the old one", sPw1 === 401 && sPw2 === 200 && sOld === 401 && sNew === 200, `${sPw1} ${sPw2} ${sOld} ${sNew}`);
// The avatar of a server account lives on this server.
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const [sAv] = await api("PUT", "/api/me/avatar", { mime: "image/png", data: png.toString("base64") }, L.token);
const [, stAv] = await api("GET", "/api/state", undefined, owner.token);
const avUrl = stAv.members.find((m) => m.userId === L.userId)?.avatarUrl;
const avRes = avUrl ? await fetch(avUrl.replace(/^https?:\/\/[^/]+/, BASE)) : null;
check("server accounts: avatar upload -> in the member list, public without a token", sAv === 200 && typeof avUrl === "string" && avUrl.includes(`/api/avatars/${L.userId}?v=`)
  && avRes?.status === 200 && avRes.headers.get("content-type") === "image/png" && avRes.headers.get("x-content-type-options") === "nosniff", `${sAv} ${avUrl} ${avRes?.status}`);
const [sSvg] = await api("PUT", "/api/me/avatar", { mime: "image/png", data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") }, L.token);
check("server accounts: an avatar that is no picture -> 400", sSvg === 400, `${sSvg}`);
const [sAvDel] = await api("DELETE", "/api/me/avatar", undefined, L.token);
const [, stAv2] = await api("GET", "/api/state", undefined, owner.token);
check("server accounts: avatar removed", sAvDel === 200 && stAv2.members.find((m) => m.userId === L.userId)?.avatarUrl === null, `${sAvDel}`);
// Deleting the account: needs the password, frees the handle, ends the session.
const [sDelBad] = await api("DELETE", "/api/me", { authKey: "22".repeat(32) }, L.token);
const [sDel] = await api("DELETE", "/api/me", { authKey: authKeyOf(keyL, "new") }, L.token);
const [, free3] = await api("GET", `/api/local/handles/${handleL}`);
const [sAfter] = await api("GET", "/api/me", undefined, L.token);
check("server accounts: delete with the password, the handle is free again, the session gone", sDelBad === 401 && sDel === 200 && free3.available === true && sAfter === 401, `${sDelBad} ${sDel} ${sAfter}`);
// Wrong passwords are limited per handle (and per address): the last check of the section, the address is blocked for a minute.
let limited = null;
for (let i = 0; i < 12 && limited === null; i++) { const [sl] = await api("POST", "/api/local/backup/fetch", { handle: localHandleOf(keyB), authKey: "33".repeat(32) }); if (sl === 429) limited = i; }
check("server accounts: wrong passwords are rate limited", limited !== null, `after ${limited}`);

// ---------- Server directory (M6d): listing + description; with a directory the server re-registers and appears in its list
const [sld] = await api("PATCH", "/api/settings", { listed: true, description: "Rauchtest im Verzeichnis" }, owner.token);
const [, stLd] = await api("GET", "/api/state", undefined, owner.token);
check("listing: patch listed + description in state", sld === 200 && stLd.settings.listed === true && stLd.settings.description === "Rauchtest im Verzeichnis");
if (hra.directoryUrl) {
  await new Promise((r) => setTimeout(r, 3500)); // debounced re-registration (1.5 s) + fetch
  const dl = await fetch(`${hra.directoryUrl}/api/servers`).then(async (r) => [r.status, await r.json().catch(() => [])]);
  const mine = Array.isArray(dl[1]) ? dl[1].find((x) => x.host === health.domain) : null;
  check("listing: server appears in the directory with description and member count", dl[0] === 200 && !!mine && mine.description === "Rauchtest im Verzeichnis" && typeof mine.memberCount === "number", JSON.stringify(dl[1]));
  await api("PATCH", "/api/settings", { listed: false }, owner.token);
  await new Promise((r) => setTimeout(r, 3500));
  const dl2 = await fetch(`${hra.directoryUrl}/api/servers`).then((r) => r.json()).catch(() => []);
  check("listing: unlisted -> gone from the directory", Array.isArray(dl2) && !dl2.some((x) => x.host === health.domain));
} else {
  await api("PATCH", "/api/settings", { listed: false }, owner.token);
}
const [sldBad] = await api("PATCH", "/api/settings", { description: "x".repeat(201) }, owner.token);
check("listing: description too long -> 400", sldBad === 400);

// ---------- Status API (docs/features/status-api.md): off by default, with the key, public
{
  const [, stSa] = await api("GET", "/api/state", undefined, owner.token);
  check("status api: settings carry the mode, off by default", stSa.settings.statusApi === "off");
  const [sOff] = await api("GET", "/api/status");
  check("status api: off -> 404", sOff === 404);
  const [sMode0] = await api("PATCH", "/api/settings", { statusApi: "key" }, B.token);
  check("status api: mode needs MANAGE_SERVER", sMode0 === 403);
  const [sKeyNone] = await api("GET", "/api/settings/status-api-key", undefined, B.token);
  check("status api: key needs MANAGE_SERVER", sKeyNone === 403);
  await api("PATCH", "/api/settings", { statusApi: "key" }, owner.token);
  const [sKey, keyRes] = await api("GET", "/api/settings/status-api-key", undefined, owner.token);
  check("status api: switching to key makes a key", sKey === 200 && typeof keyRes.key === "string" && keyRes.key.length >= 40);
  const [sNoKey] = await api("GET", "/api/status");
  const [sWrong] = await api("GET", "/api/status?key=nope");
  const [sHeader, stH] = await api("GET", "/api/status", undefined, undefined, false, { authorization: `Bearer ${keyRes.key}` });
  const [sQuery] = await api("GET", `/api/status?key=${keyRes.key}`);
  check("status api: key mode -> 401 without or with a wrong key, 200 by header and by query", sNoKey === 401 && sWrong === 401 && sHeader === 200 && sQuery === 200);
  check("status api: structure", stH.name === "Rauchtest-Server" && Array.isArray(stH.categories) && stH.channels.some((c) => c.id === voiceCh.id && c.kind === "voice") && typeof stH.time === "string");
  // Nobody sits in a voice channel yet: the member list is empty, members outside voice channels stay inside the server.
  check("status api: only members in a voice channel are listed", Array.isArray(stH.members) && stH.members.length === 0);
  const [, reKey] = await api("POST", "/api/settings/status-api-key", undefined, owner.token);
  const [sOld] = await api("GET", `/api/status?key=${keyRes.key}`);
  const [sNew] = await api("GET", `/api/status?key=${reKey.key}`);
  check("status api: regenerate replaces the key", reKey.key !== keyRes.key && sOld === 401 && sNew === 200);

  // ---------- Setup check (docs/features/doctor.md): the report for MANAGE_SERVER and for the machine itself, the media test token
  const [dcB] = await api("GET", "/api/doctor", undefined, B.token);
  check("doctor: the report needs MANAGE_SERVER", dcB === 403);
  const [dcOwner, docRep] = await api("GET", "/api/doctor", undefined, owner.token);
  const statuses = ["ok", "warn", "fail", "skip"];
  check("doctor: the owner gets the report, first the request's own view, every check with both texts",
    dcOwner === 200 && Array.isArray(docRep.checks) && docRep.checks.length >= 6 && docRep.checks[0].id === "request"
      && docRep.checks.every((c) => typeof c.text?.de === "string" && typeof c.text?.en === "string" && statuses.includes(c.status)) && typeof docRep.mediaPorts?.tcp === "number");
  check("doctor: the server reaches its own address and LiveKit (dev: the self check and the internal ping)",
    ["self", "websocket", "rtc", "livekit"].every((id) => docRep.checks.find((c) => c.id === id)?.status === "ok"), JSON.stringify(docRep.checks.filter((c) => c.status !== "ok").map((c) => [c.id, c.status, c.detail])));
  // SMOKE_DOCTOR_TOKEN = the server's DOCTOR_TOKEN (an installation without containers): the token opens, loopback alone does not.
  const doctorToken = process.env.SMOKE_DOCTOR_TOKEN;
  if (doctorToken) {
    const [dcBare] = await api("GET", "/api/doctor");
    check("doctor: with a token configured, loopback alone is refused", dcBare === 401);
  }
  const [dcLoop, loopRep] = await api("GET", "/api/doctor", undefined, undefined, false, doctorToken ? { "x-squorli-doctor": doctorToken } : {});
  check("doctor: from the machine itself without a session (squorli doctor), without the request view", dcLoop === 200 && Array.isArray(loopRep.checks) && loopRep.checks[0].id !== "request");
  const [dcFwd] = await api("GET", "/api/doctor", undefined, undefined, false, { "x-forwarded-for": "203.0.113.5" });
  check("doctor: a forwarded request without a session is refused", dcFwd === 401);
  const [dtB] = await api("POST", "/api/doctor/rtc-token", undefined, B.token);
  const [dtO, dtok] = await api("POST", "/api/doctor/rtc-token", undefined, owner.token);
  check("doctor: the media test token only with MANAGE_SERVER", dtB === 403 && dtO === 200 && typeof dtok.token === "string" && typeof dtok.url === "string");
  await api("PATCH", "/api/settings", { statusApi: "public" }, owner.token);
  const [sPub, stPub] = await api("GET", "/api/status");
  check("status api: public -> 200 without a key", sPub === 200 && Array.isArray(stPub.members));
  await api("PATCH", "/api/settings", { statusApi: "off" }, owner.token);
  const [sOffAgain] = await api("GET", `/api/status?key=${reKey.key}`);
  check("status api: off again -> 404 even with the key", sOffAgain === 404);
}
await api("PATCH", "/api/me", { displayName: "Bea" }, B.token);

// ---------- Sessions / devices (M6c): list, label from the user agent, remote sign-out (WS close 4011), others, own
const [ssl0, sessList0] = await api("GET", "/api/me/sessions", undefined, B.token);
check("sessions list: exactly one current", ssl0 === 200 && Array.isArray(sessList0) && sessList0.filter((s) => s.current).length === 1 && sessList0.length >= 2, `${sessList0.length ?? "?"} Sitzungen`);
const B3 = await login(keyB, undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0");
const [, sessList1] = await api("GET", "/api/me/sessions", undefined, B.token);
const firefox = sessList1.find((s) => s.label === "Firefox auf Windows");
check("session label from user-agent", B3.status === 200 && !!firefox && firefox.current === false && sessList1.length === sessList0.length + 1, sessList1.map((s) => s.label).join(", "));
const wsB3 = await connectWs(B3.token);
const [srv1] = await api("DELETE", `/api/me/sessions/${firefox?.id}`, undefined, B.token);
const closeCode3 = await wsB3.closed();
const [sme3] = await api("GET", "/api/me", undefined, B3.token);
check("revoke session: ws closed 4011, token dead", srv1 === 200 && closeCode3 === 4011 && sme3 === 401, `close ${closeCode3}, me ${sme3}`);
const [srv2] = await api("DELETE", "/api/me/sessions/00000000-0000-4000-8000-000000000000", undefined, B.token);
const [, ownerSess] = await api("GET", "/api/me/sessions", undefined, owner.token);
const [srv3] = await api("DELETE", `/api/me/sessions/${ownerSess.find((s) => s.current)?.id}`, undefined, B.token);
const [srv4] = await api("DELETE", "/api/me/sessions/nope", undefined, B.token);
const [smeOwner] = await api("GET", "/api/me", undefined, owner.token);
check("revoke unknown/foreign/bad id -> 404/404/400, owner untouched", srv2 === 404 && srv3 === 404 && srv4 === 400 && smeOwner === 200);
const [srv5, others] = await api("DELETE", "/api/me/sessions/others", undefined, B.token);
const [sme2] = await api("GET", "/api/me", undefined, B2.token);
const [sme1] = await api("GET", "/api/me", undefined, B.token);
check("revoke others: B2 dead, B alive", srv5 === 200 && others.revoked >= 1 && sme2 === 401 && sme1 === 200, `revoked ${others.revoked}`);
const B4 = await login(keyB);
const [srv6] = await api("DELETE", "/api/me/sessions/current", undefined, B4.token);
const [sme4] = await api("GET", "/api/me", undefined, B4.token);
check("logout current session -> token dead", srv6 === 200 && sme4 === 401);

// Freshly joined = guest: may not post until an admin grants "member".
const [sg1] = await api("POST", `/api/channels/${ownerState.channels.find((c) => c.kind === "text").id}/messages`, { content: "Gast?" }, B.token);
const [sg2] = await api("POST", "/api/rtc-token", { channelId: ownerState.channels.find((c) => c.kind === "voice").id }, B.token);
check("guest cannot write but may join voice", sg1 === 403 && sg2 === 200);
await api("PUT", `/api/members/${B.userId}/roles`, { roleIds: [memberRole.id] }, owner.token);

// ---------- Permissions
const [sb1] = await api("POST", "/api/channels", { kind: "text", name: "nope" }, B.token);
check("member cannot create channels", sb1 === 403);
const [sb2] = await api("DELETE", `/api/members/${owner.userId}`, undefined, B.token);
check("member cannot kick", sb2 === 403);
const [sar] = await api("PUT", `/api/members/${B.userId}/roles`, { roleIds: [memberRole.id, modRole.id] }, owner.token);
const [, stB] = await api("GET", "/api/state", undefined, B.token);
check("assign role -> permissions update", sar === 200 && (stB.myPermissions & P.KICK_MEMBERS) !== 0 && stB.members.find((m) => m.userId === B.userId)?.roleIds.includes(modRole.id));
// ---------- Multiple owners: only owners can appoint, permissions follow immediately, the first owner stays
const [so0] = await api("PUT", `/api/members/${B.userId}/owner`, { owner: true }, B.token);
check("non-owner cannot grant owner", so0 === 403);
const [so1] = await api("PUT", `/api/members/${B.userId}/owner`, { owner: true }, owner.token);
const [, stOwn] = await api("GET", "/api/state", undefined, B.token);
check("grant owner -> isOwner + ADMINISTRATOR", so1 === 200 && stOwn.members.find((m) => m.userId === B.userId)?.isOwner === true && (stOwn.myPermissions & P.ADMINISTRATOR) !== 0);
const [so2, ro2] = await api("PUT", `/api/members/${owner.userId}/owner`, { owner: false }, B.token);
const [so2b, ro2b] = await api("PUT", `/api/members/${B.userId}/owner`, { owner: false }, B.token);
check("founder cannot be demoted, not self", so2 === 403 && ro2.error === "founder" && so2b === 400 && ro2b.error === "self");
// Roles of an owner: only the first owner may change them (19 September 2026); B is an owner here, with its roles from above.
const [sor1] = await api("PUT", `/api/members/${B.userId}/roles`, { roleIds: [memberRole.id] }, owner.token);
const [, stOr] = await api("GET", "/api/state", undefined, owner.token);
const [sor2, ror2] = await api("PUT", `/api/members/${owner.userId}/roles`, { roleIds: [memberRole.id] }, B.token);
check("first owner sets another owner's roles, a further owner cannot set the first owner's", sor1 === 200 && JSON.stringify(stOr.members.find((m) => m.userId === B.userId)?.roleIds) === JSON.stringify([memberRole.id]) && sor2 === 403 && ror2.error === "target_above_you", `${sor1} ${sor2} ${ror2.error ?? ""}`);
await api("PUT", `/api/members/${B.userId}/roles`, { roleIds: [memberRole.id, modRole.id] }, owner.token);
const [so3] = await api("PUT", `/api/members/${B.userId}/owner`, { owner: false }, owner.token);
const [, stOwn2] = await api("GET", "/api/state", undefined, B.token);
check("revoke owner -> back to role permissions", so3 === 200 && stOwn2.members.find((m) => m.userId === B.userId)?.isOwner === false && (stOwn2.myPermissions & P.ADMINISTRATOR) === 0 && stOwn2.members.find((m) => m.userId === owner.userId)?.isOwner === true);
  // ---------- Reports and the moderation log (docs/features/reports.md)
  {
    const textCh = ownerState.channels.find((c) => c.kind === "text");
    const [, stR] = await api("GET", "/api/state", undefined, B.token);
    check("reports: the state carries the open count (0 for a member without MANAGE_REPORTS)", stR.openReports === 0);
    const [, stO] = await api("GET", "/api/state", undefined, owner.token);
    const openBefore = stO.openReports;
    check("reports: the owner sees the open count", typeof openBefore === "number");
    // B writes a message with an attachment, the owner reports it (B cannot report their own).
    const form = new FormData(); form.append("file", new Blob([Buffer.from("evidence")], { type: "text/plain" }), "beweis.txt");
    const [, upR] = await api("POST", "/api/attachments", form, B.token);
    const [, repMsg] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: "gemeldet wird das hier", attachmentIds: [upR.id] }, B.token);
    const [rOwn] = await api("POST", "/api/reports", { kind: "message", messageId: repMsg.id, reason: "spam" }, B.token);
    check("reports: one's own message cannot be reported", rOwn === 400);
    const [rBad] = await api("POST", "/api/reports", { kind: "message", messageId: repMsg.id, reason: "nope" }, owner.token);
    check("reports: an unknown reason is refused", rBad === 400);
    const [r1, rep1] = await api("POST", "/api/reports", { kind: "message", messageId: repMsg.id, reason: "harassment", text: "siehe Anhang" }, owner.token);
    check("reports: a message report is accepted", r1 === 200 && typeof rep1.id === "string", `${r1}`);
    const [r2] = await api("POST", "/api/reports", { kind: "message", messageId: repMsg.id, reason: "spam" }, owner.token);
    check("reports: the same reporter and message only once while open", r2 === 409);
    const [r3, rep3] = await api("POST", "/api/reports", { kind: "member", userId: B.userId, reason: "other", text: "allgemein" }, owner.token);
    check("reports: a member report is accepted", r3 === 200 && typeof rep3.id === "string");
    const [qB] = await api("GET", "/api/reports", undefined, B.token);
    check("reports: the queue needs MANAGE_REPORTS", qB === 403);
    const [qS, queue] = await api("GET", "/api/reports?status=open", undefined, owner.token);
    const mine = queue.reports?.find((r) => r.id === rep1.id);
    check("reports: the queue lists the report with the snapshot (text, author, attachment copy, channel)", qS === 200 && queue.open === openBefore + 2 && !!mine && mine.snapshot?.content === "gemeldet wird das hier"
      && mine.reportedUserId === B.userId && mine.channelName === textCh.name && mine.messageExists === true && mine.snapshot.attachments.length === 1 && mine.text === "siehe Anhang", JSON.stringify(mine));
    const fileRes = await fetch(BASE + mine.snapshot.attachments[0].url);
    check("reports: the attachment copy is served with its signed link", fileRes.status === 200 && (await fileRes.text()) === "evidence", `${fileRes.status}`);
    const fileBad = await fetch(BASE + mine.snapshot.attachments[0].url.replace(/s=[^&]+/, "s=forged"));
    check("reports: a forged link is a 404", fileBad.status === 404);
    // Deleting the reported message through the queue: the message goes, B gets the notice, the report is closed, the log has it.
    const wsB2 = await connectWs(B.token);
    const noticeP = wsB2.waitFor((e) => e.type === "moderation.notice");
    const delP = wsB2.waitFor((e) => e.type === "message.delete" && e.id === repMsg.id);
    const [cS, cR] = await api("POST", `/api/reports/${rep1.id}/close`, { action: "delete", note: "weg damit" }, owner.token);
    const notice = await noticeP; const delEv = await delP;
    check("reports: closing with delete removes the message, tells the author (no reporter) and counts", cS === 200 && cR.deleted === 1 && notice.kind === "message_removed" && notice.channelName === textCh.name && !("reporter" in notice) && !!delEv);
    const [cAgain] = await api("POST", `/api/reports/${rep1.id}/close`, { action: "dismiss" }, owner.token);
    check("reports: a closed report cannot be closed again", cAgain === 409);
    const [, closedQ] = await api("GET", "/api/reports?status=closed", undefined, owner.token);
    const closed = closedQ.reports?.find((r) => r.id === rep1.id);
    check("reports: the closed list shows result, note and that the message is gone; the snapshot stays", !!closed && closed.status === "actioned" && closed.action === "delete" && closed.note === "weg damit" && closed.messageExists === false && closed.snapshot?.content === "gemeldet wird das hier");
    // Delete recent messages of the reported member through the member report, then the log.
    await api("POST", `/api/channels/${textCh.id}/messages`, { content: "noch eine" }, B.token);
    await api("POST", `/api/channels/${textCh.id}/messages`, { content: "und noch eine" }, B.token);
    const bulkP = wsB2.waitFor((e) => e.type === "message.bulkDelete" && e.channelId === textCh.id);
    const [c3S, c3R] = await api("POST", `/api/reports/${rep3.id}/close`, { action: "deleteRecent", hours: 1 }, owner.token);
    const bulk = await bulkP;
    check("reports: deleteRecent removes the member's recent messages with one bulk event per channel", c3S === 200 && c3R.deleted >= 2 && bulk.ids.length >= 2, `${c3S} ${c3R.deleted}`);
    const [lgB] = await api("GET", "/api/mod-log", undefined, B.token);
    const [lgS, lg] = await api("GET", "/api/mod-log", undefined, owner.token);
    const closedEntries = lg.entries?.filter((e) => e.action === "report_closed") ?? [];
    check("reports: the moderation log needs MANAGE_REPORTS and holds the closings without message contents", lgB === 403 && lgS === 200 && closedEntries.length >= 2 && closedEntries.every((e) => JSON.stringify(e).indexOf("gemeldet wird das hier") === -1) && closedEntries.some((e) => e.detail.result === "delete" && e.targetUserId === B.userId));
    const [, stO2] = await api("GET", "/api/state", undefined, owner.token);
    check("reports: the open count is back where it was", stO2.openReports === openBefore);
    await wsB2.close();
  }

// ---------- Server icon (admin): upload, serving, favicon URL in /api/health, rejections, removal
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const pngForm = () => { const f = new FormData(); f.append("file", new Blob([PNG1], { type: "image/png" }), "icon.png"); return f; };
const [si1, ri1] = await api("PUT", "/api/settings/icon", pngForm(), owner.token);
const [, stIcon] = await api("GET", "/api/state", undefined, owner.token);
const iconRes = await api("GET", stIcon.settings.iconUrl ?? "/api/server-icon", undefined, undefined, true);
const [, hIcon] = await api("GET", "/api/health");
check("server icon: upload, iconUrl, served as png, in health with server name", si1 === 200 && typeof stIcon.settings.iconUrl === "string" && ri1.iconUrl === stIcon.settings.iconUrl && iconRes.status === 200
  && iconRes.headers.get("content-type")?.startsWith("image/png") && hIcon.iconUrl === stIcon.settings.iconUrl && hIcon.serverName === "Rauchtest-Server", `${si1} ${ri1.error ?? ""}`);
const fdSvg = new FormData(); fdSvg.append("file", new Blob(["<svg/>"], { type: "image/svg+xml" }), "x.svg");
const [si2, ri2] = await api("PUT", "/api/settings/icon", fdSvg, owner.token);
const [si3] = await api("PUT", "/api/settings/icon", pngForm(), B.token);
const [si4] = await api("DELETE", "/api/settings/icon", undefined, owner.token);
const [, stIcon2] = await api("GET", "/api/state", undefined, owner.token);
const iconGone = await api("GET", "/api/server-icon", undefined, undefined, true);
check("server icon: svg rejected, non-admin rejected, delete", si2 === 400 && ri2.error === "bad_type" && si3 === 403 && si4 === 200 && stIcon2.settings.iconUrl === null && iconGone.status === 404);

const [sb3, kickOwner] = await api("DELETE", `/api/members/${owner.userId}`, undefined, B.token);
check("mod cannot kick owner", sb3 === 403 && kickOwner.error === "target_above_you");
const [sb4] = await api("PATCH", `/api/roles/${modRole.id}`, { permissions: P.ADMINISTRATOR }, B.token);
check("mod cannot escalate role", sb4 === 403);

// ---------- WebSocket + messages
const wsA = await connectWs(owner.token);
check("ws welcome with state", wsA.welcome.type === "welcome" && wsA.welcome.state.channels.some((c) => c.id === textCh.id));
const wsB = await connectWs(B.token);
const [, stOnline] = await api("GET", "/api/state", undefined, owner.token);
check("presence online", stOnline.members.find((m) => m.userId === B.userId)?.online === true);

// ---------- Web radio (stations: MANAGE_SERVER; a voice channel's radio: CONTROL_RADIO; B has neither here)
const radioOf = async () => (await api("GET", "/api/state", undefined, owner.token))[1].channels.find((c) => c.id === voiceCh.id)?.radio ?? null;
// The voice channel is empty during these checks: keep the idle stop (checked at the end of this block) out of their way.
await api("PATCH", "/api/settings", { radioAutoStop: false }, owner.token);
const streamUrl = "https://streams.radiobob.de/bob-national/mp3-128/streams.radiobob.de/";
const [srs0] = await api("POST", "/api/radio/stations", { name: "Fremd", url: streamUrl }, B.token);
const [srsFtp] = await api("POST", "/api/radio/stations", { name: "Kaputt", url: "ftp://example.org/radio.mp3" }, owner.token);
const [srs2] = await api("POST", "/api/radio/stations", { name: "", url: streamUrl }, owner.token);
const [srs3, station] = await api("POST", "/api/radio/stations", { name: "Rauchtest-Radio", url: streamUrl }, owner.token);
const evStations = await wsB.waitFor((e) => e.type === "structure" && e.radioStations?.some((x) => x.id === station.id)).catch(() => null);
check("radio: stations need MANAGE_SERVER and an http(s) address; list in state and broadcast", srs0 === 403 && srsFtp === 400 && srs2 === 400 && srs3 === 200 && !!evStations
  && Array.isArray(stOnline.radioStations) && Array.isArray(wsA.welcome.state.radioStations), `${srs0} ${srsFtp} ${srs2} ${srs3}`);
const [srp0] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: station.id }, B.token);
const [srp1] = await api("PUT", `/api/channels/${textCh.id}/radio`, { stationId: station.id }, owner.token);
const [srp2, unknownStation] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: "00000000-0000-4000-8000-000000000000" }, owner.token);
const [srp3] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: station.id }, owner.token);
const evRadio = await wsB.waitFor((e) => e.type === "structure" && e.channels?.find((c) => c.id === voiceCh.id)?.radio?.stationId === station.id).catch(() => null);
const radioOn = evRadio?.channels.find((c) => c.id === voiceCh.id)?.radio;
check("radio: start needs CONTROL_RADIO, a voice channel and a known station; everyone gets the stream address", srp0 === 403 && srp1 === 404 && srp2 === 404 && unknownStation.error === "unknown_station" && srp3 === 200
  && radioOn?.streamUrl === streamUrl && radioOn?.name === "Rauchtest-Radio" && radioOn?.startedBy === owner.userId, `${srp0} ${srp1} ${srp2} ${srp3}`);
const [, internalStation] = await api("POST", "/api/radio/stations", { name: "Intern", url: "http://127.0.0.1:9/intern.m3u" }, owner.token);
const [srp4, internalErr] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: internalStation.id }, owner.token);
check("radio: a playlist on an internal address is never fetched, the running station stays", srp4 === 502 && internalErr.error === "radio_forbidden_host" && (await radioOf())?.stationId === station.id, `${srp4} ${internalErr.error ?? ""}`);
const [srn] = await api("PATCH", `/api/radio/stations/${station.id}`, { name: "Rauchtest-Radio 2" }, owner.token);
const renamed = await radioOf();
const [sru] = await api("PATCH", `/api/radio/stations/${station.id}`, { url: `${streamUrl}?neu=1` }, owner.token);
const [sre] = await api("PATCH", `/api/radio/stations/${station.id}`, {}, owner.token);
check("radio: a renamed station shows in the channel, a new address turns the radio off", srn === 200 && renamed?.name === "Rauchtest-Radio 2" && sru === 200 && sre === 400 && (await radioOf()) === null, `${srn} ${sru} ${sre}`);
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: station.id }, owner.token);
// A typed address instead of a station: same permission, same rules for the address; shown under its host.
const [sru0] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: streamUrl }, B.token);
const [sru1] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "ftp://example.org/x.mp3" }, owner.token);
const [sru2] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "http://127.0.0.1:9/intern.m3u" }, owner.token);
const [sru3] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: streamUrl }, owner.token);
const typed = await radioOf();
check("radio: a typed address needs CONTROL_RADIO and is checked like a station's; stationId null, named by its host", sru0 === 403 && sru1 === 400 && sru2 === 502 && sru3 === 200
  && typed?.stationId === null && typed?.streamUrl === streamUrl && typed?.name === "streams.radiobob.de", `${sru0} ${sru1} ${sru2} ${sru3} ${typed?.name}`);
// A Twitch channel page: no audio stream, clients show Twitch's player; the server normalizes the address and asks nobody.
const [srt0] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "https://twitch.tv/Squorli_Test/" }, owner.token);
const twitch = await radioOf();
const [srt1] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "https://www.twitch.tv/videos/12345" }, owner.token);
const notTwitch = await radioOf();
check("radio: a twitch channel page becomes a twitch source, other twitch pages stay plain addresses", srt0 === 200 && twitch?.twitchChannel === "squorli_test" && twitch?.streamUrl === "https://www.twitch.tv/squorli_test"
  && twitch?.name === "twitch.tv/squorli_test" && srt1 === 200 && notTwitch?.twitchChannel === null, `${srt0} ${twitch?.twitchChannel} ${srt1}`);
// A YouTube video: shown with YouTube's player, played in step. The title comes from YouTube (oEmbed); offline the name falls back.
const YT_ID = "aqz-KE-bpKQ";
const [sry0] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: `https://youtu.be/${YT_ID}?t=1m30s` }, owner.token);
const youtube = await radioOf();
check("radio: a youtube address becomes a youtube source that starts playing for everyone at the address's offset", sry0 === 200 && youtube?.youtubeVideo === YT_ID && youtube?.twitchChannel === null
  && youtube?.streamUrl === `https://www.youtube.com/watch?v=${YT_ID}` && typeof youtube?.name === "string" && youtube.name.length > 0
  && youtube?.playback?.playing === true && youtube.playback.position === 90 && youtube.playback.rate === 1 && Math.abs(youtube.playback.at - Date.now()) < 60_000, `${sry0} ${youtube?.name} ${JSON.stringify(youtube?.playback)}`);
const [spb0] = await api("PUT", `/api/channels/${voiceCh.id}/radio/playback`, { playing: false, position: 10 }, B.token);
const [spb1] = await api("PUT", `/api/channels/${voiceCh.id}/radio/playback`, { playing: false, position: -5 }, owner.token);
const [spb2] = await api("PUT", `/api/channels/${voiceCh.id}/radio/playback`, { playing: false, position: 10, rate: 9 }, owner.token);
const [spb3, setPlayback] = await api("PUT", `/api/channels/${voiceCh.id}/radio/playback`, { playing: false, position: 123.5 }, owner.token);
const evPlayback = await wsB.waitFor((e) => e.type === "radio.playback" && e.channelId === voiceCh.id && e.playback.position === 123.5).catch(() => null);
const pausedVideo = await radioOf();
check("radio: play/pause/seek of a video needs CONTROL_RADIO, is stamped by the server, goes to everyone and stays on the channel", spb0 === 403 && spb1 === 400 && spb2 === 400 && spb3 === 200
  && evPlayback?.playback.playing === false && evPlayback.playback.rate === 1 && evPlayback.playback.at === setPlayback.playback.at
  && pausedVideo?.playback?.position === 123.5 && pausedVideo.playback.playing === false && pausedVideo.playback.at === setPlayback.playback.at, `${spb0} ${spb1} ${spb2} ${spb3}`);
// A YouTube playlist: the client hands over the video ids, the server plays them as a queue (one video at a time, in step).
const YT_LIST = "PLOU2XLYxmsIJGErt5rrCqaSGTMyyqNt2H", YT_ID2 = "jfKfPfyJRdk";
const [sq0, sqNoIds] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: `https://www.youtube.com/playlist?list=${YT_LIST}` }, owner.token);
const [sq1] = await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: `https://www.youtube.com/watch?v=${YT_ID2}&list=${YT_LIST}`, videoIds: [YT_ID, YT_ID2] }, owner.token);
const queued = await radioOf();
check("radio: a youtube playlist with the client's video ids becomes a queue that starts at the video the address names", sq0 === 400 && sqNoIds.error === "radio_playlist_unresolved" && sq1 === 200
  && queued?.youtubeVideo === YT_ID2 && queued.queue?.listId === YT_LIST && queued.queue.index === 1 && queued.queue.length === 2 && queued.playback?.playing === true && queued.playback.position === 0, `${sq0} ${sq1} ${JSON.stringify(queued?.queue)}`);
const [sqa0] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID2 }, B.token);
const [sqa1] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID2, ended: true }, B.token); // not sitting in the channel
const [sqa2, stale] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID }, owner.token);
const unmoved = await radioOf();
const [sqa3, moved] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID2 }, owner.token);
const wrapped = await radioOf();
check("radio: skipping needs CONTROL_RADIO, names the running video, and goes around the end of the list", sqa0 === 403 && sqa1 === 403 && sqa2 === 200 && stale.moved === false && unmoved?.queue?.index === 1
  && sqa3 === 200 && moved.moved === true && wrapped?.youtubeVideo === YT_ID && wrapped.queue?.index === 0 && wrapped.streamUrl === `https://www.youtube.com/watch?v=${YT_ID}`, `${sqa0} ${sqa1} ${sqa2} ${sqa3} ${JSON.stringify(wrapped?.queue)}`);
wsB.send({ type: "voice.join", channelId: voiceCh.id });
await wsB.waitFor((e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === B.userId));
const [sqe0, endedMove] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID, ended: true }, B.token);
const [sqe1] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID2, step: -1, ended: true }, B.token);
const afterEnd = await radioOf();
// A radio with nothing left to play turns itself off: the last video of a queue, a single video, a Twitch stream that is over.
const [sqe2, endOfList] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID2, ended: true }, B.token);
const afterList = await radioOf();
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: `https://youtu.be/${YT_ID}` }, owner.token);
const [sqe3, otherVideo] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID2, ended: true }, B.token);
const stillSingle = await radioOf();
const [sqe4, singleEnd] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID, ended: true }, B.token);
const afterSingle = await radioOf();
check("radio: the end of a queue's last video and of a single video turn the radio off, a report about another video does not", sqe2 === 200 && endOfList.stopped === true && afterList === null
  && sqe3 === 200 && otherVideo.stopped !== true && stillSingle?.youtubeVideo === YT_ID && sqe4 === 200 && singleEnd.stopped === true && afterSingle === null, `${sqe2} ${sqe3} ${sqe4} ${JSON.stringify(afterList)} ${JSON.stringify(afterSingle)}`);
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "https://twitch.tv/squorli_test" }, owner.token);
const [sqo1, otherStream] = await api("POST", `/api/channels/${voiceCh.id}/radio/offline`, { channel: "someone_else" }, B.token);
const stillTwitch = await radioOf();
const [sqo2, streamOver] = await api("POST", `/api/channels/${voiceCh.id}/radio/offline`, { channel: "Squorli_Test" }, B.token);
const afterStream = await radioOf();
const [sqo3] = await api("POST", `/api/channels/${voiceCh.id}/radio/offline`, {}, B.token);
check("radio: a listener in the channel reports that the twitch stream is over and the radio turns off", sqo1 === 200 && otherStream.stopped === false && stillTwitch?.twitchChannel === "squorli_test"
  && sqo2 === 200 && streamOver.stopped === true && afterStream === null && sqo3 === 400, `${sqo1} ${sqo2} ${sqo3}`);
wsB.send({ type: "voice.leave" });
await wsB.waitFor((e) => e.type === "voice.state" && e.channelId === voiceCh.id && !e.members.some((m) => m.userId === B.userId));
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "https://twitch.tv/squorli_test" }, owner.token);
const [sqo0] = await api("POST", `/api/channels/${voiceCh.id}/radio/offline`, { channel: "squorli_test" }, B.token);
check("radio: someone outside the channel without CONTROL_RADIO cannot report a stream as over", sqo0 === 403 && (await radioOf())?.twitchChannel === "squorli_test", `${sqo0}`);
check("radio: a listener in the channel reports the end of the video and the queue moves on, forwards only", sqe0 === 200 && endedMove.moved === true && sqe1 === 403 && afterEnd?.youtubeVideo === YT_ID2 && afterEnd.queue?.index === 1, `${sqe0} ${sqe1} ${JSON.stringify(afterEnd?.queue)}`);
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: `https://youtu.be/${YT_ID}` }, owner.token);
const single = await radioOf();
const [sqn0, noQueue] = await api("POST", `/api/channels/${voiceCh.id}/radio/advance`, { from: YT_ID }, owner.token);
check("radio: a single video has no queue", single?.queue === null && sqn0 === 409 && noQueue.error === "no_queue", `${sqn0}`);
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: streamUrl }, owner.token);
const [spb4, noPlayback] = await api("PUT", `/api/channels/${voiceCh.id}/radio/playback`, { playing: true, position: 1 }, owner.token);
const [spb5] = await api("PUT", `/api/channels/${textCh.id}/radio/playback`, { playing: true, position: 1 }, owner.token);
check("radio: an audio source has no playback state to set", spb4 === 409 && noPlayback.error === "no_playback" && (await radioOf())?.playback === null && spb5 === 404, `${spb4} ${spb5}`);
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: station.id }, owner.token);
const [srd0] = await api("DELETE", `/api/channels/${voiceCh.id}/radio`, undefined, B.token);
const stillOn = await radioOf();
const [srd1] = await api("DELETE", `/api/channels/${voiceCh.id}/radio`, undefined, owner.token);
check("radio: stop needs CONTROL_RADIO", srd0 === 403 && stillOn?.stationId === station.id && srd1 === 200 && (await radioOf()) === null, `${srd0} ${srd1}`);
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { stationId: station.id }, owner.token);
const [srx0] = await api("DELETE", `/api/radio/stations/${station.id}`, undefined, B.token);
const [srx1] = await api("DELETE", `/api/radio/stations/${station.id}`, undefined, owner.token);
const [srx2] = await api("DELETE", `/api/radio/stations/${internalStation.id}`, undefined, owner.token);
const [, stRadioEnd] = await api("GET", "/api/state", undefined, owner.token);
check("radio: deleting a station turns it off where it plays", srx0 === 403 && srx1 === 200 && srx2 === 200 && stRadioEnd.channels.find((c) => c.id === voiceCh.id)?.radio === null
  && !stRadioEnd.radioStations.some((x) => x.id === station.id || x.id === internalStation.id), `${srx0} ${srx1} ${srx2}`);
// Idle stop: nobody in the channel -> the radio goes off (two minutes; the test server runs with RADIO_IDLE_STOP_MS, e.g. 2000).
const [sas0] = await api("PATCH", "/api/settings", { radioAutoStop: true }, B.token);
const [sas1] = await api("PATCH", "/api/settings", { radioAutoStop: true }, owner.token);
const [, stAutoStop] = await api("GET", "/api/state", undefined, owner.token);
check("radio: the idle stop is a server setting (MANAGE_SERVER), on by default", sas0 === 403 && sas1 === 200 && stAutoStop.settings.radioAutoStop === true && wsA.welcome.state.settings.radioAutoStop === true, `${sas0} ${sas1}`);
const IDLE_MS = Number(process.env.RADIO_IDLE_STOP_MS ?? 0);
if (IDLE_MS > 0 && IDLE_MS <= 10_000) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  wsB.send({ type: "voice.join", channelId: voiceCh.id });
  await wsB.waitFor((e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === B.userId));
  await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: streamUrl }, owner.token);
  await pause(IDLE_MS + 1500);
  const occupied = await radioOf();
  wsB.send({ type: "voice.leave" });
  const leftAt = Date.now();
  const evIdle = await wsA.waitFor((e) => e.type === "structure" && e.channels?.some((c) => c.id === voiceCh.id && c.radio === null) && Date.now() - leftAt >= IDLE_MS - 200, IDLE_MS + 4000).catch(() => null);
  const stoppedAfter = Date.now() - leftAt;
  // Turned off in the settings: an empty channel keeps its radio.
  await api("PATCH", "/api/settings", { radioAutoStop: false }, owner.token);
  await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: streamUrl }, owner.token);
  await pause(IDLE_MS + 1500);
  const keptOn = await radioOf();
  check("radio: goes off once the channel has been empty for the delay, not while somebody is inside, and not with the setting off", occupied !== null && !!evIdle && stoppedAfter >= IDLE_MS - 200 && (await radioOf()) !== null && keptOn !== null, `occupied=${occupied !== null} stopped after ${stoppedAfter} ms keptOn=${keptOn !== null}`);
  await api("DELETE", `/api/channels/${voiceCh.id}/radio`, undefined, owner.token);
  // The voice checks further down wait for their own voice.state: forget the ones from here.
  for (const w of [wsA, wsB]) w.events.splice(0, w.events.length, ...w.events.filter((e) => e.type !== "voice.state"));
} else console.log("skip radio idle stop timing (start the test server and this script with RADIO_IDLE_STOP_MS=2000 to check it)");
await api("PATCH", "/api/settings", { radioAutoStop: true }, owner.token);

const [sm1, msg1] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: "Hallo aus dem Rauchtest" }, B.token);
const evCreate = await wsA.waitFor((e) => e.type === "message.create" && e.message?.id === msg1.id).catch(() => null);
check("message create + broadcast", sm1 === 200 && !!evCreate && evCreate.message.authorId === B.userId);
const [sm2] = await api("PATCH", `/api/messages/${msg1.id}`, { content: "Hallo (bearbeitet)" }, B.token);
const evUpdate = await wsA.waitFor((e) => e.type === "message.update" && e.message?.id === msg1.id).catch(() => null);
check("message edit by author", sm2 === 200 && evUpdate?.message.editedAt !== null);
const [sm3] = await api("PATCH", `/api/messages/${msg1.id}`, { content: "x" }, owner.token);
check("edit foreign message rejected", sm3 === 403);
const [sm4] = await api("POST", `/api/channels/${voiceCh.id}/messages`, { content: "x" }, B.token);
check("no text in voice channel", sm4 === 404);
const [smEmpty] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: "   " }, B.token);
check("empty message rejected", smEmpty === 400);

// Attachment
const fd = new FormData();
fd.append("file", new Blob(["hallo datei"], { type: "text/plain" }), "notiz.txt");
const [su, att] = await api("POST", "/api/attachments", fd, B.token);
check("upload attachment", su === 200 && att.size === 11 && att.url.startsWith("/api/attachments/"));
const [sm5, msg2] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: "", attachmentIds: [att.id] }, B.token);
check("message with attachment", sm5 === 200 && msg2.attachments?.[0]?.id === att.id);
const dl = await api("GET", att.url, undefined, undefined, true);
check("download attachment", dl.status === 200 && (await dl.text()) === "hallo datei" && dl.headers.get("content-type")?.startsWith("text/plain"));
// An SVG (security review, 25 September 2026): never shown on this origin, always a download inside a sandbox.
{
  const fdSvg = new FormData();
  fdSvg.append("file", new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/svg+xml" }), "x.svg");
  const [, attSvg] = await api("POST", "/api/attachments", fdSvg, B.token);
  const dlSvg = await api("GET", attSvg.url, undefined, undefined, true);
  const csp = dlSvg.headers.get("content-security-policy") ?? "";
  check("svg attachment: served as a download with a sandboxing CSP", dlSvg.status === 200 && dlSvg.headers.get("content-disposition")?.startsWith("attachment") && csp.includes("sandbox") && csp.includes("default-src 'none'"), `${dlSvg.status} ${dlSvg.headers.get("content-disposition")} ${csp}`);
  await dlSvg.body?.cancel();
}
// Signed links (25 September 2026, attachmentLinks.ts): without the signature, with a changed expiry or signature -> 404.
{
  const u = new URL(att.url, BASE);
  const e = u.searchParams.get("e"), s = u.searchParams.get("s");
  const noSig = await api("GET", u.pathname, undefined, undefined, true);
  const longer = await api("GET", `${u.pathname}?e=${Number(e) + 86400}&s=${s}`, undefined, undefined, true);
  const forged = await api("GET", `${u.pathname}?e=${e}&s=${"A".repeat(s?.length ?? 32)}`, undefined, undefined, true);
  check("attachment link: signed with an expiry of 7 to 8 days; unsigned, extended or forged -> 404", e && s && Number(e) * 1000 - Date.now() > 7 * 86_400_000 - 60_000
    && Number(e) * 1000 - Date.now() <= 8 * 86_400_000 && noSig.status === 404 && longer.status === 404 && forged.status === 404, `${e} ${noSig.status} ${longer.status} ${forged.status}`);
}
const [sm6] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: "", attachmentIds: [att.id] }, B.token);
check("attachment cannot be reused", sm6 === 400);

// History + cursor
for (let i = 0; i < 3; i++) await api("POST", `/api/channels/${textCh.id}/messages`, { content: `n${i}` }, owner.token);
const [sh, page1] = await api("GET", `/api/channels/${textCh.id}/messages?limit=2`, undefined, B.token);
const [, page2] = await api("GET", `/api/channels/${textCh.id}/messages?limit=10&before=${page1.messages[0].seq}`, undefined, B.token);
check("history paging", sh === 200 && page1.messages.length === 2 && page1.hasMore === true && page2.messages.length === 3 && page2.hasMore === false
  && page2.messages[0].id === msg1.id, `seq ${page1.messages.map((m) => m.seq)} | ${page2.messages.map((m) => m.seq)}`);

// Read states (all devices of a member): B joined in this run and has never opened the channel, so the owner's messages count
const readOf = async (token) => { const [s, body] = await api("GET", "/api/read-state", undefined, token); return [s, body?.channels?.find((c) => c.channelId === textCh.id)]; };
const [srs1, rs1] = await readOf(B.token);
check("read state: unread since joining, own messages do not count", srs1 === 200 && rs1?.lastReadSeq === null && rs1.unread === true && rs1.mentions === 0 && rs1.latestSeq === page1.messages[1].seq, JSON.stringify(rs1));
const [, mention] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: `Hallo <@${B.userId}>, schau mal` }, owner.token);
const [, rs2] = await readOf(B.token);
check("read state: mention counted", rs2?.unread === true && rs2.mentions === 1 && rs2.latestSeq === mention.seq, JSON.stringify(rs2));
const [sack, ack] = await api("POST", `/api/channels/${textCh.id}/read`, { seq: mention.seq }, B.token);
const evRead = await wsB.waitFor((e) => e.type === "read.update" && e.channelId === textCh.id).catch(() => null);
const [, rs3] = await readOf(B.token);
check("mark read: clears marks, tells my own connections only", sack === 200 && ack.lastReadSeq === mention.seq && evRead?.lastReadSeq === mention.seq
  && rs3?.unread === false && rs3.mentions === 0 && rs3.lastReadSeq === mention.seq && !wsA.events.some((e) => e.type === "read.update"), JSON.stringify(rs3));
const [, ackBack] = await api("POST", `/api/channels/${textCh.id}/read`, { seq: 0 }, B.token);
const [, ackFuture] = await api("POST", `/api/channels/${textCh.id}/read`, { seq: 2 ** 40 }, B.token);
check("mark read: never backwards, never beyond the newest message", ackBack.lastReadSeq === mention.seq && ackFuture.lastReadSeq === mention.seq, `${ackBack.lastReadSeq} ${ackFuture.lastReadSeq}`);
const [sackVoice] = await api("POST", `/api/channels/${voiceCh.id}/read`, { seq: 1 }, B.token);
const [sackBad] = await api("POST", `/api/channels/${textCh.id}/read`, { seq: -1 }, B.token);
const [sackAnon] = await api("GET", "/api/read-state");
check("mark read: text channels only, valid input, signed in", sackVoice === 404 && sackBad === 400 && sackAnon === 401, `${sackVoice} ${sackBad} ${sackAnon}`);
await api("POST", `/api/channels/${textCh.id}/messages`, { content: "danach" }, owner.token);
const [, rs4] = await readOf(B.token);
check("read state: a newer message marks the channel again", rs4?.unread === true && rs4.mentions === 0);
// No false alarms: a token inside code or behind a backslash is no mention, and an edited-away mention stops counting
const fence = "```";
await api("POST", `/api/channels/${textCh.id}/messages`, { content: `so sieht das aus: \`<@${B.userId}>\` und \\<@${B.userId}>\n${fence}\n<@${B.userId}>\n${fence}` }, owner.token);
const [, rs5] = await readOf(B.token);
const [, realMention] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: `<@${B.userId}> doch` }, owner.token);
const [, rs6] = await readOf(B.token);
await api("PATCH", `/api/messages/${realMention.id}`, { content: "doch nicht" }, owner.token);
const [, rs7] = await readOf(B.token);
check("read state: tokens in code or escaped do not count, an edited-away mention neither", rs5?.mentions === 0 && rs6?.mentions === 1 && rs7?.mentions === 0 && rs7.unread === true, `${rs5?.mentions} ${rs6?.mentions} ${rs7?.mentions}`);

// Mutes (per member, all their devices): a channel and the whole server
const [smu1, mu1] = await api("PUT", `/api/channels/${textCh.id}/mute`, { muted: true }, B.token);
const evMute = await wsB.waitFor((e) => e.type === "mute.update" && e.channelIds?.includes(textCh.id)).catch(() => null);
const [, rsMuted] = await api("GET", "/api/read-state", undefined, B.token);
const [, rsOwner] = await api("GET", "/api/read-state", undefined, owner.token);
check("mute channel: stored for me only, told to my connections", smu1 === 200 && mu1.channelIds.includes(textCh.id) && mu1.serverMuted === false && !!evMute
  && rsMuted.channels.find((c) => c.channelId === textCh.id)?.muted === true && rsOwner.channels.find((c) => c.channelId === textCh.id)?.muted === false
  && !wsA.events.some((e) => e.type === "mute.update"));
const [smu2, mu2] = await api("PUT", "/api/me/mute", { muted: true }, B.token);
const [, rsServer] = await api("GET", "/api/read-state", undefined, B.token);
check("mute server", smu2 === 200 && mu2.serverMuted === true && mu2.channelIds.includes(textCh.id) && rsServer.serverMuted === true && rsOwner.serverMuted === false);
await api("PUT", `/api/channels/${textCh.id}/mute`, { muted: true }, B.token);   // twice = still once
const [, mu3] = await api("PUT", `/api/channels/${textCh.id}/mute`, { muted: false }, B.token);
const [, mu4] = await api("PUT", "/api/me/mute", { muted: false }, B.token);
check("unmute channel and server", mu3.channelIds.length === 0 && mu3.serverMuted === true && mu4.serverMuted === false);
const [smuVoice] = await api("PUT", `/api/channels/${voiceCh.id}/mute`, { muted: true }, B.token);
const [smuBad] = await api("PUT", "/api/me/mute", { muted: "ja" }, B.token);
const [smuAnon] = await api("PUT", "/api/me/mute", { muted: true });
check("mute: text channels only, valid input, signed in", smuVoice === 404 && smuBad === 400 && smuAnon === 401, `${smuVoice} ${smuBad} ${smuAnon}`);

// ---------- Link previews (docs/features/link-previews.md)
// The script plays the linked website on 127.0.0.1:3198. The server only fetches from there when it was started with
// LINK_PREVIEW_TEST_ORIGIN=http://127.0.0.1:3198 (give the same value to this script); without it only the field is checked.
{
  const [, pvFirst] = await api("POST", `/api/channels/${textCh.id}/messages`, { content: "ohne Link" }, B.token);
  check("link previews: a message carries the field (empty without links)", Array.isArray(pvFirst.previews) && pvFirst.previews.length === 0, JSON.stringify(pvFirst.previews));
  await api("DELETE", `/api/messages/${pvFirst.id}`, undefined, B.token);
  const SITE = process.env.LINK_PREVIEW_TEST_ORIGIN;
  if (!SITE) console.log("info link previews: Server und Skript mit LINK_PREVIEW_TEST_ORIGIN=http://127.0.0.1:3198 starten, um den Abruf zu pruefen");
  else {
    const { createServer } = await import("node:http");
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const hits = [];
    let insideHits = 0;
    const site = createServer((req, res) => {
      hits.push(req.url);
      const page = (title) => `<!doctype html><html><head><title>falscher Titel</title><meta property="og:title" content="${title}"><meta property="og:description" content="Eine &quot;Beschreibung&quot;"><meta property="og:site_name" content="Rauchseite"><meta property="og:image" content="/bild.png"></head><body><script>alert(1)</script></body></html>`;
      if (req.url === "/seite") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Rauchtest &amp; Vorschau"));
      if (req.url === "/zweite") return res.writeHead(200, { "content-type": "text/html" }).end(page("Zweite Seite"));
      if (req.url === "/bild.png") return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      if (req.url === "/text") return res.writeHead(200, { "content-type": "text/plain" }).end("<title>kein HTML</title>");
      if (req.url === "/nach-innen") return res.writeHead(302, { location: "http://127.0.0.1:3197/geheim" }).end();
      res.writeHead(404).end();
    });
    // What a member must never reach through the server: another address of the machine itself.
    const inside = createServer((_req, res) => { insideHits++; res.writeHead(200, { "content-type": "text/html" }).end("<title>intern</title>"); });
    await new Promise((r) => site.listen(3198, "127.0.0.1", r));
    await new Promise((r) => inside.listen(3197, "127.0.0.1", r));
    const post = (content) => api("POST", `/api/channels/${textCh.id}/messages`, { content }, B.token);
    const updateOf = (id, pred) => wsA.waitFor((e) => e.type === "message.update" && e.message?.id === id && pred(e.message), 8000).catch(() => null);
    const stored = async (id) => (await api("GET", `/api/channels/${textCh.id}/messages?limit=100`, undefined, owner.token))[1].messages.find((m) => m.id === id);

    const [, pm] = await post(`Schau: ${SITE}/seite und nochmal ${SITE}/seite`);
    const created = await wsA.waitFor((e) => e.type === "message.create" && e.message?.id === pm.id).catch(() => null);
    const withPreview = await updateOf(pm.id, (m) => m.previews?.length === 1);
    const pv = withPreview?.message.previews[0];
    check("link previews: the message goes out at once, the preview follows as an update", created?.message.previews?.length === 0 && !!pv && withPreview.message.editedAt === null);
    check("link previews: title, description and site name from the page's head, decoded, one preview per address", pv?.kind === "page" && pv.url === `${SITE}/seite` && pv.title === "Rauchtest & Vorschau" && pv.description === 'Eine "Beschreibung"' && pv.siteName === "Rauchseite", JSON.stringify(pv));
    const img = pv?.image ? await api("GET", pv.image, undefined, undefined, true) : null;
    check("link previews: the picture is a copy on this server", /^\/api\/previews\/[0-9a-f]{32}\.png$/.test(pv?.image ?? "") && img?.status === 200 && img.headers.get("content-type") === "image/png" && img.headers.get("x-content-type-options") === "nosniff" && Buffer.from(await img.arrayBuffer()).equals(PNG), `${pv?.image} ${img?.status}`);
    check("link previews: the history carries it", (await stored(pm.id))?.previews?.[0]?.title === "Rauchtest & Vorschau");
    const [sBad] = await api("GET", "/api/previews/..%2f..%2f.env");
    const [sBad2] = await api("GET", `/api/previews/${"0".repeat(32)}.png`);
    check("link previews: only names of stored pictures are served", sBad === 404 && sBad2 === 404, `${sBad} ${sBad2}`);

    const [sRmOwner] = await api("POST", `/api/messages/${pm.id}/previews/remove`, { url: pv?.url }, owner.token);
    const [sRmWrong] = await api("POST", `/api/messages/${pm.id}/previews/remove`, { url: `${SITE}/anders` }, B.token);
    check("link previews: only the author removes one, and only one that is there", sRmOwner === 403 && sRmWrong === 404, `${sRmOwner} ${sRmWrong}`);
    const [sRm] = await api("POST", `/api/messages/${pm.id}/previews/remove`, { url: pv?.url }, B.token);
    const removed = await updateOf(pm.id, (m) => m.previews?.length === 0);
    check("link previews: the author removes it for everybody", sRm === 200 && !!removed && removed.message.editedAt === null);
    const hitsBefore = hits.length;
    await api("PATCH", `/api/messages/${pm.id}`, { content: `Schau: ${SITE}/seite und ${SITE}/zweite` }, B.token);
    const second = await updateOf(pm.id, (m) => m.previews?.length === 1 && m.previews[0].title === "Zweite Seite");
    check("link previews: an edit looks the new link up and leaves the removed one away", !!second && !hits.slice(hitsBefore).includes("/seite"), JSON.stringify(hits.slice(hitsBefore)));

    const [, quiet] = await post(`<${SITE}/seite> \`${SITE}/zweite\` ${SITE}/text ${SITE}/nach-innen`);
    await new Promise((r) => setTimeout(r, 1500));
    check("link previews: none for angle brackets, code, a text file and a redirect to the machine itself (never asked)", (await stored(quiet.id))?.previews?.length === 0 && insideHits === 0 && hits.includes("/nach-innen"), `${JSON.stringify((await stored(quiet.id))?.previews)} inside ${insideHits}`);

    const [, yt] = await post(`https://youtu.be/${YT_ID}?t=42`);
    const ytUpdate = await updateOf(yt.id, (m) => m.previews?.length === 1);
    const yp = ytUpdate?.message.previews[0];
    check("link previews: a youtube link becomes a video with title and a picture from this server", yp?.kind === "youtube" && yp.videoId === YT_ID && yp.start === 42 && typeof yp.title === "string" && yp.title.length > 0 && /^\/api\/previews\//.test(yp.image ?? ""), JSON.stringify(yp));
    const [sRmYt] = await api("POST", `/api/messages/${yt.id}/previews/remove`, { url: yp?.url }, B.token);
    check("link previews: the author removes the video too", sRmYt === 200 && !!(await updateOf(yt.id, (m) => m.previews?.length === 0)));
    for (const m of [pm, quiet, yt]) await api("DELETE", `/api/messages/${m.id}`, undefined, B.token);
    await new Promise((r) => site.close(r)); await new Promise((r) => inside.close(r));
  }
}

// Deleting: a mod may delete others' messages, the author their own
const [sd1] = await api("DELETE", `/api/messages/${page1.messages[1].id}`, undefined, B.token);
const evDel = await wsA.waitFor((e) => e.type === "message.delete" && e.id === page1.messages[1].id).catch(() => null);
check("mod deletes foreign message", sd1 === 200 && !!evDel);
const [sd2] = await api("DELETE", `/api/messages/${msg2.id}`, undefined, B.token);
const dlGone = await api("GET", att.url, undefined, undefined, true);
check("delete own message removes attachment", sd2 === 200 && dlGone.status === 404);

// Typing + voice channel
wsB.send({ type: "typing", channelId: textCh.id });
const evTyping = await wsA.waitFor((e) => e.type === "typing" && e.userId === B.userId).catch(() => null);
check("typing forwarded", !!evTyping);
const pVoiceJoin = waitNew(wsA, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === B.userId));
wsB.send({ type: "voice.join", channelId: voiceCh.id, micMuted: true });
const evVoice = await pVoiceJoin.catch(() => null);
check("voice.join broadcast", evVoice?.members[0]?.displayName === "Bea");
check("voice.join carries the mute state to everybody", evVoice?.members[0]?.micMuted === true && evVoice?.members[0]?.deafened === false);
// Mute and sound off reach the whole server through voice.status (docs/features/status-api.md), and the status API shows the seat.
const pVoiceSt = waitNew(wsA, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === B.userId && m.deafened === true));
wsB.send({ type: "voice.status", micMuted: true, deafened: true, screenOn: true });
const evVoiceSt = await pVoiceSt.catch(() => null);
check("voice.status broadcast (mute, sound, screen)", !!evVoiceSt && evVoiceSt.members.find((m) => m.userId === B.userId)?.screenOn === true);
// VIEW_VIDEO per channel (25 September 2026): voice.state says per member whether they may watch here, through the channel's
// overwrites, and comes again when those change, so the senders can restrict their video.
{
  const viewOf = (e) => e?.members.find((m) => m.userId === B.userId)?.viewVideo;
  const pDeny = waitNew(wsA, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && viewOf(e) === false);
  const [sd] = await api("PUT", `/api/channels/${voiceCh.id}/overwrites`, { overwrites: [{ targetType: "member", targetId: B.userId, allow: 0, deny: P.VIEW_VIDEO }] }, owner.token);
  const evDeny = await pDeny.catch(() => null);
  const pAllow = waitNew(wsA, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && viewOf(e) === true);
  const [sa] = await api("PUT", `/api/channels/${voiceCh.id}/overwrites`, { overwrites: [] }, owner.token);
  const evAllow = await pAllow.catch(() => null);
  check("voice.state: viewVideo per member follows the channel's overwrites (true, denied -> false, cleared -> true)", viewOf(evVoiceSt) === true && sd === 200 && !!evDeny && sa === 200 && !!evAllow, `${viewOf(evVoiceSt)} ${sd} ${!!evDeny} ${sa} ${!!evAllow}`);
}
await api("PATCH", "/api/settings", { statusApi: "public" }, owner.token);
const [, stSeat] = await api("GET", "/api/status");
const seatB = stSeat.members?.find((m) => m.userId === B.userId);
check("status api: the seated member with name and avatar, no key, no roles, no online flag", !!seatB && typeof seatB.displayName === "string" && seatB.publicKey === undefined && seatB.roleIds === undefined && seatB.avatarUrl === null && seatB.online === undefined && typeof seatB.afk === "boolean");
check("status api: the seat with its mute, camera and screen state", seatB?.voice?.channelId === voiceCh.id && seatB.voice.micMuted === true && seatB.voice.deafened === true && seatB.voice.cameraOn === false && seatB.voice.screenOn === true);
check("status api: only seated members, the owner outside every voice channel is not listed", stSeat.members.every((m) => m.voice && typeof m.voice.channelId === "string") && !stSeat.members.some((m) => m.userId === owner.userId));
await api("PATCH", "/api/settings", { statusApi: "off" }, owner.token);
wsB.send({ type: "voice.join", channelId: textCh.id });
const evVoiceErr = await wsB.waitFor((e) => e.type === "error" && e.code === "unknown_channel").catch(() => null);
check("voice.join text channel rejected", !!evVoiceErr);
const [srt] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, B.token);
const [srt2] = await api("POST", "/api/rtc-token", { channelId: textCh.id }, B.token);
check("rtc-token voice only", srt === 200 && srt2 === 404);
// M3: camera/screen only with STREAM_VIDEO; LiveKit enforces this via canPublishSources in the token.
const grantOf = (tok) => JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).video;
const [, ownerTok] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, owner.token);
check("rtc-token owner: mic+camera+screen+screen audio", ["microphone", "camera", "screen_share", "screen_share_audio"].every((x) => grantOf(ownerTok.token).canPublishSources?.includes(x)));
await api("PATCH", `/api/roles/${memberRole.id}`, { permissions: memberRole.permissions & ~P.STREAM_VIDEO }, owner.token);
const [, bTok] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, B.token);
check("rtc-token ohne STREAM_VIDEO: nur Mikrofon", JSON.stringify(grantOf(bTok.token).canPublishSources) === JSON.stringify(["microphone"]));
await api("PATCH", `/api/roles/${memberRole.id}`, { permissions: memberRole.permissions }, owner.token);
// VIEW_VIDEO (guests lack it, "Mitglied" has it): the app server only reports it (`me`, roles); the senders' clients
// restrict their tracks at LiveKit. Voice itself stays allowed.
const [, stView] = await api("GET", "/api/state", undefined, B.token);
await api("PATCH", `/api/roles/${memberRole.id}`, { permissions: memberRole.permissions & ~P.VIEW_VIDEO }, owner.token);
const [, stNoView] = await api("GET", "/api/state", undefined, B.token);
const [sNoView] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, B.token);
check("VIEW_VIDEO via Mitglied; without it: state reports it, voice token still issued", (stView.myPermissions & P.VIEW_VIDEO) !== 0 && (stNoView.myPermissions & P.VIEW_VIDEO) === 0 && sNoView === 200);
await api("PATCH", `/api/roles/${memberRole.id}`, { permissions: memberRole.permissions }, owner.token);

// ---------- Voice channel moderation (M3): move, stop camera/screen, block streaming
const [, voiceCh2] = await api("POST", "/api/channels", { kind: "voice", name: "smoke-voice-2", categoryId: cat.id }, owner.token);
const [smv0] = await api("POST", `/api/members/${owner.userId}/move`, { channelId: voiceCh2.id }, B.token);
check("move without MODERATE_VOICE rejected", smv0 === 403);
const [smv1] = await api("POST", `/api/members/${B.userId}/move`, { channelId: voiceCh2.id }, owner.token);
const evMoved = await wsB.waitFor((e) => e.type === "voice.moved").catch(() => null);
check("move -> voice.moved at target", smv1 === 200 && evMoved?.channelId === voiceCh2.id && typeof evMoved.by === "string");
const [sst] = await api("POST", `/api/members/${B.userId}/stream/stop`, {}, owner.token);
const evStop = await wsB.waitFor((e) => e.type === "voice.stop").catch(() => null);
check("stop streams -> voice.stop at target", sst === 200 && evStop?.camera === true && evStop?.screen === true);
const [sblk] = await api("PUT", `/api/members/${B.userId}/stream`, { blocked: true }, owner.token);
const evMeBlocked = await wsB.waitFor((e) => e.type === "me" && (e.myPermissions & P.STREAM_VIDEO) === 0).catch(() => null);
const [, blockedTok] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, B.token);
const [, stBlocked] = await api("GET", "/api/state", undefined, owner.token);
check("stream block: me without STREAM_VIDEO, token mic only, member flag", sblk === 200 && !!evMeBlocked
  && JSON.stringify(grantOf(blockedTok.token).canPublishSources) === JSON.stringify(["microphone"])
  && stBlocked.members.find((x) => x.userId === B.userId)?.streamBlocked === true);
await api("PUT", `/api/members/${B.userId}/stream`, { blocked: false }, owner.token);
const [, unblockedTok] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, B.token);
check("stream unblock restores camera grant", grantOf(unblockedTok.token).canPublishSources?.includes("camera"));
const [smv2] = await api("POST", `/api/members/${B.userId}/move`, { channelId: null }, owner.token);
const evMovedOut = await wsB.waitFor((e) => e.type === "voice.moved" && e.channelId === null).catch(() => null);
check("move out of voice -> voice.moved null", smv2 === 200 && !!evMovedOut);

// ---------- AFK detection: status from the connections' activity reports, AFK channel (setting, silent token, no radio, move)
const [saf0] = await api("PATCH", "/api/settings", { afkChannelId: voiceCh2.id }, B.token);
const [saf1] = await api("PATCH", "/api/settings", { afkChannelId: textCh.id }, owner.token);
const [saf3] = await api("PATCH", "/api/settings", { afkChannelId: voiceCh2.id }, owner.token);
const [, stAfk] = await api("GET", "/api/state", undefined, owner.token);
check("afk channel: MANAGE_SERVER and a voice channel; no time of its own per server", saf0 === 403 && saf1 === 400 && saf3 === 200
  && stAfk.settings.afkChannelId === voiceCh2.id && stAfk.settings.afkMoveMinutes === undefined && wsA.welcome.state.settings.afkChannelId === null, `${saf0} ${saf1} ${saf3}`);
const [, afkTok] = await api("POST", "/api/rtc-token", { channelId: voiceCh2.id }, owner.token);
const [srAfk, radioAfk] = await api("PUT", `/api/channels/${voiceCh2.id}/radio`, { url: streamUrl }, owner.token);
check("afk channel: token without publish and subscribe grants, no radio", grantOf(afkTok.token).canPublish === false && grantOf(afkTok.token).canSubscribe === false && grantOf(afkTok.token).roomJoin === true
  && srAfk === 409 && radioAfk.error === "afk_channel", `${JSON.stringify(grantOf(afkTok.token))} ${srAfk}`);
const afkMoves = () => wsB.events.filter((e) => e.type === "voice.moved" && e.reason === "afk").length;
const nextAfkMove = (n, ms) => wsB.waitFor((e) => e.type === "voice.moved" && e.reason === "afk" && afkMoves() > n, ms).catch(() => null);
const afkStateOfB = (afk, from) => wsA.waitFor((e) => e.type === "structure" && e.members?.find((x) => x.userId === B.userId)?.afk === afk && wsA.events.indexOf(e) >= from).catch(() => null);
wsB.send({ type: "voice.join", channelId: voiceCh.id });
await wsB.waitFor((e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === B.userId) && wsB.events.indexOf(e) >= wsB.events.length - 1).catch(() => null);
let mark = wsA.events.length;
wsB.send({ type: "activity", idle: true });
const evAfkOn = await afkStateOfB(true, mark);
const evAfkMove = await nextAfkMove(0, 7000);
check("idle on every connection -> member afk for everyone, moved to the afk channel", !!evAfkOn && evAfkMove?.channelId === voiceCh2.id, JSON.stringify(evAfkMove));
mark = wsA.events.length;
wsB.send({ type: "activity", idle: false });
const evAfkOff = await afkStateOfB(false, mark);
// Nobody is moved out of a channel that shows a video; once it ends, the next sweep moves them.
await api("PUT", `/api/channels/${voiceCh.id}/radio`, { url: "https://twitch.tv/squorli_test" }, owner.token);
wsB.send({ type: "activity", idle: true });
const evAfkVideo = await nextAfkMove(1, 1500);
await api("DELETE", `/api/channels/${voiceCh.id}/radio`, undefined, owner.token);
const evAfkAfterVideo = await nextAfkMove(1, 8000);
check("activity ends the absence; a channel showing a video keeps its absent members until the video ends", !!evAfkOff && evAfkVideo === null && evAfkAfterVideo?.channelId === voiceCh2.id, `back ${!!evAfkOff}, moved during the video ${!!evAfkVideo}, moved after it ${!!evAfkAfterVideo}`);
wsB.send({ type: "activity", idle: false });
wsB.send({ type: "voice.leave" });
await api("DELETE", `/api/channels/${voiceCh2.id}`, undefined, owner.token);
const [, stAfkGone] = await api("GET", "/api/state", undefined, owner.token);
check("deleting the afk channel clears the setting", stAfkGone.settings.afkChannelId === null, String(stAfkGone.settings.afkChannelId));

// ---------- Game display: a connection reports what its member plays with the activity state; the server relays it to everybody
const gameOfB = (test, from, ms = 9000) => wsA.waitFor((e) => e.type === "structure" && test(e.members?.find((x) => x.userId === B.userId)?.game) && wsA.events.indexOf(e) >= from, ms).catch(() => null);
mark = wsA.events.length;
wsB.send({ type: "activity", idle: true, game: { id: "steam:730", name: " Counter-Strike 2 " } });
const evGameOn = await gameOfB((g) => g?.id === "steam:730" && g?.name === "Counter-Strike 2", mark);
const memberB = evGameOn?.members.find((x) => x.userId === B.userId);
check("a reported game reaches every member, next to the afk state", !!evGameOn && memberB?.afk === true, JSON.stringify(memberB?.game ?? null));
// An id that is no launcher's (the path of an added program) is refused as a whole; a name alone is fine.
mark = wsB.events.length;
wsB.send({ type: "activity", idle: false, game: { id: "custom:d:\\games\\x.exe", name: "X" } });
const evGameBad = await wsB.waitFor((e) => e.type === "error" && e.code === "bad_message" && wsB.events.indexOf(e) >= mark, 3000).catch(() => null);
mark = wsA.events.length;
wsB.send({ type: "activity", idle: false, game: { name: "Altes Spiel" } });
const evGameName = await gameOfB((g) => g?.name === "Altes Spiel" && g?.id === undefined, mark); // a second change within seconds waits for its turn
check("an id that is no launcher's is refused, a game by name alone is relayed", !!evGameBad && !!evGameName, `refused ${!!evGameBad}, relayed ${!!evGameName}`);
mark = wsA.events.length;
wsB.send({ type: "activity", idle: false }); // says nothing about games: the game stays
const evGameKept = await gameOfB((g) => g === null, mark, 2000);
const [, stGame] = await api("GET", "/api/state", undefined, owner.token);
check("a report without the field leaves the game alone", stGame.members.find((x) => x.userId === B.userId)?.game?.name === "Altes Spiel" && !evGameKept, JSON.stringify(stGame.members.find((x) => x.userId === B.userId)?.game ?? null));
mark = wsA.events.length;
wsB.send({ type: "activity", idle: false, game: null });
check("no game any more -> gone for everybody", !!(await gameOfB((g) => g === null, mark)));

// ---------- Kick / ban
const keyC = await newKey();
const C = await login(keyC, invite.code);
check("second invite use", C.status === 200);
const keyD = await newKey();
const D = await login(keyD, invite.code);
check("invite exhausted", D.status === 403 && D.body.error === "invite_invalid");
const wsC = await connectWs(C.token);
const removedP = wsC.waitFor((e) => e.type === "removed");
const [sk] = await api("DELETE", `/api/members/${C.userId}`, undefined, B.token);
const removed = await removedP.catch(() => null);
await wsC.closed();
const [skState] = await api("GET", "/api/state", undefined, C.token);
check("kick: removed event, socket closed, no longer member", sk === 200 && removed?.reason === "kicked" && skState === 403);
const [sinv2, invite2] = await api("POST", "/api/invites", {}, owner.token);
const [sbn] = await api("POST", "/api/bans", { userId: C.userId, reason: "Rauchtest" }, owner.token);
const Cagain = await login(keyC, invite2.code);
check("ban blocks re-join", sinv2 === 200 && sbn === 200 && Cagain.status === 403 && Cagain.body.error === "banned");
const [sbl, banList] = await api("GET", "/api/bans", undefined, owner.token);
check("ban list", sbl === 200 && banList.some((b) => b.userId === C.userId && b.reason === "Rauchtest"));
const [sub] = await api("DELETE", `/api/bans/${C.userId}`, undefined, owner.token);
const Cback = await login(keyC, invite2.code);
check("unban + rejoin", sub === 200 && Cback.status === 200);
const [sbanSelf] = await api("POST", "/api/bans", { userId: owner.userId }, owner.token);
check("cannot ban self", sbanSelf === 400);

// ---------- Account deletion via the directory (signed server-leave there): the directory pushes /api/directory/leave, the server
// confirms with its token and deletes the user (ws close 4012, token dead, member gone); the first owner is refused.
if (health0.directoryUrl) {
  const dir = health0.directoryUrl;
  const dj = async (method, path, body) => { const r = await fetch(dir + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json().catch(() => ({}))]; };
  const [, dh] = await dj("GET", "/api/health");
  const dsigned = async (key, action, path, payload, extra = {}) => {
    const [, ch] = await dj("POST", "/api/challenge", { publicKey: key.publicKey });
    const signature = hex(await ed.signAsync(new TextEncoder().encode(`community-directory-${action}\n${dh.host}\n${ch.nonce}\n${payload}`), key.priv));
    return dj("POST", path, { publicKey: key.publicKey, challengeId: ch.challengeId, signature, ...extra });
  };
  const host = health0.domain.toLowerCase();
  const [, chC] = await dj("POST", "/api/challenge", { publicKey: keyC.publicKey });
  const handleC = `smokeleave_${keyC.publicKey.slice(0, 6)}`;
  const sigC = hex(await ed.signAsync(new TextEncoder().encode(`community-directory-register\n${dh.host}\n${handleC}\n${chC.nonce}`), keyC.priv));
  const [srC] = await dj("POST", "/api/register", { handle: handleC, publicKey: keyC.publicKey, challengeId: chC.challengeId, signature: sigC });
  const Cl = await login(keyC); // the sign-in makes the server look the key up with its token = listed at the directory
  const wsCl = await connectWs(Cl.token);
  check("leave: handle for C, signed in, listed at the directory", (srC === 201 || srC === 409) && Cl.status === 200 && wsCl.welcome.type === "welcome", `${srC} ${Cl.status}`);
  const [slo, rlo] = await dsigned(ownerKey, "server-leave", "/api/servers/leave", host, { server: host });
  const [smeO] = await api("GET", "/api/me", undefined, owner.token);
  check("leave: first owner refused (409 founder), owner untouched", slo === 409 && rlo.error === "founder" && smeO === 200, `${slo} ${rlo.error ?? ""}`);
  const [slc, rlc] = await dsigned(keyC, "server-leave", "/api/servers/leave", host, { server: host });
  const closeC = await wsCl.closed();
  const [smeC] = await api("GET", "/api/me", undefined, Cl.token);
  const [, stL] = await api("GET", "/api/state", undefined, owner.token);
  check("leave: delivered, ws closed 4012, token dead, member gone", slc === 200 && rlc.delivered === true && closeC === 4012 && smeC === 401 && !stL.members.some((m) => m.userId === C.userId),
    `${slc} ${JSON.stringify(rlc)} close ${closeC} me ${smeC}`);
  const [, dst] = await dsigned(keyC, "account-status", "/api/account/status", "");
  check("leave: server gone from the account's server list", Array.isArray(dst.servers) && !dst.servers.some((s) => s.host === host), JSON.stringify(dst.servers));
  const Cnew = await login(keyC, invite2.code);
  check("leave: joining again afterwards creates a new user", Cnew.status === 200 && Cnew.userId !== C.userId, `${Cnew.status}`);
  await api("DELETE", `/api/members/${Cnew.userId}`, undefined, owner.token);
}

// ---------- Channel permissions (docs/features/channel-permissions.md): overwrites, hard visibility, the write rules,
// slowmode, the user limit, sticky channels, a move into an invisible channel, eviction, the AFK guards.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const [, invP] = await api("POST", "/api/invites", {}, owner.token);
  const G = await login(await newKey(), invP.code); // a guest: the default role only
  const wsG = await connectWs(G.token);
  const gState = async () => (await api("GET", "/api/state", undefined, G.token))[1];
  const [spc, privCh] = await api("POST", "/api/channels", { kind: "text", name: "smoke-private", categoryId: cat.id }, owner.token);
  const [spv, privVoice] = await api("POST", "/api/channels", { kind: "voice", name: "smoke-sticky", categoryId: cat.id, sticky: true, stickyPersist: true, stickyHideVoice: false, userLimit: 1 }, owner.token);
  check("channel perms: channel settings round-trip", spc === 200 && spv === 200 && privVoice.sticky === true && privVoice.stickyPersist === true && privVoice.stickyHideVoice === false && privVoice.userLimit === 1 && privVoice.slowmodeSeconds === 0 && privVoice.defaultNotify === "all" && privVoice.private === false, JSON.stringify({ sticky: privVoice.sticky, hide: privVoice.stickyHideVoice, limit: privVoice.userLimit, notify: privVoice.defaultNotify }));
  const stG0 = await gState();
  check("channel perms: state carries myChannelPermissions (visible channels only) and the guest sees the new channel", !!stG0.myChannelPermissions && (stG0.myChannelPermissions[privCh.id] & P.VIEW_CHANNELS) !== 0 && stG0.channels.some((c) => c.id === privCh.id) && stG0.myVoiceLock === null && stG0.channels.every((c) => c.private === false));
  const everyoneDeny = (perm) => ({ targetType: "role", targetId: defaultRole.id, allow: 0, deny: perm });
  // ---- Private: the default role may not see it. The guest's structure loses it, the state leaves it out, and nothing of it reaches them.
  const [so1, ro1] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS)] }, owner.token);
  const evGone = await wsG.waitFor((e) => e.type === "structure" && e.channels && !e.channels.some((c) => c.id === privCh.id)).catch(() => null);
  const stG1 = await gState();
  const [, stO1] = await api("GET", "/api/state", undefined, owner.token);
  check("channel perms: private channel vanishes from the guest's structure and state, the owner keeps it with the lock", so1 === 200 && ro1.overwrites.length === 1 && evGone !== null && !stG1.channels.some((c) => c.id === privCh.id) && stG1.myChannelPermissions[privCh.id] === undefined && stO1.channels.find((c) => c.id === privCh.id)?.private === true, `${so1} ${evGone ? "gone" : "no structure"}`);
  const [sh1] = await api("GET", `/api/channels/${privCh.id}/messages`, undefined, G.token);
  const [, rs1] = await api("GET", "/api/read-state", undefined, G.token);
  const [sp1] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "hallo?" }, G.token);
  const [sr1] = await api("POST", `/api/channels/${privCh.id}/read`, { seq: 1 }, G.token);
  const [sow1] = await api("GET", `/api/channels/${privCh.id}/overwrites`, undefined, G.token);
  check("channel perms: an invisible channel answers 404 everywhere (never 403) and is out of the read state", sh1 === 404 && sp1 === 404 && sr1 === 404 && sow1 === 404 && rs1.channels.every((c) => c.channelId !== privCh.id), `${sh1} ${sp1} ${sr1} ${sow1}`);
  const [sm1, pm] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "geheim" }, owner.token);
  const gotA = await wsA.waitFor((e) => e.type === "message.create" && e.message.id === pm.id).catch(() => null);
  await sleep(300);
  check("channel perms: the message reaches the owner's socket, not the guest's", sm1 === 200 && gotA !== null && !wsG.events.some((e) => e.type === "message.create" && e.message?.id === pm.id));
  // The status API shows one role's view: the default role by default, any other role when the admin picks it.
  await api("PATCH", "/api/settings", { statusApi: "public" }, owner.token);
  const [sst, stPub] = await api("GET", "/api/status");
  check("channel perms: the status API leaves the private channel out", sst === 200 && !stPub.channels.some((c) => c.id === privCh.id) && stPub.channels.some((c) => c.id === textCh.id));
  // From the moderator role's view the same channel is in, once that role may see it (user's wish, 23 September 2026).
  await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS), { targetType: "role", targetId: modRole.id, allow: P.VIEW_CHANNELS, deny: 0 }] }, owner.token);
  const [ssr0] = await api("PATCH", "/api/settings", { statusApiRoleId: modRole.id }, owner.token);
  const [, stMod] = await api("GET", "/api/status");
  const [, stSettings] = await api("GET", "/api/state", undefined, owner.token);
  const [ssr1] = await api("PATCH", "/api/settings", { statusApiRoleId: "00000000-0000-0000-0000-000000000000" }, owner.token);
  const [ssr2] = await api("PATCH", "/api/settings", { statusApiRoleId: modRole.id }, B.token);
  await api("PATCH", "/api/settings", { statusApiRoleId: null }, owner.token);
  const [, stBack] = await api("GET", "/api/status");
  check("channel perms: the status API answers from the chosen role's view (unknown role 400, MANAGE_SERVER only, null = default role)",
    ssr0 === 200 && stMod.channels.some((c) => c.id === privCh.id) && stSettings.settings.statusApiRoleId === modRole.id
    && ssr1 === 400 && ssr2 === 403 && !stBack.channels.some((c) => c.id === privCh.id),
    `${ssr0} ${ssr1} ${ssr2} mod=${stMod.channels.some((c) => c.id === privCh.id)} back=${stBack.channels.some((c) => c.id === privCh.id)}`);
  await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS)] }, owner.token);
  await api("PATCH", "/api/settings", { statusApi: "off" }, owner.token);
  // ---- A member allow brings it back, with its history.
  const [so2] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS), { targetType: "member", targetId: G.userId, allow: P.VIEW_CHANNELS, deny: 0 }] }, owner.token);
  const evBack = await wsG.waitFor((e) => e.type === "structure" && e.channels?.some((c) => c.id === privCh.id)).catch(() => null);
  const [sh2, hist2] = await api("GET", `/api/channels/${privCh.id}/messages`, undefined, G.token);
  check("channel perms: a member allow makes it reappear within one structure, history included", so2 === 200 && evBack !== null && sh2 === 200 && hist2.messages.some((m) => m.id === pm.id));
  // ---- Write rules: the right to manage the channel, only channel bits, only what one holds, no locking oneself out.
  const [sw0] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [] }, G.token);
  const [sw1, rw1] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [{ targetType: "role", targetId: modRole.id, allow: 32, deny: 0 }] }, owner.token); // BAN_MEMBERS is no channel right
  const [sw2, rw2] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [{ targetType: "role", targetId: modRole.id, allow: P.VIEW_CHANNELS, deny: P.VIEW_CHANNELS }] }, owner.token);
  // B manages this one channel by overwrite (server-wide B has no MANAGE_CHANNELS), may then hand out what B has here, not more.
  await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS), { targetType: "member", targetId: G.userId, allow: P.VIEW_CHANNELS, deny: 0 }, { targetType: "member", targetId: B.userId, allow: P.VIEW_CHANNELS | P.MANAGE_CHANNELS, deny: 0 }] }, owner.token);
  const [sw3, rw3] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS), { targetType: "member", targetId: B.userId, allow: P.VIEW_CHANNELS | P.MANAGE_CHANNELS, deny: 0 }, { targetType: "member", targetId: G.userId, allow: P.VIEW_CHANNELS | P.CONTROL_RADIO, deny: 0 }] }, B.token);
  const [sw4, rw4] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS)] }, B.token); // would leave B without the channel
  const [sw5] = await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS), { targetType: "member", targetId: B.userId, allow: P.VIEW_CHANNELS | P.MANAGE_CHANNELS, deny: 0 }, { targetType: "member", targetId: G.userId, allow: P.VIEW_CHANNELS | P.SEND_MESSAGES, deny: 0 }] }, B.token);
  check("channel perms: write rules (403 without the right, 400 not_channel_permission, 400 allow&deny, 403 cannot_grant, 409 would_lock_out, 200 within one's rights)",
    sw0 === 403 && sw1 === 400 && rw1.error === "not_channel_permission" && sw2 === 400 && sw3 === 403 && rw3.error === "cannot_grant" && sw4 === 409 && rw4.error === "would_lock_out" && sw5 === 200, `${sw0} ${sw1} ${sw2} ${sw3} ${sw4} ${sw5}`);
  // ---- Read-only by the everyone deny; slowmode with the exemption.
  await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS | P.SEND_MESSAGES), { targetType: "member", targetId: G.userId, allow: P.VIEW_CHANNELS, deny: 0 }] }, owner.token);
  const [sro] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "darf ich?" }, G.token);
  await api("PUT", `/api/channels/${privCh.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS), { targetType: "member", targetId: G.userId, allow: P.VIEW_CHANNELS | P.SEND_MESSAGES, deny: 0 }] }, owner.token);
  const [ssl] = await api("PATCH", `/api/channels/${privCh.id}`, { slowmodeSeconds: 1 }, owner.token);
  const [ss1] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "eins" }, G.token);
  const [ss2, rss2] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "zwei" }, G.token);
  const [ssO] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "owner exempt" }, owner.token);
  await sleep(1100);
  const [ss3] = await api("POST", `/api/channels/${privCh.id}/messages`, { content: "drei" }, G.token);
  check("channel perms: read-only = a SEND_MESSAGES deny (403); slowmode 429 with retryAfter, then 200; MANAGE_MESSAGES exempt", sro === 403 && ssl === 200 && ss1 === 200 && ss2 === 429 && rss2.error === "slowmode" && rss2.retryAfter >= 1 && ssO === 200 && ss3 === 200, `${sro} ${ss1} ${ss2} ${ssO} ${ss3}`);
  // ---- User limit: the owner takes the one seat, the guest gets channel_full; a moderator's move ignores the limit (below).
  wsA.send({ type: "voice.join", channelId: privVoice.id });
  await wsA.waitFor((e) => e.type === "voice.state" && e.channelId === privVoice.id && e.members.some((m) => m.userId === owner.userId));
  const [sfull, rfull] = await api("POST", "/api/rtc-token", { channelId: privVoice.id }, G.token);
  wsA.send({ type: "voice.leave" });
  await wsA.waitFor((e) => e.type === "voice.state" && e.channelId === privVoice.id && e.members.length === 0);
  check("channel perms: user limit answers 409 channel_full", sfull === 409 && rfull.error === "channel_full");
  await api("PATCH", `/api/channels/${privVoice.id}`, { userLimit: null }, owner.token);
  // ---- Sticky: the guest joins the sticky channel and is held: no token for another channel, the lock in the state, other
  // voice channels gone from the list (text channels stay), the hold survives a reconnect (stickyPersist), a move frees.
  const [stk0] = await api("POST", "/api/rtc-token", { channelId: privVoice.id }, G.token);
  wsG.send({ type: "voice.join", channelId: privVoice.id });
  await wsG.waitFor((e) => e.type === "voice.state" && e.channelId === privVoice.id && e.members.some((m) => m.userId === G.userId));
  const evLock = await wsG.waitFor((e) => e.type === "me" && e.myVoiceLock?.channelId === privVoice.id).catch(() => null);
  const [stk1, rtk1] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, G.token);
  const stG2 = await gState();
  check("channel perms: sticky holds (403 confined with the lock, myVoiceLock in the state, the other channel still listed)", stk0 === 200 && evLock !== null && stk1 === 403 && rtk1.error === "confined" && rtk1.lock?.channelId === privVoice.id && stG2.myVoiceLock?.channelId === privVoice.id && stG2.myVoiceLock.hideVoice === false && stG2.channels.some((c) => c.id === voiceCh.id), `${stk0} ${stk1} ${rtk1.error ?? ""}`);
  // stickyHideVoice: the other voice channels leave the held member's list (text channels stay), and are a 404 from then on.
  const [shv] = await api("PATCH", `/api/channels/${privVoice.id}`, { stickyHideVoice: true }, owner.token);
  const evHide = await wsG.waitFor((e) => e.type === "structure" && e.channels && !e.channels.some((c) => c.id === voiceCh.id)).catch(() => null);
  const stG2b = await gState();
  const [stk1b] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, G.token);
  check("channel perms: stickyHideVoice hides the other voice channels (text channels stay), they answer 404", shv === 200 && evHide !== null && stG2b.myVoiceLock?.hideVoice === true && !stG2b.channels.some((c) => c.id === voiceCh.id) && stG2b.channels.some((c) => c.id === textCh.id) && stG2b.channels.some((c) => c.id === privVoice.id) && stk1b === 404, `${shv} ${stk1b}`);
  await wsG.close();
  await sleep(200);
  const stG3 = await gState();
  const [stk2] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, G.token);
  const [stk3] = await api("POST", "/api/rtc-token", { channelId: privVoice.id }, G.token);
  check("channel perms: with stickyPersist the hold outlives the connection (the way back stays open)", stG3.myVoiceLock?.channelId === privVoice.id && stk2 === 404 && stk3 === 200, `${stk2} ${stk3}`);
  const wsG2 = await connectWs(G.token);
  check("channel perms: the welcome carries the lock", wsG2.welcome.state.myVoiceLock?.channelId === privVoice.id);
  wsG2.send({ type: "voice.join", channelId: privVoice.id });
  await wsG2.waitFor((e) => e.type === "voice.state" && e.channelId === privVoice.id && e.members.some((m) => m.userId === G.userId));
  const [smv0] = await api("POST", `/api/members/${G.userId}/move`, { channelId: voiceCh.id }, B.token); // B: MODERATE_VOICE? no, and no MOVE_MEMBERS
  const [smv1] = await api("POST", `/api/members/${G.userId}/move`, { channelId: voiceCh.id }, owner.token);
  const evFree = await wsG2.waitFor((e) => e.type === "me" && e.myVoiceLock === null).catch(() => null);
  const evMoved = await wsG2.waitFor((e) => e.type === "voice.moved" && e.channelId === voiceCh.id).catch(() => null);
  const [stk4] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, G.token);
  check("channel perms: only MOVE_MEMBERS moves (403 for B), a move frees the hold and the other channels", smv0 === 403 && smv1 === 200 && evFree !== null && evMoved !== null && stk4 === 200, `${smv0} ${smv1}`);
  wsG2.send({ type: "voice.join", channelId: voiceCh.id });
  await wsG2.waitFor((e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === G.userId));
  // ---- The AFK channel may be neither sticky nor private.
  const [safk1, rafk1] = await api("PATCH", "/api/settings", { afkChannelId: privVoice.id }, owner.token);
  const [safk2, rafk2] = await api("PATCH", "/api/settings", { afkChannelId: privCh.id }, owner.token); // a text channel anyway: 400
  check("channel perms: a sticky channel cannot be the AFK channel", safk1 === 409 && rafk1.error === "afk_channel_sticky" && safk2 === 400, `${safk1} ${rafk1.error ?? ""} ${safk2}`);
  // ---- A move into a channel the member may not see: the owner makes the sticky channel private, moves the guest in.
  await api("PATCH", `/api/channels/${privVoice.id}`, { sticky: false }, owner.token);
  await api("PUT", `/api/channels/${privVoice.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS)] }, owner.token);
  const stG4 = await gState();
  const [smv2] = await api("POST", `/api/members/${G.userId}/move`, { channelId: privVoice.id }, owner.token);
  const evSee = await wsG2.waitFor((e) => e.type === "structure" && e.channels?.some((c) => c.id === privVoice.id)).catch(() => null);
  const evMoved2 = await wsG2.waitFor((e) => e.type === "voice.moved" && e.channelId === privVoice.id).catch(() => null);
  const [stk5] = await api("POST", "/api/rtc-token", { channelId: privVoice.id }, G.token);
  wsG2.send({ type: "voice.join", channelId: privVoice.id });
  const evSeat = await wsG2.waitFor((e) => e.type === "voice.state" && e.channelId === privVoice.id && e.members.some((m) => m.userId === G.userId)).catch(() => null);
  check("channel perms: a move into an invisible channel: the channel arrives first, the token and the join pass, the seat keeps it visible", !stG4.channels.some((c) => c.id === privVoice.id) && smv2 === 200 && evSee !== null && evMoved2 !== null && stk5 === 200 && evSeat !== null, `${smv2} ${stk5}`);
  // A permission change does not throw out somebody a moderator placed: the placed guest stays while the everyone deny lands.
  const [sev0] = await api("PUT", `/api/channels/${privVoice.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS | P.CONNECT_VOICE)] }, owner.token);
  await sleep(300);
  const placedStays = !wsG2.events.some((e) => e.type === "voice.moved" && e.channelId === null);
  const movedMark = wsG2.events.length;
  const [smv3] = await api("POST", `/api/members/${G.userId}/move`, { channelId: voiceCh.id }, owner.token);
  await wsG2.waitFor((e) => e.type === "voice.moved" && e.channelId === voiceCh.id && wsG2.events.indexOf(e) >= movedMark).catch(() => null);
  // The client follows the move (that join uses the grant up and is a placement), then leaves and comes back on its own:
  // a seat taken by oneself, which the eviction below applies to. Every step waits for its own fresh event, otherwise the
  // PUT below could reach the server before the join did.
  let p1 = waitNew(wsG2, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === G.userId));
  wsG2.send({ type: "voice.join", channelId: voiceCh.id });
  await p1;
  p1 = waitNew(wsG2, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && !e.members.some((m) => m.userId === G.userId));
  wsG2.send({ type: "voice.leave" });
  await p1;
  p1 = waitNew(wsG2, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === G.userId));
  wsG2.send({ type: "voice.join", channelId: voiceCh.id });
  await p1;
  await sleep(200);
  // ---- Eviction: whoever loses CONNECT_VOICE (or the channel) while seated is put out (voice.moved null); B keeps it by a role allow.
  const bMovedBefore = wsB.events.filter((e) => e.type === "voice.moved" && e.channelId === null).length;
  const [sev] = await api("PUT", `/api/channels/${voiceCh.id}/overwrites`, { overwrites: [everyoneDeny(P.CONNECT_VOICE), { targetType: "role", targetId: modRole.id, allow: P.CONNECT_VOICE, deny: 0 }] }, owner.token);
  const evOut = await wsG2.waitFor((e) => e.type === "voice.moved" && e.channelId === null).catch(() => null);
  await sleep(200);
  const bMovedAfter = wsB.events.filter((e) => e.type === "voice.moved" && e.channelId === null).length;
  check("channel perms: a placed member stays through a permission change; losing CONNECT_VOICE on one's own seat = voice.moved out; a role allow keeps B inside", sev0 === 200 && placedStays && smv3 === 200 && sev === 200 && evOut !== null && bMovedAfter === bMovedBefore, `${sev0} ${placedStays} ${sev} ${evOut ? "evicted" : "still there"} B ${bMovedBefore}->${bMovedAfter}`);
  await api("PUT", `/api/channels/${voiceCh.id}/overwrites`, { overwrites: [] }, owner.token);
  // ---- BYPASS_STICKY: given by overwrite, the guest is not held.
  await api("PUT", `/api/channels/${privVoice.id}/overwrites`, { overwrites: [{ targetType: "member", targetId: G.userId, allow: P.BYPASS_STICKY, deny: 0 }] }, owner.token);
  await api("PATCH", `/api/channels/${privVoice.id}`, { sticky: true }, owner.token);
  wsG2.send({ type: "voice.join", channelId: privVoice.id });
  await wsG2.waitFor((e) => e.type === "voice.state" && e.channelId === privVoice.id && e.members.some((m) => m.userId === G.userId));
  await sleep(200);
  const [stk6] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, G.token);
  check("channel perms: BYPASS_STICKY by overwrite: not held", stk6 === 200 && (await gState()).myVoiceLock === null, `${stk6}`);
  wsG2.send({ type: "voice.leave" });
  // ---- Category overwrites inherit live: a deny on the category hides its channels, a channel allow undoes it for that one.
  const [scat] = await api("PUT", `/api/categories/${cat.id}/overwrites`, { overwrites: [everyoneDeny(P.VIEW_CHANNELS)] }, owner.token);
  const evCat = await wsG2.waitFor((e) => e.type === "structure" && e.channels && !e.channels.some((c) => c.id === textCh.id)).catch(() => null);
  const [scat2] = await api("PUT", `/api/channels/${textCh.id}/overwrites`, { overwrites: [{ targetType: "role", targetId: defaultRole.id, allow: P.VIEW_CHANNELS, deny: 0 }] }, owner.token);
  const evCat2 = await wsG2.waitFor((e) => e.type === "structure" && e.channels?.some((c) => c.id === textCh.id)).catch(() => null);
  const [, sow] = await api("GET", `/api/categories/${cat.id}/overwrites`, undefined, owner.token);
  check("channel perms: a category deny hides its channels for the guest, a channel allow brings one back; GET reads the category's list", scat === 200 && evCat !== null && scat2 === 200 && evCat2 !== null && sow.overwrites.length === 1, `${scat} ${scat2}`);
  await api("PUT", `/api/categories/${cat.id}/overwrites`, { overwrites: [] }, owner.token);
  await api("PUT", `/api/channels/${textCh.id}/overwrites`, { overwrites: [] }, owner.token);
  // ---- Cleanup of this section.
  await wsG2.close();
  await api("DELETE", `/api/channels/${privCh.id}`, undefined, owner.token);
  await api("DELETE", `/api/channels/${privVoice.id}`, undefined, owner.token);
  await api("DELETE", `/api/members/${G.userId}`, undefined, owner.token);
  await api("DELETE", `/api/invites/${invP.code}`, undefined, owner.token);
}

// ---------- Vote kick (docs/features/votekick.md): three guests in a voice channel, nobody who may throw anybody out.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const [, invV] = await api("POST", "/api/invites", {}, owner.token);
  const guests = [];
  for (let i = 0; i < 3; i++) {
    const g = await login(await newKey(), invV.code);
    guests.push({ ...g, ws: await connectWs(g.token) });
  }
  const [g1, g2, g3] = guests;
  const [svk, vkCh] = await api("POST", "/api/channels", { kind: "voice", name: "smoke-vote", categoryId: cat.id }, owner.token);
  check("votekick: a new voice channel allows it by default", svk === 200 && vkCh.allowVoteKick === true, `${svk}`);
  for (const g of guests) g.ws.send({ type: "voice.join", channelId: vkCh.id });
  const evThree = await g1.ws.waitFor((e) => e.type === "voice.state" && e.channelId === vkCh.id && e.members.length === 3).catch(() => null);
  check("votekick: with three guests and no moderation the channel offers a vote", evThree?.voteKick === true, JSON.stringify({ n: evThree?.members.length, offer: evThree?.voteKick }));

  // ---- A vote that the member it is about ends by leaving; afterwards no second one about them for a while.
  const pVote = waitNew(g3.ws, (e) => e.type === "votekick" && e.vote).catch(() => null);
  const pOffer = waitNew(g1.ws, (e) => e.type === "voice.state" && e.channelId === vkCh.id).catch(() => null);
  const [sv1] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g2.userId }, g1.token);
  const evVote = await pVote;
  const [svSelf] = await api("POST", `/api/channels/${vkCh.id}/votekick/vote`, { yes: false }, g2.token);
  const [svTwice] = await api("POST", `/api/channels/${vkCh.id}/votekick/vote`, { yes: true }, g1.token);
  const [svSecond] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g3.userId }, g1.token);
  check("votekick: the starter counts as a yes, the member it is about does not vote, one vote per member and per channel",
    sv1 === 200 && evVote?.vote?.yes === 1 && evVote?.vote?.no === 0 && evVote.vote.voters === 2 && evVote.vote.roomSize === 3 && evVote.vote.targetId === g2.userId
    && svSelf === 403 && svTwice === 409 && svSecond === 409, `${sv1} ${svSelf} ${svTwice} ${svSecond}`);
  const evOffer = await pOffer;
  check("votekick: while a vote runs the channel offers no second one", evOffer?.voteKick === false, JSON.stringify({ offer: evOffer?.voteKick }));
  g2.ws.send({ type: "voice.leave" });
  const evCancel = await g1.ws.waitFor((e) => e.type === "votekick.result").catch(() => null);
  check("votekick: the member leaving the channel decides nothing", evCancel?.result?.outcome === "cancelled" && evCancel.result.blockedUntil === null, JSON.stringify(evCancel?.result));
  const pBack = waitNew(g1.ws, (e) => e.type === "voice.state" && e.channelId === vkCh.id && e.members.length === 3).catch(() => null);
  g2.ws.send({ type: "voice.join", channelId: vkCh.id });
  await pBack;
  const [svCool] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g2.userId }, g1.token);
  check("votekick: no second vote about the same member right away", svCool === 429, `${svCool}`);

  // ---- A vote that passes: out of the channel and locked out of it, other channels stay open.
  const pLeft = waitNew(g1.ws, (e) => e.type === "voice.state" && e.channelId === vkCh.id && e.members.length === 2).catch(() => null);
  const [sv2] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g3.userId }, g1.token);
  const [sv3] = await api("POST", `/api/channels/${vkCh.id}/votekick/vote`, { yes: true }, g2.token);
  const evDone = await g1.ws.waitFor((e) => e.type === "votekick.result" && e.result.targetId === g3.userId).catch(() => null);
  const evMoved = await g3.ws.waitFor((e) => e.type === "voice.moved" && e.channelId === null).catch(() => null);
  check("votekick: everybody voting ends it at once; two yes of three in the channel pass",
    sv2 === 200 && sv3 === 200 && evDone?.result?.outcome === "passed" && evDone.result.yes === 2 && evDone.result.no === 0 && !!evDone.result.blockedUntil && evMoved !== null,
    JSON.stringify(evDone?.result));
  await sleep(200);
  const [stkBlocked] = await api("POST", "/api/rtc-token", { channelId: vkCh.id }, g3.token);
  const [stkOther] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, g3.token);
  check("votekick: the member voted out gets no token for that channel and keeps every other one", stkBlocked === 403 && stkOther === 200, `${stkBlocked} ${stkOther}`);
  // The vote's block is a channel block since 24 September 2026 (docs/features/channel-blocks.md): a moderator sees and lifts it.
  const [sbl, vkBlocks] = await api("GET", "/api/channel-blocks", undefined, owner.token);
  const vkBlock = Array.isArray(vkBlocks) ? vkBlocks.find((b) => b.channelId === vkCh.id && b.userId === g3.userId) : null;
  const [sLift] = await api("DELETE", `/api/channels/${vkCh.id}/blocks/${g3.userId}`, undefined, owner.token);
  const [stkLifted] = await api("POST", "/api/rtc-token", { channelId: vkCh.id }, g3.token);
  check("votekick: the block shows in the moderator's list as a vote kick's, and lifting it opens the channel again",
    sbl === 200 && vkBlock?.source === "votekick" && !!vkBlock.until && sLift === 200 && stkLifted === 200, `${sbl} ${vkBlock?.source} ${sLift} ${stkLifted}`);
  const evLeft = await pLeft;
  check("votekick: two left in the channel, so no vote is offered any more", evLeft?.voteKick === false, JSON.stringify({ n: evLeft?.members.length, offer: evLeft?.voteKick }));
  const [svFew] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g2.userId }, g1.token);
  check("votekick: fewer than three in the channel: refused", svFew === 409, `${svFew}`);

  // ---- Somebody who may throw people out is in the channel, and the channel's switch.
  const pMod = waitNew(g1.ws, (e) => e.type === "voice.state" && e.channelId === vkCh.id && e.members.length === 3).catch(() => null);
  wsA.send({ type: "voice.join", channelId: vkCh.id });
  const evMod = await pMod;
  const [svMod] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g2.userId }, g1.token);
  check("votekick: nothing to vote about while somebody present may remove members", evMod?.voteKick === false && svMod === 403, `${svMod} offer=${evMod?.voteKick}`);
  wsA.send({ type: "voice.leave" });
  const [svOff, chOff] = await api("PATCH", `/api/channels/${vkCh.id}`, { allowVoteKick: false }, owner.token);
  await sleep(200);
  const [svDisabled] = await api("POST", `/api/channels/${vkCh.id}/votekick`, { targetId: g2.userId }, g1.token);
  check("votekick: the channel's switch turns it off", svOff === 200 && chOff.allowVoteKick === false && svDisabled === 403, `${svOff} ${svDisabled}`);

  for (const g of guests) { g.ws.send({ type: "voice.leave" }); await g.ws.close(); }
  await api("DELETE", `/api/channels/${vkCh.id}`, undefined, owner.token);
  for (const g of guests) await api("DELETE", `/api/members/${g.userId}`, undefined, owner.token);
  await api("DELETE", `/api/invites/${invV.code}`, undefined, owner.token);
}

// ---------- Channel blocks (docs/features/channel-blocks.md): remove somebody from a voice channel and keep them out of it.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const [, invK] = await api("POST", "/api/invites", {}, owner.token);
  const g = await login(await newKey(), invK.code); g.ws = await connectWs(g.token);
  const h = await login(await newKey(), invK.code); h.ws = await connectWs(h.token);
  const [, blCh] = await api("POST", "/api/channels", { kind: "voice", name: "smoke-block", categoryId: cat.id }, owner.token);
  const pIn = g.ws.waitFor((e) => e.type === "voice.state" && e.channelId === blCh.id && e.members.some((m) => m.userId === g.userId)).catch(() => null);
  g.ws.send({ type: "voice.join", channelId: blCh.id });
  await pIn;

  const [sGuest] = await api("PUT", `/api/channels/${blCh.id}/blocks`, { userId: g.userId, minutes: 5 }, h.token);
  const [sBad] = await api("PUT", `/api/channels/${blCh.id}/blocks`, { userId: g.userId, minutes: 7 }, owner.token);
  const [sSelf] = await api("PUT", `/api/channels/${blCh.id}/blocks`, { userId: owner.userId, minutes: 5 }, owner.token);
  check("channel block: only with MOVE_MEMBERS, only the offered durations, never oneself", sGuest === 403 && sBad === 400 && sSelf === 400, `${sGuest} ${sBad} ${sSelf}`);

  const pMoved = g.ws.waitFor((e) => e.type === "voice.moved" && e.channelId === null).catch(() => null);
  const pGone = waitNew(h.ws, (e) => e.type === "voice.state" && e.channelId === blCh.id && !e.members.some((m) => m.userId === g.userId)).catch(() => null);
  const [s5, b5] = await api("PUT", `/api/channels/${blCh.id}/blocks`, { userId: g.userId, minutes: 5 }, owner.token);
  const evMoved = await pMoved;
  const left5 = b5?.until ? Date.parse(b5.until) - Date.now() : 0;
  check("channel block: 5 minutes, and the member sitting in the channel is removed with the reason and the end",
    s5 === 200 && b5.source === "moderator" && left5 > 4 * 60_000 && left5 <= 5 * 60_000 && evMoved?.reason === "blocked" && evMoved.until === b5.until,
    `${s5} ${JSON.stringify(evMoved)}`);
  check("channel block: the channel's presence drops the member", (await pGone) !== null);
  await sleep(100);
  const [stk5, tk5] = await api("POST", "/api/rtc-token", { channelId: blCh.id }, g.token);
  const [stkOther] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, g.token);
  const pRefused = g.ws.waitFor((e) => e.type === "error" && e.message === "channel_blocked").catch(() => null);
  g.ws.send({ type: "voice.join", channelId: blCh.id });
  check("channel block: no token and no voice.join for that channel, every other channel stays open",
    stk5 === 403 && tk5.error === "channel_blocked" && tk5.until === b5.until && stkOther === 200 && (await pRefused) !== null, `${stk5} ${JSON.stringify(tk5)} ${stkOther}`);

  const [sList, list] = await api("GET", "/api/channel-blocks", undefined, owner.token);
  const [sListG, listG] = await api("GET", "/api/channel-blocks", undefined, h.token);
  check("channel block: listed for whoever may move members, with who set it; nothing for a guest",
    sList === 200 && list.some((b) => b.channelId === blCh.id && b.userId === g.userId && typeof b.blockedBy === "string") && sListG === 200 && listG.length === 0,
    `${sList} ${sListG} ${JSON.stringify(listG)}`);

  const [sPerm, bPerm] = await api("PUT", `/api/channels/${blCh.id}/blocks`, { userId: g.userId, minutes: null }, owner.token);
  const [stkPerm, tkPerm] = await api("POST", "/api/rtc-token", { channelId: blCh.id }, g.token);
  check("channel block: permanent replaces the timed one", sPerm === 200 && bPerm.until === null && stkPerm === 403 && tkPerm.until === null, `${sPerm} ${JSON.stringify(tkPerm)}`);

  const [sLiftG] = await api("DELETE", `/api/channels/${blCh.id}/blocks/${g.userId}`, undefined, h.token);
  const [sLift] = await api("DELETE", `/api/channels/${blCh.id}/blocks/${g.userId}`, undefined, owner.token);
  const [sLift2] = await api("DELETE", `/api/channels/${blCh.id}/blocks/${g.userId}`, undefined, owner.token);
  const [stkBack] = await api("POST", "/api/rtc-token", { channelId: blCh.id }, g.token);
  check("channel block: a moderator lifts it (a guest may not), then the channel is open again", sLiftG === 403 && sLift === 200 && sLift2 === 404 && stkBack === 200, `${sLiftG} ${sLift} ${sLift2} ${stkBack}`);

  await api("PUT", `/api/channels/${blCh.id}/blocks`, { userId: h.userId, minutes: 15 }, owner.token);
  await api("DELETE", `/api/members/${h.userId}`, undefined, owner.token);
  const [, afterKick] = await api("GET", "/api/channel-blocks", undefined, owner.token);
  check("channel block: a kick clears the member's blocks", !afterKick.some((b) => b.userId === h.userId));

  await g.ws.close(); await h.ws.close();
  await api("DELETE", `/api/channels/${blCh.id}`, undefined, owner.token);
  await api("DELETE", `/api/members/${g.userId}`, undefined, owner.token);
  await api("DELETE", `/api/invites/${invK.code}`, undefined, owner.token);
}

// ---------- Limits (docs/features/limits.md)
// /api/ready and the report always; the refusals only against a server started with the limits of the recipe there:
// SMOKE_LIMITS=1 STORAGE_QUOTA_MB=1 VOICE_SEATS_MAX=6 MEMBER_MAX=8 RATE_LIMIT_FACTOR=5 for the server (six seats: earlier
// sections seat up to five at once; eight members: the vote kick needs three guests next to owner, B and C, and the seat
// part here four fresh members and one more), SMOKE_LIMITS=1 here.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const [sReady, rReady] = await api("GET", "/api/ready");
  check("limits: /api/ready answers 200 with the database up", sReady === 200 && rReady.ok === true && rReady.database === "up", `${sReady}`);
  const [sLim, lim] = await api("GET", "/api/settings/limits", undefined, owner.token);
  const [sLimB] = await api("GET", "/api/settings/limits", undefined, B.token);
  check("limits: the report (storage, voice seats, members, upload size) for MANAGE_SERVER only",
    sLim === 200 && typeof lim.storage?.usedBytes === "number" && "quotaMb" in (lim.storage ?? {}) && typeof lim.voiceSeats?.used === "number" && typeof lim.members?.count === "number" && typeof lim.maxUploadMb === "number" && sLimB === 403,
    `${sLim} ${sLimB} ${JSON.stringify(lim)}`);
  if (process.env.SMOKE_LIMITS === "1") {
    check("limits: the server runs with the recipe's limits", lim.storage.quotaMb === 1 && lim.voiceSeats.max !== null && lim.members.max !== null, JSON.stringify({ storage: lim.storage.quotaMb, seats: lim.voiceSeats.max, members: lim.members.max }));
    // Voice seats: everybody leaves first, then people are seated until the limit (the owner on wsA, B on wsB, then fresh
    // members with sockets of their own); the next one is refused, a seated one is not (a switch keeps the seat), and the
    // seat is free again after leaving. Only up to 8 seats, so the recipe's VOICE_SEATS_MAX stays small.
    wsA.send({ type: "voice.leave" }); wsB.send({ type: "voice.leave" });
    await sleep(400);
    const [, limNow] = await api("GET", "/api/settings/limits", undefined, owner.token);
    const need = limNow.voiceSeats.max - limNow.voiceSeats.used;
    const [, invS] = await api("POST", "/api/invites", { maxUses: 12 }, owner.token);
    if (need >= 1 && need <= 8) {
      const seatWs = [{ ws: wsA, user: owner }, { ws: wsB, user: B }];
      const seated = [], fresh = [];
      for (let i = 0; i < need; i++) {
        let seat = seatWs[i];
        if (!seat) { const u = await login(await newKey(), invS.code); seat = { ws: await connectWs(u.token), user: u }; fresh.push(seat); }
        seat.ws.send({ type: "voice.join", channelId: voiceCh.id });
        const sat = await waitNew(seat.ws, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.some((m) => m.userId === seat.user.userId)).catch(() => null);
        if (sat) seated.push(seat); else console.log(`FAIL limits: seat ${i + 1} of ${need} could not sit down (${seat.user.status ?? "?"} ${seat.user.body?.error ?? ""})`), failures++;
      }
      const extra = await login(await newKey(), invS.code);
      const [sSeat, rSeat] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, extra.token);
      const [sOwn] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, owner.token);
      const [, limSeated] = await api("GET", "/api/settings/limits", undefined, owner.token);
      const pEmpty = waitNew(wsA, (e) => e.type === "voice.state" && e.channelId === voiceCh.id && e.members.length === 0);
      for (const seat of seated) seat.ws.send({ type: "voice.leave" });
      await pEmpty;
      const [sFree] = await api("POST", "/api/rtc-token", { channelId: voiceCh.id }, extra.token);
      check(`limits: VOICE_SEATS_MAX=${limNow.voiceSeats.max} answers 409 voice_seats_full once every seat is taken, not for a seated member, free again after leaving; the report counts the seats`,
        seated.length === need && sSeat === 409 && rSeat.error === "voice_seats_full" && rSeat.max === limNow.voiceSeats.max && sOwn === 200 && sFree === 200 && limSeated.voiceSeats.used === limNow.voiceSeats.max,
        `${sSeat} ${rSeat.error ?? ""} own ${sOwn} free ${sFree} used ${limSeated.voiceSeats.used}/${limNow.voiceSeats.max}`);
      for (const seat of fresh) await seat.ws.close();
      for (const u of [...fresh.map((f) => f.user), extra]) await api("DELETE", `/api/members/${u.userId}`, undefined, owner.token);
    } else console.log(`info limits: VOICE_SEATS_MAX ${limNow.voiceSeats.max} bei ${limNow.voiceSeats.used} belegten Plaetzen; nicht aufgefuellt (Rezept: hoechstens 8 frei)`);
    await api("DELETE", `/api/invites/${invS.code}`, undefined, owner.token);
    // Storage: 1 MB in all; 300 KB uploads until one is refused (at most 6), the refusal is 413 storage_full and the report stays under the quota.
    const statuses = [];
    let refusal = null;
    for (let i = 0; i < 6 && !refusal; i++) {
      const fd = new FormData(); fd.append("file", new Blob([new Uint8Array(300 * 1024)], { type: "application/octet-stream" }), `block${i}.bin`);
      const [sUp, rUp] = await api("POST", "/api/attachments", fd, owner.token);
      statuses.push(sUp);
      if (sUp !== 200) refusal = { status: sUp, body: rUp };
    }
    const [, limFull] = await api("GET", "/api/settings/limits", undefined, owner.token);
    check("limits: STORAGE_QUOTA_MB=1 lets uploads through until the quota and then answers 413 storage_full; the total stays under the quota",
      refusal !== null && refusal.status === 413 && refusal.body.error === "storage_full" && refusal.body.quotaMb === 1 && statuses.filter((s) => s === 200).length >= 1 && limFull.storage.usedBytes <= 1024 * 1024,
      `${statuses.join(",")} ${refusal?.body?.error ?? ""} used ${limFull.storage.usedBytes}`);
    // Members: fill the server up to MEMBER_MAX with server accounts, the next one is refused with 403 server_full (no invite use burnt).
    const gap = lim.members.max - lim.members.count;
    if (gap >= 0 && gap <= 12) {
      const [, invF] = await api("POST", "/api/invites", { maxUses: gap + 3 }, owner.token);
      const made = [];
      for (let i = 0; i < gap; i++) made.push(await login(await newKey(), invF.code));
      const extra = await login(await newKey(), invF.code);
      check("limits: MEMBER_MAX admits members up to the limit and refuses the next with 403 server_full",
        made.every((r) => r.status === 200) && extra.status === 403 && extra.body.error === "server_full" && extra.body.max === lim.members.max,
        `${made.map((r) => r.status).join(",")} extra ${extra.status} ${extra.body.error}`);
      for (const r of made) await api("DELETE", `/api/members/${r.userId}`, undefined, owner.token);
      await api("DELETE", `/api/invites/${invF.code}`, undefined, owner.token);
    } else console.log(`info limits: MEMBER_MAX ${lim.members.max} liegt ${gap} ueber der Mitgliederzahl ${lim.members.count}; nicht aufgefuellt (Rezept: hoechstens 12 darueber)`);
  } else console.log("info limits: die Ablehnungen (storage_full, voice_seats_full, server_full) prueft nur ein Server mit SMOKE_LIMITS=1 (docs/features/limits.md)");
}

// ---------- Protocol version
const wsOld = new WebSocket(BASE.replace(/^http/, "ws") + "/api/ws");
await new Promise((r) => wsOld.on("open", r));
wsOld.send(JSON.stringify({ type: "hello", protocolVersion: 99, sessionToken: owner.token }));
const vErr = JSON.parse(await new Promise((r) => wsOld.once("message", (m) => r(m.toString()))));
check("ws rejects v99", vErr.type === "error" && vErr.code === "protocol_version");
await new Promise((r) => wsOld.once("close", r));

// ---------- Cleanup
await wsA.close(); await wsB.close();
await api("DELETE", `/api/invites/${invite.code}`, undefined, owner.token);
await api("DELETE", `/api/invites/${invite2.code}`, undefined, owner.token);
await api("DELETE", `/api/channels/${textCh.id}`, undefined, owner.token);
await api("DELETE", `/api/channels/${voiceCh.id}`, undefined, owner.token);
await api("DELETE", `/api/categories/${cat.id}`, undefined, owner.token);
await api("DELETE", `/api/roles/${modRole.id}`, undefined, owner.token);
for (const u of [B, C]) await api("DELETE", `/api/members/${u.userId}`, undefined, owner.token);
const [, finalState] = await api("GET", "/api/state", undefined, owner.token);
check("cleanup", !finalState.channels.some((c) => c.id === textCh.id) && !finalState.roles.some((r) => r.id === modRole.id));

// The claim of a member from before on a fresh key (security review, 25 September 2026; docs/features/local-accounts.md).
// Such a member (membership, no account) cannot be made through the API any more, so this part needs the database:
// SMOKE_DATABASE_URL = the server's DATABASE_URL. Skipped without it.
if (process.env.SMOKE_DATABASE_URL) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.SMOKE_DATABASE_URL, { max: 1 });
  try {
    const old = await newKey(); const fresh = await newKey(); const other = await newKey();
    const [u] = await sql`insert into users (public_key) values (${old.publicKey}) returning id`;
    await sql`insert into members (user_id) values (${u.id})`;
    const signedIn = await verify(old);
    check("claim: a member from before signs in and must register", signedIn.status === 200 && signedIn.body.registrationRequired === true, `${signedIn.status}`);
    const handle = `c${fresh.publicKey.slice(0, 10)}`;
    const claimWith = async (newSigner, oldSigner = old) => {
      const [, ch] = await api("POST", "/api/auth/challenge", { publicKey: old.publicKey });
      const backup = backupOf(fresh);
      const msg = new TextEncoder().encode(`squorli-local-claim\n${DOMAIN}\n${ch.nonce}\n${handle}\n${fresh.publicKey}\n${backup.ciphertext}`);
      return api("POST", "/api/local/claim", { handle, backup, challengeId: ch.challengeId, newPublicKey: fresh.publicKey,
        signature: hex(await ed.signAsync(msg, oldSigner.priv)), newSignature: hex(await ed.signAsync(msg, newSigner.priv)) }, signedIn.token);
    };
    const [sBad] = await claimWith(other);
    const [sBadOld] = await claimWith(fresh, other);
    const [sLegacy] = await api("POST", "/api/local/claim", { handle, backup: backupOf(old) }, signedIn.token);
    check("claim: refused without the new key's signature, with a foreign old signature, and in the old form (key upload)", sBad === 401 && sBadOld === 401 && sLegacy === 400, `${sBad} ${sBadOld} ${sLegacy}`);
    const [sOk, rOk] = await claimWith(fresh);
    const [, meC] = await api("GET", "/api/me", undefined, signedIn.token);
    const [[row]] = [await sql`select public_key from users where id = ${u.id}`];
    const byFresh = await verify(fresh);
    const byOld = await verify(old);
    // Read in the database: the fetch route may already be at its failure limit for this address after the checks above.
    const [acct] = await sql`select ciphertext from local_accounts where user_id = ${u.id} and handle = ${handle}`;
    check("claim: the membership moved to the fresh key; the session stays; the old key no longer signs in; the backup holds the fresh key only",
      sOk === 200 && rOk.localHandle === handle && meC.localHandle === handle && row.public_key === fresh.publicKey
      && byFresh.status === 200 && byFresh.userId === u.id && byOld.status === 403 && acct?.ciphertext === backupOf(fresh).ciphertext,
      `${sOk} ${row.public_key === fresh.publicKey} fresh ${byFresh.status} old ${byOld.status} backup ${acct?.ciphertext === backupOf(fresh).ciphertext}`);
    await sql`delete from users where id = ${u.id}`;
  } finally { await sql.end(); }
} else console.log("info claim: mit SMOKE_DATABASE_URL (die DATABASE_URL des Servers) starten, um den Claim zu pruefen");

console.log(failures ? `\n${failures} Pruefung(en) fehlgeschlagen` : "\nalles ok");
process.exitCode = failures ? 1 : 0;
