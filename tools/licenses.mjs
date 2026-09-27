#!/usr/bin/env node
/**
 * Third-party notices for the web client (Einstellungen > Lizenzen): the client is shipped as one minified bundle, so the
 * license files of the packages inside it are gone; the Apache, MIT, ISC, BSD and OFL licenses all ask that their text and
 * copyright notice travel with a distribution. This walks the production dependencies of @squorli/web (including those of
 * @squorli/protocol) through node_modules, plus the packages whose assets are shipped although they are no runtime
 * dependency (ASSETS: emoji data), the emoji font and the background blur's model that are no packages at all (FONT_DIR,
 * MODELS), and the desktop app's main process bundle (DESKTOP_ROOTS: electron-updater and what the shell's own workspace
 * packages pull in; since 27 September 2026, apps/desktop/AGENTS.md), and writes
 *   apps/web/src/licenses/thirdParty.ts   loaded by the settings dialog when the tab opens
 *   THIRD-PARTY-NOTICES.md                the same for readers of the repository and of the container image
 * The walk lists every package that can end up in the bundle (a superset: a package the bundler drops is listed anyway).
 * The server's packages keep their own license files in node_modules of the image and are not part of this.
 * Runs in `pnpm build` and via `pnpm run licenses` (`pnpm licenses` is pnpm's own command); fails when a package states no license.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(root, "apps", "web");
const outDir = join(webDir, "src", "licenses");

/** Shipped as generated files or fonts, although package.json lists them under devDependencies (or not as code). */
const ASSETS = { "emojibase-data": "Emoji names, keywords and shortcodes (picker, :shortcode:)" };
const NOTES = {
  "lucide-static": "Icon font, only the icons in use",
  ...ASSETS,
};
/** Shipped files that are no npm package: the emoji font, downloaded by tools/emoji.mjs together with its license and font.json. */
const FONT_DIR = join(webDir, "src", "emoji", "font");
/** Models shipped as files (apps/web/public/mediapipe/, apps/web/src/voice/AGENTS.md); their license text is Apache-2.0 = our LICENSE. */
const MODELS = [
  { name: "MediaPipe Selfie Segmenter (model)", version: "float16, 2023-05-07", license: "Apache-2.0", url: "https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter", author: "Google LLC", note: "Camera background blur, delivered by this server" },
];
/**
 * The desktop app's main process is one bundle of everything but electron (apps/desktop/tsup.config.ts): electron-updater
 * plus the dependencies of the workspace packages it imports. Electron itself ships its own LICENSE.electron.txt and
 * LICENSES.chromium.html next to the program.
 */
const desktopDir = join(root, "apps", "desktop");
const DESKTOP_ROOTS = ["electron-updater", "@squorli/protocol", "@squorli/link-preview"];

/** Directory of `name` as seen from the package in `fromDir` (Node's lookup, which also follows pnpm's layout). */
function locate(name, fromDir) {
  for (let dir = realpathSync(fromDir); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** Homepage or repository field as an https address ("git@github.com:a/b.git", "github:a/b" and "a/b" are common spellings). */
function webUrl(value) {
  if (!value) return null;
  const url = value.replace(/^git\+/, "").replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, "https://github.com/").replace(/^git:\/\//, "https://")
    .replace(/^github:/, "https://github.com/").replace(/^(?=[\w.-]+\/[\w.-]+$)/, "https://github.com/").replace(/\.git$/, "");
  return /^https?:\/\//.test(url) ? url : null;
}

const found = new Map();
/** `origin`: "web" (the client, in the browser and the app) or "desktop" (the app's shell only). */
function visit(name, fromDir, origin = "web") {
  const dir = locate(name, fromDir);
  if (!dir) { console.error(`[licenses] ${name} nicht gefunden (von ${fromDir}); pnpm install ausgeführt?`); process.exit(1); }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  const seen = found.get(key);
  if (seen?.origins.has(origin)) return;
  if (seen) seen.origins.add(origin); else found.set(key, { dir, pkg, origins: new Set([origin]) });
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (locate(dep, dir)) visit(dep, dir, origin);   // optional packages for other platforms are simply not installed
  }
}

const webPkg = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8"));
for (const name of [...Object.keys(webPkg.dependencies), ...Object.keys(ASSETS)]) visit(name, webDir);
for (const name of DESKTOP_ROOTS) visit(name, desktopDir, "desktop");

const texts = [];
const packages = [];
for (const { dir, pkg, origins } of [...found.values()].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))) {
  if (pkg.name.startsWith("@squorli/")) continue;   // our own workspace packages
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(" OR ");
  if (!license) { console.error(`[licenses] ${pkg.name}@${pkg.version} nennt keine Lizenz; bitte prüfen und hier eintragen`); process.exit(1); }
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)([.-].*)?$/i.test(f));
  // No license file in the package: for Apache-2.0 the standard text (our own LICENSE is that text), otherwise only the SPDX statement.
  const source = file ? join(dir, file) : /Apache-2\.0/.test(license) ? join(root, "LICENSE") : null;
  const text = source ? readFileSync(source, "utf8").replace(/\r\n?/g, "\n").trim() : null;
  let textIndex = text === null ? -1 : texts.indexOf(text);
  if (text !== null && textIndex < 0) textIndex = texts.push(text) - 1;
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const url = webUrl(pkg.homepage) ?? webUrl(repo) ?? `https://www.npmjs.com/package/${pkg.name}`;
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name ?? null;
  const note = [NOTES[pkg.name], origins.has("web") ? null : "desktop app only"].filter(Boolean).join("; ") || null;
  packages.push({ name: pkg.name, version: pkg.version, license, url, author: author?.replace(/\s*<[^>]*>|\s*\([^)]*\)/g, "") ?? null, note, text: textIndex });
}

