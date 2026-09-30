import { describe, expect, it } from "vitest";
import { classifyFailure, errorCode, mediaHost, onPlatform, requestCheck } from "./doctor";

describe("mediaHost", () => {
  it("probes PUBLIC_DOMAIN by default, LIVEKIT_PUBLIC_URL's host when it names another machine, LIVEKIT_NODE_IP first", () => {
    expect(mediaHost({ PUBLIC_DOMAIN: "chat.example.org", livekitPublicUrl: "wss://chat.example.org" })).toBe("chat.example.org");
    expect(mediaHost({ PUBLIC_DOMAIN: "chat.example.org", livekitPublicUrl: "wss://CHAT.example.org/rtc" })).toBe("chat.example.org");
    expect(mediaHost({ PUBLIC_DOMAIN: "chat.example.org", livekitPublicUrl: "wss://media.example.org" })).toBe("media.example.org");
    expect(mediaHost({ PUBLIC_DOMAIN: "chat.example.org", livekitPublicUrl: "ws://localhost:7880" })).toBe("chat.example.org");
    expect(mediaHost({ PUBLIC_DOMAIN: "localhost", livekitPublicUrl: "ws://127.0.0.1:7880" })).toBe("localhost");
    expect(mediaHost({ PUBLIC_DOMAIN: "chat.example.org", livekitPublicUrl: "wss://media.example.org", LIVEKIT_NODE_IP: "203.0.113.7" })).toBe("203.0.113.7");
    expect(mediaHost({ PUBLIC_DOMAIN: "chat.example.org", livekitPublicUrl: "not a url" })).toBe("chat.example.org");
  });
});

describe("onPlatform", () => {
  it("words a text for containers, and for services on Windows", () => {
    expect(onPlatform("container", "service", "linux")).toBe("container");
    expect(onPlatform("container", "service", "win32")).toBe("service");
    expect(onPlatform("container", "service")).toBe(process.platform === "win32" ? "service" : "container");
  });
});

describe("classifyFailure", () => {
  it("sorts the codes an operator meets", () => {
    expect(classifyFailure("ENOTFOUND")).toBe("dns");
    expect(classifyFailure("EAI_AGAIN")).toBe("dns");
    expect(classifyFailure("CERT_HAS_EXPIRED")).toBe("tls");
    expect(classifyFailure("DEPTH_ZERO_SELF_SIGNED_CERT")).toBe("tls");
    expect(classifyFailure("ERR_TLS_CERT_ALTNAME_INVALID")).toBe("tls");
    expect(classifyFailure("ECONNREFUSED")).toBe("refused");
    expect(classifyFailure("timeout")).toBe("timeout");
    expect(classifyFailure("UND_ERR_CONNECT_TIMEOUT")).toBe("timeout");
    expect(classifyFailure("ECONNRESET")).toBe("reset");
    expect(classifyFailure("something else")).toBe("other");
  });
});

describe("errorCode", () => {
  it("prefers the cause's code, names a timeout, falls back to the message", () => {
    expect(errorCode(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe("ENOTFOUND");
    expect(errorCode(Object.assign(new Error("aborted"), { name: "TimeoutError" }))).toBe("timeout");
    expect(errorCode(new Error("plain"))).toBe("plain");
    expect(errorCode("text")).toBe("text");
  });
});

describe("requestCheck", () => {
  const config = { PUBLIC_DOMAIN: "chat.example.org", trustedProxies: ["172.16.0.0/12"] };
  const view = { hostname: "chat.example.org", protocol: "https", ip: "203.0.113.5", remoteAddress: "172.18.0.3", forwardedFor: "203.0.113.5" };
  it("is nothing for the loopback call and a skip in development", () => {
    expect(requestCheck(null, config)).toBeNull();
    expect(requestCheck(view, { ...config, PUBLIC_DOMAIN: "localhost" })?.status).toBe("skip");
  });
  it("passes a request through a trusted proxy", () => {
    const c = requestCheck(view, config)!;
    expect(c.status).toBe("ok");
    expect(c.text.en).toContain("203.0.113.5");
  });
  it("fails a host that is not PUBLIC_DOMAIN", () => {
    const c = requestCheck({ ...view, hostname: "www.example.org" }, config)!;
    expect(c.status).toBe("fail");
    expect(c.text.de).toContain("signature_invalid");
  });
  it("warns when the proxy forwards but is not trusted (the client's address stays the proxy's)", () => {
    const c = requestCheck({ ...view, ip: "172.18.0.3" }, config)!;
    expect(c.status).toBe("warn");
    expect(c.text.en).toContain("TRUSTED_PROXIES");
  });
  it("warns when a proxy on a private address sends no X-Forwarded-For", () => {
    const c = requestCheck({ ...view, ip: "172.18.0.3", forwardedFor: null }, config)!;
    expect(c.status).toBe("warn");
    expect(c.text.en).toContain("X-Forwarded-For");
  });
  it("warns when the scheme did not survive the proxy", () => {
    expect(requestCheck({ ...view, protocol: "http" }, config)?.text.en).toContain("X-Forwarded-Proto");
  });
});
