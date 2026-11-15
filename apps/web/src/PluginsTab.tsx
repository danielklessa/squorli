import { PLUGIN_SOURCE_MAX_BYTES, PluginCapabilityInfo, pluginText, type PluginAvailable, type PluginInfo, type PluginText, type PluginsResponse, type ServerState } from "@squorli/protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, type ServerApi } from "./api";
import { pluginProblem, type PluginProblem } from "./apiErrorText";
import { useBackClose } from "./backStack";
import { Icon } from "./Icon";
import { fmtDateTime, locale, t } from "./i18n";
import { CapabilityList, PluginDetail, PluginSignedBadge, PluginStateBadge, blockedText, type CapabilityInfo } from "./PluginDetail";
import { PluginChrome, PluginProblemText } from "./PluginFormDialog";

/** The confirmation that is open: which plugin, and the capabilities the owner is shown (and that go out as `grant`). */
type EnableAsk = { id: string; name: PluginText; capabilities: CapabilityInfo[]; changed: boolean; signature: PluginInfo["signature"] };

/**
 * Verwaltung > Plugins (docs/features/plugins.md; shown with MANAGE_SERVER against a server that runs plugins): the
 * installed plugins with their state and switch, the plugins that ship with the server ("Verfügbar"), and the upload of a
 * plugin file. Installing, enabling, disabling and removing are an owner's (the server answers 403 `owner_only` to
 * anybody else), installing here only where the operator allows it (`mode` "owner"; otherwise the `squorli plugin` command).
 * **Enabling always goes through the confirmation** that lists what the plugin may do, in the server's plain words.
 */
