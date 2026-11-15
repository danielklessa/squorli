import type { ManifestField } from "@squorli/protocol";
import { PLUGIN_CAPABILITIES } from "@squorli/protocol";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPABILITY_INFO, apiSupported, checkValues, readPluginFile, scopeIds, wireField } from "./manifest";

const head = (json: string) => `/* squorli-plugin\n${json}\n*/\nsquorli.on("enable", () => {});\n`;
const minimal = `{ "id": "abc", "name": "A", "description": "B", "version": "1.0.0", "apiVersion": 1 }`;

describe("readPluginFile", () => {
  it("reads the manifest from the leading comment without running anything", () => {
    const r = readPluginFile(head(minimal), "abc.js");
    expect(r.ok && r.manifest.id).toBe("abc");
    expect(r.ok && r.language).toBe("js");
    expect(readPluginFile(head(minimal), "Plugin.TS")).toMatchObject({ ok: true, language: "ts" });
    // A byte order mark and blank lines before the comment are fine; code before it is not.
    expect(readPluginFile(`﻿\n\n${head(minimal)}`, "abc.js").ok).toBe(true);
    expect(readPluginFile(`const x = 1;\n${head(minimal)}`, "abc.js")).toMatchObject({ ok: false, code: "no_manifest" });
  });

  it("refuses other files and broken manifests with a reason", () => {
    expect(readPluginFile(head(minimal), "abc.zip")).toMatchObject({ ok: false, code: "bad_file_name" });
    expect(readPluginFile(head(minimal), "abc.d.ts")).toMatchObject({ ok: false, code: "bad_file_name" });
    expect(readPluginFile("squorli.on('x', () => {});", "abc.js")).toMatchObject({ ok: false, code: "no_manifest" });
    expect(readPluginFile(head("{ not json"), "abc.js")).toMatchObject({ ok: false, code: "bad_manifest" });
    const strict = readPluginFile(head(minimal.replace('"apiVersion": 1', '"apiVersion": 1, "network": true')), "abc.js");
    expect(strict).toMatchObject({ ok: false, code: "bad_manifest" });
    expect(readPluginFile(`${head(minimal)}${"x".repeat(300 * 1024)}`, "abc.js")).toMatchObject({ ok: false, code: "too_large" });
  });

  it("tells a plugin for a later interface apart from a broken one", () => {
    expect(readPluginFile(head(minimal.replace('"apiVersion": 1', '"apiVersion": 2, "somethingNew": 1')), "abc.js")).toMatchObject({ ok: false, code: "api_too_new" });
    expect(readPluginFile(head(minimal.replace('"apiVersion": 1', '"apiVersion": 0')), "abc.js")).toMatchObject({ ok: false, code: "api_too_old" });
    expect(apiSupported(1)).toBe(true);
    expect(apiSupported(2)).toBe(false);
  });

  it("reads the plugin that ships with the server", () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "timed-roles.ts");
    const r = readPluginFile(readFileSync(file, "utf8"), "timed-roles.ts");
    expect(r).toMatchObject({ ok: true, language: "ts" });
    if (!r.ok) return;
    expect(r.manifest.id).toBe("timed-roles");
    expect(r.manifest.capabilities).toEqual(["members.read", "roles.manage"]);
    expect(r.manifest.memberActions[0]!.fields.map((f) => f.type)).toEqual(["role", "duration"]);
  });

  it("has a text in both languages for every capability", () => {
    for (const c of PLUGIN_CAPABILITIES) {
      expect(CAPABILITY_INFO[c].text.en.length).toBeGreaterThan(10);
      expect(CAPABILITY_INFO[c].text.de!.length).toBeGreaterThan(10);
    }
  });
});

const field = (f: Partial<ManifestField> & { key: string; type: ManifestField["type"] }): ManifestField => ({ label: { en: f.key }, required: false, ...f });
const A = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a11", B = "5f0e4d7c-93a1-4b53-9d6a-2f1c8c7f1a12";

