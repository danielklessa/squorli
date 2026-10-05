import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENOUGH_OVERLAP, safeGet } from "./fetch";

/**
 * `safeGet`'s reading against a local server (exempted as the test origin, as the smoke tests do it): `enough` sees each
 * piece with the ENOUGH_OVERLAP bytes before it, so a marker split across two pieces still stops the reading, and the
 * answer so far is never searched again (security audit of 5 October 2026: that search grew with the square of the answer).
 */
let server: Server;
let origin: string;
const TAIL = "x".repeat(300 * 1024);

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const pieces = req.url === "/split"
      ? ["<html><head><title>T</title></hea", "d><body>", TAIL]
      : req.url === "/whole"
        ? ["<html><head><title>T</title></head><body>", TAIL]
        : ["<html><head><title>T</title>", TAIL];
    let i = 0;
    const step = () => {
      if (i >= pieces.length) { res.end(); return; }
      res.write(pieces[i++]!);
      setTimeout(step, 40);
    };
    step();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = (path: string, enough: boolean) => safeGet(`${origin}${path}`, {
  accept: "text/html", maxBytes: () => 512 * 1024, cut: () => true, testOrigin: origin, timeoutMs: 5000,
  ...(enough ? { enough: (_type: string, latest: Buffer) => latest.includes("</head>") } : {}),
});

describe("safeGet stops at the marker", () => {
  it("also when the marker arrives split across two pieces", async () => {
    const res = await get("/split", true);
    expect(res).not.toBeNull();
    const body = res!.body.toString();
    expect(body.endsWith("</head><body>")).toBe(true); // the first two pieces, nothing of the third
    expect(ENOUGH_OVERLAP).toBeGreaterThanOrEqual("</head>".length);
  });

  it("when the marker arrives in one piece, and reads on to the cap without a marker", async () => {
    const whole = await get("/whole", true);
    expect(whole!.body.toString().endsWith("</head><body>")).toBe(true);
    const none = await get("/none", true);
    expect(none!.body.length).toBeGreaterThan(TAIL.length);
    const noEnough = await get("/split", false);
    expect(noEnough!.body.length).toBeGreaterThan(TAIL.length);
  });
});
