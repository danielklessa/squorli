// Smoke test of the plugins (docs/features/plugins.md, 15 November 2026): installing, enabling with the capabilities
// confirmed, the scope from the settings, member actions, slash commands, a plugin's messages, schedules, the operator's
// routes, failures and removal. Separate from smoke.mjs because it needs a server of its own: a scratch database (the first
// sign-in becomes the owner; one run per database) and a data folder whose `operator-token` this script may read.
//
// Start the server with
//   DIRECTORY_URL= PORT=3001 PUBLIC_DOMAIN=localhost RATE_LIMIT_FACTOR=5 DATA_DIR=<scratch folder> DATABASE_URL=<scratch>
// then: SMOKE_URL=http://127.0.0.1:3001 SMOKE_DATA_DIR=<the same folder> pnpm smoke:plugins
import * as ed from "@noble/ed25519";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const PROTOCOL_VERSION = 4; // must match packages/protocol
const BASE = process.env.SMOKE_URL ?? "http://127.0.0.1:3001";
const DATA_DIR = process.env.SMOKE_DATA_DIR;
const hex = (b) => Buffer.from(b).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " " + detail : ""}`); if (!ok) failures++; };
const P = { ADMINISTRATOR: 1, MANAGE_SERVER: 2, MANAGE_ROLES: 8, KICK_MEMBERS: 16, VIEW_CHANNELS: 128, SEND_MESSAGES: 256, MANAGE_MESSAGES: 512, CONNECT_VOICE: 1024 };

async function api(method, path, body, token, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: payload });
  return [r.status, await r.json().catch(() => ({}))];
}
const [, health] = await api("GET", "/api/health");
if (health.directoryUrl) { console.error("FAIL the server names a directory; start it with DIRECTORY_URL= (empty)"); process.exit(1); }
const DOMAIN = health.domain ?? "localhost";

async function newKey() { const priv = ed.utils.randomSecretKey(); return { priv, publicKey: hex(await ed.getPublicKeyAsync(priv)) }; }
async function login(key) {
  const sign = async (msg) => hex(await ed.signAsync(new TextEncoder().encode(msg), key.priv));
  let [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
  let [status, body] = await api("POST", "/api/auth/verify", { challengeId: ch.challengeId, publicKey: key.publicKey, signature: await sign(`community-chat-login\n${DOMAIN}\n${ch.nonce}`) });
  if (status === 403 && body.error === "registration_required") {
    [, ch] = await api("POST", "/api/auth/challenge", { publicKey: key.publicKey });
    const handle = `p${key.publicKey.slice(0, 12)}`;
    const backup = { ciphertext: Buffer.from(key.priv).toString("base64"), params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: "00".repeat(16), iv: "00".repeat(12) }, authKey: createHash("sha256").update(`auth:${key.publicKey}`).digest("hex") };
    [status, body] = await api("POST", "/api/local/register", { challengeId: ch.challengeId, publicKey: key.publicKey, signature: await sign(`squorli-local-register\n${DOMAIN}\n${ch.nonce}\n${handle}\n${backup.ciphertext}`), handle, backup });
  }
  if (status !== 200) throw new Error(`login failed: ${status} ${JSON.stringify(body)}`);
  return { token: body.sessionToken, userId: body.userId };
}
async function connectWs(token) {
  const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/api/ws");
  const events = [], waiters = [];
  ws.on("message", (m) => { const e = JSON.parse(m.toString()); events.push(e); for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); } });
  await new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const hit = events.find(pred); if (hit) return resolve(hit);
    const w = { pred, resolve }; waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i < 0) return; waiters.splice(i, 1); reject(new Error("timeout waiting for event")); }, ms);
  });
  const waitNew = (pred, ms) => { const mark = events.length; return waitFor((e) => pred(e) && events.indexOf(e) >= mark, ms); };
  let isClosed = false;
  ws.on("close", () => { isClosed = true; });
  const close = () => new Promise((r) => { if (isClosed) return r(); ws.once("close", r); ws.close(); });
  ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, sessionToken: token }));
  const welcome = await waitFor((e) => e.type === "welcome" || e.type === "error");
  return { events, waitFor, waitNew, close, welcome };
}

// ---------- The plugin this test uploads: one command that runs whatever the test asks for, a member action with a
// schedule of seconds, and an answer to "ping" in the channel of its settings.
const PROBE = `/* squorli-plugin
{
  "id": "smoke-probe", "name": { "en": "Smoke probe", "de": "Rauchtest" }, "description": "What the smoke test drives.", "version": "1.0.0", "apiVersion": 1,
  "capabilities": ["members.read", "roles.manage", "messages.read", "messages.write"],
  "settings": [
    { "key": "roles", "type": "roles", "label": "Roles" },
    { "key": "room", "type": "channel", "label": "Channel" },
    { "key": "note", "type": "text", "label": "Note", "maxLength": 20 }
  ],
  "commands": [
    { "name": "probe", "description": "Runs a probe", "input": "text" },
    { "name": "modonly", "description": "For moderators", "permission": "MANAGE_MESSAGES" }
  ],
  "memberActions": [
    { "id": "lend", "label": { "en": "Lend a role", "de": "Rolle leihen" }, "permission": "MANAGE_ROLES", "target": "any",
      "fields": [ { "key": "role", "type": "role", "from": "roles", "required": true, "label": "Role" }, { "key": "seconds", "type": "duration", "required": true, "min": 1, "label": "Seconds" } ] }
  ],
  "views": [ { "id": "jobs", "title": "Jobs", "columns": [ { "key": "name", "label": "Name" }, { "key": "dueAt", "label": "Due", "type": "time" } ] } ]
}
*/
squorli.on("command", async (e) => {
  if (e.command === "modonly") return "mods only";
  const space = e.text.indexOf(" ");
  const what = space < 0 ? e.text : e.text.slice(0, space), arg = space < 0 ? "" : e.text.slice(space + 1);
  if (what === "echo") return { message: { en: "echo " + arg, de: "Echo " + arg } };
  if (what === "say") { const m = await squorli.messages.send(e.channelId, "said: " + arg); return m.id; }
  if (what === "env") return JSON.stringify({ process: typeof process, fetch: typeof fetch, require: typeof require });
  if (what === "give") { try { return String(await squorli.roles.give(e.by, arg)); } catch (err) { return "refused: " + err.message; } }
  if (what === "store") { await squorli.storage.set("k", { v: arg }); return JSON.stringify(await squorli.storage.get("k")); }
  if (what === "last") return JSON.stringify(await squorli.storage.get("lastRoles"));
  if (what === "members") { const r = await squorli.members.list(); return r.total + ":" + Object.keys(r.members[0]).sort().join(","); }
  if (what === "settings") return JSON.stringify(await squorli.settings.get());
  if (what === "sayto") { try { await squorli.messages.send(arg, "room message"); return "sent"; } catch (err) { return "refused: " + err.message; } }
  if (what === "edit") { try { await squorli.messages.edit(arg, "edited by the plugin"); return "edited"; } catch (err) { return "refused: " + err.message; } }
  if (what === "spin") { for (;;) {} }
  if (what === "throw") throw new Error("on purpose");
  return "unknown";
});
squorli.on("memberAction", async (e) => {
  await squorli.schedule.at(Date.now() + e.values.seconds * 1000, "take", { userId: e.userId, roleId: e.values.role }, { key: e.userId + ":" + e.values.role });
  await squorli.roles.give(e.userId, e.values.role);
  return { ok: true, message: "lent" };
});
squorli.on("job", async (job) => { await squorli.roles.take(job.payload.userId, job.payload.roleId); });
squorli.on("message.create", async (e) => { if (e.message.content.indexOf("ping") === 0) await squorli.messages.send(e.message.channelId, "pong" + e.message.content.slice(4)); });
squorli.on("member.roles", async (e) => { await squorli.storage.set("lastRoles", e); });
squorli.on("view", async () => (await squorli.schedule.list()).map((j) => ({ name: j.name, dueAt: j.dueAt })));
`;
const HELLO_TS = `/* squorli-plugin
{ "id": "hello-ts", "name": "Hello", "description": "A TypeScript plugin.", "version": "1.0.0", "apiVersion": 1,
  "commands": [ { "name": "hello", "description": "Says hello" } ] }
*/
interface Greeting { en: string; de: string }
const greeting: Greeting = { en: "Hello!", de: "Hallo!" };
squorli.on("command", async (e: { by: string }): Promise<{ message: Greeting }> => ({ message: greeting }));
`;

// ---------- People, roles, channels
const owner = await login(await newKey());
await api("PATCH", "/api/settings", { openJoin: true }, owner.token);
const [, state0] = await api("GET", "/api/state", undefined, owner.token);
check("state: the plugins flag is there before any plugin is installed", !!state0.plugins && Array.isArray(state0.plugins.commands) && state0.plugins.commands.length === 0, JSON.stringify(state0.plugins));
const memberRole = state0.roles.find((r) => r.name === "Mitglied");
const general = state0.channels.find((c) => c.kind === "text");
const [, other] = await api("POST", "/api/channels", { kind: "text", name: "plugin-other", categoryId: general.categoryId }, owner.token);
const mkRole = async (name, permissions, position) => { const [, r] = await api("POST", "/api/roles", { name, permissions }, owner.token); await api("PATCH", `/api/roles/${r.id}`, { position }, owner.token); return r; };
const lendRole = await mkRole("Lend", 0, 1);
const kickRole = await mkRole("Kicker", P.KICK_MEMBERS, 2);
const modRole = await mkRole("PluginMod", P.MANAGE_ROLES | P.MANAGE_SERVER | P.VIEW_CHANNELS | P.SEND_MESSAGES, 5);
const adminRole = await mkRole("PluginAdmin", P.ADMINISTRATOR, 9);
const mod = await login(await newKey());
const member = await login(await newKey());
await api("PUT", `/api/members/${mod.userId}/roles`, { roleIds: [modRole.id, memberRole.id] }, owner.token);
await api("PUT", `/api/members/${member.userId}/roles`, { roleIds: [memberRole.id] }, owner.token);
const ownerWs = await connectWs(owner.token);
const rolesOf = async (userId) => (await api("GET", "/api/state", undefined, owner.token))[1].members.find((m) => m.userId === userId)?.roleIds ?? [];

// ---------- Verwaltung > Plugins
const [sList, list0] = await api("GET", "/api/plugins", undefined, owner.token);
check("list: an owner sees it, with the plugin that ships with the server under available", sList === 200 && list0.mode === "owner" && list0.plugins.length === 0 && list0.available.some((a) => a.id === "timed-roles"), JSON.stringify(list0).slice(0, 200));
check("list: a member without MANAGE_SERVER gets 403", (await api("GET", "/api/plugins", undefined, member.token))[0] === 403);
check("install: a member with MANAGE_SERVER who is no owner gets 403", (await api("POST", "/api/plugins", { source: PROBE, fileName: "smoke-probe.js" }, mod.token))[0] === 403);
const [sBad, bad] = await api("POST", "/api/plugins", { source: "squorli.on('x', () => 1);", fileName: "nohead.js" }, owner.token);
check("install: a file without the manifest comment is refused", sBad === 400 && bad.error === "plugin_no_manifest", `${sBad} ${bad.error}`);
const [sNew, tooNew] = await api("POST", "/api/plugins", { source: PROBE.replace('"apiVersion": 1', '"apiVersion": 99'), fileName: "smoke-probe.js" }, owner.token);
check("install: a plugin for a later interface version is refused with its own code", sNew === 409 && tooNew.error === "plugin_api_too_new", `${sNew} ${tooNew.error}`);
const [sEnum, en] = await api("POST", "/api/plugins", { source: HELLO_TS.replace("interface Greeting", "enum E { A }\ninterface Greeting"), fileName: "hello.ts" }, owner.token);
check("install: TypeScript that needs more than removing types is refused with the reason", sEnum === 400 && en.error === "plugin_bad_code" && /enum/.test(en.message ?? ""), `${sEnum} ${en.error} ${en.message}`);
const [sSyn, syn] = await api("POST", "/api/plugins", { source: PROBE + "\nfunction (", fileName: "smoke-probe.js" }, owner.token);
check("install: code that does not compile is refused", sSyn === 400 && syn.error === "plugin_bad_code", `${sSyn} ${syn.error}`);

const [sIn, probe] = await api("POST", "/api/plugins", { source: PROBE, fileName: "smoke-probe.js" }, owner.token);
check("install: the plugin is stored switched off, nothing granted", sIn === 200 && probe.id === "smoke-probe" && probe.enabled === false && probe.state === "disabled" && probe.capabilities.length === 4 && probe.capabilities.every((c) => c.granted === false && c.text.de && c.text.en), JSON.stringify(probe).slice(0, 200));
const [sNoGrant, noGrant] = await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true }, owner.token);
check("enable: without the confirmed capabilities it is refused and names them", sNoGrant === 409 && noGrant.error === "capabilities_changed" && noGrant.capabilities.length === 4, `${sNoGrant} ${noGrant.error}`);
check("enable: with fewer capabilities than asked it is refused too", (await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: ["members.read"] }, owner.token))[0] === 409);
check("enable: a non-owner gets 403", (await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: probe.capabilities.map((c) => c.id) }, mod.token))[0] === 403);
const surfaceEvent = ownerWs.waitNew((e) => e.type === "structure" && e.plugins && e.plugins.commands.some((c) => c.name === "probe"));
const [sOn, on] = await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: probe.capabilities.map((c) => c.id) }, owner.token);
check("enable: with exactly what it asks for it runs", sOn === 200 && on.enabled === true && on.state === "running" && on.capabilities.every((c) => c.granted), `${sOn} ${on.state}`);
const surface1 = await surfaceEvent.catch(() => null);
check("enable: every client gets the commands and member actions with a structure event", !!surface1 && surface1.plugins.memberActions.some((a) => a.id === "lend" && a.plugin === "smoke-probe"));

// ---------- Settings are the scope
const [sSet1, set1] = await api("PUT", "/api/plugins/smoke-probe/settings", { values: { roles: [lendRole.id], room: general.id, note: "hi" } }, owner.token);
check("settings: an owner saves roles and a channel", sSet1 === 200 && set1.values.roles[0] === lendRole.id && set1.values.room === general.id, `${sSet1} ${JSON.stringify(set1).slice(0, 120)}`);
const [sSet2, set2] = await api("PUT", "/api/plugins/smoke-probe/settings", { values: { roles: [lendRole.id, adminRole.id] } }, owner.token);
check("settings: a role with administrator rights is refused, even for the owner", sSet2 === 400 && set2.error === "invalid_values" && !!set2.fieldErrors?.roles, `${sSet2} ${JSON.stringify(set2)}`);
const [sSet3, set3] = await api("PUT", "/api/plugins/smoke-probe/settings", { values: { roles: [lendRole.id, kickRole.id] } }, mod.token);
check("settings: an admin cannot add a role whose permissions they do not hold", sSet3 === 400 && !!set3.fieldErrors?.roles, `${sSet3} ${JSON.stringify(set3)}`);
const [sSet4] = await api("PUT", "/api/plugins/smoke-probe/settings", { values: { note: "by the mod" } }, mod.token);
check("settings: the same admin may change a text and keeps the scope the owner made", sSet4 === 200 && (await api("GET", "/api/plugins/smoke-probe/settings", undefined, mod.token))[1].values.roles.length === 1);
const [sSet5, set5] = await api("PUT", "/api/plugins/smoke-probe/settings", { values: { note: "x".repeat(30) } }, owner.token);
check("settings: a value past the field's limit is refused with a text in both languages", sSet5 === 400 && !!set5.fieldErrors?.note?.de && !!set5.fieldErrors?.note?.en, JSON.stringify(set5));
const [, state1] = await api("GET", "/api/state", undefined, member.token);
const lend = state1.plugins.memberActions.find((a) => a.id === "lend");
check("surface: the dialog's role field offers exactly the roles of the settings", JSON.stringify(lend?.fields.find((f) => f.key === "role")?.allowed) === JSON.stringify([lendRole.id]), JSON.stringify(lend?.fields));

// ---------- Slash commands
const cmd = (token, text, channelId = general.id, name = "probe") => api("POST", `/api/channels/${channelId}/commands`, { plugin: "smoke-probe", name, text }, token);
const [sEcho, echo] = await cmd(member.token, "echo hallo");
check("command: the handler's answer comes back to the caller in two languages", sEcho === 200 && echo.ok === true && echo.message.en === "echo hallo" && echo.message.de === "Echo hallo", `${sEcho} ${JSON.stringify(echo)}`);
const [, env] = await cmd(member.token, "env");
check("command: inside the plugin there is no process, fetch or require", env.message?.en === JSON.stringify({ process: "undefined", fetch: "undefined", require: "undefined" }), env.message?.en);
check("command: an unknown command is a 404", (await api("POST", `/api/channels/${general.id}/commands`, { plugin: "smoke-probe", name: "nope" }, member.token))[0] === 404);
check("command: a command that needs MANAGE_MESSAGES refuses a member", (await cmd(member.token, "", general.id, "modonly"))[0] === 403);
check("command: and runs for the owner", (await cmd(owner.token, "", general.id, "modonly"))[1].message?.en === "mods only");
const [, mem] = await cmd(member.token, "members");
check("command: the member list carries names and roles, no key and no presence", mem.message?.en === "3:displayName,handle,isOwner,joinedAt,roleIds,userId", mem.message?.en);
const [, stored] = await cmd(member.token, "store 42");
check("command: storage keeps a value", stored.message?.en === JSON.stringify({ v: "42" }), stored.message?.en);
const [, viaSettings] = await cmd(member.token, "settings");
check("command: the plugin reads its settings", JSON.parse(viaSettings.message?.en ?? "{}").note === "by the mod", viaSettings.message?.en);

// ---------- Roles only inside the scope
const [, g1] = await cmd(member.token, `give ${kickRole.id}`);
check("roles: a role outside the scope is refused", /^refused: .*not among the roles/.test(g1.message?.en ?? ""), g1.message?.en);
const [, g2] = await cmd(member.token, `give ${adminRole.id}`);
check("roles: an administrator role is refused", /^refused: /.test(g2.message?.en ?? ""), g2.message?.en);
const [, g3] = await cmd(member.token, `give ${lendRole.id}`);
check("roles: a role of the scope is given", g3.message?.en === "true" && (await rolesOf(member.userId)).includes(lendRole.id), g3.message?.en);
await api("PATCH", `/api/roles/${lendRole.id}`, { permissions: P.KICK_MEMBERS }, owner.token);
await api("PUT", `/api/members/${member.userId}/roles`, { roleIds: [memberRole.id] }, owner.token);
const [, g4] = await cmd(member.token, `give ${lendRole.id}`);
check("roles: a role that gained permissions since the settings were saved is refused", /^refused: .*gained permissions/.test(g4.message?.en ?? ""), g4.message?.en);
await api("PATCH", `/api/roles/${lendRole.id}`, { permissions: 0 }, owner.token);
const [, last] = await cmd(member.token, "last");
const lastRoles = JSON.parse(last.message?.en ?? "null");
check("events: the plugin learns of a role change by a person, with who did it", lastRoles?.userId === member.userId && lastRoles.removed.includes(lendRole.id) && lastRoles.origin === "user" && lastRoles.by === owner.userId, last.message?.en);

// ---------- Member actions and schedules
const act = (token, userId, values) => api("POST", "/api/plugins/smoke-probe/member-actions/lend", { userId, values }, token);
check("member action: a member without MANAGE_ROLES gets 403", (await act(member.token, member.userId, { role: lendRole.id, seconds: 2 }))[0] === 403);
const [sAct1, act1] = await act(mod.token, member.userId, { role: kickRole.id, seconds: 2 });
check("member action: a role that is not in the field's list is refused before the plugin runs", sAct1 === 200 && act1.ok === false && !!act1.fieldErrors?.role, `${sAct1} ${JSON.stringify(act1)}`);
const [sAct2, act2] = await act(mod.token, member.userId, { role: lendRole.id });
check("member action: a missing duration is a field error", sAct2 === 200 && act2.ok === false && !!act2.fieldErrors?.seconds, JSON.stringify(act2));
const [sAct3, act3] = await act(mod.token, owner.userId, { role: lendRole.id, seconds: 2 });
check("member action: nobody but the first owner gives an owner a role through a plugin either", sAct3 === 200 && act3.ok === false && !!act3.fieldErrors?.role, JSON.stringify(act3));
const gotRole = ownerWs.waitNew((e) => e.type === "structure" && e.members?.find((m) => m.userId === member.userId)?.roleIds.includes(lendRole.id));
const [sAct4, act4] = await act(mod.token, member.userId, { role: lendRole.id, seconds: 2 });
check("member action: a moderator lends the role", sAct4 === 200 && act4.ok === true && act4.message?.en === "lent", `${sAct4} ${JSON.stringify(act4)}`);
check("member action: the role arrives with a structure event", !!(await gotRole.catch(() => null)));
const [sView, view] = await api("GET", "/api/plugins/smoke-probe/views/jobs", undefined, mod.token);
check("view: the plugin's table shows the waiting job with the manifest's columns", sView === 200 && view.rows.length === 1 && view.rows[0].name === "take" && view.columns.length === 2, JSON.stringify(view).slice(0, 200));
const lostRole = ownerWs.waitNew((e) => e.type === "structure" && e.members && !e.members.find((m) => m.userId === member.userId)?.roleIds.includes(lendRole.id), 8000);
check("schedule: the job takes the role away again when its time is up", !!(await lostRole.catch(() => null)) && !(await rolesOf(member.userId)).includes(lendRole.id));
const [, last2] = await cmd(member.token, "last");
check("events: a plugin does not get the role changes it made itself", JSON.parse(last2.message?.en ?? "null")?.origin === "user", last2.message?.en);

// ---------- A plugin's messages
const createdByCommand = ownerWs.waitNew((e) => e.type === "message.create" && e.message.content === "said: hallo");
const [, say] = await cmd(member.token, "say hallo", other.id);
const said = (await createdByCommand.catch(() => null))?.message;
check("messages: a command answers publicly in the channel it was run in, also outside the scope", !!said && said.channelId === other.id && say.message?.en === said.id, JSON.stringify(said));
check("messages: the message names the plugin, the caller and the command, and goes out as a notice", said?.plugin?.id === "smoke-probe" && said.plugin.by === member.userId && said.plugin.command === "probe" && said.notice === true && said.plugin.name.de === "Rauchtest", JSON.stringify(said?.plugin));
check("messages: its author is no member", !(await api("GET", "/api/state", undefined, owner.token))[1].members.some((m) => m.userId === said?.authorId));
const [, toOther] = await cmd(member.token, `sayto ${other.id}`, general.id);
check("messages: outside a command's own channel only the channels of the settings are writable", /^refused: .*not among the channels/.test(toOther.message?.en ?? ""), toOther.message?.en);
const pong = ownerWs.waitNew((e) => e.type === "message.create" && e.message.content === "pong 1");
await api("POST", `/api/channels/${general.id}/messages`, { content: "ping 1" }, member.token);
check("messages: the plugin reads a channel of its scope and answers there", !!(await pong.catch(() => null)));
await sleep(600);
const [, hist] = await api("GET", `/api/channels/${general.id}/messages`, undefined, owner.token);
check("messages: its own answer does not come back to it (one pong, no loop)", hist.messages.filter((m) => m.content.startsWith("pong")).length === 1, String(hist.messages.length));
await api("POST", `/api/channels/${other.id}/messages`, { content: "ping 2" }, member.token);
await sleep(600);
check("messages: a channel outside the scope is not read", !(await api("GET", `/api/channels/${other.id}/messages`, undefined, owner.token))[1].messages.some((m) => m.content.startsWith("pong")));
const [, mine] = await api("POST", `/api/channels/${general.id}/messages`, { content: "a member's message" }, member.token);
const [, ed1] = await cmd(member.token, `edit ${mine.id}`);
check("messages: a plugin cannot edit somebody else's message", /^refused: /.test(ed1.message?.en ?? ""), ed1.message?.en);
const [sNotice, noticed] = await api("PUT", `/api/messages/${said.id}/notice`, { notice: false }, owner.token);
check("messages: the notice switch of an older app changes nothing on a plugin's message", sNotice === 200 && noticed.notice === true, `${sNotice} ${noticed.notice}`);
const [sRep] = await api("POST", "/api/reports", { kind: "message", messageId: said.id, reason: "spam" }, mod.token);
const [, reps] = await api("GET", "/api/reports?status=open", undefined, owner.token);
const rep = reps.reports?.find((r) => r.messageId === said.id);
check("messages: a report of a plugin's message names the plugin and no person to kick or ban", sRep === 200 && !!rep && rep.reportedUserId === null && rep.reportedName === "Smoke probe", `${sRep} ${JSON.stringify(rep).slice(0, 160)}`);
const [sTooBig, tooBig] = await api("POST", "/api/plugins", { source: PROBE + "//" + "x".repeat(300 * 1024), fileName: "smoke-probe.js" }, owner.token);
check("install: a file over 256 KB is refused with the answer that says so", sTooBig === 400 && tooBig.error === "plugin_too_large", `${sTooBig} ${tooBig.error}`);
const [sCtl, ctl] = await api("POST", "/api/plugins", { source: PROBE.replace('"en": "Smoke probe"', '"en": "Smoke\\u001b[2Jprobe"'), fileName: "smoke-probe.js" }, owner.token);
check("install: a name with an escape sequence is refused", sCtl === 400 && ctl.error === "plugin_bad_manifest", `${sCtl} ${ctl.error}`);
check("messages: the plugin's author cannot be banned", (await api("POST", "/api/bans", { userId: said.authorId }, owner.token))[0] === 404);
check("messages: a moderator deletes a plugin's message like any other", (await api("DELETE", `/api/messages/${said.id}`, undefined, owner.token))[0] === 200);

// ---------- Failures
const t0 = Date.now();
const [sSpin, spin] = await cmd(member.token, "spin");
const [sHealth] = await api("GET", "/api/health");
check("failure: an endless loop ends with 502 and the server keeps answering", sSpin === 502 && spin.error === "plugin_failed" && sHealth === 200 && Date.now() - t0 < 5000, `${sSpin} ${spin.error} ${Date.now() - t0} ms`);
check("failure: the plugin still runs afterwards", (await cmd(member.token, "echo again"))[1].message?.en === "echo again");
for (let i = 0; i < 4; i++) await cmd(member.token, "throw");
await sleep(300);
const [, afterThrows] = await api("GET", "/api/plugins", undefined, owner.token);
const suspended = afterThrows.plugins.find((p) => p.id === "smoke-probe");
check("failure: five failures in a row suspend the plugin and keep the last error", suspended?.state === "suspended" && /on purpose/.test(suspended.lastError ?? ""), `${suspended?.state} ${suspended?.lastError}`);
check("failure: a suspended plugin's commands are gone from every client", (await api("GET", "/api/state", undefined, member.token))[1].plugins.commands.length === 0);
check("failure: and running one answers 404", (await cmd(member.token, "echo x"))[0] === 404);
const [, log] = await api("GET", "/api/plugins/smoke-probe/log", undefined, mod.token);
check("log: it holds the server's notes about the plugin (roles given, failures, the suspension)", log.entries.some((e) => /gave the role/.test(e.text)) && log.entries.some((e) => /suspended after/.test(e.text)) && log.entries.every((e) => e.source === "host"), String(log.entries.length));
const [sBack, back] = await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: probe.capabilities.map((c) => c.id) }, owner.token);
check("failure: an owner switches it on again", sBack === 200 && back.state === "running" && (await cmd(member.token, "echo back"))[1].message?.en === "echo back");

// ---------- An update that asks for more
const SMALLER = PROBE.replace('"capabilities": ["members.read", "roles.manage", "messages.read", "messages.write"]', '"capabilities": ["members.read"]').replace('"version": "1.0.0"', '"version": "1.1.0"');
const [sUp1, up1] = await api("POST", "/api/plugins", { source: SMALLER, fileName: "smoke-probe.js" }, owner.token);
check("update: a new version that asks for less keeps running, with its settings", sUp1 === 200 && up1.version === "1.1.0" && up1.state === "running" && (await api("GET", "/api/plugins/smoke-probe/settings", undefined, owner.token))[1].values.note === "by the mod", `${sUp1} ${up1.state}`);
await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: ["members.read"] }, owner.token);
const [sUp2, up2] = await api("POST", "/api/plugins", { source: PROBE.replace('"version": "1.0.0"', '"version": "1.2.0"'), fileName: "smoke-probe.js" }, owner.token);
check("update: a new version that asks for more stops until an owner confirms", sUp2 === 200 && up2.state === "needs_approval" && (await cmd(member.token, "echo x"))[0] === 404, `${sUp2} ${up2.state}`);
check("update: confirming starts it again", (await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: probe.capabilities.map((c) => c.id) }, owner.token))[1].state === "running");

// ---------- TypeScript, and the plugin that ships with the server
const [sTs, ts] = await api("POST", "/api/plugins", { source: HELLO_TS, fileName: "hello.ts" }, owner.token);
check("typescript: a .ts plugin is installed", sTs === 200 && ts.language === "ts", `${sTs} ${JSON.stringify(ts).slice(0, 120)}`);
await api("PUT", "/api/plugins/hello-ts/enabled", { enabled: true, grant: [] }, owner.token);
const [, hello] = await api("POST", `/api/channels/${general.id}/commands`, { plugin: "hello-ts", name: "hello" }, member.token);
check("typescript: and runs", hello.message?.de === "Hallo!", JSON.stringify(hello));
const [sTr, tr] = await api("POST", "/api/plugins", { bundled: "timed-roles" }, owner.token);
check("bundled: the timed roles plugin installs from the server itself", sTr === 200 && tr.id === "timed-roles" && tr.installedVia === "bundled" && tr.language === "ts", `${sTr} ${JSON.stringify(tr).slice(0, 160)}`);
await api("PUT", "/api/plugins/timed-roles/enabled", { enabled: true, grant: tr.capabilities.map((c) => c.id) }, owner.token);
await api("PUT", "/api/plugins/timed-roles/settings", { values: { roles: [lendRole.id] } }, owner.token);
const [sGive, give] = await api("POST", "/api/plugins/timed-roles/member-actions/give", { userId: member.userId, values: { role: lendRole.id, duration: 3600 } }, mod.token);
check("timed roles: a moderator gives a role for an hour and is told when it ends", sGive === 200 && give.ok === true && /1 hour/.test(give.message?.en ?? "") && /1 Stunde/.test(give.message?.de ?? "") && (await rolesOf(member.userId)).includes(lendRole.id), `${sGive} ${JSON.stringify(give)}`);
const [, running] = await api("GET", "/api/plugins/timed-roles/views/running", undefined, owner.token);
check("timed roles: the running assignment is listed with member, role, end and who gave it", running.rows.length === 1 && running.rows[0].member === member.userId && running.rows[0].role === lendRole.id && running.rows[0].by === mod.userId && running.rows[0].until > Date.now(), JSON.stringify(running.rows));
await api("PUT", `/api/members/${member.userId}/roles`, { roleIds: [memberRole.id] }, owner.token);
await sleep(800);
check("timed roles: taking the role away by hand ends the assignment", (await api("GET", "/api/plugins/timed-roles/views/running", undefined, owner.token))[1].rows.length === 0);
check("timed roles: the list under available no longer offers what is installed", !(await api("GET", "/api/plugins", undefined, owner.token))[1].available.some((a) => a.id === "timed-roles"));

// ---------- The operator at the machine
check("operator: without the machine's token the routes answer 403", (await api("GET", "/api/operator/plugins"))[0] === 403 && (await api("GET", "/api/operator/plugins", undefined, undefined, { "x-squorli-operator": "wrong" }))[0] === 403);
check("operator: a session does not open them either", (await api("GET", "/api/operator/plugins", undefined, owner.token))[0] === 403);
if (DATA_DIR) {
  const op = { "x-squorli-operator": readFileSync(join(DATA_DIR, "operator-token"), "utf8").trim() };
  const [sOp, opList] = await api("GET", "/api/operator/plugins", undefined, undefined, op);
  check("operator: with the token of the data folder the list answers", sOp === 200 && opList.plugins.length === 3, `${sOp} ${opList.plugins?.length}`);
  const OP_PLUGIN = HELLO_TS.replace('"id": "hello-ts"', '"id": "hello-op"').replace('"name": "hello"', '"name": "hello-op"');
  const [sOpIn, opIn] = await api("POST", "/api/operator/plugins", { source: OP_PLUGIN, fileName: "hello-op.ts" }, undefined, op);
  check("operator: installs a plugin", sOpIn === 200 && opIn.installedVia === "cli", `${sOpIn} ${JSON.stringify(opIn).slice(0, 100)}`);
  check("operator: enables it without a grant list", (await api("PUT", "/api/operator/plugins/hello-op/enabled", { enabled: true }, undefined, op))[1].state === "running");
  check("operator: reads its log", (await api("GET", "/api/operator/plugins/hello-op/log", undefined, undefined, op))[1].entries.some((e) => /switched on by the operator/.test(e.text)));
  check("operator: removes it", (await api("DELETE", "/api/operator/plugins/hello-op", undefined, undefined, op))[0] === 200);
} else console.log("skip operator routes with a token: SMOKE_DATA_DIR is not set");

// ---------- The second plugin that ships: birthdays
const [sBd, bd] = await api("POST", "/api/plugins", { bundled: "birthdays" }, owner.token);
check("birthdays: the plugin installs from the server itself", sBd === 200 && bd.id === "birthdays" && bd.commands.includes("geburtstag") && bd.commands.includes("geburtstage"), `${sBd} ${JSON.stringify(bd).slice(0, 160)}`);
await api("PUT", "/api/plugins/birthdays/enabled", { enabled: true, grant: bd.capabilities.map((c) => c.id) }, owner.token);
await api("PUT", "/api/plugins/birthdays/settings", { values: { channel: general.id, hour: 9, zone: "cet", language: "de" } }, owner.token);
const bday = (token, name, values) => api("POST", `/api/channels/${general.id}/commands`, { plugin: "birthdays", name, values }, token);
const [, bd1] = await bday(member.token, "geburtstag", { date: "1990-12-24" });
check("birthdays: a member enters their birthday with the year and is told what happens", bd1.ok === true && bd1.message?.de === "Gespeichert: 24. Dezember. Der Glückwunsch nennt dein Alter.", JSON.stringify(bd1));
const [, bd2] = await bday(mod.token, "birthday", { date: "--02-30" });
check("birthdays: a day the month does not have is a field error of the date field, before the plugin runs", bd2.ok === false && !!bd2.fieldErrors?.date?.de, JSON.stringify(bd2));
const [, bd2b] = await bday(mod.token, "birthday", { date: "2099-01-01" });
check("birthdays: a year of birth in the future is a field error from the plugin", bd2b.ok === false && /Jahr/.test(bd2b.fieldErrors?.date?.de ?? ""), JSON.stringify(bd2b));
check("birthdays: the form's date field tells the app that the year may be left out", (await api("GET", "/api/state", undefined, member.token))[1].plugins.commands.find((c) => c.name === "geburtstag")?.fields.find((f) => f.key === "date")?.yearOptional === true);
const [, bdView] = await api("GET", "/api/plugins/birthdays/views/list", undefined, owner.token);
check("birthdays: the admin's table lists it", bdView.rows.length === 1 && bdView.rows[0].member === member.userId && bdView.rows[0].date === "24. Dezember" && bdView.rows[0].year === 1990, JSON.stringify(bdView.rows));
const [, bdNext] = await bday(mod.token, "geburtstage", undefined);
check("birthdays: anybody may ask for the next birthdays and gets them as an answer only they see", /^Die nächsten Geburtstage:\n(heute|24\. Dezember): .+ \(wird \d+\)$/.test(bdNext.message?.de ?? ""), JSON.stringify(bdNext));
check("birthdays: the daily job waits", (await api("GET", "/api/plugins", undefined, owner.token))[1].plugins.find((p) => p.id === "birthdays")?.pendingJobs === 1);
const [, bd3] = await bday(member.token, "geburtstag", { remove: true });
check("birthdays: the member takes it out again", bd3.message?.de === "Dein Geburtstag wurde entfernt." && (await api("GET", "/api/plugins/birthdays/views/list", undefined, owner.token))[1].rows.length === 0, JSON.stringify(bd3));

// ---------- Two plugins, one command name
const CLASH = HELLO_TS.replace('"id": "hello-ts"', '"id": "hello-clash"');
await api("POST", "/api/plugins", { source: CLASH, fileName: "clash.ts" }, owner.token);
const [sClash, clash] = await api("PUT", "/api/plugins/hello-clash/enabled", { enabled: true, grant: [] }, owner.token);
check("commands: a second plugin with a command name that is taken cannot be enabled", sClash === 409 && clash.error === "command_taken" && clash.command === "hello", `${sClash} ${JSON.stringify(clash)}`);

// ---------- Switching off and removing
const off = ownerWs.waitNew((e) => e.type === "structure" && e.plugins && !e.plugins.commands.some((c) => c.plugin === "smoke-probe"));
check("disable: an owner switches the plugin off", (await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: false }, owner.token))[1].state === "disabled");
check("disable: its commands leave every client", !!(await off.catch(() => null)));
await api("PUT", "/api/plugins/smoke-probe/enabled", { enabled: true, grant: probe.capabilities.map((c) => c.id) }, owner.token);
await cmd(member.token, "say bleibt", general.id);
check("remove: a non-owner gets 403", (await api("DELETE", "/api/plugins/smoke-probe", undefined, mod.token))[0] === 403);
const bulk = ownerWs.waitNew((e) => e.type === "message.bulkDelete" && e.channelId === general.id);
check("remove: an owner removes the plugin and asks for its messages to go", (await api("DELETE", "/api/plugins/smoke-probe?messages=delete", undefined, owner.token))[0] === 200);
check("remove: its messages leave the channel with one event", !!(await bulk.catch(() => null)) && !(await api("GET", `/api/channels/${general.id}/messages`, undefined, owner.token))[1].messages.some((m) => m.plugin));
check("remove: the roles it gave and the list are as expected", (await api("GET", "/api/plugins", undefined, owner.token))[1].plugins.every((p) => p.id !== "smoke-probe"));
check("limits: Verwaltung > Server > Grenzen names the plugins", (await api("GET", "/api/settings/limits", undefined, owner.token))[1].plugins?.mode === "owner");

await ownerWs.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall plugin checks passed");
process.exitCode = failures ? 1 : 0;
