import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../../desktop/src/main/appFiles";
import { APP_CONTENT_SECURITY_POLICY, appIndexHtml } from "./appIndex.mjs";

const source = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

describe("appIndexHtml", () => {
  it("keeps the desktop app's policy apart from frame-ancestors, which a meta tag cannot carry", () => {
    const desktop = CONTENT_SECURITY_POLICY.split("; ").filter((d) => !d.startsWith("frame-ancestors"));
    expect(APP_CONTENT_SECURITY_POLICY.split("; ")).toEqual(desktop);
  });

  it("prepares the web client's page: policy before any script, viewport-fit=cover, no manifest", () => {
    const html = appIndexHtml(source);
    const csp = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(csp).toBeGreaterThan(html.indexOf("<meta charset"));
    expect(csp).toBeLessThan(html.indexOf("<script"));
    expect(html).toContain(`content="${APP_CONTENT_SECURITY_POLICY}"`);
    expect(html).toMatch(/<meta name="viewport" content="[^"]*user-scalable=no, viewport-fit=cover"/);
    expect(html).not.toContain('rel="manifest"');
    expect(html).toContain('<div id="root"></div>');
  });

  it("leaves a viewport-fit that is already there", () => {
    const html = appIndexHtml(source.replace("user-scalable=no", "user-scalable=no, viewport-fit=contain"));
    expect(html).toContain("viewport-fit=contain");
    expect(html).not.toContain("viewport-fit=cover");
  });

  it("stops when the page no longer has what it changes", () => {
    expect(() => appIndexHtml(source.replace(/<link rel="manifest"[^>]*>/, ""))).toThrow(/manifest link/);
    expect(() => appIndexHtml(source.replace(/<meta name="viewport"[^>]*>/, ""))).toThrow(/viewport/);
    expect(() => appIndexHtml(source.replace(/<meta charset="UTF-8" \/>/, ""))).toThrow(/charset/);
  });
});
