import { PLUGIN_API_MIN, PLUGIN_API_VERSION, PLUGIN_CAPABILITIES, PLUGIN_NETWORK_HOSTS_MAX, PLUGIN_COMMANDS_MAX, PLUGIN_FIELD_TYPES, PLUGIN_FORM_FIELDS_MAX, PLUGIN_MEMBER_ACTIONS_MAX, PLUGIN_SETTINGS_FIELDS_MAX, PLUGIN_SOURCE_MAX_BYTES, PLUGIN_VIEWS_MAX, PLUGIN_VIEW_COLUMN_TYPES, PLUGIN_VIEW_ROWS_MAX, Permission } from "@squorli/protocol";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CAPABILITY_INFO, readPluginFile } from "./manifest";
import { HOST_FUNCTIONS, PLUGIN_EVENTS } from "./prelude";
import { EVENT_HOST_CALLS_MAX, EVENT_QUEUE_MAX, EVENT_WALL_MS, PluginRunner } from "./runner";
import { RETRY_SECONDS } from "./scheduler";
import { HISTORY_MAX, JOBS_MAX, JOB_PAYLOAD_MAX, LOG_DAYS, LOG_KEEP, LOG_LINE_MAX, MEMBERS_PAGE, MESSAGE_MAX, NET_BODY_MAX, NET_TIMEOUT_MS, RATE, STORAGE_KEYS_MAX, STORAGE_KEY_MAX, STRIKES, STRIKE_WINDOW_MS } from "./service";
import { pluginDefaults } from "../config";
import { verifyPluginSignature } from "./signature";
import { PLUGIN_SIGNING_KEYS, REVOKED_PLUGIN_HASHES } from "./signingKeys";
import { MAX_JSON_CHARS } from "./wire";

/**
 * The plugins the repository carries for people to read (the one that ships with the server and the examples of the guide)
 * are real: each one's manifest is valid and its code compiles in the sandbox, a TypeScript one after the server removed
 * its types. And `packages/plugin-api/reference.json`, the list the website's guide is held against, says what the server
 * does: run the tests with UPDATE_PLUGIN_REFERENCE=1 after a change of the interface and commit the file.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const runner = new PluginRunner({ workerFile: join(here, "..", "plugin-worker.ts"), execArgv: ["--import", "tsx"], cpuMs: 200, memoryMb: 32, onCall: async () => undefined, onFailure: () => {} });
afterAll(() => runner.close());

function pluginFiles(): string[] {
  const out: string[] = [];
  const shipped = join(root, "apps", "server", "plugins");
  for (const f of readdirSync(shipped)) if (/\.(js|ts)$/.test(f)) out.push(join(shipped, f));
  const examples = join(root, "examples", "plugins");
  if (existsSync(examples)) for (const dir of readdirSync(examples, { withFileTypes: true })) if (dir.isDirectory()) for (const f of readdirSync(join(examples, dir.name))) if (/\.(js|ts)$/.test(f) && !f.endsWith(".d.ts")) out.push(join(examples, dir.name, f));
  return out;
}

describe("the plugins in the repository", () => {
  const files = pluginFiles();
  it("there is the one that ships and at least one example", () => {
    expect(files.some((f) => f.endsWith("timed-roles.ts"))).toBe(true);
    expect(files.some((f) => f.includes("examples"))).toBe(true);
  });

  for (const file of files) {
    it(`${file.slice(root.length + 1).replace(/\\/g, "/")} has a valid manifest and compiles`, async () => {
      const source = readFileSync(file, "utf8");
      const name = file.split(/[\\/]/).pop()!;
      const read = readPluginFile(source, name);
      expect(read).toMatchObject({ ok: true });
      if (!read.ok) return;
      // Every text a person reads comes in both languages in what this repository ships.
      expect(read.manifest.name.de, "name.de").toBeTruthy();
      expect(read.manifest.description.de, "description.de").toBeTruthy();
      expect(await runner.prepare(source, read.language)).toMatchObject({ ok: true });
    }, 30_000);
  }
});

describe("the plugins that ship with the server", () => {
  const shipped = pluginFiles().filter((f) => f.replace(/\\/g, "/").includes("/apps/server/plugins/"));
  /**
   * The server offers a plugin that asks for the network only with Squorli's signature, and it holds the ones in its own
   * image to that rule too (`loadBundled`). So a change to such a file needs a new signature before it is released: the
   * file goes through the signing workflow of the repository squorli-plugins and comes back with its last line replaced.
   *
   * That workflow signs with this repository's own tool at a commit that is on GitHub already, so the changed, still
   * unsigned file has to be committed first: an unsigned file is a warning here, and a failure only in the build of a
   * server release tag (`v1.2.3`; GitLab's CI_COMMIT_TAG, GitHub's GITHUB_REF_NAME). A signature that does not hold (the
   * file was changed after it was signed and still carries the old line) fails everywhere.
   */
  const tag = process.env.CI_COMMIT_TAG ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined) ?? "";
  const releaseBuild = /^v\d/.test(tag);
  for (const file of shipped) {
    it(`${file.split(/[\\/]/).pop()} carries a signature that holds, where it needs one`, () => {
      const source = readFileSync(file, "utf8");
      const read = readPluginFile(source, file.split(/[\\/]/).pop()!);
      if (!read.ok) throw new Error(read.message);
      const check = verifyPluginSignature(source, PLUGIN_SIGNING_KEYS, REVOKED_PLUGIN_HASHES);
      expect(check.status === "none" || check.status === "valid", `signature: ${check.status}`).toBe(true);
      if (check.status === "valid") expect(check.kind).toBe("official");
      if (!read.manifest.capabilities.includes("net.fetch") || check.status === "valid") return;
      if (releaseBuild) expect(check.status, "a shipped plugin that asks for the network must be signed before a release (docs/features/plugins.md)").toBe("valid");
      else console.warn(`${file.split(/[\\/]/).pop()} asks for the network and is not signed: the server does not offer it. Sign it in squorli-plugins before the next server release (docs/features/plugins.md).`);
    });
  }
});

