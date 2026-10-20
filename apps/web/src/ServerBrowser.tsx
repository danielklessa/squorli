import { directoryServerIconUrl, directoryServerUrl, type DirectoryServer } from "@squorli/protocol";
import { useEffect, useState, type FormEvent } from "react";
import * as api from "./api";
import { useBackClose } from "./backStack";
import { Icon } from "./Icon";
import { RailEntry } from "./ServerRail";
import { t } from "./i18n";
import { filterServers, typedAddress } from "./serverSearch";

/**
 * "Add a server" (the rail's one plus button since 14 October 2026, user's wish: the plus and the compass combined): one field
 * takes a server's address, an invite link or a squorli:// link, and filters the directory's published servers below it
 * (serverSearch.ts) at the same time; Enter opens the address. The list is the server directory of M6d: public
 * `GET /api/servers` of the directory (only servers that opt into listing); open = can be entered without an invite.
 * `onAdd` / `onOpen` (client without a home server: the desktop app) show the server inside the client; without them an
 * address and a listed server are opened in their own origin. Without a directory only the field is there.
 */
export function ServerBrowser({ directoryUrl, currentHost, onClose, onOpen, onAdd, onReport = null }: { directoryUrl: string | null; currentHost: string | null; onClose: () => void; onOpen: ((host: string) => void) | null;
  /** Show the typed server in the client; the promise gives an error text, null when it is shown (the caller closes the dialog then). */
  onAdd: ((input: string) => Promise<string | null>) | null;
  /** Report a listed server to the directory's operator (docs/features/reports.md); null = not offered. */
  onReport?: ((host: string, name: string) => void) | null }) {
  const [servers, setServers] = useState<DirectoryServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirHost = directoryUrl ? new URL(directoryUrl).host : null;
  useBackClose(onClose);

  useEffect(() => {
    if (!directoryUrl) return;
    let alive = true;
    api.directoryServers(directoryUrl)
      .then((list) => { if (alive) setServers(list); })
      .catch((err) => { if (alive) setError(api.explainDirectoryError(err)); });
    return () => { alive = false; };
  }, [directoryUrl]);

  const address = typedAddress(query);
  const shown = servers ? filterServers(servers, query) : null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!address || busy) return;
    if (!onAdd) { window.location.assign(`${directoryServerUrl(address.host)}${address.invite ? `/invite/${address.invite}` : ""}`); return; }
    setBusy(true); setAddError(null);
    const failed = await onAdd(query).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    setBusy(false);
    if (failed) setAddError(failed);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal browser-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{t("browser.title")}</h2><span className="spacer" />
          <button className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        <form className="browser-search" onSubmit={(event) => { void submit(event); }}>
          <input autoFocus value={query} maxLength={400} spellCheck={false} autoCapitalize="off" autoComplete="off"
            placeholder={t(directoryUrl ? "browser.placeholder" : "add.placeholder")} aria-label={t("browser.field")}
            onChange={(e) => { setQuery(e.target.value); setAddError(null); }} />
          <button type="submit" disabled={!address || busy}>{t(onAdd ? "add.confirm" : "common.open")}</button>
        </form>
        {addError ? <p className="error small browser-note">{addError}</p>
          : <p className="muted small browser-note">{address ? t("browser.addressHint", { host: address.host }) : t(directoryUrl ? "browser.hint" : "add.text")}</p>}
        {dirHost && <>
          <p className="muted small browser-note">{t("browser.intro", { host: dirHost })}</p>
          {error && <p className="error small browser-note">{error}</p>}
          {servers === null && !error && <p className="muted center">{t("common.loading")}</p>}
          {servers && servers.length === 0 && <p className="muted center">{t("browser.empty")}</p>}
          {servers && servers.length > 0 && shown?.length === 0 && !address && <p className="muted center">{t("browser.noMatch", { query: query.trim() })}</p>}
          {shown && shown.length > 0 && (
            <ul className="browser-list">
              {shown.map((s) => {
                const name = s.name ?? s.host;
                const current = s.host === currentHost;
                return (
                  <li key={s.host} className="browser-item">
                    <RailEntry host={s.host} name={name} sub={null} iconUrl={directoryServerIconUrl(directoryUrl!, s.host, s.iconUpdatedAt)} current={current} />
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
        </>}
      </div>
    </div>
  );
}
