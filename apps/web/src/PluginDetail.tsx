import { PluginText, pluginText, type PluginInfo, type PluginLogEntry, type PluginSettingsResponse, type PluginViewResponse, type ServerState } from "@squorli/protocol";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, type ServerApi } from "./api";
import { pluginProblem, type PluginProblem } from "./apiErrorText";
import { askSelect } from "./dialogs";
import { Icon } from "./Icon";
import { fmtDateTime, locale, t, tOr } from "./i18n";
import { PluginForm, type PluginFormContext } from "./PluginForm";
import { PluginProblemText } from "./PluginFormDialog";
import { PluginTable } from "./PluginTable";
import { initialValues, submitValues } from "./pluginFields";
import { safeHref } from "./safeHref";
import { SaveButton } from "./SaveButton";

/** What the confirmation before enabling lists, and what a plugin's page shows: one capability with the server's own words. */
export type CapabilityInfo = PluginInfo["capabilities"][number];

/** "Läuft", "Aus", "Angehalten", ...: a state of a later server shows as it came. */
export function PluginStateBadge({ state }: { state: string }) {
  const known = ["running", "disabled", "suspended", "incompatible", "needs_approval"].includes(state);
  return <span className={`badge plugin-state plugin-state-${known ? state : "other"}`}>{tOr(`admin.plugins.state.${state}`, state)}</span>;
}

