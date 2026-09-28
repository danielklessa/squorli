import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The web client's files are the only place where a path from the address reaches the file system as it is (every route
 * under DATA_DIR checks its parameter first: a UUID, a signed id, a file name of a fixed form). On Windows a backslash
 * separates folders too, so an address must not get out of the folder with one either.
 */
describe("static files", () => {
  let dir = "";
  const app = Fastify();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "squorli-static-"));
    await mkdir(join(dir, "public", "assets"), { recursive: true });
    await writeFile(join(dir, "public", "index.html"), "<!doctype html>client");
    await writeFile(join(dir, "public", "assets", "app.js"), "app");
    await writeFile(join(dir, "secret.env"), "LIVEKIT_API_SECRET=geheim");
    await app.register(fastifyStatic, { root: join(dir, "public"), wildcard: true });
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a file of the folder", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("app");
  });

  it.each([
    "/../secret.env",
    "/..%2fsecret.env",
    "/..%5csecret.env",
    "/..\\secret.env",
    "/%2e%2e%5csecret.env",
    "/assets/..%5c..%5csecret.env",
    "/assets\\..\\..\\secret.env",
    "/assets/%2e%2e/%2e%2e/secret.env",
  ])("does not leave the folder for %s", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).not.toBe(200);
    expect(res.body).not.toContain("geheim");
  });
});
