/**
 * What the debug panel may show of a WebSocket message (security audit, 2 October 2026, C6): the `hello` carries the session
 * token, which is a working key to the account on that server for up to 30 days, and the panel is what a user opens and then
 * shares on a screen or in a screenshot while somebody helps them. Every secret field is masked, in either direction.
 */
const SECRET_FIELDS = /("(?:sessionToken|token|authKey|password|privateKey)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

export function redactForLog(json: string): string {
  return json.replace(SECRET_FIELDS, '$1"•••"');
}
