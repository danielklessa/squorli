import { directoryServerIconUrl, directoryServerUrl, type DirectoryServer } from "@squorli/protocol";
import { useEffect, useState } from "react";
import * as api from "./api";
import { Icon } from "./Icon";
import { RailEntry } from "./ServerRail";
import { t } from "./i18n";

/**
 * Server directory (M6d): public list from the directory service (GET /api/servers, only servers that opt into listing).
 * Joining via link: the server is opened in its own origin; open = can be entered without an invite.
 * `onOpen` (client without a home server: the desktop app) shows the server inside the client instead.
 */
export function ServerBrowser({ directoryUrl, currentHost, onClose, onOpen, onReport = null }: { directoryUrl: string; currentHost: string | null; onClose: () => void; onOpen: ((host: string) => void) | null;
  /** Report a listed server to the directory's operator (docs/features/reports.md); null = not offered. */
  onReport?: ((host: string, name: string) => void) | null }) {
  const [servers, setServers] = useState<DirectoryServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirHost = new URL(directoryUrl).host;

  useEffect(() => {
    let alive = true;
    api.directoryServers(directoryUrl)
      .then((list) => { if (alive) setServers(list); })
      .catch((err) => { if (alive) setError(api.explainDirectoryError(err)); });
    return () => { alive = false; };
  }, [directoryUrl]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal browser-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{t("browser.title")}</h2><span className="spacer" />
          <button className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        <p className="muted small" style={{ padding: "0.6rem 1.25rem 0" }}>{t("browser.intro", { host: dirHost })}</p>
        {error && <p className="error small">{error}</p>}
        {servers === null && !error && <p className="muted center">{t("common.loading")}</p>}
        {servers && servers.length === 0 && <p className="muted center">{t("browser.empty")}</p>}
        {servers && servers.length > 0 && (
          <ul className="browser-list">
            {servers.map((s) => {
              const name = s.name ?? s.host;
              const current = s.host === currentHost;
              return (
                <li key={s.host} className="browser-item">
                  <RailEntry host={s.host} name={name} sub={null} iconUrl={directoryServerIconUrl(directoryUrl, s.host, s.iconUpdatedAt)} current={current} />
                  <div className="grow">
                    <strong>{name}</strong> <span className="muted small">{s.host}</span>
                    <p className="muted small">
                      {s.memberCount !== null && <>{t("login.memberCount", { n: s.memberCount })} · </>}
                      {s.openJoin ? t("browser.open") : t("browser.inviteOnly")}
                    </p>
                    {s.description && <p className="small">{s.description}</p>}
                  </div>
                  {onReport && <button className="icon" title={t("report.reportServer")} aria-label={t("report.reportServer")} onClick={() => onReport(s.host, name)}><Icon name="flag" /></button>}
                  {current ? <span className="muted small">{t("browser.thisServer")}</span> : onOpen ? <button onClick={() => onOpen(s.host)}>{t("common.open")}</button> : <a className="link-btn" href={directoryServerUrl(s.host)}>{t("common.open")}</a>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
