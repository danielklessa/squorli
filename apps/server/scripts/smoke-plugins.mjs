// Smoke test of the plugins (docs/features/plugins.md, 15 November 2026): installing, enabling with the capabilities
// confirmed, the scope from the settings, member actions, slash commands, a plugin's messages, schedules, the operator's
// routes, failures and removal. Separate from smoke.mjs because it needs a server of its own: a scratch database (the first
// sign-in becomes the owner; one run per database) and a data folder whose `operator-token` this script may read.
//
// Start the server with
//   DIRECTORY_URL= PORT=3001 PUBLIC_DOMAIN=localhost RATE_LIMIT_FACTOR=5 DATA_DIR=<scratch folder> DATABASE_URL=<scratch>
// then: SMOKE_URL=http://127.0.0.1:3001 SMOKE_DATA_DIR=<the same folder> pnpm smoke:plugins
// For the network and the signature (the section "The network and Squorli's signature") the server also gets
//   LINK_PREVIEW_TEST_ORIGIN=http://127.0.0.1:3198 PLUGIN_TEST_SIGNING_KEY=<the value the script prints when it is missing>
// and the script the same LINK_PREVIEW_TEST_ORIGIN; without them those checks are left out with a line that says so.
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

// ---------- A list in the settings, and the plugin's word before they are saved (interface version 2)
{
  const LIST = `/* squorli-plugin
{
  "id": "smoke-list", "name": "Smoke list", "description": "A list field and settings.check.", "version": "1.0.0", "apiVersion": 2,
  "settings": [
    { "key": "items", "type": "list", "maxItems": 3, "label": "Items", "fields": [
      { "key": "name", "type": "text", "label": "Name", "required": true, "maxLength": 30 },
      { "key": "mode", "type": "select", "label": "Mode", "default": "a", "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }] }
    ] },
    { "key": "note", "type": "text", "label": "Note" }
  ]
}
*/
squorli.on("settings.check", async (e) => {
  const items = e.values.items || [];
  const bad = items.find((i) => i.name === "bad");
  if (bad) return { fieldErrors: { items: { en: "No entry may be named bad.", de: "Kein Eintrag darf bad heißen." } } };
  if (e.values.note === "throw") throw new Error("on purpose");
  await squorli.storage.set("checkedBy", e.by);
  return { values: { items: items.map((i) => ({ name: i.name.toUpperCase(), mode: i.mode })), note: e.values.note === "scope" ? "x" : e.values.note } };
});
`;
  const [sList, listInfo] = await api("POST", "/api/plugins", { source: LIST, fileName: "smoke-list.js" }, owner.token);
  check("list: a version 2 plugin with a list field installs, unsigned, since it asks for no network", sList === 200 && listInfo.apiVersion === 2 && listInfo.signature === null, `${sList} ${JSON.stringify(listInfo).slice(0, 160)}`);
  const [, listFields] = await api("GET", "/api/plugins/smoke-list/settings", undefined, owner.token);
  check("list: the settings tell the client the columns of an entry", listFields.fields?.[0]?.type === "list" && listFields.fields[0].fields?.map((f) => `${f.key}:${f.type}`).join(",") === "name:text,mode:select" && listFields.fields[0].maxItems === 3, JSON.stringify(listFields.fields?.[0]).slice(0, 200));
  const saveList = (values) => api("PUT", "/api/plugins/smoke-list/settings", { values }, owner.token);
  // Switched off: nobody to ask, the values are saved as they were sent (after the server's own check).
  const [sOff, off] = await saveList({ items: [{ name: " one " }, {}, { mode: "b" }, { name: "two", mode: "b", stray: 1 }] });
  check("list: entries are saved with their defaults, a row nobody typed into is dropped", sOff === 200 && off.values.items?.map((i) => `${i.name}:${i.mode}:${Object.keys(i).length}`).join(",") === "one:a:2,two:b:2", `${sOff} ${JSON.stringify(off.values ?? off)}`);
  const [sTooMany, tooMany] = await saveList({ items: [1, 2, 3, 4].map((n) => ({ name: `n${n}` })) });
  const [sBadMode] = await saveList({ items: [{ name: "x", mode: "z" }] });
  check("list: more entries than the list holds and an entry that does not fit are refused at the field", sTooMany === 400 && !!tooMany.fieldErrors?.items && sBadMode === 400, `${sTooMany} ${sBadMode}`);
  await api("PUT", "/api/plugins/smoke-list/enabled", { enabled: true, grant: [] }, owner.token);
  const [sOn, on] = await saveList({ items: [{ name: "one" }, { name: "two", mode: "b" }], note: "hello" });
  check("settings.check: values the plugin hands back are what is saved", sOn === 200 && on.values.items?.map((i) => `${i.name}:${i.mode}`).join(",") === "ONE:a,TWO:b" && on.values.note === "hello", `${sOn} ${JSON.stringify(on.values ?? on)}`);
  const [sBad, bad] = await saveList({ items: [{ name: "bad" }], note: "changed" });
  const [, afterBad] = await api("GET", "/api/plugins/smoke-list/settings", undefined, owner.token);
  check("settings.check: the plugin refuses a field with its own sentence, and nothing is saved then", sBad === 400 && bad.error === "invalid_values" && bad.fieldErrors?.items?.de === "Kein Eintrag darf bad heißen." && afterBad.values.note === "hello" && afterBad.values.items[0].name === "ONE", `${sBad} ${JSON.stringify(bad)}`);
  const [sThrow, thrown] = await saveList({ note: "throw" });
  check("settings.check: a plugin that fails while it is asked fails the save", sThrow === 502 && thrown.error === "plugin_failed" && (await api("GET", "/api/plugins/smoke-list/settings", undefined, owner.token))[1].values.note === "hello", `${sThrow} ${thrown.error}`);
  await api("DELETE", "/api/plugins/smoke-list", undefined, owner.token);
}

