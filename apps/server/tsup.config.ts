import { defineConfig } from "tsup";

export default defineConfig({
  // Two bundles: the server itself and the worker thread that reads linked pages' heads for the link previews
  // (src/preview-worker.ts); index.ts starts the worker from the file next to its own.
  entry: { index: "src/index.ts", "preview-worker": "src/preview-worker.ts" },
  format: ["esm"],
  target: "node24",
  clean: true,
  // The protocol package only exists as TypeScript source; include it in the bundle
  // so dist/index.js runs without type stripping and without a workspace link.
  noExternal: ["@squorli/protocol", "@squorli/link-preview"],
  // @fastify/multipart pulls in busboy; leave it external (it lives in the deploy output's node_modules).
});