export function PluginsTab({ api, server, myUserId }: { api: ServerApi; server: ServerState; myUserId: string }) {
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [ask, setAsk] = useState<EnableAsk | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const me = server.members.find((m) => m.userId === myUserId) ?? null;
  const isOwner = me?.isOwner ?? false;

  const load = useCallback(() => api.plugins().then((r) => setData(r), (e) => setProblem(pluginProblem(e))), [api]);
  // `server.plugins` is replaced whenever a plugin was enabled, disabled, updated or its settings saved (also by somebody
  // else, or by the operator's command): the list is read again then.
  useEffect(() => { void load(); }, [load, server.plugins]);

  const run = async (fn: () => Promise<unknown>) => {
    setProblem(null); setNote(null); setBusy(true);
    try { await fn(); } catch (e) { setProblem(pluginProblem(e)); } finally { setBusy(false); void load(); }
  };
  const install = (body: { source: string; fileName: string } | { bundled: string }) => run(async () => {
    const info = await api.installPlugin(body);
    setNote(t(info.enabled ? "admin.plugins.updatedNote" : "admin.plugins.installedNote", { name: pluginText(info.name, locale), version: info.version }));
  });
  const upload = (file: File) => run(async () => {
    // The server would answer a file past its limit with a bare "bad request": say what is wrong here.
    if (file.size > PLUGIN_SOURCE_MAX_BYTES) throw new ApiError("POST", "/api/plugins", 413, "plugin_too_large", {});
    const info = await api.installPlugin({ source: await file.text(), fileName: file.name });
    setNote(t(info.enabled ? "admin.plugins.updatedNote" : "admin.plugins.installedNote", { name: pluginText(info.name, locale), version: info.version }));
  });
  const askEnable = (p: PluginInfo) => { setProblem(null); setNote(null); setAsk({ id: p.id, name: p.name, capabilities: p.capabilities, changed: false, signature: p.signature }); };
  const disable = (p: PluginInfo) => run(() => api.setPluginEnabled(p.id, false));
  /** "Aktivieren": exactly the listed capabilities go out. Another list by now (409) = the confirmation again, with that list. */
  const confirmEnable = async (current: EnableAsk): Promise<PluginProblem | null> => {
    try {
      await api.setPluginEnabled(current.id, true, current.capabilities.map((c) => c.id));
      setAsk(null); void load();
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.code === "capabilities_changed") {
        const now = z.array(PluginCapabilityInfo).safeParse(e.body.capabilities);
        if (now.success) { setAsk({ ...current, capabilities: now.data, changed: true }); return null; }
      }
      return pluginProblem(e);
    }
  };

  const open = openId ? data?.plugins.find((p) => p.id === openId) ?? null : null;
  const dialog = ask && <PluginEnableDialog key={`${ask.id}:${ask.capabilities.map((c) => c.id).join(",")}`} ask={ask} onConfirm={() => confirmEnable(ask)} onClose={() => setAsk(null)} />;
  if (open) {
    return <>
      <PluginDetail api={api} server={server} me={me} plugin={open} isOwner={isOwner} busy={busy} onBack={() => setOpenId(null)} onEnable={() => askEnable(open)} onDisable={() => void disable(open)} onRemoved={() => { setOpenId(null); void load(); }} />
      <PluginProblemText problem={problem} />
      {dialog}
    </>;
  }
  const mayInstall = isOwner && data?.mode === "owner";
  return (
    <div className="stack plugins-tab">
      <h3>{t("admin.tab.plugins")}</h3>
      <p className="muted small">{t("admin.plugins.intro")}</p>
      {data && !isOwner && <p className="muted small"><Icon name="info" /> {t("admin.plugins.ownerOnly")}</p>}
      <PluginProblemText problem={problem} />
      {note && <p className="plugin-result" role="status"><Icon name="check" /> <span>{note}</span></p>}
      {data === null && !problem && <p className="muted">{t("common.loading")}</p>}
      {data && (data.plugins.length === 0 ? <p className="muted">{t("admin.plugins.none")}</p> : (
        <ul className="plugin-list">
          {data.plugins.map((p) => (
            <li key={p.id} className="plugin-row">
              <span className="user-avatar plugin-avatar" aria-hidden="true"><Icon name="puzzle" /></span>
              <button className="plugin-row-main" onClick={() => setOpenId(p.id)} title={t("admin.plugins.open")}>
                <span className="plugin-row-name"><strong>{pluginText(p.name, locale)}</strong> <span className="muted small">{p.version}</span> <PluginStateBadge state={p.state} /> <PluginSignedBadge signature={p.signature} /></span>
                <span className="muted small plugin-row-desc">{pluginText(p.description, locale)}</span>
                {p.enabled && p.blocked && blockedText(p.blocked)
                  ? <span className="small plugin-last-error">{blockedText(p.blocked)}</span>
                  : p.lastError && <span className="small plugin-last-error"><span className="error">{t("admin.plugins.lastError")}</span>{p.lastErrorAt ? ` (${fmtDateTime(p.lastErrorAt)})` : ""}: {p.lastError}</span>}
              </button>
              {isOwner && p.enabled && !p.blocked && (p.state === "needs_approval" || p.state === "suspended") && <button className="small" disabled={busy} onClick={() => askEnable(p)}>{t(p.state === "needs_approval" ? "admin.plugins.approve" : "admin.plugins.restart")}</button>}
              <input type="checkbox" className="switch" role="switch" aria-label={t("admin.plugins.enabledOf", { name: pluginText(p.name, locale) })} title={isOwner ? t("admin.plugins.enabled") : t("admin.plugins.ownerOnly")}
                checked={p.enabled} disabled={!isOwner || busy || (p.state === "incompatible" && !p.enabled)} onChange={(e) => (e.target.checked ? askEnable(p) : void disable(p))} />
              <button className="icon" title={t("admin.plugins.open")} aria-label={t("admin.plugins.open")} onClick={() => setOpenId(p.id)}><Icon name="chevron-right" /></button>
            </li>
          ))}
        </ul>
      ))}
      {data && <span className="muted small">{t("admin.plugins.count", { n: data.plugins.length, max: data.max })}</span>}

      {data && <>
        <h3>{t("admin.plugins.install")}</h3>
        {data.mode !== "owner" ? <p className="muted small">{t("admin.plugins.operatorOnly")}</p> : <>
          <p className="muted small">{t("admin.plugins.uploadHint")}</p>
          {mayInstall && <div className="row">
            <input ref={fileRef} type="file" accept=".js,.ts,text/javascript,application/javascript,text/typescript" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            <button className="secondary" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="upload" /> {t("admin.plugins.upload")}</button>
          </div>}
        </>}
        {data.available.length > 0 && <>
          <h3>{t("admin.plugins.available")}</h3>
          <span className="muted small">{t("admin.plugins.availableHint")}</span>
          <ul className="plugin-list">
            {data.available.map((a) => <AvailableRow key={a.id} plugin={a} mayInstall={mayInstall} busy={busy} onInstall={() => void install({ bundled: a.id })} />)}
          </ul>
        </>}
      </>}
      {dialog}
    </div>
  );
}

