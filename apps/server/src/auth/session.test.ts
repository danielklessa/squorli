import { generateKeyPairSync, sign } from "node:crypto";
import { SESSION_PROOF_MAX_SKEW_MS, deviceProofMessage, parseSessionProofHeader, sessionProofHeader, sessionProofMessage } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { sessionIdle, sessionProofProblem, setSessionPolicy } from "./session";

// A device key as the client makes it (Ed25519, raw 32 bytes in hex) and its signature over what a bound session proves.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const deviceKey = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
const account = "cd".repeat(32);
const session = { publicKey: account, deviceKey };
const proofFor = (method: string, path: string, at: number, domain = "chat.example") => ({ domain, at, signature: sign(null, Buffer.from(deviceProofMessage(account, sessionProofMessage(domain, at, method, path)), "utf8"), privateKey).toString("hex") });

describe("sessions bound to the device (security audit S10, 4 October 2026)", () => {
  setSessionPolicy({ idleDays: 14, domain: "chat.example" });
  const now = 1_800_000_000_000;

  it("takes the device's fresh proof over this very request and names what is wrong with any other", () => {
    expect(sessionProofProblem(proofFor("GET", "/api/me", now), session, "GET", "/api/me", "chat.example", now)).toBeNull();
    expect(sessionProofProblem(proofFor("get", "/api/me", now), session, "GET", "/api/me", "chat.example:3000", now)).toBeNull();
    expect(sessionProofProblem(proofFor("WS", "/api/ws", now - SESSION_PROOF_MAX_SKEW_MS + 1000), session, "WS", "/api/ws", "chat.example", now)).toBeNull();
    expect(sessionProofProblem(null, session, "GET", "/api/me", "chat.example", now)).toBe("missing");
    expect(sessionProofProblem(proofFor("GET", "/api/me", now - SESSION_PROOF_MAX_SKEW_MS - 1), session, "GET", "/api/me", "chat.example", now)).toBe("stale");
    expect(sessionProofProblem(proofFor("GET", "/api/me", now + SESSION_PROOF_MAX_SKEW_MS + 1), session, "GET", "/api/me", "chat.example", now)).toBe("stale");
    expect(sessionProofProblem(proofFor("GET", "/api/state", now), session, "GET", "/api/me", "chat.example", now)).toBe("signature");
    expect(sessionProofProblem(proofFor("POST", "/api/me", now), session, "GET", "/api/me", "chat.example", now)).toBe("signature");
    expect(sessionProofProblem(proofFor("GET", "/api/me", now, "other.example"), session, "GET", "/api/me", "chat.example", now)).toBe("domain");
    // The host the request came in on counts as well (a dev proxy, an address next to PUBLIC_DOMAIN).
    expect(sessionProofProblem(proofFor("GET", "/api/me", now, "localhost"), session, "GET", "/api/me", "localhost:5173", now)).toBeNull();
    // Another account's or another device's signature is worth nothing.
    expect(sessionProofProblem(proofFor("GET", "/api/me", now), { publicKey: "ef".repeat(32), deviceKey }, "GET", "/api/me", "chat.example", now)).toBe("signature");
    expect(sessionProofProblem(proofFor("GET", "/api/me", now), { publicKey: account, deviceKey: "ab".repeat(32) }, "GET", "/api/me", "chat.example", now)).toBe("signature");
    expect(sessionProofProblem(proofFor("GET", "/api/me", now), { publicKey: account, deviceKey: null }, "GET", "/api/me", "chat.example", now)).toBe("signature");
    expect(sessionProofProblem({ ...proofFor("GET", "/api/me", now), signature: "zz" }, session, "GET", "/api/me", "chat.example", now)).toBe("signature");
  });

  it("reads the header the client sends and refuses anything else", () => {
    const p = proofFor("GET", "/api/me", now);
    expect(parseSessionProofHeader(sessionProofHeader(p.domain, p.at, p.signature))).toEqual(p);
    expect(parseSessionProofHeader(`Chat.Example:${now}:${p.signature.toUpperCase()}`)).toEqual(p);
    expect(parseSessionProofHeader(undefined)).toBeNull();
    expect(parseSessionProofHeader(`chat.example:${now}`)).toBeNull();
    expect(parseSessionProofHeader(`chat.example:x:${p.signature}`)).toBeNull();
    expect(parseSessionProofHeader(`chat.example:${now}:${p.signature.slice(2)}`)).toBeNull();
    expect(parseSessionProofHeader(`chat example:${now}:${p.signature}`)).toBeNull();
  });

  it("ends a session that was not used for the idle time, counting from its creation when it was never touched", () => {
    const day = 86_400_000;
    const created = new Date(now - 20 * day);
    expect(sessionIdle(new Date(now - 13 * day), created, now)).toBe(false);
    expect(sessionIdle(new Date(now - 15 * day), created, now)).toBe(true);
    expect(sessionIdle(null, created, now)).toBe(true);
    expect(sessionIdle(null, new Date(now - 2 * day), now)).toBe(false);
    expect(sessionIdle(new Date(now - 100 * day), created, now, 0)).toBe(false);
  });
});
