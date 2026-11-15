/**
 * Reads plugin files the way the server does at installation, without a server and without running them
 * (docs/features/plugins.md): the manifest, the TypeScript's types taken off, a compile in the sandbox, the signature.
 *
 *   pnpm --filter @squorli/server plugin:check <file> [<file> ...]
 *
 * Prints one JSON object (`{ ok, files: [...] }`) and ends with exit code 1 when a file would be refused. Made for the
 * repository squorli-plugins, whose pull request check and signing workflow run it from a checkout of this repository at a
 * fixed commit, so a submitted plugin is judged by the server's own code and never by a second reading of the rules. A
 * plugin author runs it for the same reason.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPluginFile } from "./plugins/manifest";
import { PluginRunner } from "./plugins/runner";
import { verifyPluginSignature } from "./plugins/signature";
import { PLUGIN_SIGNING_KEYS, REVOKED_PLUGIN_HASHES } from "./plugins/signingKeys";

type Checked = { file: string; ok: boolean; error?: string } & Record<string, unknown>;

async function main(files: string[]): Promise<number> {
  if (files.length === 0) { console.error("usage: plugin:check <file> [<file> ...]"); return 2; }
  const here = dirname(fileURLToPath(import.meta.url));
  const runner = new PluginRunner({ workerFile: join(here, "plugin-worker.ts"), execArgv: ["--import", "tsx"], cpuMs: 200, memoryMb: 32, onCall: async () => undefined, onFailure: () => {} });
  const out: Checked[] = [];
  try {
    for (const file of files) {
      let source: string;
      try { source = readFileSync(file, "utf8"); } catch (err) { out.push({ file, ok: false, error: `cannot read the file: ${String((err as Error).message)}` }); continue; }
      const read = readPluginFile(source, basename(file));
      if (!read.ok) { out.push({ file, ok: false, error: read.message }); continue; }
      const m = read.manifest;
      const check = verifyPluginSignature(source, PLUGIN_SIGNING_KEYS, REVOKED_PLUGIN_HASHES);
      const facts = {
        id: m.id, name: m.name, description: m.description, version: m.version, apiVersion: m.apiVersion, author: m.author ?? null, homepage: m.homepage ?? null,
        capabilities: m.capabilities, hosts: m.network?.hosts ?? [], commands: m.commands.map((c) => c.name), language: read.language, bytes: Buffer.byteLength(source, "utf8"),
        // What a signature covers and a revocation names: the SHA-256 of the file without its signature comment, in one form.
        hash: check.hash,
        signature: check.status === "valid" || check.status === "revoked" ? { status: check.status, key: check.keyId, kind: check.kind } : { status: check.status },
      };
      if (check.status === "invalid") { out.push({ file, ok: false, error: `signature: ${check.reason}`, ...facts }); continue; }
      const prepared = await runner.prepare(source, read.language);
      out.push(prepared.ok ? { file, ok: true, ...facts } : { file, ok: false, error: prepared.message, ...facts });
    }
  } finally { await runner.close(); }
  const ok = out.every((f) => f.ok);
  console.log(JSON.stringify({ ok, files: out }, null, 2));
  return ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
