import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHardening } from "./httpHardening";
import { wantsHsts } from "./webHeaders";

async function app(domain: string) {
  const a = Fastify({ trustProxy: true, logger: false });
  registerHardening(a, domain);
  a.get("/ok", async () => ({ ok: true }));
  a.get("/own", async (_req, reply) => reply.header("x-content-type-options", "custom").send({ ok: true }));
  a.get("/db", async () => { throw new Error('relation "users" does not exist (secret detail)'); });
  a.get("/teapot", async () => { const e = new Error("no coffee") as Error & { statusCode: number }; e.statusCode = 418; throw e; });
  a.post("/json", async () => ({ ok: true }));
  await a.ready();
  return a;
}

describe("HSTS", () => {
  it("only over https and never for localhost", async () => {
    const a = await app("chat.example.org");
    expect((await a.inject({ url: "/ok", headers: { "x-forwarded-proto": "https" } })).headers["strict-transport-security"]).toBe("max-age=31536000");
    expect((await a.inject({ url: "/ok" })).headers["strict-transport-security"]).toBeUndefined();
    await a.close();
    const l = await app("localhost");
    expect((await l.inject({ url: "/ok", headers: { "x-forwarded-proto": "https" } })).headers["strict-transport-security"]).toBeUndefined();
    await l.close();
    expect(wantsHsts("LocalHost", "https")).toBe(false);
    expect(wantsHsts("chat.example.org", "http")).toBe(false);
  });
  it("is not believed from an untrusted proxy", async () => {
    const a = Fastify({ trustProxy: false, logger: false });
    registerHardening(a, "chat.example.org");
    a.get("/ok", async () => ({ ok: true }));
    await a.ready();
    expect((await a.inject({ url: "/ok", headers: { "x-forwarded-proto": "https" } })).headers["strict-transport-security"]).toBeUndefined();
    await a.close();
  });
});

describe("nosniff", () => {
  it("is added unless a route names the header itself", async () => {
    const a = await app("chat.example.org");
    expect((await a.inject({ url: "/ok" })).headers["x-content-type-options"]).toBe("nosniff");
    expect((await a.inject({ url: "/own" })).headers["x-content-type-options"]).toBe("custom");
    await a.close();
  });
});

describe("server errors", () => {
  it("answer `internal` and leave the message out, with HSTS and nosniff still on", async () => {
    const a = await app("chat.example.org");
    const res = await a.inject({ url: "/db", headers: { "x-forwarded-proto": "https" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(res.body).not.toMatch(/relation|secret/);
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
    await a.close();
  });
  it("keep Fastify's own answer for a client error", async () => {
    const a = await app("chat.example.org");
    const t = await a.inject({ url: "/teapot" });
    expect(t.statusCode).toBe(418);
    expect(t.json()).toMatchObject({ message: "no coffee" });
    const bad = await a.inject({ method: "POST", url: "/json", headers: { "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });
});