describe("packages/plugin-api/reference.json", () => {
  it("lists what this server offers plugins", () => {
    const defaults = pluginDefaults();
    const reference = {
      apiVersion: PLUGIN_API_VERSION,
      apiMin: PLUGIN_API_MIN,
      capabilities: PLUGIN_CAPABILITIES.map((id) => ({ id, risk: CAPABILITY_INFO[id].risk, text: CAPABILITY_INFO[id].text })),
      events: [...PLUGIN_EVENTS],
      functions: HOST_FUNCTIONS.flatMap((f) => (f === "log" ? ["log.info", "log.warn", "log.error"] : [f])),
      fieldTypes: [...PLUGIN_FIELD_TYPES],
      viewColumnTypes: [...PLUGIN_VIEW_COLUMN_TYPES],
      permissions: Object.keys(Permission),
      limits: {
        eventWallSeconds: EVENT_WALL_MS / 1000, hostCallsPerEvent: EVENT_HOST_CALLS_MAX, eventQueue: EVENT_QUEUE_MAX, jsonKb: MAX_JSON_CHARS / 1024,
        // The defaults of PLUGIN_CPU_MS, PLUGIN_MEMORY_MB, PLUGIN_STORAGE_MB and PLUGIN_MAX (config.ts), which an operator may change.
        cpuMs: defaults.PLUGIN_CPU_MS, memoryMb: defaults.PLUGIN_MEMORY_MB, storageMb: defaults.PLUGIN_STORAGE_MB, pluginsMax: defaults.PLUGIN_MAX,
        perMinute: RATE,
        storageKeys: STORAGE_KEYS_MAX, storageKeyChars: STORAGE_KEY_MAX, jobs: JOBS_MAX, jobPayloadKb: JOB_PAYLOAD_MAX / 1024, jobRetrySeconds: [...RETRY_SECONDS],
        messageChars: MESSAGE_MAX, historyMessages: HISTORY_MAX, membersPage: MEMBERS_PAGE,
        logLineChars: LOG_LINE_MAX, logLinesKept: LOG_KEEP, logDays: LOG_DAYS,
        failuresToSuspend: STRIKES, failureWindowMinutes: STRIKE_WINDOW_MS / 60_000,
        netHosts: PLUGIN_NETWORK_HOSTS_MAX, netAnswerKb: NET_BODY_MAX / 1024, netTimeoutSeconds: NET_TIMEOUT_MS / 1000,
        sourceKb: PLUGIN_SOURCE_MAX_BYTES / 1024, settingsFields: PLUGIN_SETTINGS_FIELDS_MAX, formFields: PLUGIN_FORM_FIELDS_MAX, commands: PLUGIN_COMMANDS_MAX, memberActions: PLUGIN_MEMBER_ACTIONS_MAX, views: PLUGIN_VIEWS_MAX, viewRows: PLUGIN_VIEW_ROWS_MAX,
      },
    };
    const text = `${JSON.stringify(reference, null, 2)}\n`;
    const file = join(root, "packages", "plugin-api", "reference.json");
    if (process.env.UPDATE_PLUGIN_REFERENCE === "1" || !existsSync(file)) writeFileSync(file, text, "utf8");
    expect(readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "reference.json is stale: run the tests with UPDATE_PLUGIN_REFERENCE=1 and commit it").toBe(text);
  });
});
