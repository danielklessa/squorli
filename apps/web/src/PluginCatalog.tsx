import { pluginText, type PluginCatalogEntry, type PluginCatalogResponse } from "@squorli/protocol";
import { useCallback, useEffect, useState } from "react";
import type { ServerApi } from "./api";
import { pluginProblem, type PluginProblem } from "./apiErrorText";
import { Icon } from "./Icon";
import { fmtDay, locale, t } from "./i18n";
import { catalogDate, filterCatalog } from "./catalogSearch";
import { CapabilityList, PluginSignedBadge } from "./PluginDetail";
import { PluginProblemText } from "./PluginFormDialog";
import { safeHref } from "./safeHref";

/**
 * Verwaltung > Plugins > Katalog (docs/features/plugins.md): the signed plugins of the public repository squorli-plugins,
 * to search and to install with one click. The server fetches the list from GitHub, and only when somebody asks for it:
 * the section starts closed, behind a button that says so. Installing downloads the signed file to the server, which
 * checks its signature like any other; the plugin arrives switched off, and enabling goes through the confirmation.
 *
 * An entry's texts are its author's: text nodes only, like everything a plugin declares. `stamp` changes whenever the list
 * of installed plugins was read again, so an entry's state ("Installiert", "Aktualisieren") follows an installation.
 */
export function PluginCatalog({ api, mayInstall, busy, stamp, onInstall }: { api: ServerApi; mayInstall: boolean; busy: boolean; stamp: unknown; onInstall: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PluginCatalogResponse | null>(null);
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback((refresh: boolean) => {
    setLoading(true); setProblem(null);
    return api.pluginCatalog(refresh).then((r) => setData(r), (e) => setProblem(pluginProblem(e))).finally(() => setLoading(false));
  }, [api]);
  // Opened, and again after something was installed or removed: the server answers from its copy, GitHub is not asked again.
  useEffect(() => { if (open) void load(false); }, [open, load, stamp]);

  if (!open) {
    return (
      <>
        <h3>{t("admin.plugins.catalog")}</h3>
        <p className="muted small">{t("admin.plugins.catalogHint")}</p>
        <div className="row"><button className="secondary" onClick={() => setOpen(true)}><Icon name="search" /> {t("admin.plugins.catalogOpen")}</button></div>
      </>
    );
  }
  const all = data?.plugins ?? [];
  const shown = filterCatalog(all, query);
  return (
    <>
      <h3>{t("admin.plugins.catalog")}</h3>
      <p className="muted small">{t("admin.plugins.catalogHint")}</p>
      <div className="row plugin-catalog-tools">
        <input type="search" value={query} placeholder={t("admin.plugins.catalogSearch")} aria-label={t("admin.plugins.catalogSearch")} onChange={(e) => setQuery(e.target.value)} />
        <button className="icon" disabled={loading} title={t("admin.plugins.catalogReload")} aria-label={t("admin.plugins.catalogReload")} onClick={() => void load(true)}><Icon name="refresh-cw" /></button>
      </div>
      <PluginProblemText problem={problem} />
      {data?.stale && <p className="warn-box small">{t("admin.plugins.catalogStale")}</p>}
      {data === null && loading && <p className="muted">{t("common.loading")}</p>}
      {data && all.length === 0 && <p className="muted">{t("admin.plugins.catalogNone")}</p>}
      {data && all.length > 0 && shown.length === 0 && <p className="muted">{t("admin.plugins.catalogNoMatch", { query: query.trim() })}</p>}
      {shown.length > 0 && (
        <ul className="plugin-list">
          {shown.map((p) => <CatalogRow key={p.id} plugin={p} mayInstall={mayInstall} busy={busy || loading} onInstall={() => onInstall(p.id)} />)}
        </ul>
      )}
      {data && all.length > 0 && <span className="muted small">{shown.length === all.length ? t("admin.plugins.catalogCount", { n: all.length }) : t("admin.plugins.catalogCountOf", { shown: shown.length, n: all.length })}</span>}
    </>
  );
}

function CatalogRow({ plugin, mayInstall, busy, onInstall }: { plugin: PluginCatalogEntry; mayInstall: boolean; busy: boolean; onInstall: () => void }) {
  const source = safeHref(plugin.source);
  const signed = catalogDate(plugin.signedAt);
  return (
    <li className="plugin-row plugin-available plugin-catalog-row">
      <span className="user-avatar plugin-avatar" aria-hidden="true"><Icon name="puzzle" /></span>
      <div className="plugin-row-main">
        <span className="plugin-row-name"><strong>{pluginText(plugin.name, locale) || plugin.id}</strong> <span className="muted small">{plugin.version}</span> <PluginSignedBadge signature={plugin.signature} />{plugin.installedVersion && <span className="muted small">{t("admin.plugins.installedVersion", { version: plugin.installedVersion })}</span>}</span>
        <span className="muted small">{[plugin.author ? t("admin.plugins.catalogBy", { author: plugin.author }) : null, signed ? t("admin.plugins.catalogSignedAt", { date: fmtDay(signed) }) : null].filter(Boolean).join(" · ")}</span>
        <span className="small plugin-row-desc">{pluginText(plugin.description, locale)}</span>
        <details className="plugin-available-caps small"><summary>{t("admin.plugins.capabilitiesAsked", { n: plugin.capabilities.length })}</summary><CapabilityList capabilities={plugin.capabilities} /></details>
        {source && <a className="small" href={source} target="_blank" rel="noreferrer noopener">{t("admin.plugins.catalogSource")} <Icon name="external-link" /></a>}
      </div>
      {plugin.status === "installed" && <span className="muted small plugin-catalog-state"><Icon name="check" /> {t("admin.plugins.catalogInstalled")}</span>}
      {plugin.status === "needs_server" && <span className="muted small plugin-catalog-state">{t("admin.plugins.catalogNeedsServer")}</span>}
      {mayInstall && plugin.status === "new" && <button className="secondary" disabled={busy} onClick={onInstall}><Icon name="download" /> {t("admin.plugins.installOne")}</button>}
      {mayInstall && plugin.status === "update" && <button className="secondary" disabled={busy} onClick={onInstall}><Icon name="download" /> {t("admin.plugins.catalogUpdate", { version: plugin.version })}</button>}
      {/* A state of a later server: nothing to press, the entry is still there to read. */}
    </li>
  );
}
