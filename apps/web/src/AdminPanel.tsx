import { PERMISSION_GROUPS, PRIVACY_POLICY_URL_MAX, Permission, PrivacyPolicyUrl, hasPermission, type Ban, type DoctorReport, type DoctorStatus, type Invite, type LimitsReport, type PermissionName, type Role, type ServerState, type StatusApiMode } from "@squorli/protocol";
import { useEffect, useRef, useState } from "react";
import type { ServerApi } from "./api";
import { askConfirm } from "./dialogs";
import { roleOrder } from "./roleOrder";
import { rolesByRank } from "./memberRank";
import { ChannelsTab } from "./ChannelsTab";
import type { ChannelDialogTarget } from "./ChannelDialog";
import { CopyButton } from "./CopyButton";
import { SaveButton } from "./SaveButton";
import { formatDeepLink, parseDeepLink } from "./platform/deepLink";
import { RadioTab } from "./RadioTab";
import { ImportTab } from "./ImportTab";
import { ReportsTab } from "./ReportsTab";
import { ReactionRolesTab } from "./ReactionRolesTab";
import { Icon } from "./Icon";
import { fmtDateTime, locale, t } from "./i18n";
import { runMediaCheck, type MediaCheckResult } from "./doctorMedia";

type Tab = "server" | "channels" | "radio" | "roles" | "reactionRoles" | "invites" | "bans" | "reports" | "import";

/** Admin area: server, categories/channels, radio stations, roles, invites, bans. Changes come back via the structure event. */
export function AdminPanel({ api, server, myUserId, directoryUrl, onClose, onEditChannel }: { api: ServerApi; server: ServerState; myUserId: string; directoryUrl: string | null; onClose: () => void; onEditChannel: (target: ChannelDialogTarget) => void }) {
  const p = server.myPermissions;
  const [mobileFocus] = useState(() => window.matchMedia("(max-width: 700px), (pointer: coarse)").matches);
  const allTabs: { id: Tab; label: string; icon: string; ok: boolean }[] = [
    { id: "server", label: t("admin.tab.server"), icon: "server", ok: hasPermission(p, Permission.MANAGE_SERVER) },
    { id: "channels", label: t("admin.tab.channels"), icon: "hash", ok: hasPermission(p, Permission.MANAGE_CHANNELS) },
    // Only against a server that knows the radio (older servers send no station list).
    { id: "radio", label: t("admin.tab.radio"), icon: "radio", ok: hasPermission(p, Permission.MANAGE_SERVER) && server.radioStations !== undefined },
    { id: "roles", label: t("admin.tab.roles"), icon: "shield", ok: hasPermission(p, Permission.MANAGE_ROLES) },
    // Reaction roles (docs/features/reactions.md): only against a server that does reactions (the flag).
    { id: "reactionRoles", label: t("admin.tab.reactionRoles"), icon: "shield-plus", ok: hasPermission(p, Permission.MANAGE_ROLES) && server.reactions === true },
    { id: "invites", label: t("admin.tab.invites"), icon: "link", ok: hasPermission(p, Permission.CREATE_INVITES) },
    { id: "bans", label: t("admin.tab.bans"), icon: "ban", ok: hasPermission(p, Permission.BAN_MEMBERS) },
    // Reports (docs/features/reports.md): only against a server that takes them (the count field is the flag).
    { id: "reports", label: t("admin.tab.reports"), icon: "flag", ok: hasPermission(p, Permission.MANAGE_REPORTS) && server.openReports !== undefined },
    // Import of a Discord template: creates channels and roles, so both rights; only against a server that offers the source.
    { id: "import", label: t("admin.tab.import"), icon: "import", ok: hasPermission(p, Permission.MANAGE_CHANNELS) && hasPermission(p, Permission.MANAGE_ROLES) && (server.importSources?.includes("discord-template") ?? false) },
  ];
  const tabs = allTabs.filter((t) => t.ok);
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? "invites");
  const [err, setErr] = useState<string | null>(null);
  // The error goes to the panel's line, and on to the caller (SaveButton says "Nicht gespeichert" then); other callers ignore the rejection.
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(String(e)); } };
  /** Like run(), but the caller learns about the failure too (SaveButton says "Nicht gespeichert" then). */
  const save = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (e) { setErr(String(e)); throw e; } };

  return (
    <div className="modal-backdrop admin-backdrop" onClick={onClose}>
      <div className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="admin-title">{t("admin.title")}</h2><span className="spacer" />
          <button className="icon" autoFocus={mobileFocus} onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        {/* categories always on the left (as the user specified for all categorized modals) */}
        <div className="settings-layout">
          <nav className="settings-nav">
            {tabs.map((t) => <button key={t.id} className={tab === t.id ? "active" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => { setTab(t.id); setErr(null); }}><Icon name={t.icon} /> <span>{t.label}</span>{t.id === "reports" && (server.openReports ?? 0) > 0 && <span className="nav-badge">{server.openReports}</span>}</button>)}
          </nav>
          <div className="settings-body">
            {err && <p className="error">{err}</p>}
            {tab === "server" && <ServerTab api={api} server={server} directoryUrl={directoryUrl} run={run} save={save} />}
            {tab === "channels" && <ChannelsTab api={api} server={server} run={run} onEdit={onEditChannel} />}
            {tab === "radio" && <RadioTab api={api} server={server} run={run} />}
            {tab === "roles" && <RolesTab api={api} server={server} myUserId={myUserId} run={run} save={save} />}
            {tab === "reactionRoles" && <ReactionRolesTab api={api} server={server} run={run} />}
            {tab === "invites" && <InvitesTab api={api} run={run} canManage={hasPermission(p, Permission.MANAGE_SERVER)} />}
            {tab === "bans" && <BansTab api={api} run={run} />}
            {tab === "reports" && <ReportsTab api={api} myPermissions={p} run={run} openCount={server.openReports ?? 0} />}
            {tab === "import" && <ImportTab api={api} server={server} run={run} />}
          </div>
        </div>
      </div>
    </div>
  );
}

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;