{
  const font = JSON.parse(readFileSync(join(FONT_DIR, "font.json"), "utf8"));
  const text = readFileSync(join(FONT_DIR, "OFL.txt"), "utf8").replace(/\r\n?/g, "\n").trim();
  packages.push({ name: font.name, version: font.version, license: font.license, url: font.source, author: "Google Inc.", note: "Emoji font, delivered by this server", text: texts.push(text) - 1 });
  const apache = readFileSync(join(root, "LICENSE"), "utf8").replace(/\r\n?/g, "\n").trim();
  let apacheIndex = texts.indexOf(apache);
  if (apacheIndex < 0) apacheIndex = texts.push(apache) - 1;
  for (const model of MODELS) packages.push({ ...model, text: apacheIndex });
  packages.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "thirdParty.ts"), [
  "// GENERATED by tools/licenses.mjs, do not edit by hand. Third-party packages and assets shipped inside the web client.",
  'import type { ThirdPartyPackage } from "./types";',
  "",
  `export const PACKAGES: ThirdPartyPackage[] = JSON.parse(${JSON.stringify(JSON.stringify(packages))});`,
  "/** License texts; `ThirdPartyPackage.text` is an index into this list (identical texts are stored once), -1 = the package ships no license file. */",
  `export const TEXTS: string[] = JSON.parse(${JSON.stringify(JSON.stringify(texts))});`,
  "",
].join("\n"));

writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), [
  "# Third-party notices",
  "",
  "GENERATED by `tools/licenses.mjs` (`pnpm run licenses`, also part of `pnpm build`), do not edit by hand.",
  "",
  "The Squorli web client (`apps/web`) is distributed as a bundle that contains the following third-party packages and",
  "assets; the desktop app (`apps/desktop`) adds its shell's bundle (marked \"desktop app only\"), and Electron ships its own",
  "LICENSE.electron.txt and LICENSES.chromium.html next to the program. The same list with the full license texts is shown",
  "in the client under Settings > Licenses. The packages of the app server are installed unmodified, with their license",
  "files, in `node_modules` of the container image.",
  "",
  "| Package | Version | License | Source |",
  "|---|---|---|---|",
  ...packages.map((p) => `| ${p.name}${p.note ? ` (${p.note})` : ""} | ${p.version} | ${p.license} | ${p.url} |`),
  "",
  ...texts.flatMap((text, i) => [
    `## License text ${i + 1}`,
    "",
    `Applies to: ${packages.filter((p) => p.text === i).map((p) => `${p.name} ${p.version}`).join(", ")}`,
    "",
    "```text",
    text.replace(/```/g, "'''"),
    "```",
    "",
  ]),
].join("\n"));

const missing = packages.filter((p) => p.text < 0).map((p) => p.name);
console.log(`[licenses] ${packages.length} Pakete, ${texts.length} Lizenztexte${missing.length ? `; ohne Lizenzdatei (nur SPDX-Angabe): ${missing.join(", ")}` : ""}`);
