import { SESSION_PROOF_HEADER, deviceProofMessage, sessionProofMessage } from "@squorli/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerApi } from "./api";

/**
 * A bound session (docs/features/devices.md, 4 October 2026): the client's side of the proof. The signer is a stub that
 * records what it signs; whether the server takes the signature is the server's test and the devices smoke test.
 */
const signed: string[] = [];
const signer = { publicKey: "ab".repeat(32), sign: async (message: string) => { signed.push(message); return "cd".repeat(64); } };
const account = "ef".repeat(32);

function withFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler(url, init); });
  return calls;
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("the session proof on the client's requests", () => {
  afterEach(() => { vi.unstubAllGlobals(); signed.length = 0; });

  it("adds the header with the host, the time and the device's signature over method and path without the query", async () => {
    const calls = withFetch(() => ok({ userId: "0ab2f0c4-5f3a-4b1e-9c2d-1234567890ab", publicKey: account, displayName: null, handle: "x", avatarUrl: null, localHandle: null, registrationRequired: false }));
    const api = new ServerApi("https://chat.example:8443");
    api.setToken("tok");
    api.setProver(() => ({ signer, accountPublicKey: account }));
    const before = Date.now();
    await api.getMe();
    const header = String((calls[0]!.init.headers as Record<string, string>)[SESSION_PROOF_HEADER]);
    const m = /^chat\.example:(\d+):([0-9a-f]{128})$/.exec(header);
    expect(m).not.toBeNull();
    const at = Number(m![1]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(signed).toEqual([deviceProofMessage(account, sessionProofMessage("chat.example", at, "GET", "/api/me"))]);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("sends no header without a token or without a device, and the hello's proof names WS and /api/ws", async () => {
    const calls = withFetch(() => ok({ ok: true }));
    const api = new ServerApi("https://chat.example");
    api.setProver(() => ({ signer, accountPublicKey: account }));
    await api.getHealth();
    expect((calls[0]!.init.headers as Record<string, string>)[SESSION_PROOF_HEADER]).toBeUndefined();
    api.setToken("tok");
    api.setProver(() => null);
    expect(await api.helloProof()).toBeNull();
    api.setProver(() => ({ signer, accountPublicKey: account }));
    const hello = await api.helloProof();
    expect(hello?.domain).toBe("chat.example");
    expect(signed.at(-1)).toBe(deviceProofMessage(account, sessionProofMessage("chat.example", hello!.at, "WS", "/api/ws")));
  });

  it("learns the server's clock from a stale answer and tries once more, but only once", async () => {
    let n = 0;
    const serverTime = new Date(Date.now() + 20 * 60_000).toISOString();
    const calls = withFetch(() => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: "device_proof_required", why: "stale", serverTime }), { status: 401 });
      return ok({ userId: "0ab2f0c4-5f3a-4b1e-9c2d-1234567890ab", publicKey: account, displayName: null, handle: "x", avatarUrl: null, localHandle: null, registrationRequired: false });
    });
    const api = new ServerApi("https://chat.example");
    api.setToken("tok");
    api.setProver(() => ({ signer, accountPublicKey: account }));
    const lost: (string | null)[] = [];
    api.onUnauthorized = (code) => lost.push(code);
    await api.getMe();
    expect(calls.length).toBe(2);
    expect(Math.abs(api.clockOffsetMs - 20 * 60_000)).toBeLessThan(5000);
    const second = Number(/:(\d+):/.exec(String((calls[1]!.init.headers as Record<string, string>)[SESSION_PROOF_HEADER]))![1]);
    expect(second - Date.now()).toBeGreaterThan(19 * 60_000);
    expect(lost).toEqual([]);
    // Stale again after the retry, or any other reason: the session is reported lost like every 401.
    n = 0;
    withFetch(() => new Response(JSON.stringify({ error: "device_proof_required", why: "signature", serverTime }), { status: 401 }));
    await expect(api.getMe()).rejects.toMatchObject({ status: 401, code: "device_proof_required" });
    expect(lost).toEqual(["device_proof_required"]);
  });
});