function ServerTab({ api, server, directoryUrl, run, save }: { api: ServerApi; server: ServerState; directoryUrl: string | null; run: RunFn; save: RunFn }) {
  const [name, setName] = useState(server.settings.name);
  const [description, setDescription] = useState(server.settings.description ?? "");
  const [privacyUrl, setPrivacyUrl] = useState(server.settings.privacyPolicyUrl ?? "");
  const privacyValid = !privacyUrl.trim() || PrivacyPolicyUrl.safeParse(privacyUrl).success;
  const owners = server.members.filter((m) => m.isOwner);
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="stack">
      <label className="stack">{t("admin.serverName")}<input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} /></label>
      <SaveButton disabled={name.trim() === server.settings.name || !name.trim()} onSave={() => save(() => api.updateSettings({ name: name.trim() }))} />
      <label className="check">
        <input type="checkbox" checked={server.settings.openJoin} onChange={(e) => run(() => api.updateSettings({ openJoin: e.target.checked }))} />
        {t("admin.openJoin")}
      </label>
      {/* Server accounts (docs/features/local-accounts.md): a server from before them does not send the field. */}
      {server.settings.localAccounts !== undefined && <>
        <label className="check">
          <input type="checkbox" checked={server.settings.localAccounts} disabled={server.settings.localAccountsLocked === true} onChange={(e) => run(() => api.updateSettings({ localAccounts: e.target.checked }))} />
          {t("admin.localAccounts")}
        </label>
        <span className="muted small">{t(!directoryUrl ? "admin.localAccountsNoDirectory" : server.settings.localAccountsLocked ? "admin.localAccountsLocked" : "admin.localAccountsHint")}</span>
      </>}
      {/* Suspended directory accounts (docs/features/reports.md): a server from before it, or one without a directory, does not send the field. */}
      {server.settings.refuseSuspended !== undefined && <>
        <label className="check">
          <input type="checkbox" checked={server.settings.refuseSuspended} onChange={(e) => run(() => api.updateSettings({ refuseSuspended: e.target.checked }))} />
          {t("admin.refuseSuspended")}
        </label>
        <span className="muted small">{t("admin.refuseSuspendedHint")}</span>
      </>}
      {/* The server's privacy policy (docs/features/local-accounts.md): linked under the form for a new server account; a server from before it does not send the field. */}
      {server.settings.privacyPolicyUrl !== undefined && <>
        <label className="stack">{t("admin.privacyPolicyUrl")}
          <input type="url" value={privacyUrl} maxLength={PRIVACY_POLICY_URL_MAX} placeholder="https://" autoCapitalize="none" spellCheck={false} onChange={(e) => setPrivacyUrl(e.target.value)} aria-describedby="admin-privacy-hint" />
          {!privacyValid && <small className="error">{t("admin.privacyPolicyUrlInvalid")}</small>}
        </label>
        <SaveButton disabled={!privacyValid || (privacyUrl.trim() || null) === server.settings.privacyPolicyUrl} onSave={() => save(() => api.updateSettings({ privacyPolicyUrl: privacyUrl.trim() || null }))} />
        <span id="admin-privacy-hint" className="muted small">{t("admin.privacyPolicyUrlHint")}</span>
      </>}
      <h3>{t("admin.directoryHeading")}</h3>
      <label className="check">
        <input type="checkbox" checked={server.settings.listed} disabled={!directoryUrl} onChange={(e) => run(() => api.updateSettings({ listed: e.target.checked }))} />
        {t("admin.listed")}
      </label>
      <label className="stack">{t("admin.description")}<textarea value={description} maxLength={200} rows={3} disabled={!directoryUrl} placeholder={t("admin.descriptionPlaceholder")} onChange={(e) => setDescription(e.target.value)} /></label>
      <SaveButton disabled={!directoryUrl || (description.trim() || null) === server.settings.description} onSave={() => save(() => api.updateSettings({ description: description.trim() || null }))} label={t("admin.saveDescription")} />
      {!directoryUrl && <span className="muted small">{t("admin.noDirectoryListing")}</span>}
      <h3>{t("admin.iconHeading")}</h3>
      <div className="row">
        <img className="server-icon-preview" src={server.settings.iconUrl ? api.abs(server.settings.iconUrl) : "/brand/squorli-icon-small.svg"} alt="" width="48" height="48" />
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(() => api.uploadServerIcon(f)); }} />
        <button className="secondary" onClick={() => fileRef.current?.click()}>{t("admin.uploadIcon")}</button>
        {server.settings.iconUrl && <button className="secondary" onClick={() => run(() => api.deleteServerIcon())}>{t("common.remove")}</button>}
      </div>
      <span className="muted small">{t("admin.iconHint")}</span>
      {server.settings.statusApi !== undefined && <StatusApiSection api={api} mode={server.settings.statusApi} roleId={server.settings.statusApiRoleId ?? null} roles={server.roles} run={run} />}
      {server.settings.doctor && <DoctorSection api={api} run={run} />}
      {server.settings.limits && <LimitsSection api={api} run={run} />}
      <h3>{t("admin.ownersHeading")}</h3>
      <p className="muted small">{owners.map((o) => o.displayName).join(", ") || "–"}. {t("admin.ownersHint")}</p>
    </div>
  );
}

