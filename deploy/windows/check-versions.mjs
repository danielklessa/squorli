#!/usr/bin/env node
/**
 * The package for Windows ships the programs the Docker way gets as images, so their versions live in two places. This
 * holds them together: deploy/windows/versions.json against .nvmrc (Node) and against the LiveKit and PostgreSQL images
 * of the Compose files. Runs in CI (job `test`) and at the start of build-package.ps1; exit 1 names what differs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (...path) => readFileSync(join(root, ...path), "utf8");
const versions = JSON.parse(read("deploy", "windows", "versions.json"));
const problems = [];

const nvmrc = read(".nvmrc").trim().replace(/^v/, "");
if (versions.node.version !== nvmrc) problems.push(`Node: versions.json has ${versions.node.version}, .nvmrc has ${nvmrc}`);

for (const file of ["compose.yml", "portainer.yml", "compose.dev.yml"]) {
  const text = read("deploy", file);
  const livekit = /livekit\/livekit-server:v([0-9.]+)/.exec(text)?.[1];
  if (!livekit) problems.push(`LiveKit: no pinned livekit/livekit-server:v<version> in deploy/${file}`);
  else if (livekit !== versions.livekit.version) problems.push(`LiveKit: versions.json has ${versions.livekit.version}, deploy/${file} has ${livekit}`);
  const postgres = /image:\s*postgres:([0-9]+)/.exec(text)?.[1];
  if (postgres && postgres !== versions.postgresql.version.split(".")[0]) problems.push(`PostgreSQL: versions.json has ${versions.postgresql.version}, deploy/${file} has major version ${postgres}`);
}

for (const [key, item] of Object.entries(versions)) {
  // The PostgreSQL build carries its own number behind the version (16.15-4); the address must name exactly that build.
  const inUrl = item.build ?? item.version;
  if (!item.url.includes(inUrl)) problems.push(`${key}: the address does not name version ${inUrl}: ${item.url}`);
  if (!item.url.startsWith("https://")) problems.push(`${key}: the address is not https: ${item.url}`);
  for (const field of ["sha256", "licenseSha256"]) {
    if (field in item && !/^[0-9a-f]{64}$/.test(item[field])) problems.push(`${key}: ${field} is not 64 lowercase hex characters`);
  }
  if (!item.sha256) problems.push(`${key}: no sha256`);
  if (!item.license || !item.source || !item.name) problems.push(`${key}: name, license and source are required (THIRD-PARTY-NOTICES.md)`);
}

if (problems.length) {
  for (const p of problems) console.error(`[windows versions] ${p}`);
  console.error("[windows versions] Raise deploy/windows/versions.json together with the Compose files and .nvmrc (deploy/windows/AGENTS.md).");
  process.exit(1);
}
console.log(`[windows versions] ok: ${Object.values(versions).map((v) => `${v.name} ${v.build ?? v.version}`).join(", ")}`);
