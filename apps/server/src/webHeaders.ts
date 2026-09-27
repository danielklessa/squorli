/**
 * Headers of the web client's pages (security review, 25 September 2026). The policy is the desktop app's
 * (apps/desktop/src/main/appFiles.ts, CONTENT_SECURITY_POLICY): keep the two in step. Scripts only from this server (the
 * background blur's MediaPipe WASM ships with the client since 27 September 2026); connections go anywhere, because the client talks to every chat server
 * the user adds; frames only to the web radio's two players; no page may frame the client. One difference: `http:` and
 * `ws:` connections are allowed to any host, for a server run over plain http in a LAN (LiveKit at ws://<address>:7880);
 * a page served over https cannot use them anyway (mixed content).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:",
  "media-src 'self' https: http: blob: data:",
  "connect-src 'self' https: wss: http: ws: data: blob:",
  "frame-src https://player.twitch.tv https://www.youtube-nocookie.com",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Every page of the client. `strict-origin-when-cross-origin`: other sites learn only this server's origin, never a path
 * (signed attachment links carry their signature in the query); YouTube's player needs the origin to play.
 */
export const PAGE_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
