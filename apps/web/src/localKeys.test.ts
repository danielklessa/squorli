import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerApi } from "./api";
import { t } from "./i18n";

// Security audit C2 (3 October 2026): the keys of a server account's password are derived from parameters the SERVER names.
// Unbound ones are refused before any key leaves the client: a foreign server that names the salt and the iterations the
// directory shows for a handle would otherwise be handed the directory account's own auth key.
const BASE = "https://chat.example.test";
const SALT = "ab".repeat(16);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubServer(params: Record<string, unknown>) {
  const calls: { url: string; body: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : null });
    return String(url).endsWith("/params") ? json(params) : json({ error: "unauthorized" }, 401);
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const unbound = { kdf: "pbkdf2-sha256", iterations: 600_000, salt: SALT };
const bound = { ...unbound, bound: true };

describe("a server account's keys", () => {
  it("are refused when the server does not call the backup bound: nothing but the parameters is asked", async () => {
    const calls = stubServer(unbound);
    const api = new ServerApi(BASE);
    await expect(api.localRestore("alice", "hunter2hunter2")).rejects.toThrow(t("err.backupNotBound"));
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/local/backup/alice/params`]);
  });

  it("are refused on every path that derives them: changing the password, deleting the account, signing a device out", async () => {
    for (const run of [
      (api: ServerApi) => api.localChangePassword({ publicKey: "00".repeat(32), privateKey: "11".repeat(32), device: null }, "alice", "old-password-1", "new-password-1"),
      (api: ServerApi) => api.localDelete("alice", "hunter2hunter2"),
      (api: ServerApi) => api.revokeDevice("alice", "hunter2hunter2", "others"),
    ]) {
      const calls = stubServer(unbound);
      await expect(run(new ServerApi(BASE))).rejects.toThrow(t("err.backupNotBound"));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toBeNull();
    }
  });

  it("go on to the key fetch with an auth key derived for this client's host when the backup is bound", async () => {
    const calls = stubServer(bound);
    const api = new ServerApi(BASE);
    await expect(api.localRestore("alice", "hunter2hunter2")).rejects.toMatchObject({ status: 401 });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/local/backup/alice/params`, `${BASE}/api/local/backup/fetch`]);
    const sent = JSON.parse(calls[1]!.body!) as { handle: string; authKey: string };
    expect(sent.handle).toBe("alice");
    expect(sent.authKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derive another auth key for another host: a password reused on a foreign server is worth nothing there", async () => {
    const keyAt = async (base: string) => {
      const calls = stubServer(bound);
      await new ServerApi(base).localRestore("alice", "hunter2hunter2").catch(() => undefined);
      return (JSON.parse(calls[1]!.body!) as { authKey: string }).authKey;
    };
    const a = await keyAt("https://chat.example.test");
    const b = await keyAt("https://evil.example.test");
    expect(a).not.toBe(b);
  });
});

describe("the KDF a server takes (security audit of 5 October 2026, L-1)", () => {
  it("is PBKDF2 until /api/health says backupArgon2, and a PBKDF2 backup is only stored anew where Argon2id is taken", async () => {
    const api = new ServerApi(BASE);
    expect(api.backupKdf).toBe("pbkdf2-sha256");
    const calls = stubServer(bound);
    const id = { publicKey: "00".repeat(32), privateKey: "11".repeat(32), device: null };
    // A server from before: nothing is sent, not even the parameters request.
    expect(await api.localRewrapBackup(id, "alice", "hunter2hunter2")).toBe(false);
    expect(calls).toEqual([]);
    // A server that takes Argon2id and holds a PBKDF2 backup: the parameters are read, the new backup is sent with Argon2id parameters.
    api.backupKdf = "argon2id";
    api.setToken("tok");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : null });
      return String(url).endsWith("/params") ? json(bound) : json({ ok: true });
    }));
    expect(await api.localRewrapBackup(id, "alice", "hunter2hunter2")).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/api/local/backup/alice/params`, `${BASE}/api/local/backup`]);
    const sent = JSON.parse(calls[1]!.body!) as { backup: { params: { kdf: string; memoryKib?: number; bound?: true } } };
    expect(sent.backup.params.kdf).toBe("argon2id");
    expect(sent.backup.params.memoryKib).toBe(65536);
    expect(sent.backup.params.bound).toBe(true);
  }, 30_000);
});
