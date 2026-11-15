import { cpSync, existsSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  // Three bundles: the server itself, the worker thread that reads linked pages' heads for the link previews
  // (src/preview-worker.ts) and the worker thread a plugin runs in (src/plugin-worker.ts, docs/features/plugins.md);
  // index.ts starts each worker from the file next to its own.
  entry: { index: "src/index.ts", "preview-worker": "src/preview-worker.ts", "plugin-worker": "src/plugin-worker.ts" },
  // The plugins that ship with the server (apps/server/plugins) go next to the bundle, so the image and the package for
  // Windows carry them with `dist` and need no line of their own.
  onSuccess: async () => { if (existsSync("plugins")) cpSync("plugins", "dist/plugins", { recursive: true }); },
  format: ["esm"],
  target: "node26",
  clean: true,
  // The protocol package only exists as TypeScript source; include it in the bundle
  // so dist/index.js runs without type stripping and without a workspace link.
  noExternal: ["@squorli/protocol", "@squorli/link-preview"],
  // @fastify/multipart pulls in busboy; leave it external (it lives in the deploy output's node_modules).
});
