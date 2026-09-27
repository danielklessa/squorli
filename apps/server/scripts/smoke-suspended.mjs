// Smoke test of what a chat server does with a directory account the directory's operator suspended, and with a
// registration the directory refuses (docs/features/reports.md, 27 September 2026). Separate from smoke.mjs because the
// server under test needs a directory this script controls: the script plays it on 127.0.0.1:3197.
//
// The server (a scratch database, never the dev one: the first sign-in becomes the owner) is started with
//   DIRECTORY_URL=http://127.0.0.1:3197 PORT=3001 PUBLIC_DOMAIN=localhost RATE_LIMIT_FACTOR=5 DATABASE_URL=<scratch>
// before or after this script; then: SMOKE_URL=http://localhost:3001 pnpm smoke:suspended
// The script refuses a server that names any other directory.
import * as ed from "@noble/ed25519";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import WebSocket from "ws";

const PROTOCOL_VERSION = 4; // must match packages/protocol
const BASE = process.env.SMOKE_URL ?? "http://localhost:3001";
const DIRECTORY_PORT = 3197;
const DIRECTORY = `http://127.0.0.1:${DIRECTORY_PORT}`;
const hex = (b) => Buffer.from(b).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " " + detail : ""}`); if (!ok) failures++; };

// ---------- The played directory: accounts by key, one token, and what it says to a registration.
const accounts = new Map(); // publicKey -> { handle, suspendedUntil }
let token = null;
let registration = "ok"; // "ok" | "blocked"
let registrations = 0;
const account = (key, withToken) => {
  const a = accounts.get(key);
  if (!a) return null;
  const suspended = withToken && a.suspendedUntil && Date.parse(a.suspendedUntil) > Date.now() ? a.suspendedUntil : null;
  return { handle: a.handle, publicKey: key, createdAt: "2026-09-01T10:00:00.000Z", hasBackup: true, displayName: null, serverDisplayName: null, avatarUpdatedAt: null, suspendedUntil: suspended };
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
    if (req.method === "GET" && url.pathname === "/api/health") return send(200, { ok: true, service: "directory", host: `127.0.0.1:${DIRECTORY_PORT}`, features: { backup: true, totp: false, email: false }, time: new Date().toISOString() });
    if (req.method === "POST" && url.pathname === "/api/challenge") return send(200, { challengeId: randomUUID(), nonce: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (req.method === "POST" && url.pathname === "/api/servers/register") {
      registrations++;
      if (registration === "blocked") { token = null; return send(403, { error: "server_blocked", detail: "spam" }); }
      token = randomBytes(32).toString("hex");
      return send(200, { host: body.host, token, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/keys/")) {
      if (url.searchParams.has("server") && !bearer) return send(401, { error: "server_unauthorized" });
      const acc = account(url.pathname.slice("/api/keys/".length), bearer);
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

async function newAccount(handle) {
  const priv = ed.utils.randomPrivateKey();
  const key = { priv, publicKey: hex(await ed.getPublicKeyAsync(priv)) };
  accounts.set(key.publicKey, { handle, suspendedUntil: null });
  return key;
}
async function verify(key) {
  const [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
  const signature = hex(await ed.signAsync(new TextEncoder().encode(`community-chat-login\n${DOMAIN}\n${ch.nonce}`), key.priv));
  const [status, body] = await api("POST", "/api/auth/verify", { challengeId: ch.challengeId, publicKey: key.publicKey, signature });
  return { status, body, token: body.sessionToken };
}
function connectWs(sessionToken) {
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/ws");
  const events = [];
  let closeCode = null;
  ws.on("message", (m) => events.push(JSON.parse(m.toString())));
  ws.on("close", (code) => { closeCode = code; });
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionToken })));
  const until = async (pred, ms = 5000) => { for (let t = 0; t < ms; t += 50) { const v = pred(); if (v) return v; await sleep(50); } return null; };
  return {
    events,
    first: () => until(() => events.find((e) => e.type === "welcome" || e.type === "error")),
    closed: (ms) => until(() => closeCode, ms),
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
}
const notify = (key) => api("POST", "/api/directory/notify", { publicKey: key.publicKey });
const suspend = (key, days) => { accounts.get(key.publicKey).suspendedUntil = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(); return accounts.get(key.publicKey).suspendedUntil; };

// ---------- Two directory accounts: the first sign-in becomes the owner.
const stamp = randomBytes(3).toString("hex");
const owner = await newAccount(`owner${stamp}`);
const user = await newAccount(`user${stamp}`);
const o = await verify(owner);
check("the owner signs in with a directory account", o.status === 200 && typeof o.token === "string", `${o.status} ${o.body.error ?? ""}`);
const [ss, state] = await api("GET", "/api/state", undefined, o.token);
// A server that started before this script could not register (the directory was not there yet) and waits a minute
// before a lookup tries again; the setup check registers at once.
const firstCheck = (await api("GET", "/api/doctor", undefined, o.token))[1].checks?.find((c) => c.id === "directory");
check("the server registers at the played directory", firstCheck?.status === "ok" && token !== null, JSON.stringify(firstCheck).slice(0, 200));
check("the settings carry the switch, on by default", ss === 200 && state.settings?.refuseSuspended === true, JSON.stringify(state.settings ?? {}).slice(0, 160));
check("open join for the test", (await api("PATCH", "/api/settings", { openJoin: true }, o.token))[0] === 200);
const u = await verify(user);
check("a second account joins", u.status === 200 && typeof u.token === "string", `${u.status} ${u.body.error ?? ""}`);
const wsU = connectWs(u.token);
check("its socket is welcomed", (await wsU.first())?.type === "welcome");
const wsO = connectWs(o.token);
check("the owner's socket too", (await wsO.first())?.type === "welcome");

// ---------- Suspended at the directory: the push tells the server.
const until = suspend(user, 7);
check("the directory's push is taken", (await notify(user))[0] === 204);
const code = await wsU.closed(5000);
const told = wsU.events.find((e) => e.type === "error");
check("suspended: the running socket gets `unauthorized` with the date and is closed with 4014", code === 4014 && told?.code === "unauthorized" && told.message === `account_suspended ${until}`, JSON.stringify({ code, told }));
const [ms, me] = await api("GET", "/api/me", undefined, u.token);
check("suspended: a request with the session -> 403 account_suspended with the date", ms === 403 && me.error === "account_suspended" && me.until === until, `${ms} ${JSON.stringify(me)}`);
const again = await verify(user);
check("suspended: no sign-in -> 403 account_suspended with the date", again.status === 403 && again.body.error === "account_suspended" && again.body.until === until, `${again.status} ${JSON.stringify(again.body)}`);
{
  const ws = connectWs(u.token);
  const first = await ws.first();
  check("suspended: a new socket is refused the same way", first?.type === "error" && first.code === "unauthorized" && first.message === `account_suspended ${until}` && (await ws.closed(3000)) === 4014, JSON.stringify(first));
}
check("suspended: members see nothing of it, the owner's socket stays", (await api("GET", "/api/state", undefined, o.token))[1].members?.some((m) => m.publicKey === user.publicKey) === true && (await wsO.closed(300)) === null);

// ---------- The operator of the server switches it off, and on again.
check("the switch off -> ok", (await api("PATCH", "/api/settings", { refuseSuspended: false }, o.token))[0] === 200 && (await api("GET", "/api/state", undefined, o.token))[1].settings.refuseSuspended === false);
check("switched off: the same session works again (it was never deleted)", (await api("GET", "/api/me", undefined, u.token))[0] === 200);
const wsU2 = connectWs(u.token);
check("switched off: the socket is welcomed, a sign-in works", (await wsU2.first())?.type === "welcome" && (await verify(user)).status === 200);
check("the switch on again -> ok", (await api("PATCH", "/api/settings", { refuseSuspended: true }, o.token))[0] === 200);
check("switched on: whoever is known as suspended is disconnected at once", (await wsU2.closed(5000)) === 4014 && (await api("GET", "/api/me", undefined, u.token))[1].error === "account_suspended");

// ---------- Lifted at the directory.
suspend(user, null);
await notify(user);
let back = 0;
for (let i = 0; i < 40 && back !== 200; i++) { await sleep(100); back = (await api("GET", "/api/me", undefined, u.token))[0]; }
const wsU3 = connectWs(u.token);
check("lifted: the session and the socket work again without a new sign-in", back === 200 && (await wsU3.first())?.type === "welcome");

// ---------- A suspension that has run out is none.
accounts.get(user.publicKey).suspendedUntil = new Date(Date.now() - 1000).toISOString();
await notify(user);
await sleep(500);
check("a date that has passed refuses nothing", (await api("GET", "/api/me", undefined, u.token))[0] === 200 && (await wsU3.closed(300)) === null);
wsU3.close();

// ---------- The directory refuses this server's registration.
registration = "blocked";
const [ds, report] = await api("GET", "/api/doctor", undefined, o.token);
const dirCheck = report.checks?.find((c) => c.id === "directory");
check("refused registration: the setup check says who refused and why, not that the address is wrong", ds === 200 && dirCheck?.status === "fail" && /abgelehnt/.test(dirCheck.text?.de ?? "") && /Spam/.test(dirCheck.text.de)
  && /refused this server/.test(dirCheck.text?.en ?? "") && !/DIRECTORY_PROOF_URL/.test(dirCheck.text.de) && /server_blocked/.test(dirCheck.detail ?? ""), JSON.stringify(dirCheck).slice(0, 300));
const before = registrations;
await notify(user); await notify(owner);
await sleep(600);
check("refused registration: pushes start no new registration for a while", registrations === before, `${registrations - before} more`);
check("refused registration: whoever is signed in stays signed in, a known account still signs in", (await api("GET", "/api/me", undefined, o.token))[0] === 200 && (await verify(user)).status === 200);
registration = "ok";
const [ds2, report2] = await api("GET", "/api/doctor", undefined, o.token);
check("allowed again: the setup check registers", ds2 === 200 && report2.checks?.find((c) => c.id === "directory")?.status === "ok", JSON.stringify(report2.checks?.find((c) => c.id === "directory")).slice(0, 200));

wsO.close();
// Windows: leaving while sockets are still closing trips an assertion in libuv.
await wsO.closed(2000);
await new Promise((r) => { directory.close(r); directory.closeAllConnections(); });
console.log(failures === 0 ? "\nSmoke test (suspended accounts) green" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