/**
 * Status API (docs/features/status-api.md): off, with the server's key, or public. The key is fetched only here (never part
 * of the settings every member gets) and shown with a copy button; "Neu erzeugen" replaces it at once.
 */
function StatusApiSection({ api, mode, roleId, roles, run }: { api: ServerApi; mode: StatusApiMode; roleId: string | null; roles: Role[]; run: RunFn }) {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => { if (mode === "key") void api.getStatusApiKey().then((r) => setKey(r.key)).catch(() => setKey(null)); }, [api, mode]);
  const url = `${api.base || window.location.origin}/api/status`;
  const modes: StatusApiMode[] = ["off", "key", "public"];
  // Whose view the answer carries: the default role ("Gast") is a plain visitor, any other role sees what that role sees.
  // A role with ADMINISTRATOR would expose every private channel, so it is said out loud instead of being hidden.
  const defaultRole = roles.find((r) => r.isDefault) ?? null;
  const chosen = roleId ? roles.find((r) => r.id === roleId) ?? null : defaultRole;
  const showsEverything = !!chosen && hasPermission(chosen.permissions, Permission.ADMINISTRATOR);
  const byRank = rolesByRank(roles);
  return (
    <>
      <h3>{t("admin.statusApiHeading")}</h3>
      <span className="muted small">{t("admin.statusApiHint")}</span>
      <div className="stack">
        {modes.map((m) => (
          <label key={m} className="check">
            <input type="radio" name="status-api" checked={mode === m} onChange={() => run(() => api.updateSettings({ statusApi: m }))} />
            {t(`admin.statusApi.${m}`)}
          </label>
        ))}
      </div>
      {mode !== "off" && (
        <div className="row">
          <code className="status-api-url">{url}</code>
          <CopyButton text={url} label={t("common.copy")} className="secondary" />
        </div>
      )}
      {mode === "key" && (
        <>
          <div className="row">
            <code className="status-api-key">{key ?? "…"}</code>
            {key && <CopyButton text={key} label={t("common.copy")} title={t("common.copy")} className="secondary" />}
            <button className="secondary" onClick={() => run(async () => { const ok = await askConfirm({ title: t("admin.statusApiRegenerateTitle"), text: t("admin.statusApiRegenerateText"), confirmLabel: t("admin.statusApiRegenerate") }); if (ok) setKey((await api.regenerateStatusApiKey()).key); })}>{t("admin.statusApiRegenerate")}</button>
          </div>
          <span className="muted small">{t("admin.statusApiKeyHint")}</span>
        </>
      )}
      {mode !== "off" && (
        <>
          <label>{t("admin.statusApiRole")}
            <select value={roleId ?? ""} onChange={(e) => run(() => api.updateSettings({ statusApiRoleId: e.target.value || null }))}>
              <option value="">{defaultRole ? t("admin.statusApiRoleDefault", { name: defaultRole.name }) : t("admin.statusApiRoleDefaultPlain")}</option>
              {byRank.filter((r) => !r.isDefault).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></label>
          <span className="muted small">{t("admin.statusApiRoleHint")}</span>
          {showsEverything && <span className="warn-box small" role="status">{t("admin.statusApiRoleAdmin", { name: chosen?.name ?? "" })}</span>}
        </>
      )}
      {mode === "public" && <span className="muted small">{t("admin.statusApiPublicHint")}</span>}
    </>
  );
}

