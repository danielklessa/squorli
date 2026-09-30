import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerReadyRoute } from "./ready";

describe("GET /api/ready", () => {
  it("answers 200 while the database answers", async () => {
    const app = Fastify();
    registerReadyRoute(app, async () => [{ one: 1 }]);
    const res = await app.inject({ method: "GET", url: "/api/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, database: "up" });
    await app.close();
  });

  it("answers 503 when the database is down, and when it does not answer in time", async () => {
    const app = Fastify();
    registerReadyRoute(app, async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); });
    const down = await app.inject({ method: "GET", url: "/api/ready" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ ok: false, database: "down", error: "ECONNREFUSED 127.0.0.1:5432" });
    expect(down.headers["cache-control"]).toBe("no-store");
    await app.close();

    const slow = Fastify();
    registerReadyRoute(slow, () => new Promise(() => {}), 20);
    const late = await slow.inject({ method: "GET", url: "/api/ready" });
    expect(late.statusCode).toBe(503);
    expect(late.json()).toMatchObject({ ok: false, error: "timeout" });
    await slow.close();
  });
});
