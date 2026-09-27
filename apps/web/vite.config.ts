import react from "@vitejs/plugin-react";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * MediaPipe's WASM for the camera's background blur, served by the client itself under /mediapipe/wasm/ instead of
 * jsdelivr (user's decision, 25 September 2026; apps/web/src/voice/AGENTS.md). Taken from the @mediapipe/tasks-vision
 * version @livekit/track-processors depends on, so code and WASM always match; the model sits in public/mediapipe/.
 */
function mediapipeWasm(): Plugin {
  const fromHere = createRequire(import.meta.url);
  const wasmDir = join(dirname(createRequire(fromHere.resolve("@livekit/track-processors")).resolve("@mediapipe/tasks-vision")), "wasm");
  let outDir = "dist";
  return {
    name: "squorli-mediapipe-wasm",
    configResolved(config) { outDir = config.build.outDir; },
    configureServer(server) {
      server.middlewares.use("/mediapipe/wasm/", (req, res, next) => {
        const file = join(wasmDir, (req.url ?? "").split("?")[0].replace(/^\/+/, ""));
        if (!file.startsWith(wasmDir) || !existsSync(file)) return next();
        res.setHeader("content-type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      const target = join(outDir, "mediapipe", "wasm");
      mkdirSync(target, { recursive: true });
      for (const f of readdirSync(wasmDir)) copyFileSync(join(wasmDir, f), join(target, f));
    },
  };
}

// In dev the app server runs on 3000; everything under /api is proxied there
// so cookies/origin look like they do in production (a single domain).
export default defineConfig({
  plugins: [react(), mediapipeWasm()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", ws: true, changeOrigin: false },
    },
  },
  // Two pages: the app, and the small page a popped-out Twitch/YouTube player lives in (src/playerWindow.ts).
  build: { outDir: "dist", sourcemap: true, rollupOptions: { input: { main: fileURLToPath(new URL("./index.html", import.meta.url)), playerWindow: fileURLToPath(new URL("./player-window.html", import.meta.url)) } } },
});