/**
 * Setup check (docs/features/doctor.md): the server's report (its own address, LiveKit, the directory, and the directory's view
 * from outside) with texts in the client's language, plus the browser's own media connection, which is the UDP check.
 */
/**
 * Operator limits (docs/features/limits.md): what the server's configuration bounds it to (STORAGE_QUOTA_MB, VOICE_SEATS_MAX,
 * MEMBER_MAX, MAX_UPLOAD_MB) and how much of that is in use. Read only: the values come from the environment, so nothing
 * here can change them; a limit that is not set shows as unlimited. Fetched only here (MANAGE_SERVER).
 */
function LimitsSection({ api, run }: { api: ServerApi; run: RunFn }) {
  const [report, setReport] = useState<LimitsReport | null>(null);
  useEffect(() => { let stale = false; void api.limits().then((r) => { if (!stale) setReport(r); }).catch(() => {}); return () => { stale = true; }; }, [api]);
  const mb = (bytes: number) => { const v = bytes / 1024 / 1024; return v < 10 ? v.toFixed(1) : String(Math.round(v)); };
  const cell = (used: string, max: number | null, unit: string) => {
    const label = max === null ? `${used}${unit} · ${t("admin.limitsUnlimited")}` : t("admin.limitsOf", { used: `${used}${unit}`, max: `${max}${unit}` });
    return <span className={max !== null && Number(used) >= max ? "warn" : "muted"}>{label}</span>;
  };
  return <>
    <h3>{t("admin.limitsHeading")}</h3>
    {report && <table className="limits-table">
      <tbody>
        <tr><td>{t("admin.limitsStorage")}</td><td>{cell(mb(report.storage.usedBytes), report.storage.quotaMb, " MB")}</td></tr>
        <tr><td>{t("admin.limitsVoiceSeats")}</td><td>{cell(String(report.voiceSeats.used), report.voiceSeats.max, "")}</td></tr>
        <tr><td>{t("admin.limitsMembers")}</td><td>{cell(String(report.members.count), report.members.max, "")}</td></tr>
        <tr><td>{t("admin.limitsUpload")}</td><td><span className="muted">{report.maxUploadMb} MB</span></td></tr>
      </tbody>
    </table>}
    <span className="muted small">{t("admin.limitsHint")}</span>
    <div className="row"><button className="secondary" onClick={() => run(async () => setReport(await api.limits()))}>{t("admin.limitsRefresh")}</button></div>
  </>;
}

