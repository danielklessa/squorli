import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The stations' addresses are checked and pinned by resolve.ts; here every host is "public" and resolves to the test server.
vi.mock("./resolve", () => ({
  checkHost: async () => "public",
  // Node's sockets ask with `all: true` (happy eyeballs) and expect a list then, like dns.lookup gives it.
  publicLookup: (_host: string, options: { all?: boolean }, cb: (err: null, address: string | { address: string; family: number }[], family?: number) => void) => {
    if (options.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
    else cb(null, "127.0.0.1", 4);
  },
}));

const { isParserRefusal, openStream } = await import("./metadata");

/**
 * The lenient HTTP parser only after the strict one refused (security audit of 5 October 2026, L-18): a raw socket plays
 * a station whose answer is sloppy (bare line feeds, as a large CDN sends them) and one whose answer is clean.
 */
let sloppy: Server, clean: Server;
let sloppyPort = 0, cleanPort = 0;
let hits = { sloppy: 0, clean: 0 };
const sockets = new Set<Socket>();
const headers = (sep: string) => `HTTP/1.1 200 OK${sep}content-type: audio/mpeg${sep}icy-metaint: 16${sep}icy-name: Test FM${sep}${sep}`;

beforeAll(async () => {
  sloppy = createServer((socket) => { sockets.add(socket); hits.sloppy++; socket.write(headers("\n")); socket.end(); });
  clean = createServer((socket) => { sockets.add(socket); hits.clean++; socket.write(headers("\r\n")); socket.end(); });
  await new Promise<void>((r) => sloppy.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => clean.listen(0, "127.0.0.1", r));
  sloppyPort = (sloppy.address() as { port: number }).port;
  cleanPort = (clean.address() as { port: number }).port;
});
afterAll(async () => {
  // Node's default agent keeps a client socket alive after the response; a server only closes once they are gone.
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => sloppy.close(() => r()));
  await new Promise<void>((r) => clean.close(() => r()));
});

describe("openStream", () => {
  it("reads a clean answer with the strict parser alone", async () => {
    hits = { sloppy: 0, clean: 0 };
    const log = { info: vi.fn(), warn: vi.fn() };
    const res = await openStream(`http://station.example:${cleanPort}/stream`, new AbortController().signal, log);
    expect(res.headers["icy-metaint"]).toBe("16");
    res.destroy();
    expect(hits.clean).toBe(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("falls back to the lenient parser after the strict one refused, and says so", async () => {
    hits = { sloppy: 0, clean: 0 };
    const log = { info: vi.fn(), warn: vi.fn() };
    const res = await openStream(`http://station.example:${sloppyPort}/stream`, new AbortController().signal, log);
    expect(res.headers["icy-metaint"]).toBe("16");
    res.destroy();
    expect(hits.sloppy).toBe(2);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0]![1]).toMatch(/lenient/);
    expect(String((log.info.mock.calls[0]![0] as { code: string }).code)).toMatch(/^HPE_/);
  });

  it("does not try again when the station is gone or the feed was dropped", async () => {
    const gone = createServer(() => {});
    await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r));
    const port = (gone.address() as { port: number }).port;
    await new Promise<void>((r) => gone.close(() => r()));
    await expect(openStream(`http://station.example:${port}/stream`, new AbortController().signal)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(isParserRefusal({ code: "HPE_INVALID_HEADER_TOKEN" })).toBe(true);
    expect(isParserRefusal({ code: "ECONNRESET" })).toBe(false);
    expect(isParserRefusal(new Error("x"))).toBe(false);
    expect(isParserRefusal(null)).toBe(false);
  });
});
