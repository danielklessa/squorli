import Fastify from "fastify";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { logOptions, redactUrl, requestSerializer } from "./logRedact";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, stream };
}

describe("redactUrl", () => {
  it("hides the secret parameters and keeps everything else", () => {
    expect(redactUrl("/api/status?key=abc&x=1")).toBe("/api/status?key=***&x=1");
    expect(redactUrl("/api/attachments/u/n.png?e=123&s=deadbeef")).toBe("/api/attachments/u/n.png?e=123&s=***");
    expect(redactUrl("/api/keys/k?nonce=n&sig=ff&KEY=x")).toBe("/api/keys/k?nonce=n&sig=***&KEY=***");
    expect(redactUrl("/api/health")).toBe("/api/health");
    expect(redactUrl("/x?s")).toBe("/x?s");
  });
  it("reaches Fastify's request log", async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: { level: "info", stream, serializers: { req: requestSerializer } } });
    app.get("/api/status", async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/api/status?key=supersecret" });
    await app.close();
    const log = lines.join("");
    expect(log).toContain("key=***");
    expect(log).not.toContain("supersecret");
  });
});

describe("logOptions", () => {
  async function run(logRequests: boolean) {
    const { lines, stream } = capture();
    const opts = logOptions("info", logRequests);
    const app = Fastify({ ...opts, logger: { ...opts.logger, stream } });
    app.get("/ok", async () => ({ ok: true }));
    app.get("/boom", async () => { throw new Error("kaputt"); });
    app.get("/bad", async (_req, reply) => reply.code(502).send({ error: "upstream" }));
    for (const url of ["/ok", "/boom", "/bad", "/missing?key=geheim"]) await app.inject({ method: "GET", url, remoteAddress: "203.0.113.7" });
    await app.close();
    return lines.map((l) => JSON.parse(l) as { msg: string; req?: { url: string; remoteAddress?: string } });
  }

  it("logs no request by default, only server errors, and never the address", async () => {
    const entries = await run(false);
    const text = JSON.stringify(entries);
    expect(text).not.toContain("203.0.113.7");
    expect(entries.some((e) => e.msg === "incoming request" || e.msg === "request completed")).toBe(false);
    expect(entries.some((e) => e.req?.url === "/ok")).toBe(false);
    expect(entries.some((e) => e.msg === "kaputt")).toBe(true);
    expect(entries.filter((e) => e.msg === "request failed").map((e) => e.req?.url).sort()).toEqual(["/bad", "/boom"]);
    expect(text).not.toContain("geheim");
  });

  it("LOG_REQUESTS brings back the full request log with addresses", async () => {
    const entries = await run(true);
    expect(entries.filter((e) => e.msg === "incoming request")).toHaveLength(4);
    expect(entries.find((e) => e.msg === "incoming request")?.req?.remoteAddress).toBe("203.0.113.7");
    expect(JSON.stringify(entries)).not.toContain("geheim");
  });
});
