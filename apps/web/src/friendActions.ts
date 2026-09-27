import { askConfirm } from "./dialogs";
import { t } from "./i18n";
import type { Store } from "./store";

/**
 * Removing and blocking a friend (docs/features/directory.md, 24 September 2026, user's wish: "Es fehlt generell die
 * Möglichkeit Freunde zu entfernen"). Both ask first and say what follows; the directory does the rest (`friends.remove`
 * ends the friendship for both, `friends.block` also keeps their requests out). The conversation stays at the directory
 * and shows again after a new friendship; it is not deleted.
 */
export function askRemoveFriend(store: Store, publicKey: string, name: string): void {
  void askConfirm({ title: t("friends.removeTitle", { name }), text: t("friends.removeText", { name }), confirmLabel: t("friends.remove"), danger: true })
    .then((ok) => { if (ok) store.removeFriend(publicKey); });
}

export function askBlockFriend(store: Store, publicKey: string, name: string): void {
  void askConfirm({ title: t("friends.blockTitle", { name }), text: t("friends.blockText", { name }), confirmLabel: t("friends.block"), danger: true })
    .then((ok) => { if (ok) store.blockFriend(publicKey, name); });
}

/**
 * Blocking a member of a server (docs/features/reports.md, stage 3, 27 September 2026): asks first and says what follows and
 * where the block holds (`store.setBlocked`): everywhere for the directory account, on this device for a server account.
 * `directory` = the person has a directory account, so the directory keeps their requests out as well.
 */
export function askBlockPerson(store: Store, host: string, publicKey: string, name: string, directory: boolean): void {
  const account = !store.state.serverAccounts[host] && !!store.state.directoryAccount;
  void askConfirm({ title: t("block.title", { name }), text: t(account ? "block.textAccount" : "block.textDevice", { name }), confirmLabel: t("block.block"), danger: true })
    .then((ok) => { if (ok) store.setBlocked(host, publicKey, true, { name, directory }); });
}
