import Fastify from "fastify";
import { createHash } from "node:crypto";
import { sessionBodyHash } from "@squorli/protocol";
import { describe, expect, it } from "vitest";
import { registerBodyHash } from "./bodyHash";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function app() {
  const f = Fastify({ bodyLimit: 64 });
  registerBodyHash(f);
  f.post("/json", async (req) => ({ hash: req.bodyHash ?? null, body: req.body }));
  f.post("/text", async (req) => ({ hash: req.bodyHash ?? null }));
  f.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => done(null, body));
  f.get("/none", async (req) => ({ hash: req.bodyHash ?? null }));
  return f;
}

describe("the hash of a JSON body for the proof of version 2 (security audit of 5 October 2026, L-6)", () => {
  it("hashes the bytes as received, the same as the client hashes what it sends", async () => {
    const f = await app();
    const text = JSON.stringify({ content: "hällo", n: 1 });
    const res = await f.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json; charset=utf-8" }, payload: text });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hash: sha256(text), body: { content: "hällo", n: 1 } });
    expect(res.json().hash).toBe(await sessionBodyHash(text));
    await f.close();
  });

  it("leaves other bodies and requests without one alone, and keeps Fastify's limits", async () => {
    const f = await app();
    expect((await f.inject({ method: "POST", url: "/text", headers: { "content-type": "text/plain" }, payload: "hi" })).json()).toEqual({ hash: null });
    expect((await f.inject({ method: "GET", url: "/none" })).json()).toEqual({ hash: null });
    const big = await f.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: JSON.stringify({ x: "y".repeat(200) }) });
    expect(big.statusCode).toBe(413);
    const bad = await f.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    await f.close();
  });

  it("the client's hash is empty for no body and hex of SHA-256 otherwise", async () => {
    expect(await sessionBodyHash(undefined)).toBe("");
    expect(await sessionBodyHash("")).toBe("");
    expect(await sessionBodyHash("{}")).toBe(sha256("{}"));
  });
});
