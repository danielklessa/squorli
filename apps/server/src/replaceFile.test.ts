import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPLACE_WAITS_MS, replaceFile, type ReplaceFileDeps } from "./replaceFile";

const fail = (code: string) => Object.assign(new Error(code), { code });

/** A rename that fails with the given codes in turn and then succeeds; records the waits and what was removed. */
function fake(codes: string[], removeFails?: string) {
  const waits: number[] = [];
  const removed: string[] = [];
  let calls = 0;
  const deps: ReplaceFileDeps = {
    rename: async () => { const code = codes[calls++]; if (code) throw fail(code); },
    remove: async (path) => { if (removeFails && path === "a") throw fail(removeFails); removed.push(path); },
    sleep: async (ms) => { waits.push(ms); },
  };
  return { deps, waits, removed, calls: () => calls };
}

describe("replaceFile", () => {
  it("renames at once when nothing is in the way", async () => {
    const f = fake([]);
    await replaceFile("a.tmp", "a", f.deps);
    expect(f.calls()).toBe(1);
    expect(f.waits).toEqual([]);
    expect(f.removed).toEqual([]);
  });

  it("tries again after EPERM, EBUSY and EACCES with a growing wait", async () => {
    const f = fake(["EPERM", "EBUSY", "EACCES"]);
    await replaceFile("a.tmp", "a", f.deps);
    expect(f.calls()).toBe(4);
    expect(f.waits).toEqual(REPLACE_WAITS_MS.slice(0, 3));
    expect(f.removed).toEqual([]);
  });

  it("removes the target after the fifth failure and renames then", async () => {
    const f = fake(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM"]);
    await replaceFile("a.tmp", "a", f.deps);
    expect(f.calls()).toBe(6);
    expect(f.waits).toEqual(REPLACE_WAITS_MS);
    expect(f.removed).toEqual(["a"]);
  });

  it("gives up when the rename after the removal fails too, removes the temp file and throws", async () => {
    const f = fake(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EBUSY"]);
    await expect(replaceFile("a.tmp", "a", f.deps)).rejects.toMatchObject({ code: "EBUSY" });
    expect(f.calls()).toBe(6);
    expect(f.removed).toEqual(["a", "a.tmp"]);
  });

  it("gives up when the target cannot be removed (held without sharing) and leaves it alone", async () => {
    const f = fake(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM"], "EPERM");
    await expect(replaceFile("a.tmp", "a", f.deps)).rejects.toMatchObject({ code: "EPERM" });
    expect(f.calls()).toBe(5);
    expect(f.removed).toEqual(["a.tmp"]);
  });

  it("does not try again after another error", async () => {
    const f = fake(["ENOENT"]);
    await expect(replaceFile("a.tmp", "a", f.deps)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls()).toBe(1);
    expect(f.waits).toEqual([]);
    expect(f.removed).toEqual(["a.tmp"]);
  });

  it("replaces an existing file on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "squorli-replace-"));
    try {
      await writeFile(join(dir, "icon"), "old");
      await writeFile(join(dir, "icon.tmp"), "new");
      await replaceFile(join(dir, "icon.tmp"), join(dir, "icon"));
      expect(await readFile(join(dir, "icon"), "utf8")).toBe("new");
      expect(await readdir(dir)).toEqual(["icon"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