function AvailableRow({ plugin, mayInstall, busy, onInstall }: { plugin: PluginAvailable; mayInstall: boolean; busy: boolean; onInstall: () => void }) {
  return (
    <li className="plugin-row plugin-available">
      <span className="user-avatar plugin-avatar" aria-hidden="true"><Icon name="puzzle" /></span>
      <div className="plugin-row-main">
        <span className="plugin-row-name"><strong>{pluginText(plugin.name, locale)}</strong> <span className="muted small">{plugin.version}</span>{plugin.installedVersion && <span className="muted small"> · {t("admin.plugins.installedVersion", { version: plugin.installedVersion })}</span>} <PluginSignedBadge signature={plugin.signature} /></span>
        <span className="muted small plugin-row-desc">{pluginText(plugin.description, locale)}</span>
        <details className="plugin-available-caps small"><summary>{t("admin.plugins.capabilitiesAsked", { n: plugin.capabilities.length })}</summary><CapabilityList capabilities={plugin.capabilities} /></details>
      </div>
      {mayInstall && <button className="secondary" disabled={busy} onClick={onInstall}><Icon name="download" /> {t(plugin.installedVersion ? "admin.plugins.update" : "admin.plugins.installOne")}</button>}
    </li>
  );
}

/**
 * The step before a plugin runs: what it may do, every capability in the server's plain words, the far-reaching ones
 * marked. "Aktivieren" grants exactly this list. Also the way to start a plugin again that waits for a confirmation (an
 * update asked for more) or was suspended. Under the fixed chrome like every dialog a plugin causes.
 */
function PluginEnableDialog({ ask, onConfirm, onClose }: { ask: EnableAsk; onConfirm: () => Promise<PluginProblem | null>; onClose: () => void }) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<PluginProblem | null>(null);
  useBackClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const confirm = async () => { setBusy(true); setProblem(null); const p = await onConfirm(); setProblem(p); setBusy(false); };
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog plugin-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <PluginChrome name={ask.name}><button type="button" className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button></PluginChrome>
        <div className="dialog-body stack">
          <h2 id={titleId}>{t("admin.plugins.enableTitle", { name: pluginText(ask.name, locale) })}</h2>
          {ask.changed && <p className="warn-box small">{t("admin.plugins.enableChanged")}</p>}
          {ask.signature && <p className="small plugin-enable-signed"><PluginSignedBadge signature={ask.signature} /> <span className="muted">{ask.signature.kind === "official" ? t("admin.plugins.signedHint.official") : ask.signature.kind === "reviewed" ? t("admin.plugins.signedHint.reviewed") : t("admin.plugins.signedHint.other")}</span></p>}
          <p className="dialog-text">{t(ask.capabilities.length > 0 ? "admin.plugins.enableText" : "admin.plugins.enableTextNone")}</p>
          {ask.capabilities.length > 0 && <CapabilityList capabilities={ask.capabilities} />}
          <p className="muted small">{t("admin.plugins.enableAlways")}</p>
          <PluginProblemText problem={problem} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" autoFocus disabled={busy} onClick={() => void confirm()}>{t("admin.plugins.enable")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
