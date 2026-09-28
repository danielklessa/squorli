// Data for the acceptance test of the package for Windows (acceptance.ps1): a member who writes and reads through the
// API like a client does. Node's own modules only, so the package's node.exe runs it.
//   node data.mjs seed  <base> <key file> <marker> <setup code>   the owner by setup code (first run), a message with an attachment
//   node data.mjs post  <base> <key file> <marker>                one more message
//   node data.mjs check <base> <key file> <marker> [<marker of a message that must be gone>]
// A marker that starts with @ names a text file (UTF-8) that holds it. The key file is written on the first run.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [mode, base, keyFile, markerArg, extraArg] = process.argv.slice(2);
const text = (arg) => (arg?.startsWith("@") ? readFileSync(arg.slice(1), "utf8").trim() : arg);
const marker = text(markerArg);
const extra = text(extraArg);
const fail = (message) => { console.log(`FAIL ${message}`); process.exit(1); };

const api = async (method, path, body, token) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers, body: payload });
  return [r.status, await r.json().catch(() => ({}))];
};

const health = await (await fetch(`${base}/api/health`)).json();
// An Ed25519 key as PKCS#8: 16 bytes in front of the 32 of the key itself
const PKCS8 = "302e020100300506032b657004220420";
let raw;
if (existsSync(keyFile)) raw = JSON.parse(readFileSync(keyFile, "utf8")).priv;
else {
  raw = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("hex").slice(PKCS8.length);
  writeFileSync(keyFile, JSON.stringify({ priv: raw }));
}
const privateKey = createPrivateKey({ key: Buffer.from(PKCS8 + raw, "hex"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const sign = (message) => edSign(null, Buffer.from(message, "utf8"), privateKey).toString("hex");

let [, ch] = await api("POST", "/api/auth/challenge", { publicKey });
let [status, body] = await api("POST", "/api/auth/verify", { challengeId: ch.challengeId, publicKey, signature: sign(`community-chat-login\n${health.domain}\n${ch.nonce}`) });
if (status === 403 && body.error === "registration_required" && mode === "seed") {
  [, ch] = await api("POST", "/api/auth/challenge", { publicKey });
  const handle = `s${publicKey.slice(0, 12)}`;
  // No real encryption: the server never opens the backup of a key
  const backup = { ciphertext: Buffer.from(raw, "hex").toString("base64"), params: { kdf: "pbkdf2-sha256", iterations: 100_000, salt: "00".repeat(16), iv: "00".repeat(12) }, authKey: "ab".repeat(32) };
  [status, body] = await api("POST", "/api/local/register", { challengeId: ch.challengeId, publicKey, signature: sign(`squorli-local-register\n${health.domain}\n${ch.nonce}\n${handle}\n${backup.ciphertext}`), handle, backup, ownerCode: extra });
}
if (!body.sessionToken) fail(`sign-in: ${status} ${JSON.stringify(body)}`);
const token = body.sessionToken;
const [, state] = await api("GET", "/api/state", undefined, token);
const channel = state.channels?.find((c) => c.kind === "text");
if (!channel) fail("no text channel in /api/state");
// Characters outside ASCII on purpose: through the database, the dump, the archive and back
const CONTENT = `Anhang für ${"ä".repeat(3)} den Test\n`.repeat(2000);

if (mode === "seed" || mode === "post") {
  const ids = [];
  if (mode === "seed") {
    const form = new FormData();
    form.append("file", new Blob([CONTENT], { type: "text/plain" }), "prüfung ü.txt");
    const [uploaded, attachment] = await api("POST", "/api/attachments", form, token);
    if (uploaded !== 200) fail(`upload: ${uploaded} ${JSON.stringify(attachment)}`);
    ids.push(attachment.id);
  }
  const [sent, message] = await api("POST", `/api/channels/${channel.id}/messages`, { content: marker, attachmentIds: ids }, token);
  if (sent !== 200) fail(`message: ${sent} ${JSON.stringify(message)}`);
  console.log(`ok   ${mode}: message "${marker}" written, attachments: ${ids.length} (server ${health.version}, key ${health.serverKey?.slice(0, 8)})`);
} else if (mode === "check") {
  const [, page] = await api("GET", `/api/channels/${channel.id}/messages?limit=50`, undefined, token);
  const found = page.messages?.find((m) => m.content === marker);
  let failures = 0;
  const check = (label, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`); if (!ok) failures++; };
  check(`the account of the key file signs in (server ${health.version}, key ${health.serverKey?.slice(0, 8)})`, true);
  check(`message "${marker}" is there`, !!found);
  const attachment = found?.attachments?.[0];
  if (attachment) {
    const r = await fetch(base + attachment.url);
    const got = await r.text();
    check("its attachment is there and has its content", r.status === 200 && got === CONTENT, `(HTTP ${r.status}, ${got.length} characters)`);
  } else check("its attachment is listed", false);
  if (extra) check(`message "${extra}", written after the backup, is gone`, !page.messages.some((m) => m.content === extra));
  process.exit(failures ? 1 : 0);
} else fail(`unknown mode ${mode}`);
