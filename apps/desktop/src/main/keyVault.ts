import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC, KEYED_SECRETS, KEY_VAULT_ENTRY } from "@squorli/web/platform/bridge";
import { KeyVault, namedKeys, takeSeeds } from "./keyVaultLogic";
import type { SecretsFile } from "./secrets";

/**
 * The key vault's Electron side (keyVaultLogic.ts has the logic): its seeds live in `KEY_VAULT_ENTRY` of the encrypted
 * store (secrets.ts), the page reaches it over `ipcRenderer.invoke` (`DesktopBridge.keys`), only from the client's own
 * frame. Without real encryption there is no vault: the page then keeps its keys in localStorage as it did, and a plain
 * file here would be no better (secrets.ts says the same of the store).
 */
export function openKeyVault(secrets: SecretsFile): KeyVault | null {
  if (!secrets.available) return null;
  return new KeyVault({
    read: () => { try { const v = JSON.parse(secrets.read(KEY_VAULT_ENTRY) ?? "{}") as unknown; return v && typeof v === "object" ? v as Record<string, string> : {}; } catch { return {}; } },
    write: (keys) => secrets.write(KEY_VAULT_ENTRY, JSON.stringify(keys)),
  });
}

/**
 * At a start, before the page runs: the seeds of an app from before the vault move out of the identity's and the server
 * accounts' entries (an entry the page stored while the app was older), and a key no entry names any more goes.
 */
export function migrateKeys(secrets: SecretsFile, vault: KeyVault): void {
  const named: string[] = [];
  for (const entry of KEYED_SECRETS) {
    const json = secrets.read(entry);
    if (json === null) continue;
    const stripped = takeSeeds(vault, entry, json);
    if (stripped !== json && !secrets.write(entry, stripped)) console.warn(`keys: ${entry} not rewritten without its seeds`);
    named.push(...namedKeys(entry, stripped));
  }
  const taken = vault.list().length;
  const gone = vault.prune(named);
  if (taken || gone.length) console.log(`keys: the vault holds ${vault.list().length} key(s)${gone.length ? `, ${gone.length} nobody named let go` : ""}`);
}

export function handleKeyVault(vault: KeyVault | null, isClientFrame: (event: IpcMainInvokeEvent) => boolean): void {
  const guarded = <T>(channel: string, run: (...args: unknown[]) => Promise<T> | T, none: T) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<T> => {
      if (!vault || !isClientFrame(event)) return none;
      try { return await run(...args); } catch (err) { console.warn(`keys: ${channel} failed:`, err instanceof Error ? err.message : err); return none; }
    });
  };
  guarded<string | null>(IPC.keysSign, (publicKey, message) => vault!.sign(publicKey, message), null);
  guarded<string | null>(IPC.keysDm, (publicKey, peer) => vault!.dmKey(publicKey, peer), null);
  guarded<string | null>(IPC.keysSettings, (publicKey) => vault!.settingsKey(publicKey), null);
  guarded(IPC.keysBackup, (publicKey, password, context, kdf) => vault!.backup(publicKey, password, context, kdf), null);
  guarded<string | null>(IPC.keysGenerate, () => vault!.generate(), null);
  guarded<string | null>(IPC.keysImport, (seed) => vault!.import(seed), null);
  guarded<void>(IPC.keysForget, (publicKey) => { vault!.forget(publicKey); }, undefined);
}
