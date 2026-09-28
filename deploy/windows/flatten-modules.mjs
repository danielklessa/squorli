#!/usr/bin/env node
/**
 * node flatten-modules.mjs <deploy folder> <target node_modules>
 *
 * pnpm's node_modules consist of links (junctions on Windows), which a ZIP cannot hold. pnpm can write plain folders
 * (node-linker=hoisted), but `pnpm deploy` then ignores the lockfile and installs newer versions than the ones that were
 * tested (seen on 28 September 2026 with pnpm 10.15: nine packages, fastify and ws among them). So the package is made
 * from the deploy output the Dockerfile uses, which follows the lockfile, and this script writes it again as plain
 * folders: every package once at the top of node_modules where its name is free, a second version of a name below the
 * package that needs it. Afterwards it checks, for every package and every dependency, that Node's lookup in the new tree
 * finds the same version as in pnpm's; exit 1 when one differs.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const [from, to] = process.argv.slice(2).map((p) => resolve(p));
if (!from || !to) { console.error("usage: node flatten-modules.mjs <deploy folder> <target node_modules>"); process.exit(1); }
if (!existsSync(join(from, "package.json")) || !existsSync(join(from, "node_modules"))) { console.error(`[flatten] ${from} is no deploy output (package.json and node_modules expected)`); process.exit(1); }

const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
/** Node's lookup in pnpm's tree: the folder of `name` as seen from `fromDir`, links resolved; null when it is not installed. */
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

/** The packages by their real folder in pnpm's tree, each with the folders of what it depends on. */
const graph = new Map();
function read(dir, names) {
  const deps = new Map();
  for (const name of names) {
    const found = locate(name, dir);
    if (found && found !== dir) deps.set(name, found);   // an optional or peer dependency that is not installed is left out
  }
  return deps;
}
function visit(dir) {
  if (graph.has(dir)) return;
  const pkg = manifestOf(dir);
  const node = { dir, name: pkg.name, version: pkg.version, deps: new Map() };
  graph.set(dir, node);
  node.deps = read(dir, Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }));
  for (const dep of node.deps.values()) visit(dep);
}
const rootDir = realpathSync(from);
const rootDeps = read(rootDir, Object.keys({ ...manifestOf(rootDir).dependencies, ...manifestOf(rootDir).optionalDependencies }));
for (const dep of rootDeps.values()) visit(dep);

/** The new tree: a path like "fastify" or "a/node_modules/b" (relative to the target) -> the package placed there. */
const placed = new Map();
/** What Node finds for `name` from the package placed at `at` ("" = the application itself). */
function found(name, at) {
  for (let base = at; ; ) {
    const path = base ? `${base}/node_modules/${name}` : name;
    if (placed.has(path)) return { path, dir: placed.get(path) };
    if (!base) return null;
    const cut = base.lastIndexOf("/node_modules/");
    base = cut < 0 ? "" : base.slice(0, cut);
  }
}
const queue = [];
function place(name, dir, at) {
  const seen = found(name, at);
  if (seen?.dir === dir) return;
  // Free at the top: there. Taken by another version (or by the same version with other dependencies): below the package that asks.
  const path = seen ? `${at}/node_modules/${name}` : name;
  placed.set(path, dir);
  queue.push(path);
}
for (const [name, dir] of rootDeps) place(name, dir, "");
while (queue.length) {
  const at = queue.shift();
  for (const [name, dir] of graph.get(placed.get(at)).deps) place(name, dir, at);
}

// The check: the new tree answers every lookup like pnpm's.
const problems = [];
for (const [name, dir] of rootDeps) if (found(name, "")?.dir !== dir) problems.push(`the application finds another ${name}`);
for (const [at, dir] of placed) {
  for (const [name, dep] of graph.get(dir).deps) {
    const got = found(name, at);
    if (got?.dir !== dep) problems.push(`${at} needs ${name}@${graph.get(dep).version}, finds ${got ? graph.get(got.dir).version : "nothing"}`);
  }
}
if (problems.length) { for (const p of problems) console.error(`[flatten] ${p}`); process.exit(1); }

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
// Parents before their children, so a package's own files never overwrite what was placed below it.
for (const [at, dir] of [...placed].sort(([a], [b]) => a.length - b.length)) {
  // A package's own folder holds no links but those of pnpm (dependencies of a workspace package); they are left out.
  cpSync(dir, join(to, ...at.split("/")), { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
}
const nested = [...placed.keys()].filter((p) => p.includes("/node_modules/"));
console.log(`[flatten] ${placed.size} packages as plain folders in ${to}${sep}; ${nested.length} below another package${nested.length ? ` (${nested.join(", ")})` : ""}`);
