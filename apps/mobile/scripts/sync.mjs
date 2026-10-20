#!/usr/bin/env node
/**
 * Puts the web client's build into the app and lets Capacitor bring both native projects up to date (apps/mobile/AGENTS.md):
 *   pnpm build                                      (repo root: the web client's build in apps/web/dist)
 *   pnpm --filter @squorli/mobile sync [android|ios]
 * Copies apps/web/dist to www/ (without the test pages), prepares its index.html for the app (appIndex.mjs), writes the
 * version into the Xcode project (versions.mjs) and runs `cap sync`, which copies www/ and capacitor.config.js into
 * android/ and ios/ and writes the plugins' entries there (with pnpm's real paths: after every update of a @capacitor
 * package this has to run again, the test `native.test.mjs` says so).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { appIndexHtml } from "./appIndex.mjs";
import { withIosVersion } from "./versions.mjs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "..", "web", "dist");
const www = join(app, "www");
/** Pages of the build the app never shows: the screen share test page (a browser's matrix, docs/features/voice-video.md). */
const SKIP = new Set(["test"]);

if (!existsSync(join(dist, "index.html"))) {
  console.error(`[mobile] ${dist} enthaelt keinen gebauten Client. Erst \`pnpm build\` im Wurzelordner.`);
  process.exit(1);
}
rmSync(www, { recursive: true, force: true });
cpSync(dist, www, { recursive: true, filter: (src) => !SKIP.has(relative(dist, src).split(/[\\/]/)[0] ?? "") });
writeFileSync(join(www, "index.html"), appIndexHtml(readFileSync(join(www, "index.html"), "utf8")));
console.log(`[mobile] ${dist} -> ${www}`);

// The version of package.json into the Xcode project (Android's build.gradle reads it itself).
const { version } = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const pbxproj = join(app, "ios", "App", "App.xcodeproj", "project.pbxproj");
if (existsSync(pbxproj)) {
  const before = readFileSync(pbxproj, "utf8"), after = withIosVersion(before, version);
  if (after !== before) { writeFileSync(pbxproj, after); console.log(`[mobile] iOS-Version ${version}`); }
}

const require = createRequire(join(app, "package.json"));
const cliDir = dirname(require.resolve("@capacitor/cli/package.json"));
const cli = join(cliDir, JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).bin.cap);
const run = spawnSync(process.execPath, [cli, "sync", ...process.argv.slice(2)], { cwd: app, stdio: "inherit" });
process.exit(run.status ?? 1);
