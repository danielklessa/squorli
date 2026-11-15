import type { SigningKey } from "./signature";

/**
 * The keys whose signature on a plugin file this server takes (docs/features/plugins.md, docs/features/release-signing.md):
 * Squorli's plugin key, public half. Its private half exists only as the secret `PLUGIN_SIGNING_KEY` of the environment
 * `signing` in the repository squorli-plugins, where every signing run waits for the owner's approval. It is a key of its
 * own on purpose: the release key signs what an installation runs, this one says "Squorli wrote or read this plugin".
 *
 * A list, so that a key can be replaced: one release carries the old and the new key, plugins are signed again with the new
 * one, a later release drops the old. `tools/squorli-plugins.pub` is the newest entry as a PEM file (a test holds the two
 * against each other); the id is the month the key was made.
 *
 * `2026-11`: the first key, made by the owner on 15 November 2026.
 */
export const PLUGIN_SIGNING_KEYS: readonly SigningKey[] = [
  { id: "2026-11", publicKey: "jjvE54Y+c3n38dogaLju0Dc3pXfvXtKpBaJUW8kWGUE=" },
];

/**
 * Signatures Squorli took back: the SHA-256 of the signed file's canonical body (`bodyHash`), lower-case hex. The source is
 * `revoked.json` of the repository squorli-plugins, copied here before a server release. A server learns of a revocation
 * with its next update and not before: it asks nobody.
 */
export const REVOKED_PLUGIN_HASHES: readonly string[] = [];