function DoctorSection({ api, run }: { api: ServerApi; run: RunFn }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [media, setMedia] = useState<MediaCheckResult | "running" | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => run(async () => {
    setBusy(true); setReport(null); setMedia("running");
    try {
      const [r, m] = await Promise.all([api.doctor(), runMediaCheck(api).catch((e): MediaCheckResult => ({ kind: "signal-failed", error: String(e), ms: 0 }))]);
      setReport(r); setMedia(m);
    } catch (e) { setMedia(null); throw e; } finally { setBusy(false); }
  });
  // Literal <Icon name> per state: tools/icons.mjs collects the names it finds in the source, a name inside a record stays out of the font.
  const statusIcon = (s: DoctorStatus) => s === "ok" ? <Icon name="check" /> : s === "warn" ? <Icon name="triangle-alert" /> : s === "fail" ? <Icon name="x" /> : <Icon name="minus" />;
  const mediaLine = (m: MediaCheckResult, r: DoctorReport | null): { status: DoctorStatus; text: string } => {
    const ports = { tcp: r?.mediaPorts.tcp ?? 7881, udp: r?.mediaPorts.udp ?? 7882 };
    switch (m.kind) {
      case "ok": return { status: "ok", text: t("admin.doctorMedia.ok", { address: m.path.address, port: m.path.port ?? "?", ms: m.ms }) };
      case "tcp-only": return { status: "warn", text: t("admin.doctorMedia.tcpOnly", { address: m.path.address, port: m.path.port ?? "?", ms: m.ms, udp: ports.udp }) };
      case "relay": return { status: "warn", text: t("admin.doctorMedia.relay", { address: m.path.address, ms: m.ms }) };
      case "private-address": return { status: "warn", text: t("admin.doctorMedia.private", { address: m.path.address }) };
      case "connected-unknown": return { status: "ok", text: t("admin.doctorMedia.unknown", { ms: m.ms }) };
      case "media-failed": return { status: "fail", text: t("admin.doctorMedia.mediaFailed", { ...ports, error: m.error }) };
      case "not-allowed": return { status: "fail", text: t("admin.doctorMedia.notAllowed", { error: m.error }) };
      case "signal-failed": return { status: "fail", text: t("admin.doctorMedia.signalFailed", { url: r?.livekitPublicUrl ?? "LiveKit", error: m.error }) };
    }
  };
  const ml = media && media !== "running" ? mediaLine(media, report) : null;
  return (
    <>
      <h3>{t("admin.doctorHeading")}</h3>
      <span className="muted small">{t("admin.doctorHint")}</span>
      <div className="row"><button className="secondary" disabled={busy} onClick={start}>{busy ? t("admin.doctorRunning") : t("admin.doctorRun")}</button></div>
      {report && (
        <>
          <h4 className="doctor-sub">{t("admin.doctorServerHeading")}</h4>
          <ul className="doctor-list" role="status">
            {report.checks.map((c) => (
              <li key={c.id} className={`doctor-${c.status}`}>{statusIcon(c.status)}<span>{c.text[locale]}{c.detail && <span className="muted small"> ({c.detail})</span>}</span></li>
            ))}
          </ul>
        </>
      )}
      {media && (
        <>
          <h4 className="doctor-sub">{t("admin.doctorBrowserHeading")}</h4>
          <ul className="doctor-list" role="status">
            {media === "running"
              ? <li className="doctor-skip"><Icon name="minus" /><span>{t("admin.doctorMedia.running")}</span></li>
              : <li className={`doctor-${ml!.status}`}>{statusIcon(ml!.status)}<span>{ml!.text}</span></li>}
          </ul>
        </>
      )}
      {report && <span className="muted small">{t("admin.doctorFooter", { tcp: report.mediaPorts.tcp, udp: report.mediaPorts.udp, url: report.livekitPublicUrl })}</span>}
    </>
  );
}