/** A plugin's capabilities in the server's plain words; one that reaches far is marked. `granted` adds what is in force. */
export function CapabilityList({ capabilities, granted = false }: { capabilities: readonly CapabilityInfo[]; granted?: boolean }) {
  if (capabilities.length === 0) return <p className="muted small">{t("admin.plugins.noCapabilities")}</p>;
  return (
    <ul className="plugin-caps">
      {capabilities.map((c) => (
        <li key={c.id} className={c.risk === "high" ? "plugin-cap high" : "plugin-cap"}>
          {c.risk === "high" ? <Icon name="triangle-alert" /> : <Icon name="check" />}
          <span>{pluginText(c.text, locale) || c.id}{c.risk === "high" && <span className="badge plugin-risk">{t("admin.plugins.riskHigh")}</span>}{granted && !c.granted && <span className="muted small"> · {t("admin.plugins.notGranted")}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One plugin in Verwaltung > Plugins (docs/features/plugins.md): what it is and who wrote it, what it may do, its
 * settings (the roles and channels picked there are all it may touch), its views, the tail of its log, and removing it.
 * Everything the plugin supplies is data drawn by the client's own components; its texts are plain text.
 */
export function PluginDetail({ api, server, me, plugin, isOwner, busy, onBack, onEnable, onDisable, onRemoved }: {
  api: ServerApi; server: ServerState; me: PluginFormContext["me"]; plugin: PluginInfo; isOwner: boolean; busy: boolean;
  onBack: () => void; onEnable: () => void; onDisable: () => void; onRemoved: () => void;
}) {
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const name = pluginText(plugin.name, locale);
  const href = safeHref(plugin.homepage);
  const running = plugin.state === "running";
  const context: PluginFormContext = { roles: server.roles, channels: server.channels, members: server.members, me };
  const remove = async () => {
    const choice = await askSelect({
      title: t("admin.plugins.removeTitle", { name }), text: t("admin.plugins.removeText"), initial: "keep", confirmLabel: t("admin.plugins.remove"), danger: true,
      options: [{ value: "keep", label: t("admin.plugins.removeKeep") }, { value: "delete", label: t("admin.plugins.removeDelete") }],
    });
    if (choice !== "keep" && choice !== "delete") return;
    setProblem(null);
    try { await api.removePlugin(plugin.id, choice); onRemoved(); } catch (e) { setProblem(pluginProblem(e)); }
  };
  return (
    <div className="stack plugin-detail">
      <div className="row plugin-detail-head">
        <button className="secondary small" onClick={onBack}><Icon name="arrow-left" /> {t("admin.plugins.back")}</button>
      </div>
      <div className="plugin-title">
        <span className="user-avatar plugin-avatar" aria-hidden="true"><Icon name="puzzle" /></span>
        <div className="plugin-title-text"><strong>{name}</strong><span className="muted small">{t("admin.plugins.version", { version: plugin.version })} · {plugin.id}</span></div>
        <PluginStateBadge state={plugin.state} />
        <span className="spacer" />
        <label className="check" title={isOwner ? undefined : t("admin.plugins.ownerOnly")}>
          <input type="checkbox" className="switch" role="switch" checked={plugin.enabled} disabled={!isOwner || busy || (plugin.state === "incompatible" && !plugin.enabled)} onChange={(e) => (e.target.checked ? onEnable() : onDisable())} />
          {t("admin.plugins.enabled")}
        </label>
      </div>
      <p className="plugin-description">{pluginText(plugin.description, locale)}</p>
      {plugin.enabled && (plugin.state === "needs_approval" || plugin.state === "suspended") && (
        <div className="warn-box stack">
          <span>{t(plugin.state === "needs_approval" ? "admin.plugins.needsApprovalText" : "admin.plugins.suspendedText")}</span>
          {isOwner && <div><button disabled={busy} onClick={onEnable}>{t(plugin.state === "needs_approval" ? "admin.plugins.approve" : "admin.plugins.restart")}</button></div>}
        </div>
      )}
      {plugin.state === "incompatible" && <p className="warn-box">{t("admin.plugins.incompatibleText")}</p>}
      {plugin.lastError && <p className="small plugin-last-error"><span className="error">{t("admin.plugins.lastError")}</span>{plugin.lastErrorAt ? ` (${fmtDateTime(plugin.lastErrorAt)})` : ""}: <code>{plugin.lastError}</code></p>}
      <PluginProblemText problem={problem} />
      <table className="limits-table plugin-meta">
        <tbody>
          {plugin.author && <tr><td>{t("admin.plugins.author")}</td><td>{plugin.author}</td></tr>}
          {plugin.homepage && <tr><td>{t("admin.plugins.homepage")}</td><td>{href ? <a href={href} target="_blank" rel="noreferrer noopener">{plugin.homepage}</a> : <span className="muted">{plugin.homepage}</span>}</td></tr>}
          <tr><td>{t("admin.plugins.installed")}</td><td>{fmtDateTime(plugin.installedAt)} · {tOr(`admin.plugins.via.${plugin.installedVia}`, plugin.installedVia)}{fmtDateTime(plugin.updatedAt) !== fmtDateTime(plugin.installedAt) ? ` · ${t("admin.plugins.updated", { at: fmtDateTime(plugin.updatedAt) })}` : ""}</td></tr>
          <tr><td>{t("admin.plugins.file")}</td><td>{plugin.language === "ts" ? "TypeScript" : plugin.language === "js" ? "JavaScript" : plugin.language} · <code title={plugin.sourceHash}>SHA-256 {plugin.sourceHash.slice(0, 16)}…</code></td></tr>
          {plugin.commands.length > 0 && <tr><td>{t("admin.plugins.commands")}</td><td>{plugin.commands.map((c) => <code key={c} className="plugin-command-name">/{c}</code>)}</td></tr>}
          {plugin.pendingJobs > 0 && <tr><td>{t("admin.plugins.pendingJobs")}</td><td>{plugin.pendingJobs}</td></tr>}
        </tbody>
      </table>

      <h3>{t("admin.plugins.capabilities")}</h3>
      <CapabilityList capabilities={plugin.capabilities} granted={plugin.enabled} />

      {plugin.hasSettings && <PluginSettings api={api} plugin={plugin} context={context} />}
      {plugin.views.map((v) => <PluginViewSection key={v.id} api={api} pluginId={plugin.id} viewId={v.id} title={pluginText(v.title, locale)} running={running} server={server} />)}
      <PluginLog api={api} pluginId={plugin.id} stamp={`${plugin.state}:${plugin.updatedAt}:${plugin.lastErrorAt ?? ""}`} />

      {isOwner && <>
        <h3>{t("admin.plugins.removeHeading")}</h3>
        <span className="muted small">{t("admin.plugins.removeHint")}</span>
        <div className="row"><button className="danger" disabled={busy} onClick={() => void remove()}><Icon name="trash-2" /> {t("admin.plugins.remove")}</button></div>
      </>}
    </div>
  );
}

/** The plugin's settings: the fields of its manifest. Saving checks the roles and channels against the saving admin's rank on the server. */
function PluginSettings({ api, plugin, context }: { api: ServerApi; plugin: PluginInfo; context: PluginFormContext }) {
  const [data, setData] = useState<PluginSettingsResponse | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, PluginText>>({});
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  const adopt = (r: PluginSettingsResponse) => { setData(r); setValues({ ...initialValues(r.fields), ...r.values }); setDirty(false); };
  useEffect(() => {
    let stale = false;
    api.pluginSettings(plugin.id).then((r) => { if (!stale) adopt(r); }, (e) => { if (!stale) setProblem(pluginProblem(e)); });
    return () => { stale = true; };
  }, [api, plugin.id, plugin.version]);
  const save = async () => {
    if (!data) return;
    setProblem(null); setErrors({});
    try { adopt(await api.savePluginSettings(plugin.id, submitValues(data.fields, values))); } catch (e) {
      // The server names the fields it refused, each with a text in both languages.
      const named = e instanceof ApiError && e.code === "invalid_values" ? z.record(z.string(), PluginText).safeParse(e.body.fieldErrors) : null;
      if (named?.success) setErrors(named.data);
      setProblem(pluginProblem(e));
      throw e;
    }
  };
  return (
    <>
      <h3>{t("admin.plugins.settings")}</h3>
      <span className="muted small">{t("admin.plugins.settingsHint")}</span>
      {data === null && !problem && <p className="muted">{t("common.loading")}</p>}
      {data && <PluginForm fields={data.fields} values={values} errors={errors} context={context} settings onChange={(key, v) => { setValues((cur) => ({ ...cur, [key]: v })); setDirty(true); }} />}
      <PluginProblemText problem={problem} />
      {data && <SaveButton disabled={!dirty} onSave={save} />}
    </>
  );
}

/** One of the plugin's tables. Only a running plugin can fill it: its handler is asked each time. */
function PluginViewSection({ api, pluginId, viewId, title, running, server }: { api: ServerApi; pluginId: string; viewId: string; title: string; running: boolean; server: ServerState }) {
  const [view, setView] = useState<PluginViewResponse | null>(null);
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setProblem(null);
    try { setView(await api.pluginView(pluginId, viewId)); } catch (e) { setProblem(pluginProblem(e)); } finally { setLoading(false); }
  }, [api, pluginId, viewId]);
  useEffect(() => { if (running) void load(); }, [load, running]);
  return (
    <>
      <h3 className="plugin-section-head"><span>{title}</span><button className="icon" title={t("admin.plugins.reload")} aria-label={t("admin.plugins.reload")} disabled={!running || loading} onClick={() => void load()}><Icon name="refresh-cw" /></button></h3>
      {!running ? <p className="muted small">{t("admin.plugins.viewNotRunning")}</p> : view ? <PluginTable view={view} members={server.members} roles={server.roles} channels={server.channels} /> : !problem && <p className="muted">{t("common.loading")}</p>}
      <PluginProblemText problem={problem} />
    </>
  );
}

/** The newest lines of the plugin's log: what the server noted about it (roles given, failures) and what it wrote itself. */
function PluginLog({ api, pluginId, stamp }: { api: ServerApi; pluginId: string; stamp: string }) {
  const [log, setLog] = useState<{ entries: PluginLogEntry[]; hasMore: boolean } | null>(null);
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setProblem(null);
    try { setLog(await api.pluginLog(pluginId, null)); } catch (e) { setProblem(pluginProblem(e)); } finally { setLoading(false); }
  }, [api, pluginId]);
  useEffect(() => { void load(); }, [load, stamp]);
  const older = async () => {
    const last = log?.entries[log.entries.length - 1];
    if (!last) return;
    setLoading(true); setProblem(null);
    try { const next = await api.pluginLog(pluginId, last.id); setLog({ entries: [...(log?.entries ?? []), ...next.entries], hasMore: next.hasMore }); } catch (e) { setProblem(pluginProblem(e)); } finally { setLoading(false); }
  };
  return (
    <>
      <h3 className="plugin-section-head"><span>{t("admin.plugins.log")}</span><button className="icon" title={t("admin.plugins.reload")} aria-label={t("admin.plugins.reload")} disabled={loading} onClick={() => void load()}><Icon name="refresh-cw" /></button></h3>
      <span className="muted small">{t("admin.plugins.logHint")}</span>
      {log === null && !problem && <p className="muted">{t("common.loading")}</p>}
      {log?.entries.length === 0 && <p className="muted small">{t("admin.plugins.logEmpty")}</p>}
      {log && log.entries.length > 0 && (
        <div className="plugin-log">
          {log.entries.map((e) => (
            <div key={e.id} className={`plugin-log-line level-${e.level === "warn" || e.level === "error" ? e.level : "info"}`}>
              <time className="muted" dateTime={e.at}>{fmtDateTime(e.at)}</time>
              <span className="plugin-log-who">{tOr(`admin.plugins.logSource.${e.source}`, e.source)} · {tOr(`admin.plugins.logLevel.${e.level}`, e.level)}</span>
              <span className="plugin-log-text">{e.text}</span>
            </div>
          ))}
        </div>
      )}
      <PluginProblemText problem={problem} />
      {log?.hasMore && <div><button className="secondary small" disabled={loading} onClick={() => void older()}>{t("admin.plugins.logOlder")}</button></div>}
    </>
  );
}