describe("checkValues", () => {
  it("takes what fits and drops what the fields do not name", () => {
    const fields = [field({ key: "t", type: "text" }), field({ key: "n", type: "number", min: 0, max: 10 }), field({ key: "b", type: "boolean" }), field({ key: "d", type: "duration", min: 60 }),
      field({ key: "s", type: "select", options: [{ value: "a", label: { en: "A" } }] }), field({ key: "r", type: "role" }), field({ key: "rs", type: "roles" })];
    const r = checkValues(fields, { t: "  hello\nworld ", n: 3, b: true, d: 120, s: "a", r: A.toUpperCase(), rs: [A, A, B], extra: 1 });
    expect(r).toEqual({ ok: true, values: { t: "hello world", n: 3, b: true, d: 120, s: "a", r: A, rs: [A, B] } });
  });

  it("names the field and the kind of mistake", () => {
    const fields = [field({ key: "t", type: "text", maxLength: 3 }), field({ key: "n", type: "number", min: 0, max: 10 }), field({ key: "d", type: "duration", min: 60 }),
      field({ key: "s", type: "select", options: [{ value: "a", label: { en: "A" } }] }), field({ key: "r", type: "role", required: true }), field({ key: "rs", type: "roles" }), field({ key: "b", type: "boolean" })];
    const r = checkValues(fields, { t: "four", n: 11, d: 5, s: "z", rs: ["nope"], b: "yes" });
    expect(r).toEqual({ ok: false, errors: { t: "too_long", n: "out_of_range", d: "out_of_range", s: "invalid", r: "required", rs: "invalid", b: "invalid" } });
    expect(checkValues([field({ key: "d", type: "duration" })], { d: 1.5 })).toEqual({ ok: false, errors: { d: "invalid" } });
    expect(checkValues([field({ key: "d", type: "duration" })], { d: 400 * 86400 * 365 })).toEqual({ ok: false, errors: { d: "out_of_range" } });
  });

  it("takes a date as a day of the calendar, without its year only where the field says so", () => {
    const fields = [field({ key: "full", type: "date" }), field({ key: "birthday", type: "date", yearOptional: true })];
    expect(checkValues(fields, { full: "2026-11-15", birthday: "--12-24" })).toEqual({ ok: true, values: { full: "2026-11-15", birthday: "--12-24" } });
    expect(checkValues(fields, { full: "--11-15", birthday: "1990-02-30" })).toEqual({ ok: false, errors: { full: "invalid", birthday: "invalid" } });
    expect(checkValues(fields, { full: 20261115 })).toEqual({ ok: false, errors: { full: "invalid" } });
    expect(checkValues(fields, {})).toEqual({ ok: true, values: {} });
  });

  it("fills defaults and leaves an optional empty field out", () => {
    const fields = [field({ key: "t", type: "text", default: "x" }), field({ key: "o", type: "text" }), field({ key: "rs", type: "roles" }), field({ key: "b", type: "boolean" }), field({ key: "m", type: "text", multiline: true })];
    expect(checkValues(fields, { t: "", m: "a\r\nb" })).toEqual({ ok: true, values: { t: "x", rs: [], b: false, m: "a\nb" } });
  });
});

describe("the scope of a set of settings", () => {
  const fields = [field({ key: "roles", type: "roles" }), field({ key: "one", type: "role" }), field({ key: "room", type: "channel" }), field({ key: "note", type: "text" })];
  const values = { roles: [A], one: B, room: A, note: B };

  it("collects the roles and channels the settings name, and nothing a text field holds", () => {
    expect(scopeIds(fields, values)).toEqual({ roles: [A, B], channels: [A] });
  });

  it("offers a dialog's field what lies in the scope, or the values of the settings field it names", () => {
    const settings = { fields, values, scope: { roles: [A, B], channels: [A] } };
    expect(wireField(field({ key: "r", type: "role" }), settings).allowed).toEqual([A, B]);
    expect(wireField(field({ key: "r", type: "role", from: "roles" }), settings).allowed).toEqual([A]);
    expect(wireField(field({ key: "c", type: "channel" }), settings).allowed).toEqual([A]);
    // What the settings name but the scope does not hold (a role the saver could not grant) is not offered.
    expect(wireField(field({ key: "r", type: "role", from: "roles" }), { ...settings, scope: { roles: [], channels: [] } }).allowed).toEqual([]);
    // `from` never leaves the server, and a settings field carries no list.
    expect(wireField(field({ key: "r", type: "role", from: "roles" }), settings)).not.toHaveProperty("from");
    expect(wireField(field({ key: "roles", type: "roles" }))).not.toHaveProperty("allowed");
  });
});