function RolesTab({ api, server, myUserId, run, save }: { api: ServerApi; server: ServerState; myUserId: string; run: RunFn; save: RunFn }) {
  const [sel, setSel] = useState<string | null>(server.roles.find((r) => !r.isDefault)?.id ?? server.roles[0]?.id ?? null);
  const [combo, setCombo] = useState(false);
  const [newName, setNewName] = useState("");
  const role = server.roles.find((r) => r.id === sel) ?? null;
  const [name, setName] = useState(role?.name ?? "");
  const [color, setColor] = useState(role?.color ?? "#888888");
  const [perms, setPerms] = useState(role?.permissions ?? 0);

  useEffect(() => { setName(role?.name ?? ""); setColor(role?.color ?? "#888888"); setPerms(role?.permissions ?? 0); }, [role?.id, role?.name, role?.color, role?.permissions]);
  // Active permissions in the same order as the groups below.
  const active: PermissionName[] = PERMISSION_GROUPS.flatMap((g) => [...g.permissions]).filter((n) => (perms & Permission[n]) !== 0);
  const sorted = rolesByRank(server.roles);
  const me = server.members.find((m) => m.userId === myUserId);
  const ceiling = me?.isOwner || server.settings.ownerId === myUserId ? Infinity : Math.max(0, ...server.roles.filter((r) => me?.roleIds.includes(r.id)).map((r) => r.position));
  const editable = sorted.filter((r) => !r.isDefault && r.position < ceiling);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const reorder = (id: string, target: string, after: boolean) => {
    if (busy.current) return;
    const changes = roleOrder(server.roles, id, target, after, ceiling);
    if (!changes) { setNotice(t("admin.roleOrderSpace")); return; }
    if (!changes.length) return;
    busy.current = true; setSaving(true); setNotice("");
    void run(async () => {
      try {
        for (const patch of changes) await api.updateRole(patch.id, { position: patch.position });
        setNotice(t("admin.orderSaved"));
      } finally { busy.current = false; setSaving(false); }
    });
  };
  const moveRole = (id: string, direction: -1 | 1) => {
    const target = editable[editable.findIndex((r) => r.id === id) + direction];
    if (target) reorder(id, target.id, direction === 1);
  };
  return (
    <div className="roles">
      <div className="roles-list">
        <p className="muted small">{t("admin.roleSortHint")}</p>
        <ul aria-busy={saving}>{sorted.map((r) => {
          const index = editable.findIndex((item) => item.id === r.id);
          return <li key={r.id} className={`role-sort-row${r.id === sel ? " active" : ""}${dragId === r.id ? " is-dragging" : ""}${drop?.id === r.id ? (drop.after ? " drop-after" : " drop-before") : ""}`}
            onDragOver={(e) => {
              if (!dragId || dragId === r.id || index < 0 || saving) return;
              e.preventDefault(); e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              setDrop({ id: r.id, after: e.clientY > rect.top + rect.height / 2 });
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}
            onDrop={(e) => { e.preventDefault(); if (dragId && drop?.id === r.id) reorder(dragId, r.id, drop.after); setDragId(null); setDrop(null); }}>
            {index >= 0 ? <button className="icon role-drag" draggable={!saving} disabled={saving} title={t("admin.dragItem", { name: r.name })} aria-label={t("admin.dragItem", { name: r.name })}
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); if (e.currentTarget.parentElement) e.dataTransfer.setDragImage(e.currentTarget.parentElement, 16, 16); setDragId(r.id); }}
              onDragEnd={() => { setDragId(null); setDrop(null); }}
              onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); moveRole(r.id, e.key === "ArrowUp" ? -1 : 1); } }}><Icon name="grip-vertical" /></button> : <span className="role-fixed" title={t("admin.roleFixed")}><Icon name="lock" /></span>}
            <button className="role-select" title={r.name} aria-pressed={r.id === sel && !combo} style={r.color ? { color: r.color } : undefined} onClick={() => { setSel(r.id); setCombo(false); }}>{r.name}{r.isDefault && <span className="muted small"> {t("admin.defaultRole")}</span>}</button>
            {index >= 0 && <div className="role-sort-actions">
              <button className="icon" disabled={saving || index === 0} title={t("admin.up")} aria-label={`${r.name}: ${t("admin.up")}`} onClick={() => moveRole(r.id, -1)}><Icon name="chevron-up" /></button>
              <button className="icon" disabled={saving || index === editable.length - 1} title={t("admin.down")} aria-label={`${r.name}: ${t("admin.down")}`} onClick={() => moveRole(r.id, 1)}><Icon name="chevron-down" /></button>
            </div>}
          </li>;
        })}</ul>
        <p className="muted small" role="status">{saving ? t("admin.orderSaving") : notice}</p>
        <div className="row">
          <input value={newName} placeholder={t("admin.newRole")} onChange={(e) => setNewName(e.target.value)} />
          <button disabled={saving || !newName.trim()} aria-label={t("admin.newRole")} onClick={() => run(() => api.createRole({ name: newName.trim() }).then((r) => { setNewName(""); setSel(r.id); setCombo(false); }))}>+</button>
        </div>
        {/* The combination check (user's wish, 6 October 2026): what a set of roles adds up to, in the editor's place. */}
        <button className={`secondary combo-btn${combo ? " active" : ""}`} aria-pressed={combo} onClick={() => setCombo(!combo)}><Icon name="layers" /> {t("admin.combo")}</button>
      </div>
      {combo ? <RoleCombo server={server} /> : role && (
        <div className="stack role-edit">
          <div className="row">
            <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} disabled={role.isDefault} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          {/* Grouped and ordered by meaning (PERMISSION_GROUPS in the protocol package), not by bit number. */}
          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.id} className="perm-group">
              <legend>{t(`permGroup.${g.id}`)}</legend>
              <div className="perm-grid">
                {g.permissions.map((n) => {
                  // A right one does not hold stays as it is (the server's canChangeGrant): the box shows it, locked, with the reason.
                  const ok = hasPermission(server.myPermissions, Permission[n]);
                  return (
                    <label key={n} className="check" title={ok ? undefined : t("admin.notGrantable")}>
                      <input type="checkbox" checked={(perms & Permission[n]) !== 0} disabled={!ok} onChange={(e) => setPerms(e.target.checked ? perms | Permission[n] : perms & ~Permission[n])} />
                      {t(`perm.${n}`)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <p className="muted small">{t("admin.activePerms", { list: active.join(", ") || t("admin.none") })}</p>
          <div className="row">
            <SaveButton onSave={() => save(() => api.updateRole(role.id, { name: name.trim() || role.name, color, permissions: perms }))} />
            {!role.isDefault && <button className="danger" onClick={() => run(async () => { if (await askConfirm({ title: t("admin.deleteRoleTitle", { name: role.name }), text: t("admin.deleteRoleText"), confirmLabel: t("common.delete"), danger: true })) { await api.deleteRole(role.id); setSel(null); } })}>{t("common.delete")}</button>}
          </div>
          <p className="muted small">{t("admin.roleHint")}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The combination check of Verwaltung > Rollen (user's wish, 6 October 2026, instead of allow/deny states on roles: "eine neue
 * Ansicht wo man die Auswirkungen der Rollenkombinationen sehen kann"): tick roles, or take a member's, and read what they
 * add up to, right by right with the roles that give it. The rule is the server's `effectivePermissions`: the default role for
 * everybody plus the OR of the ticked roles; an owner is always an administrator.
 */
function RoleCombo({ server }: { server: ServerState }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [memberId, setMemberId] = useState("");
  const sorted = rolesByRank(server.roles);
  const member = server.members.find((m) => m.userId === memberId) ?? null;
  const chosen = sorted.filter((r) => r.isDefault || picked.includes(r.id));
  const mask = member?.isOwner ? Permission.ADMINISTRATOR : chosen.reduce((m, r) => m | r.permissions, 0);
  const admin = hasPermission(mask, Permission.ADMINISTRATOR);
  const members = [...server.members].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const takeMember = (id: string) => { setMemberId(id); setPicked(server.members.find((m) => m.userId === id)?.roleIds ?? []); };
  const toggle = (id: string) => { setMemberId(""); setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]); };
  return (
    <div className="stack role-combo">
      <p className="muted small">{t("admin.comboHint")}</p>
      <label className="row">
        <span>{t("admin.comboMember")}</span>
        <select value={memberId} onChange={(e) => takeMember(e.target.value)}>
          <option value="">{t("admin.comboNobody")}</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
        </select>
      </label>
      <div className="combo-roles">
        {sorted.map((r) => (
          <label key={r.id} className="check">
            <input type="checkbox" checked={r.isDefault || picked.includes(r.id)} disabled={r.isDefault} onChange={() => toggle(r.id)} />
            <span style={r.color ? { color: r.color } : undefined}>{r.name}</span>{r.isDefault && <span className="muted small"> {t("admin.defaultRole")}</span>}
          </label>
        ))}
      </div>
      {member?.isOwner && <p className="muted small">{t("admin.comboOwner")}</p>}
      {admin && !member?.isOwner && <p className="muted small">{t("admin.comboAdmin")}</p>}
      {PERMISSION_GROUPS.map((g) => (
        <fieldset key={g.id} className="perm-group">
          <legend>{t(`permGroup.${g.id}`)}</legend>
          <div className="perm-grid">
            {g.permissions.map((n) => {
              const has = hasPermission(mask, Permission[n]);
              const via = admin ? [] : chosen.filter((r) => (r.permissions & Permission[n]) !== 0).map((r) => r.name);
              return (
                <div key={n} className={`combo-perm${has ? " has" : ""}`}>
                  <span className="combo-mark">{has ? <Icon name="check" /> : <Icon name="x" />}</span>
                  <span>{t(`perm.${n}`)}</span>
                  {via.length > 0 && <small className="muted">{via.join(", ")}</small>}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function InvitesTab({ api, run, canManage }: { api: ServerApi; run: RunFn; canManage: boolean }) {
  const [list, setList] = useState<Invite[]>([]);
  const [hours, setHours] = useState<string>("168");
  const [uses, setUses] = useState<string>("");
  const reload = () => api.listInvites().then(setList).catch(() => {});
  useEffect(() => { void reload(); }, []);
  // The invite belongs to the server the panel acts on, which need not be the one serving the page (multi-server client).
  const link = (code: string) => `${api.base || window.location.origin}/invite/${code}`;
  // The same invitation as a squorli:// link for the desktop app (user's wish, 23 September 2026): the host is where this
  // server is reached (the foreign server's base, else the address bar, with its port in dev), built through the parser
  // like the login screen's "open in the app" link, so it is only offered when the app will accept it.
  const appLink = (code: string) => { const host = api.base ? new URL(api.base).host : window.location.host; const l = parseDeepLink(`squorli://invite/${host}/${code}`); return l ? formatDeepLink(l) : null; };
  return (
    <div className="stack">
      <div className="row">
        <label className="row">{t("admin.validHours")} <input value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: "5rem" }} /></label>
        <label className="row">{t("admin.maxUses")} <input value={uses} onChange={(e) => setUses(e.target.value)} style={{ width: "5rem" }} /></label>
        <button onClick={() => run(() => api.createInvite({ expiresInHours: hours ? Number(hours) : null, maxUses: uses ? Number(uses) : null }).then(reload))}>{t("admin.createInvite")}</button>
      </div>
      {list.length === 0 && <p className="muted">{canManage ? t("admin.noInvites") : t("admin.noInvitesMine")}</p>}
      {list.length > 0 && <span className="muted small">{t("admin.appLinkHint")}</span>}
      {list.map((i) => (
        <div key={i.code} className="row invite-row">
          <code>{link(i.code)}</code>
          <CopyButton text={link(i.code)} label={t("admin.copyLink")} />
          {appLink(i.code) && <CopyButton text={appLink(i.code)!} label={t("admin.copyAppLink")} />}
          <span className="muted small">{i.uses}{i.maxUses ? `/${i.maxUses}` : ""} {t("admin.used")}{i.expiresAt ? ` · ${t("admin.until", { date: fmtDateTime(i.expiresAt) })}` : ""}</span>
          <button className="danger small" onClick={() => run(() => api.revokeInvite(i.code).then(reload))}>{t("admin.revoke")}</button>
        </div>
      ))}
    </div>
  );
}

function BansTab({ api, run }: { api: ServerApi; run: RunFn }) {
  const [list, setList] = useState<Ban[]>([]);
  const reload = () => api.listBans().then(setList).catch(() => {});
  useEffect(() => { void reload(); }, []);
  return (
    <div className="stack">
      {list.length === 0 && <p className="muted">{t("admin.noBans")}</p>}
      {list.map((b) => (
        <div key={b.userId} className="row">
          <strong>{b.displayName}</strong>
          <span className="muted small">{b.reason ?? t("admin.noReason")} · {fmtDateTime(b.createdAt)}</span>
          <button className="secondary small" onClick={() => run(() => api.unban(b.userId).then(reload))}>{t("admin.unban")}</button>
        </div>
      ))}
    </div>
  );
}
