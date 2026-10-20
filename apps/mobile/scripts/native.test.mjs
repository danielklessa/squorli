// The native projects against the installed packages: Capacitor writes pnpm's real paths (with the versions in them) into
// android/capacitor.settings.gradle and ios/App/CapApp-SPM/Package.swift. After an update of a @capacitor package they
// point to folders that are gone until `pnpm --filter @squorli/mobile sync` ran again (apps/mobile/AGENTS.md).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildNumber, withIosVersion } from "./versions.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(app, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const web = JSON.parse(read("../web/package.json"));
const ran = "run `pnpm --filter @squorli/mobile sync` and commit the native projects";

describe("native projects", () => {
  it("name only folders that exist (Android)", () => {
    const dirs = [...read("android/capacitor.settings.gradle").matchAll(/new File\('([^']+)'\)/g)].map((m) => m[1]);
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) expect(existsSync(resolve(app, "android", dir)), `${dir}: ${ran}`).toBe(true);
  });

  it("name only folders that exist and the installed Capacitor (iOS)", () => {
    const swift = read("ios/App/CapApp-SPM/Package.swift");
    for (const [, dir] of swift.matchAll(/path: "([^"]+)"/g)) expect(existsSync(resolve(app, "ios/App/CapApp-SPM", dir)), `${dir}: ${ran}`).toBe(true);
    expect(/capacitor-swift-pm\.git", exact: "([^"]+)"/.exec(swift)?.[1], ran).toBe(pkg.dependencies["@capacitor/ios"]);
  });

  it("use one Capacitor version, in the shell and in the web client", () => {
    const core = pkg.dependencies["@capacitor/core"];
    expect(pkg.dependencies["@capacitor/android"]).toBe(core);
    expect(pkg.dependencies["@capacitor/ios"]).toBe(core);
    expect(pkg.devDependencies["@capacitor/cli"]).toBe(core);
    // The web client calls the plugins (apps/web/src/platform/mobileApp.ts): the same versions as the shell's native parts.
    expect(web.dependencies["@capacitor/core"]).toBe(core);
    expect(web.dependencies["@capacitor/app"]).toBe(pkg.dependencies["@capacitor/app"]);
  });

  it("carry the app's version (iOS; Android's build.gradle reads package.json itself)", () => {
    const pbxproj = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(withIosVersion(pbxproj, pkg.version), ran).toBe(pbxproj);
    expect(read("android/app/build.gradle")).toContain("appMajor * 1000000 + appMinor * 1000 + appPatch");
    expect(buildNumber(pkg.version)).toBeGreaterThan(0);
  });
});
