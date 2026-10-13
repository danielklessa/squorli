import type { DirectoryAccount } from "@squorli/protocol";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { platform } from "./platform";

/**
 * Main area of a client without a home server (the desktop app) while no server is shown: the account has none yet and
 * none was added by address. Offers the public server directory, adding a server, and the way out (also in the settings
 * dialog, which opens without a server too: everything except the profile and the sessions, which belong to a server).
 */
export function NoServers({ directoryUrl, account, onAdd, onLogout }: {
  directoryUrl: string | null; account: DirectoryAccount | null; onAdd: () => void; onLogout: () => void;
}) {
  return (
    <section className="chat empty server-status">
      <div className="stack">
        <h2>{t("noServers.title")}</h2>
        <p className="muted">{account ? t("noServers.textAccount", { handle: account.handle }) : t("noServers.textKey")}</p>
        <div className="row">
          {/* One dialog for an address or link and for the server directory, like the rail's plus button (14 October 2026). */}
          <button onClick={onAdd}><Icon name="plus" /> {t("noServers.add")}</button>
        </div>
        <div className="row">
          {directoryUrl && !account && <button className="secondary small" onClick={() => platform.links.openExternal(directoryUrl)}>{t("noServers.createAccount", { host: new URL(directoryUrl).host })}</button>}
          <button className="secondary small" onClick={onLogout}>{t("noServers.logout")}</button>
        </div>
      </div>
    </section>
  );
}
