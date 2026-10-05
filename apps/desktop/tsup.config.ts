import { defineConfig } from "tsup";

// Three CommonJS bundles: the main process, the (sandboxed) preload script and the worker thread that reads linked pages'
// heads for the previews of direct messages (main/previewWorker.ts, started by linkLookup.ts from the file next to main.cjs).
// Everything except `electron` is bundled: the workspace packages only exist as TypeScript source, and a packaged app then
// needs no node_modules at all.
export default defineConfig({
  entry: { main: "src/main/index.ts", preload: "src/preload/index.ts", "preview-worker": "src/main/previewWorker.ts" },
  outDir: "out",
  format: ["cjs"],
  outExtension: () => ({ js: ".cjs" }),
  target: "node22",
  platform: "node",
  clean: true,
  external: ["electron"],
  // CommonJS shims for `import.meta.url` and `__dirname` of bundled ESM packages: openpgp's Node build calls
  // `createRequire(import.meta.url)`, which esbuild turns into `undefined` without the shim and the app died at its start
  // (found 5 October 2026 right after the 0.12.6 tag; the shim gives it `pathToFileURL(__filename)`).
  shims: true,
  // `noExternal` wins over `external`, so the pattern itself has to leave `electron` out (the runtime provides it).
  noExternal: [/^(?!electron$).*/],
});