// ---------- The network and Squorli's signature (interface version 2)
// A plugin that asks for `net.fetch` is installed only with Squorli's signature. The script signs with a key of its own
// (made from a fixed seed, so no private key stands in the repository); the server takes that key only when it was
// started with PLUGIN_TEST_SIGNING_KEY=<the value printed below>, which a production start refuses. The fetches go to
// a source the script plays on LINK_PREVIEW_TEST_ORIGIN (give the same value to the server and to this script).
{
  const { createPrivateKey, createPublicKey, generateKeyPairSync } = await import("node:crypto");
  const { signSource } = await import("../../../tools/plugin-sign.mjs");
  const seed = createHash("sha256").update("squorli smoke test plugin key").digest();
  const testKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const TEST_KEY_ENV = `smoke:${createPublicKey(testKey).export({ format: "der", type: "spki" }).subarray(-32).toString("base64")}`;
  const NET = `/* squorli-plugin
{
  "id": "smoke-net", "name": { "en": "Smoke net", "de": "Rauchtest Netz" }, "description": "Fetches what the smoke test asks for.", "version": "1.0.0", "apiVersion": 2,
  "capabilities": ["messages.write", "net.fetch"],
  "network": { "hosts": ["feeds.example.org"] },
  "commands": [{ "name": "net", "input": "text", "description": "get <address> | post <text> | flood <address> | card <json>" }]
}
*/
squorli.on("command", async (e) => {
  const at = e.text.indexOf(" ");
  const what = at < 0 ? e.text : e.text.slice(0, at), rest = at < 0 ? "" : e.text.slice(at + 1);
  if (what === "get") {
    try { const r = await squorli.net.get(rest); return JSON.stringify({ type: r.contentType, length: r.text.length, start: r.text.slice(0, 60) }); }
    catch (err) { return "refused: " + String(err.message).slice(0, 300); }
  }
  if (what === "post") return (await squorli.messages.send(e.channelId, rest)).id;
  if (what === "card") {
    try { const said = JSON.parse(rest); return (await squorli.messages.send(e.channelId, said.content, { card: said.card })).id; }
    catch (err) { return "refused: " + String(err.message).slice(0, 300); }
  }
  if (what === "flood") {
    let n = 0;
    try { for (let i = 0; i < 40; i++) { await squorli.net.get(rest); n++; } } catch (err) { return n + " then " + String(err.message).slice(0, 120); }
    return String(n);
  }
});
`;
  const upload = (source, fileName = "smoke-net.js") => api("POST", "/api/plugins", { source, fileName }, owner.token);
  const net = async (text) => (await api("POST", `/api/channels/${general.id}/commands`, { plugin: "smoke-net", name: "net", text }, owner.token))[1].message?.en ?? "";

  const [sUnsigned, unsigned] = await upload(NET);
  check("net: a plugin that asks for the network is refused without Squorli's signature", sUnsigned === 400 && unsigned.error === "plugin_signature_required", `${sUnsigned} ${JSON.stringify(unsigned).slice(0, 160)}`);
  const stranger = generateKeyPairSync("ed25519").privateKey;
  const [sStranger, strangerBody] = await upload(signSource(NET, stranger, "stranger", "official"));
  check("net: a signature with a key the server does not know is refused", sStranger === 400 && strangerBody.error === "plugin_signature_invalid", `${sStranger} ${strangerBody.error}`);
  const signed = signSource(NET, testKey, "smoke", "reviewed");
  const [sTampered, tampered] = await upload(signed.replace('["feeds.example.org"]', '["feeds.example.org", "evil.example.org"]'));
  check("net: a file changed after it was signed is refused, whoever signed it", sTampered === 400 && tampered.error === "plugin_signature_invalid", `${sTampered} ${tampered.error}`);
  check("net: an unsigned plugin without the network installs as before and carries no mark", probe.signature === null && probe.blocked === null, JSON.stringify([probe.signature, probe.blocked]));
  const [, listNow] = await api("GET", "/api/plugins", undefined, owner.token);
  // No plugin that asks for the network ships with the server (the game news plugin comes from the catalogue); if one ever does, only signed as Squorli's own.
  const shippedNet = listNow.available.filter((a) => (a.capabilities ?? []).some((c) => c.id === "net.fetch"));
  check("net: a plugin with the network is offered from the server's own files only signed as Squorli's own", shippedNet.every((a) => a.signature?.kind === "official") && !listNow.available.some((a) => a.id === "game-news"), JSON.stringify(shippedNet.map((a) => [a.id, a.signature ?? null])));

  const [sNet, netInfo] = await upload(signed);
  if (sNet === 400 && netInfo.error === "plugin_signature_invalid") {
    console.log(`info net: Server mit PLUGIN_TEST_SIGNING_KEY=${TEST_KEY_ENV} starten, um signierte Plugins und net.get zu pruefen`);
  } else {
    check("net: a signed plugin installs and is shown with whose signature it carries", sNet === 200 && netInfo.signature?.key === "smoke" && netInfo.signature?.kind === "reviewed" && netInfo.apiVersion === 2, `${sNet} ${JSON.stringify(netInfo).slice(0, 200)}`);
    const netCap = netInfo.capabilities?.find((c) => c.id === "net.fetch");
    check("net: the confirmation names the hosts it may fetch from, in both languages", /feeds\.example\.org/.test(netCap?.text?.en ?? "") && /feeds\.example\.org/.test(netCap?.text?.de ?? ""), JSON.stringify(netCap));
    const [sOn, on] = await api("PUT", "/api/plugins/smoke-net/enabled", { enabled: true, grant: netInfo.capabilities.map((c) => c.id) }, owner.token);
    check("net: an owner switches it on", sOn === 200 && on.state === "running", `${sOn} ${on.state}`);
    check("net: a host the manifest does not name is refused", /^refused: .*not among the hosts/.test(await net("get https://example.com/")), await net("get https://example.com/"));
    check("net: http, another port and an address with a user name are refused for a host it names", [await net("get http://feeds.example.org/x"), await net("get https://feeds.example.org:8443/x"), await net("get https://user@feeds.example.org/x")].every((a) => /^refused: .*not among the hosts/.test(a)));
    check("net: what is no address is refused", /^refused: /.test(await net("get not an address")));

    // A signed plugin without the network: the mark, and no network.
    const PLAIN = NET.replace('"id": "smoke-net"', '"id": "smoke-signed"').replace('"apiVersion": 2', '"apiVersion": 1').replace('"capabilities": ["messages.write", "net.fetch"]', '"capabilities": ["messages.write"]').replace('  "network": { "hosts": ["feeds.example.org"] },\n', "").replace('"name": "net"', '"name": "plain"');
    const [sPlain, plain] = await upload(signSource(PLAIN, testKey, "smoke", "official"), "smoke-signed.js");
    check("net: a signed plugin without the network installs with its mark", sPlain === 200 && plain.signature?.kind === "official" && !plain.capabilities.some((c) => c.id === "net.fetch"), `${sPlain} ${JSON.stringify(plain.signature)}`);
    await api("PUT", "/api/plugins/smoke-signed/enabled", { enabled: true, grant: plain.capabilities.map((c) => c.id) }, owner.token);
    const plainGet = (await api("POST", `/api/channels/${general.id}/commands`, { plugin: "smoke-signed", name: "plain", text: "get https://feeds.example.org/x" }, owner.token))[1].message?.en ?? "";
    check("net: and its net.get is refused for want of the capability", /^refused: .*net\.fetch/.test(plainGet), plainGet);

    const SITE = process.env.LINK_PREVIEW_TEST_ORIGIN;
    if (!SITE) console.log("info net: Server und Skript mit LINK_PREVIEW_TEST_ORIGIN=http://127.0.0.1:3198 starten, um den Abruf zu pruefen");
    else {
      const { createServer } = await import("node:http");
      const hits = [];
      let insideHits = 0;
      const site = createServer((req, res) => {
        hits.push(req.url);
        if (req.url === "/feed.json") return res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ items: [{ id: 1, title: "Neu" }] }));
        if (req.url === "/gross.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pad: "x".repeat(300 * 1024) }));
        if (req.url === "/zu-gross.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pad: "x".repeat(600 * 1024) }));
        if (req.url === "/bild.png") return res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
        if (req.url === "/weg") return res.writeHead(404, { "content-type": "application/json" }).end("{}");
        if (req.url === "/nach-innen") return res.writeHead(302, { location: "http://127.0.0.1:3197/geheim" }).end();
        if (req.url === "/weiter") return res.writeHead(302, { location: "/feed.json" }).end();
        if (req.url === "/seite") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><html><head><meta property="og:title" content="Patch 1.2"><meta property="og:description" content="Was neu ist"></head><body></body></html>');
        res.writeHead(404).end();
      });
      const inside = createServer((_req, res) => { insideHits++; res.writeHead(200, { "content-type": "application/json" }).end("{}"); });
      await new Promise((r) => site.listen(Number(new URL(SITE).port), "127.0.0.1", r));
      await new Promise((r) => inside.listen(3197, "127.0.0.1", r));
      const got = await net(`get ${SITE}/feed.json`);
      check("net: net.get answers with the type and the text of what the source sent", got === JSON.stringify({ type: "application/json; charset=utf-8", length: 34, start: '{"items":[{"id":1,"title":"Neu"}]}' }), got);
      const big = await net(`get ${SITE}/gross.json`);
      check("net: an answer larger than the other functions' 64 KB reaches the plugin whole", JSON.parse(big.startsWith("{") ? big : "{}").length === 300 * 1024 + 10, big.slice(0, 120));
      const refusals = [await net(`get ${SITE}/zu-gross.json`), await net(`get ${SITE}/bild.png`), await net(`get ${SITE}/weg`), await net(`get ${SITE}/nach-innen`)];
      check("net: more than 512 KB, a picture, a status that is not 200 and a redirect to another address are no answer", refusals.every((a) => /^refused: .*no usable answer/.test(a)) && insideHits === 0 && hits.includes("/nach-innen"), `${JSON.stringify(refusals.map((a) => a.slice(0, 40)))} inside ${insideHits}`);
      check("net: a redirect that stays with the source is followed", JSON.parse(await net(`get ${SITE}/weiter`)).length === 34);

      // Its messages get link previews like a member's; the probe without the network still gets none.
      const stored = async (id) => (await api("GET", `/api/channels/${general.id}/messages?limit=100`, undefined, owner.token))[1].messages.find((m) => m.id === id);
      const withPreview = ownerWs.waitNew((e) => e.type === "message.update" && e.message?.plugin?.id === "smoke-net" && e.message.previews?.length === 1, 8000).catch(() => null);
      await net(`post Update: ${SITE}/seite`);
      const previewed = await withPreview;
      check("net: links in the messages of a plugin with the network get a preview", previewed?.message.previews[0]?.title === "Patch 1.2", JSON.stringify(previewed?.message?.previews ?? null));
      const hitsBefore = hits.length;
      const [, said] = await cmd(owner.token, `say Auch hier: ${SITE}/seite`, general.id);
      await sleep(1500);
      const plainMessage = (await api("GET", `/api/channels/${general.id}/messages?limit=100`, undefined, owner.token))[1].messages.filter((m) => m.plugin?.id === "smoke-probe").at(-1);
      check("net: a plugin without the network still gets none, and its link is never fetched", said.ok !== false && (plainMessage?.previews ?? []).length === 0 && hits.length === hitsBefore && !!(await stored(plainMessage?.id)), `${JSON.stringify(plainMessage?.previews)} hits ${hits.length - hitsBefore}`);

      // ---------- Cards (interface version 2): a message drawn as a box; its pictures are fetched by the server, never named to a client.
      {
        const card = async (content, c) => net(`card ${JSON.stringify({ content, card: c })}`);
        // The database hands a stored object back with its keys in its own order.
        const sameCard = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());
        const created = ownerWs.waitNew((e) => e.type === "message.create" && e.message?.plugin?.id === "smoke-net" && !!e.message.plugin.card, 8000).catch(() => null);
        const pictured = ownerWs.waitNew((e) => e.type === "message.update" && e.message?.plugin?.id === "smoke-net" && !!e.message.plugin.card?.image, 8000).catch(() => null);
        const cardId = await card(`Karte: ${SITE}/seite`, { kicker: " Smoke ", title: "Patch\n1.3", url: "https://example.org/notes", text: "**Neu**\n- eins", image: `${SITE}/bild.png`, thumbnail: `${SITE}/seite` });
        const first = await created;
        check("card: a message with a card goes out at once with its texts, and without any address of a picture", /^[0-9a-f-]{36}$/.test(cardId) && sameCard(first?.message.plugin.card, { kicker: "Smoke", title: "Patch 1.3", url: "https://example.org/notes", text: "**Neu**\n- eins" }) && first.message.content.startsWith("Karte:"), `${cardId} ${JSON.stringify(first?.message?.plugin ?? null)}`);
        const second = await pictured;
        const path = second?.message.plugin.card.image ?? "";
        const file = /^\/api\/previews\/[0-9a-f]{32}\.png$/.test(path) ? await fetch(`${BASE}${path}`) : null;
        check("card: the picture arrives as a file of this server; an address that is a page and no picture is left out", file?.status === 200 && file.headers.get("content-type") === "image/png" && second.message.plugin.card.thumbnail === undefined && second.message.plugin.card.title === "Patch 1.3", `${path} ${file?.status} ${JSON.stringify(second?.message?.plugin?.card ?? null)}`);
        await sleep(1200);
        const kept = await stored(cardId);
        check("card: the card is stored with the message, and it takes the link previews' place", kept?.plugin?.card?.image === path && (kept?.previews ?? []).length === 0, JSON.stringify([kept?.plugin?.card, kept?.previews]));
        const refused = [await card("x", { kicker: "nur das" }), await card("x", { title: "t", image: "http://example.org/a.png" }), await card("x", { title: "t", colour: "#f00" }), await card("x", { title: "t".repeat(201) }), await card("x", "keine Karte")];
        check("card: one without a title or text, with an address that is not https, with a key that is none, or too long is refused", refused.every((r) => r.startsWith("refused: ")), JSON.stringify(refused));

        // A plugin without the network may send a card; its pictures are never fetched. One written for interface version 1 may not.
        const PLAIN = (id, apiVersion) => `/* squorli-plugin
{ "id": "${id}", "name": "Smoke card", "description": "Sends a card.", "version": "1.0.0", "apiVersion": ${apiVersion}, "capabilities": ["messages.write"],
  "commands": [{ "name": "${id}", "description": "a card" }] }
*/
squorli.on("command", async (e) => {
  try { return (await squorli.messages.send(e.channelId, "Ohne Netz", { card: { title: "Ohne Netz", image: "${SITE}/bild.png" } })).id; }
  catch (err) { return "refused: " + String(err.message).slice(0, 200); }
});
`;
        for (const [id, apiVersion] of [["smoke-card", 2], ["smoke-card-old", 1]]) {
          await api("POST", "/api/plugins", { source: PLAIN(id, apiVersion), fileName: `${id}.js` }, owner.token);
          await api("PUT", `/api/plugins/${id}/enabled`, { enabled: true, grant: ["messages.write"] }, owner.token);
        }
        const hitsBeforeCard = hits.length;
        const run = async (id) => (await api("POST", `/api/channels/${general.id}/commands`, { plugin: id, name: id }, owner.token))[1].message?.en ?? "";
        const plainId = await run("smoke-card");
        await sleep(1500);
        const plainCard = await stored(plainId);
        check("card: a plugin without the network sends a card too, and its picture is never fetched", JSON.stringify(plainCard?.plugin?.card) === JSON.stringify({ title: "Ohne Netz" }) && hits.length === hitsBeforeCard, `${plainId} ${JSON.stringify(plainCard?.plugin ?? null)} hits ${hits.length - hitsBeforeCard}`);
        const old = await run("smoke-card-old");
        check("card: a plugin written for interface version 1 is told to name version 2", /^refused: .*apiVersion/.test(old), old);
        await api("DELETE", "/api/plugins/smoke-card?messages=delete", undefined, owner.token);
        await api("DELETE", "/api/plugins/smoke-card-old", undefined, owner.token);
      }

      const flood = await net(`flood ${SITE}/feed.json`);
      const floodCount = Number(flood.split(" ")[0]);
      check("net: thirty requests a minute, then the limit", /^\d+ then .*rate limit/.test(flood) && floodCount > 0 && floodCount <= 30, flood);
      // ---------- The catalogue of signed plugins: the script plays the repository (the list and a release's file) on the same origin.
      {
        const { bodyHash, bodyOf } = await import("../../../tools/plugin-sign.mjs");
        const CAT = (version, extra = "") => NET.replace('"id": "smoke-net"', '"id": "smoke-cat"').replace('"version": "1.0.0"', `"version": "${version}"`).replace('"name": "net"', '"name": "cat"') + extra;
        const signedCat = (version) => signSource(CAT(version), testKey, "smoke", "reviewed");
        const listed = (version, over = {}) => ({
          id: "smoke-cat", name: { en: "Smoke <b>cat</b>\nalogue", de: "Rauchtest Katalog" }, description: { en: "Listed by the smoke test." }, author: "Somebody", homepage: "javascript:alert(1)",
          kind: "reviewed", version, apiVersion: 2, capabilities: ["messages.write", "net.fetch"], hosts: ["feeds.example.org"], language: "js", file: "smoke-cat.js",
          sha256: bodyHash(bodyOf(signedCat(version))), key: "smoke", signedAt: "2026-11-15", download: "https://evil.example/x.js", ...over,
        });
        let catalogFile = { version: 1, plugins: [listed("1.0.0"), { id: "broken" }, listed("9.9.9", { id: "smoke-later", file: "smoke-later.js", apiVersion: 99 })] };
        let releases = { "/releases/download/smoke-cat-v1.0.0/smoke-cat.js": signedCat("1.0.0") };
        const catalogSite = createServer((req, res) => {
          hits.push(req.url);
          if (req.url === "/catalog.json") return res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(JSON.stringify(catalogFile));
          if (releases[req.url]) return res.writeHead(200, { "content-type": "application/octet-stream" }).end(releases[req.url]);
          res.writeHead(404).end();
        });
        // The same origin as the played sources: that server makes way for this one.
        await new Promise((r) => site.close(r)); site.closeAllConnections?.();
        await new Promise((r) => catalogSite.listen(Number(new URL(SITE).port), "127.0.0.1", r));
        const catalog = async () => (await api("GET", "/api/plugins/catalog", undefined, owner.token))[1];
        const fromCatalog = (id) => api("POST", "/api/plugins", { catalog: id }, owner.token);

        check("catalog: the plugin list says the server offers one", (await api("GET", "/api/plugins", undefined, owner.token))[1].catalog === true);
        check("catalog: it is for managers of the server", (await api("GET", "/api/plugins/catalog", undefined, member.token))[0] === 403);
        const c1 = await catalog();
        const e1 = c1.plugins?.find((p) => p.id === "smoke-cat");
        check("catalog: lists the entries it can read, as new, with the kind and the hosts in the server's own words", c1.plugins?.length === 2 && e1?.status === "new" && e1.signature?.kind === "reviewed" && /feeds\.example\.org/.test(e1.capabilities.find((x) => x.id === "net.fetch")?.text?.de ?? ""), JSON.stringify(c1).slice(0, 300));
        check("catalog: an author's texts are cleaned, a homepage that is no https address is dropped, the source points into the repository", e1?.name?.en === "Smoke <b>cat</b> alogue" && e1.homepage === null && e1.source === "https://github.com/danielklessa/squorli-plugins/tree/main/plugins/smoke-cat" && !("download" in e1), JSON.stringify(e1).slice(0, 300));
        check("catalog: an entry for a later plugin interface is listed as needing a newer server and cannot be installed", c1.plugins.find((p) => p.id === "smoke-later")?.status === "needs_server" && (await fromCatalog("smoke-later"))[0] === 409);
        check("catalog: an id the list does not name is unknown", (await fromCatalog("not-listed"))[1].error === "catalog_unknown");
        check("catalog: installing needs an owner", (await api("POST", "/api/plugins", { catalog: "smoke-cat" }, mod.token))[0] === 403);

        const [sCat, cat] = await fromCatalog("smoke-cat");
        check("catalog: one request installs the signed file from the release, switched off", sCat === 200 && cat.id === "smoke-cat" && cat.version === "1.0.0" && cat.installedVia === "catalog" && cat.enabled === false && cat.signature?.kind === "reviewed" && hits.includes("/releases/download/smoke-cat-v1.0.0/smoke-cat.js"), `${sCat} ${JSON.stringify(cat).slice(0, 200)}`);
        check("catalog: the entry is installed then", (await catalog()).plugins.find((p) => p.id === "smoke-cat")?.status === "installed");

        // A new version in the list: an update, and the file must be the one the list names.
        catalogFile = { version: 1, plugins: [listed("1.1.0")] };
        releases = { "/releases/download/smoke-cat-v1.1.0/smoke-cat.js": signedCat("1.0.0") };
        const upd = (await catalog()).plugins.find((p) => p.id === "smoke-cat");
        check("catalog: a higher version in the list is an update", upd?.status === "update" && upd.installedVersion === "1.0.0" && upd.version === "1.1.0", JSON.stringify(upd).slice(0, 160));
        const [sWrong, wrong] = await fromCatalog("smoke-cat");
        check("catalog: a release that holds another file than the list names is not installed", sWrong === 502 && wrong.error === "catalog_mismatch", `${sWrong} ${wrong.error}`);
        releases = { "/releases/download/smoke-cat-v1.1.0/smoke-cat.js": CAT("1.1.0") };
        const [sBare, bare] = await fromCatalog("smoke-cat");
        check("catalog: nor is an unsigned file, whatever the list says", sBare === 502 && bare.error === "catalog_mismatch", `${sBare} ${bare.error}`);
        releases = { "/releases/download/smoke-cat-v1.1.0/smoke-cat.js": signSource(CAT("1.1.0"), stranger, "stranger", "reviewed") };
        check("catalog: nor is one signed with a key the server does not know", (await fromCatalog("smoke-cat"))[1].error === "catalog_mismatch");
        releases = {};
        check("catalog: a file that cannot be downloaded says so", (await fromCatalog("smoke-cat"))[1].error === "catalog_unavailable");
        check("catalog: after all that the installed version is still the first", (await api("GET", "/api/plugins", undefined, owner.token))[1].plugins.find((p) => p.id === "smoke-cat")?.version === "1.0.0");
        releases = { "/releases/download/smoke-cat-v1.1.0/smoke-cat.js": signedCat("1.1.0") };
        const [sUp, up] = await fromCatalog("smoke-cat");
        check("catalog: the right file updates the plugin", sUp === 200 && up.version === "1.1.0" && (await catalog()).plugins.find((p) => p.id === "smoke-cat")?.status === "installed", `${sUp} ${up.version}`);

        // The list is gone: the last one that could be read is served, marked.
        catalogFile = "no list";
        const stale = await catalog();
        check("catalog: when the list cannot be read the last one is served as stale", stale.stale === true && stale.plugins?.length === 1, JSON.stringify(stale).slice(0, 120));
        await api("DELETE", "/api/plugins/smoke-cat?messages=delete", undefined, owner.token);
        await new Promise((r) => catalogSite.close(r)); catalogSite.closeAllConnections?.();
      }
      await new Promise((r) => inside.close(r));
    }
    for (const id of ["smoke-net", "smoke-signed"]) await api("DELETE", `/api/plugins/${id}?messages=delete`, undefined, owner.token);
    check("net: both are removed again", (await api("GET", "/api/plugins", undefined, owner.token))[1].plugins.every((p) => p.id !== "smoke-net" && p.id !== "smoke-signed"));
  }
}

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
