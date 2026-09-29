// Smoke test of the devices (docs/features/devices.md, 29 September 2026): a sign-in names its device and proves it, a
// session counts only while its device is let in. Separate from smoke.mjs because the server under test needs a directory
// this script controls (for a directory account the directory says which devices are let in): the script plays it on
// 127.0.0.1:3196. Server accounts, for which the server decides itself, are checked in the same run.
//
// The server (a scratch database, never the dev one: the first sign-in becomes the owner) is started with
//   DIRECTORY_URL=http://127.0.0.1:3196 PORT=3001 PUBLIC_DOMAIN=localhost RATE_LIMIT_FACTOR=5 DATABASE_URL=<scratch>
// before or after this script; then: SMOKE_URL=http://localhost:3001 pnpm smoke:devices
// The script refuses a server that names any other directory.
import * as ed from "@noble/ed25519";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import WebSocket from "ws";

const PROTOCOL_VERSION = 4; // must match packages/protocol
const DEVICE_MAX = 10; // must match packages/protocol (directory.ts)
const BASE = process.env.SMOKE_URL ?? "http://localhost:3001";
const DIRECTORY_PORT = 3196;
const DIRECTORY = `http://127.0.0.1:${DIRECTORY_PORT}`;
const hex = (b) => Buffer.from(b).toString("hex");
const utf8 = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => { checks++; console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " " + detail : ""}`); if (!ok) failures++; };
const signWith = async (key, message) => hex(await ed.signAsync(utf8(message), key.priv));
const valid = (publicKey, signature, message) => ed.verifyAsync(Buffer.from(signature, "hex"), utf8(message), Buffer.from(publicKey, "hex")).catch(() => false);
async function newKey() { const priv = ed.utils.randomPrivateKey(); return { priv, publicKey: hex(await ed.getPublicKeyAsync(priv)) }; }
/** What the device signs next to the account's key (packages/protocol, directory.ts `deviceProofMessage`). */
const proofMessage = (accountKey, message) => `squorli-device\n${accountKey}\n${message}`;

// ---------- The played directory: accounts by key with what it says about their devices, and what the server asked.
const accounts = new Map(); // publicKey -> { handle, enforced, deviceKeys }
const lookups = []; // the query of every key lookup with a token
let token = null;
const account = (key, withToken) => {
  const a = accounts.get(key);
  if (!a) return null;
  return { handle: a.handle, publicKey: key, createdAt: "2026-09-01T10:00:00.000Z", hasBackup: true, displayName: null, serverDisplayName: null, avatarUpdatedAt: null, suspendedUntil: null,
    devicesEnforced: withToken ? a.enforced : false, deviceKeys: withToken ? a.deviceKeys : [] };
};
const directory = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, DIRECTORY);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { /* no JSON */ }
    const bearer = req.headers.authorization === `Bearer ${token}` && token !== null;
    const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.method === "GET" && url.pathname === "/api/health") return send(200, { ok: true, service: "directory", host: `127.0.0.1:${DIRECTORY_PORT}`, features: { backup: true, totp: false, email: false, devices: true, deviceRevoke: true }, time: new Date().toISOString() });
    if (req.method === "POST" && url.pathname === "/api/challenge") return send(200, { challengeId: randomUUID(), nonce: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (req.method === "POST" && url.pathname === "/api/servers/register") {
      token = randomBytes(32).toString("hex");
      return send(200, { host: body.host, token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/keys/")) {
      if (url.searchParams.has("server") && !bearer) return send(401, { error: "server_unauthorized" });
      const key = url.pathname.slice("/api/keys/".length);
      if (bearer) lookups.push({ key, ...Object.fromEntries(url.searchParams) });
      const acc = account(key, bearer);
      return acc ? send(200, acc) : send(404, { error: "not_found" });
    }
    if (req.method === "POST" && url.pathname === "/api/servers/resolve") {
      if (!bearer) return send(401, { error: "server_unauthorized" });
      return send(200, (body.publicKeys ?? []).map((k) => account(k, true)).filter(Boolean));
    }
    if (req.method === "GET" && url.pathname === "/api/servers/leaves") return bearer ? send(200, { publicKeys: [] }) : send(401, { error: "server_unauthorized" });
    return send(404, { error: "not_found" });
  });
});
await new Promise((resolve, reject) => { directory.once("error", reject); directory.listen(DIRECTORY_PORT, "127.0.0.1", resolve); });

// ---------- The chat server
async function api(method, path, body, sessionToken) {
  const headers = {};
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return [r.status, await r.json().catch(() => ({}))];
}
const [hs, health] = await api("GET", "/api/health").catch(() => [0, {}]);
if (hs !== 200) { console.error(`Kein Server unter ${BASE}. Start: DIRECTORY_URL=${DIRECTORY} PORT=3001 PUBLIC_DOMAIN=localhost RATE_LIMIT_FACTOR=5 DATABASE_URL=<Wegwerf-Datenbank> npx tsx src/index.ts`); process.exit(2); }
if (health.directoryUrl !== DIRECTORY) { console.error(`Der Server unter ${BASE} nennt das Verzeichnis ${health.directoryUrl}, nicht ${DIRECTORY}: dieser Test laeuft nur gegen eine Instanz mit der gespielten Directory.`); process.exit(2); }
const DOMAIN = health.domain ?? "localhost";
check("health says that the server knows devices", health.devices === true);

async function newAccount(handle) { const key = await newKey(); accounts.set(key.publicKey, { handle, enforced: false, deviceKeys: [] }); return key; }
/** The plain sign-in; `dev` = the device that signs along, `tamper` = its proof is over another message. */
async function verify(key, dev = null, { tamper = false, invite } = {}) {
  const [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
  const message = `community-chat-login\n${DOMAIN}\n${ch.nonce}`;
  const proof = dev ? { deviceKey: dev.publicKey, deviceSignature: await signWith(dev, proofMessage(key.publicKey, tamper ? `${message}x` : message)) } : {};
  const [status, body] = await api("POST", "/api/auth/verify", { challengeId: ch.challengeId, publicKey: key.publicKey, signature: await signWith(key, message), ...proof, ...(invite ? { invite } : {}) });
  return { status, body, token: body.sessionToken, message };
}
function connectWs(sessionToken) {
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/ws");
  const events = [];
  let closed = null;
  ws.on("message", (m) => events.push(JSON.parse(m.toString())));
  ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionToken })));
  const until = async (pred, ms = 5000) => { for (let t = 0; t < ms; t += 50) { const v = pred(); if (v) return v; await sleep(50); } return null; };
  return { events, first: () => until(() => events.find((e) => e.type === "welcome" || e.type === "error")), closed: (ms) => until(() => closed, ms), isOpen: () => closed === null, close: () => { try { ws.close(); } catch { /* closed */ } } };
}
const notify = (key) => api("POST", "/api/directory/notify", { publicKey: key.publicKey });
const says = (key, enforced, deviceKeys) => Object.assign(accounts.get(key.publicKey), { enforced, deviceKeys: deviceKeys.map((d) => d.publicKey) });
const me = (sessionToken) => api("GET", "/api/me", undefined, sessionToken);
const ended = (c) => c?.code === 4011 && c.reason === "device_revoked";

// ---------- Directory accounts: the first sign-in becomes the owner.
const stamp = randomBytes(3).toString("hex");
const owner = await newAccount(`owner${stamp}`);
const ownerDevice = await newKey();
const o = await verify(owner, ownerDevice);
check("the owner signs in with a directory account and a device", o.status === 200 && typeof o.token === "string", `${o.status} ${o.body.error ?? ""}`);
const doctor = (await api("GET", "/api/doctor", undefined, o.token))[1];
// A database that saw a run already has its owner and its registration at a directory that is gone: one run per database.
if (!Array.isArray(doctor.checks)) { console.error(`Der Server unter ${BASE} hat schon einen Eigentuemer: dieser Test braucht je Lauf eine frische Wegwerf-Datenbank.`); process.exit(2); }
const firstCheck = doctor.checks.find((c) => c.id === "directory");
check("the server registers at the played directory", firstCheck?.status === "ok" && token !== null, JSON.stringify(firstCheck ?? null).slice(0, 200));
// The owner's first lookup may have gone out without a token (the server registers on demand): sign in once more.
const o2 = await verify(owner, ownerDevice);
const asked = lookups.filter((l) => l.key === owner.publicKey).at(-1);
check("the sign-in's proof goes to the directory with the device's proof next to it", o2.status === 200 && !!asked?.nonce && !!asked.sig && asked.dkey === ownerDevice.publicKey
  && await valid(owner.publicKey, asked.sig, `community-chat-login\n${DOMAIN}\n${asked.nonce}`) && await valid(ownerDevice.publicKey, asked.dsig ?? "", proofMessage(owner.publicKey, `community-chat-login\n${DOMAIN}\n${asked.nonce}`)), JSON.stringify(asked ?? {}).slice(0, 120));
const bad = await verify(owner, ownerDevice, { tamper: true });
check("a device's proof over another message -> 401 device_signature_invalid", bad.status === 401 && bad.body.error === "device_signature_invalid", `${bad.status} ${bad.body.error ?? ""}`);
await api("PATCH", "/api/settings", { openJoin: true, localAccounts: true }, o.token);

const user = await newAccount(`user${stamp}`);
const d1 = await newKey(); const d2 = await newKey();
const old = await verify(user);
const [sOld] = await me(old.token);
check("an account that is not enforced signs in without a device (a client from before devices)", old.status === 200 && sOld === 200, `${old.status} ${sOld}`);
const viaD1 = await verify(user, d1);
const wsOld = connectWs(old.token); const wsD1 = connectWs(viaD1.token);
check("and with a device; both sessions get a socket", viaD1.status === 200 && (await wsOld.first())?.type === "welcome" && (await wsD1.first())?.type === "welcome", `${viaD1.status}`);
const [sDev, rDev] = await api("GET", "/api/me/devices", undefined, viaD1.token);
check("the device list of a directory account is the directory's -> 409 use_directory", sDev === 409 && rDev.error === "use_directory", `${sDev} ${rDev.error ?? ""}`);

// The directory says: the account lets only enrolled devices in, and d1 is one.
says(user, true, [d1]);
await notify(user);
check("the account becomes enforced: the session without a device ends (socket 4011 device_revoked)", ended(await wsOld.closed(4000)), JSON.stringify(await wsOld.closed(1)));
const [sGone, rGone] = await me(old.token);
const [sStay] = await me(viaD1.token);
check("its token is worth nothing any more, the enrolled device's session and socket stay", sGone === 401 && sStay === 200 && wsD1.isOpen(), `${sGone} ${rGone.error ?? ""} ${sStay}`);
const noDevice = await verify(user);
const stranger = await verify(user, d2);
const again = await verify(user, d1);
check("sign-in: without a device and with one that is not enrolled -> 403 device_refused; the enrolled one gets in", noDevice.status === 403 && noDevice.body.error === "device_refused" && stranger.status === 403 && stranger.body.error === "device_refused" && again.status === 200, `${noDevice.status} ${stranger.status} ${again.status}`);

// d1 is signed out at the directory, d2 enrolled in its place.
says(user, true, [d2]);
const wsAgain = connectWs(again.token);
await wsAgain.first();
await notify(user);
check("a device that was signed out: its sockets end with 4011 device_revoked", ended(await wsD1.closed(4000)) && ended(await wsAgain.closed(4000)), `${JSON.stringify(await wsD1.closed(1))} ${JSON.stringify(await wsAgain.closed(1))}`);
const [sOut] = await me(viaD1.token);
const out = await verify(user, d1);
const inD2 = await verify(user, d2);
check("its sessions are gone, its sign-in is refused, the other device gets in", sOut === 401 && out.status === 403 && out.body.error === "device_refused" && inD2.status === 200, `${sOut} ${out.status} ${inD2.status}`);

// A session made while the server still believed an old list: the lookup of every request refuses it.
says(user, true, [d1, d2]);
await notify(user);
const racing = await verify(user, d1);
accounts.get(user.publicKey).deviceKeys = [d2.publicKey];
await notify(user);
await sleep(300);
const [sRace, rRace] = await me(racing.token);
check("a session of a device that is signed out right after its sign-in ends too", racing.status === 200 && sRace === 401, `${racing.status} ${sRace} ${rRace.error ?? ""}`);

// The directory cannot be reached with a token (a public answer says "not enforced" about everybody): the cached state counts.
const savedToken = token;
token = null;
const cachedRefusal = await verify(user, d1);
const cachedOk = await verify(user, d2);
check("while the directory does not know the server's token, what it told last counts", cachedRefusal.status === 403 && cachedRefusal.body.error === "device_refused" && cachedOk.status === 200, `${cachedRefusal.status} ${cachedOk.status}`);
token = savedToken;

// ---------- Server accounts: this server decides.
const authKeyOf = (key, salt = "") => createHash("sha256").update(`auth:${salt}${key.publicKey}`).digest("hex");
// Bound to the server's host, as every client makes a server account's backup (the server only passes the mark on).
const backupOf = (key) => ({ ciphertext: Buffer.from(key.priv).toString("base64"), params: { kdf: "pbkdf2-sha256", iterations: 100_000, salt: "00".repeat(16), iv: "00".repeat(12), bound: true }, authKey: authKeyOf(key) });
const local = await newKey();
const handle = `g${stamp}`;
const l1 = await newKey(); const l2 = await newKey();
async function register(key, name, dev, tamper = false) {
  const [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
  const backup = backupOf(key);
  const message = `squorli-local-register\n${DOMAIN}\n${ch.nonce}\n${name}\n${backup.ciphertext}`;
  const proof = dev ? { deviceKey: dev.publicKey, deviceSignature: await signWith(dev, proofMessage(key.publicKey, tamper ? `${message}x` : message)) } : {};
  const [status, body] = await api("POST", "/api/local/register", { challengeId: ch.challengeId, publicKey: key.publicKey, signature: await signWith(key, message), handle: name, backup, ...proof });
  return { status, body, token: body.sessionToken };
}
async function fetchKey(name, key, dev, extra = {}, tamper = false) {
  const enrol = dev ? { deviceKey: dev.publicKey, deviceSignature: await signWith(dev, `squorli-device-enrol\n${DOMAIN}\n${tamper ? `${name}x` : name}\n${dev.publicKey}`) } : {};
  return api("POST", "/api/local/backup/fetch", { handle: name, authKey: authKeyOf(key), ...enrol, ...extra });
}
const devicesOf = (sessionToken) => api("GET", "/api/me/devices", undefined, sessionToken);
const regBad = await register(local, handle, l1, true);
const reg = await register(local, handle, l1);
const [sList, list] = await devicesOf(reg.token);
check("a server account registers with its first device; a proof over another message is refused", regBad.status === 401 && regBad.body.error === "device_signature_invalid" && reg.status === 200
  && sList === 200 && list.length === 1 && list[0].current === true && list[0].kind === "client" && !JSON.stringify(list).includes(l1.publicKey), `${regBad.status} ${reg.status} ${JSON.stringify(list).slice(0, 160)}`);
const [sPar, par] = await api("GET", `/api/local/backup/${handle}/params`);
check("the backup's parameters say that it is bound to this server (a client derives other keys for such a one)", sPar === 200 && par.bound === true && !("iv" in par), `${sPar} ${JSON.stringify(par)}`);
const [sF0, rF0] = await fetchKey(handle, local, l2, {}, true);
const [sF1, rF1] = await fetchKey(handle, local, l2);
const viaL2 = await verify(local, l2);
const plain = await verify(local);
const [, list2] = await devicesOf(viaL2.token);
check("a key fetch enrols the asking device (which has to prove its key); a sign-in without a device still works", sF0 === 401 && rF0.error === "device_signature_invalid" && sF1 === 200 && rF1.publicKey === local.publicKey && viaL2.status === 200 && plain.status === 200
  && list2.length === 2 && list2[0].current === true, `${sF0} ${sF1} ${viaL2.status} ${plain.status} ${list2.length}`);
// A device that proves itself at a sign-in of an account that is not enforced is enrolled silently.
const l3 = await newKey();
const viaL3 = await verify(local, l3);
const [, list3] = await devicesOf(viaL3.token);
check("a device of an account that is not enforced is enrolled at its first sign-in", viaL3.status === 200 && list3.length === 3, `${viaL3.status} ${list3.length}`);

// The list names devices by id, never by key: the second device's id is the one its own session marks as the asking one.
const l2Id = list2.find((d) => d.current).id;
const wsL2 = connectWs(viaL2.token); const wsPlain = connectWs(plain.token); const wsL1 = connectWs(reg.token);
await Promise.all([wsL2.first(), wsPlain.first(), wsL1.first()]);
const [sR0] = await api("DELETE", `/api/me/devices/${l2Id}`, {}, reg.token);
const [sR1, rR1] = await api("DELETE", `/api/me/devices/${l2Id}`, { authKey: "11".repeat(32) }, reg.token);
const [sR2, rR2] = await api("DELETE", `/api/me/devices/${l2Id}`, { authKey: authKeyOf(local) }, plain.token);
check("signing a device out: without the password 400, with a wrong one 401, from a session without a device 400 no_device", sR0 === 400 && sR1 === 401 && rR1.error === "auth_invalid" && sR2 === 400 && rR2.error === "no_device", `${sR0} ${sR1} ${sR2} ${rR2.error ?? ""}`);
const [sR3, rR3] = await api("DELETE", `/api/me/devices/${l2Id}`, { authKey: authKeyOf(local) }, reg.token);
check("with the password the device is signed out and leaves the list", sR3 === 200 && rR3.revoked === 1 && rR3.devices.length === 2 && rR3.devices.every((d) => d.id !== l2Id), `${sR3} ${JSON.stringify(rR3).slice(0, 200)}`);
check("its socket ends with 4011 device_revoked, and so does the one of the session without a device (the account is enforced now); the asking device stays",
  ended(await wsL2.closed(4000)) && ended(await wsPlain.closed(4000)) && wsL1.isOpen(), `${JSON.stringify(await wsL2.closed(1))} ${JSON.stringify(await wsPlain.closed(1))}`);
const [sT1, rT1] = await me(viaL2.token);
const outL2 = await verify(local, l2);
const outPlain = await verify(local);
const outNew = await verify(local, await newKey());
const stillL3 = await verify(local, l3);
check("sessions and sign-ins: the device that was signed out, no device and a device that is not enrolled are refused; an enrolled one gets in",
  sT1 === 401 && outL2.status === 403 && outL2.body.error === "device_refused" && outPlain.status === 403 && outNew.status === 403 && stillL3.status === 200, `${sT1} ${rT1.error ?? ""} ${outL2.status} ${outPlain.status} ${outNew.status} ${stillL3.status}`);
const [sF2] = await fetchKey(handle, local, l2);
const backL2 = await verify(local, l2);
check("with the password the device comes back", sF2 === 200 && backL2.status === 200, `${sF2} ${backL2.status}`);
const [sS1, rS1] = await api("DELETE", "/api/me/devices/current", undefined, backL2.token);
const [sS2] = await me(backL2.token);
const afterSelf = await verify(local, l2);
check("a device signs itself out without the password and is refused afterwards", sS1 === 200 && rS1.revoked === 1 && sS2 === 401 && afterSelf.status === 403, `${sS1} ${JSON.stringify(rS1)} ${sS2} ${afterSelf.status}`);
const [sO1, rO1] = await api("DELETE", "/api/me/devices/others", { authKey: authKeyOf(local) }, reg.token);
const [, listEnd] = await devicesOf(reg.token);
check("all others: only the asking device is left", sO1 === 200 && rO1.revoked === 1 && listEnd.length === 1 && listEnd[0].current === true && (await verify(local, l3)).status === 403, `${sO1} ${JSON.stringify(rO1).slice(0, 120)} ${listEnd.length}`);
wsL1.close();

// The limit: ten devices, the eleventh gets the list and no key.
const many = await newKey();
const manyHandle = `v${stamp}`;
const devs = [await newKey()];
const regMany = await register(many, manyHandle, devs[0]);
for (let i = 1; i < DEVICE_MAX; i++) { const d = await newKey(); devs.push(d); await fetchKey(manyHandle, many, d); }
const eleventh = await newKey();
const [sM1, rM1] = await fetchKey(manyHandle, many, eleventh);
check(`device number ${DEVICE_MAX + 1}: 409 too_many_devices with the ${DEVICE_MAX} devices, no key`, regMany.status === 200 && sM1 === 409 && rM1.error === "too_many_devices" && rM1.devices?.length === DEVICE_MAX && rM1.ciphertext === undefined && rM1.ticket === null, `${regMany.status} ${sM1} ${rM1.devices?.length}`);
// The list is sorted by use, so its last entry is the device the account was registered with: its session ends with it.
const makesWay = rM1.devices.at(-1);
const [sM2, rM2] = await fetchKey(manyHandle, many, eleventh, { replaceDevice: makesWay.id });
const viaEleventh = await verify(many, eleventh);
const [, listMany] = await devicesOf(viaEleventh.token);
const [sFirst] = await me(regMany.token);
check("with the device that makes way the key comes, the chosen device is out with its session and the new one in", sM2 === 200 && rM2.publicKey === many.publicKey && viaEleventh.status === 200 && listMany.length === DEVICE_MAX && listMany.every((d) => d.id !== makesWay.id) && listMany[0].current === true && sFirst === 401, `${sM2} ${viaEleventh.status} ${listMany.length} ${sFirst}`);
const [sM3, rM3] = await fetchKey(manyHandle, many, await newKey(), { replaceDevice: makesWay.id });
check("naming a device that is not enrolled to make way -> 409 again", sM3 === 409 && rM3.error === "too_many_devices", `${sM3} ${rM3.error ?? ""}`);
const [sM4] = await fetchKey(manyHandle, many, null);
check("a key fetch without a device still hands the key out", sM4 === 200, `${sM4}`);

wsD1.close(); wsOld.close(); wsAgain.close();
await new Promise((r) => directory.close(r));
console.log(failures ? `\n${failures} Fehler (${checks} Pruefungen)` : `\nalles ok (${checks} Pruefungen)`);
process.exit(failures ? 1 : 0);
