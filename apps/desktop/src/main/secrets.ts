import { ipcMain, safeStorage, type IpcMainEvent } from "electron";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC, SECRET_KEYS } from "@squorli/web/platform/bridge";
import { takeSeeds, type KeyVault } from "./keyVaultLogic";

/**
 * The client's secrets (the identity key, the server accounts' keys and tokens), encrypted with the operating system's key
 * store through Electron's `safeStorage` (Windows: DPAPI, macOS: Keychain, Linux: the desktop's secret service) in
 * `<userData>/secrets.json` (25 September 2026, docs/features/desktop.md, "Keys in safeStorage"). Until then the client kept
 * them unencrypted in the origin's localStorage; it moves them over itself (identity.ts).
 *
 * Since 4 October 2026 (security audit C1, keyVault.ts) the seeds of the account keys are the vault's: an entry the page
 * stores or reads passes through `takeSeeds`, so a `privateKey` the page still has (an app from before, a value moved out
 * of localStorage) lands in the vault's own entry, which the page cannot read (`SECRET_KEYS` does not name it), and the
 * page gets the entry without it.
 *
 * Synchronous IPC on purpose: the client reads its key synchronously in many places, and a handful of small values at start
 * costs nothing. Without real encryption (Linux without a keyring falls back to "basic_text") `available` is false and the
 * client stays with localStorage: a plain file would be no better, and moving the key there would hide that.
 */
type Stored = Record<string, string>;

/** The encrypted file: values in the clear on this side, every entry encrypted on the disk. */
export type SecretsFile = { readonly available: boolean; read(key: string): string | null; write(key: string, value: string | null): boolean };

export function openSecrets(userData: string): SecretsFile {
  const file = join(userData, "secrets.json");
  const backend = process.platform === "linux" ? safeStorage.getSelectedStorageBackend?.() : undefined;
  const available = safeStorage.isEncryptionAvailable() && backend !== "basic_text";

  const readAll = (): Stored => {
    try { const v = JSON.parse(readFileSync(file, "utf8")) as unknown; return typeof v === "object" && v !== null ? v as Stored : {}; } catch { return {}; }
  };
  const writeAll = (all: Stored) => {
    // Write the new file next to the old one, then swap: a crash mid-write never leaves half a key.
    writeFileSync(`${file}.tmp`, JSON.stringify(all), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    available,
    read: (key) => {
      if (!available) return null;
      const enc = readAll()[key];
      if (typeof enc !== "string") return null;
      try { return safeStorage.decryptString(Buffer.from(enc, "base64")); } catch { return null; } // another user's or machine's file
    },
    write: (key, value) => {
      if (!available || (value !== null && value.length > 1_000_000)) return false;
      try {
        const all = readAll();
        if (value === null) delete all[key];
        else all[key] = safeStorage.encryptString(value).toString("base64");
        writeAll(all);
        return true;
      } catch (err) { console.warn(`secrets: ${key} not written:`, err instanceof Error ? err.message : err); return false; } // the client keeps its copy
    },
  };
}

export function handleSecrets(secrets: SecretsFile, vault: KeyVault | null, isClientFrame: (event: IpcMainEvent) => boolean): void {
  const allowed = new Set<string>(SECRET_KEYS);
  /** The entry as the page may have it: its seeds in the vault, where there is one. */
  const withoutSeeds = (key: string, value: string): string => {
    if (!vault) return value;
    const stripped = takeSeeds(vault, key, value);
    if (stripped !== value && !secrets.write(key, stripped)) console.warn(`secrets: ${key} not rewritten without its seeds`);
    return stripped;
  };

  // Every handler answers exactly once: Electron sends `returnValue` at its first assignment (a later one is lost), and a
  // sendSync without an answer would hang the page. So each computes its answer first.
  const get = (event: IpcMainEvent, key: unknown): string | null => {
    if (!secrets.available || !isClientFrame(event) || typeof key !== "string" || !allowed.has(key)) return null;
    const value = secrets.read(key);
    return value === null ? null : withoutSeeds(key, value);
  };
  const set = (event: IpcMainEvent, key: unknown, value: unknown): boolean => {
    if (!secrets.available || !isClientFrame(event) || typeof key !== "string" || !allowed.has(key)) return false;
    if (value !== null && typeof value !== "string") return false;
    return secrets.write(key, value === null || !vault ? value : takeSeeds(vault, key, value));
  };
  ipcMain.on(IPC.secretsAvailable, (event) => { event.returnValue = secrets.available && isClientFrame(event); });
  ipcMain.on(IPC.secretsGet, (event, key: unknown) => { event.returnValue = get(event, key); });
  ipcMain.on(IPC.secretsSet, (event, key: unknown, value: unknown) => { event.returnValue = set(event, key, value); });
}
