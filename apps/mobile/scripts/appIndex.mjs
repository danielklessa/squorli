// The web client's index.html as the app shows it (pure, tested in appIndex.test.mjs; scripts/sync.mjs applies it).

/**
 * Content-Security-Policy of the app's page: the desktop app's (apps/desktop/src/main/appFiles.ts), which the server's web
 * client sends too, without `frame-ancestors` (a policy in a meta tag cannot carry it, and nothing frames the app's page).
 * A Capacitor shell sends no headers, so the policy travels in the page. The test keeps the two in step.
 */
export const APP_CONTENT_SECURITY_POLICY = [
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
].join("; ");

/** Replaces exactly one match of `pattern`; a page that no longer has it stops the sync instead of shipping half a change. */
function once(html, pattern, replace, what) {
  const matches = html.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"));
  if (!matches || matches.length !== 1) throw new Error(`index.html: expected exactly one ${what}, found ${matches?.length ?? 0}`);
  return html.replace(pattern, replace);
}

/**
 * What the app changes in the client's page: the policy above as the first thing after the charset (before any script);
 * `viewport-fit=cover`, so the page reaches under the system bars and the notch and gets the safe areas the client's CSS
 * pads with (a browser keeps its page without it, docs/features/home-screen.md); no manifest link (a route of the chat
 * server, which the app's files do not have).
 */
export function appIndexHtml(html) {
  let out = once(html, /<meta charset="UTF-8"\s*\/?>/i, (tag) => `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${APP_CONTENT_SECURITY_POLICY}" />`, "charset meta tag");
  out = once(out, /<meta name="viewport" content="([^"]*)"/, (_tag, content) => `<meta name="viewport" content="${content.includes("viewport-fit=") ? content : `${content}, viewport-fit=cover`}"`, "viewport meta tag");
  out = once(out, /\s*<link rel="manifest"[^>]*>/, "", "manifest link");
  return out;
}
