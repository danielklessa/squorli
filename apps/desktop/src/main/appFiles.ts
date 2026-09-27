import { extname, join, normalize, sep } from "node:path";

/**
 * The client's files behind `app://squorli`. Pure path logic (tested); `scheme.ts` reads the files.
 *
 * The origin is final once a public version exists: the client keeps the user's key in this origin's localStorage
 * (docs/features/desktop.md). Never rename scheme or host.
 */
export const APP_SCHEME = "app";
export const APP_HOST = "squorli";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
};
export const contentTypeOf = (file: string): string => TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

/**
 * File for a request path, or null when the path leaves the root. Like the chat server's static handler: a path without
 * a file extension is a route of the single-page client and gets `index.html`.
 */
export function resolveAppFile(root: string, pathname: string): string | null {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return null; }
  if (path.includes("\0") || path.includes("\\")) return null;
  const base = normalize(root);
  const file = normalize(join(base, path));
  if (file !== base && !file.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return extname(file) === "" ? join(base, "index.html") : file;
}

/**
 * Content-Security-Policy of the client's pages. Scripts only from the app itself (MediaPipe's WASM of the background blur
 * ships with the client since 27 September 2026, apps/web/src/voice/AGENTS.md); connections go anywhere, because the client talks to whatever chat
 * server the user adds; frames only to the two embedded players of the web radio. The server's web client sends the same
 * policy (apps/server/src/webHeaders.ts): keep the two in step.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:",
  "media-src 'self' https: http: blob: data:",
  "connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* data: blob:",
  "frame-src https://player.twitch.tv https://www.youtube-nocookie.com",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
