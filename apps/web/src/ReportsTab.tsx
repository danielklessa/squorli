import { REPORT_CLOSED_BY_SYSTEM, DELETE_RECENT_HOURS, Permission, hasPermission, type DeleteRecentHours, type ModLogEntry, type Report } from "@squorli/protocol";
import { useCallback, useEffect, useState } from "react";
import { ApiError, type ServerApi } from "./api";
import { askConfirm, askInput, askSelect } from "./dialogs";
import { Icon } from "./Icon";
import { fmtDateTime, t, tOr } from "./i18n";
import { safeHref } from "./safeHref";

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** The hours choice of "delete the member's messages of the last ...", as a dialog; null = cancelled. */
export async function askDeleteRecentHours(title: string): Promise<DeleteRecentHours | null | "none"> {
  const v = await askSelect({ title, text: t("report.deleteRecentText"), options: [{ value: "none", label: t("report.deleteRecent.none") }, ...DELETE_RECENT_HOURS.map((h) => ({ value: String(h), label: t(`report.deleteRecent.${h}`) }))], initial: "none", confirmLabel: t("common.ok") });
  if (v === null) return null;
  return v === "none" ? "none" : (Number(v) as DeleteRecentHours);
}

/**
 * Verwaltung > Meldungen (docs/features/reports.md): the open reports newest first with their snapshots and the actions that
 * close them, the closed ones on request, and the moderation log below.
 */
export function ReportsTab({ api, myPermissions, run, openCount }: { api: ServerApi; myPermissions: number; run: RunFn; openCount: number }) {
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [log, setLog] = useState<{ entries: ModLogEntry[]; hasMore: boolean } | null>(null);
  const reload = useCallback(() => api.listReports(status).then((r) => setReports(r.reports)).catch(() => setReports([])), [api, status]);
  useEffect(() => { void reload(); }, [reload, openCount]);
  useEffect(() => { void api.listModLog(null).then(setLog).catch(() => setLog({ entries: [], hasMore: false })); }, [api, openCount]);
  const canKick = hasPermission(myPermissions, Permission.KICK_MEMBERS);
  const canBan = hasPermission(myPermissions, Permission.BAN_MEMBERS);
  // Deleting through a report needs MANAGE_MESSAGES, the person's recent messages a rank above them too (the server's
  // rule since 2 October 2026); the channel's own overwrites and the rank only the server knows, so its refusal gets a text.
  const canDelete = hasPermission(myPermissions, Permission.MANAGE_MESSAGES);
  const close = (r: Report, action: Report["action"] & string, extra: { hours?: DeleteRecentHours; note?: string } = {}) =>
    run(async () => {
      try { await api.closeReport(r.id, { action, ...extra }); } catch (e) {
        if (e instanceof ApiError && (e.code === "forbidden" || e.code === "target_above_you")) throw new Error(t(`report.err.${e.code}`));
        throw e;
      }
      await reload();
    });
  const moreLog = () => run(async () => {
    const last = log?.entries[log.entries.length - 1];
    const next = await api.listModLog(last?.at ?? null);
    setLog({ entries: [...(log?.entries ?? []), ...next.entries], hasMore: next.hasMore });
  });
  return (
    <div className="stack reports-tab">
      <div className="row">
        <button className={status === "open" ? "" : "secondary"} onClick={() => setStatus("open")}>{t("report.tabOpen", { n: openCount })}</button>
        <button className={status === "closed" ? "" : "secondary"} onClick={() => setStatus("closed")}>{t("report.tabClosed")}</button>
      </div>
      <span className="muted small">{t("report.queueHint")}</span>
      {reports === null && <p className="muted">{t("common.loading")}</p>}
      {reports?.length === 0 && <p className="muted">{status === "open" ? t("report.noneOpen") : t("report.noneClosed")}</p>}
      {reports?.map((r) => (
        <article key={r.id} className={`report-card report-${r.status}`}>
          <header className="report-head">
            <strong>{t(`report.reason.${r.reason}`)}</strong>
            <span className="muted small">{t(r.kind === "message" ? "report.aboutMessage" : "report.aboutMember", { name: r.reportedName })}{r.channelName ? ` · #${r.channelName}` : ""} · {fmtDateTime(r.createdAt)}</span>
            {r.earlier > 0 && <span className="warn-box small">{t("report.earlier", { n: r.earlier })}</span>}
          </header>
          <p className="small"><span className="muted">{t("report.reporter")}:</span> {r.reporterName}{r.text ? <> · <q>{r.text}</q></> : null}</p>
          {r.snapshot ? (
            <div className="report-snapshot">
              {r.kind === "message" && (
                <>
                  <div className="muted small">{r.snapshot.name}{r.snapshot.handle ? ` (${r.snapshot.handle})` : ""}{r.snapshot.messageCreatedAt ? ` · ${fmtDateTime(r.snapshot.messageCreatedAt)}` : ""}{!r.messageExists && <> · <em>{t("report.messageGone")}</em></>}</div>
                  {r.snapshot.content && <pre className="report-content">{r.snapshot.content}</pre>}
                  {r.snapshot.attachments.map((a) => (
                    a.mimeType.startsWith("image/")
                      ? <a key={a.n} href={safeHref(api.abs(a.url))} target="_blank" rel="noreferrer"><img className="attachment-img" src={api.abs(a.url)} alt={a.name} loading="lazy" /></a>
                      : <a key={a.n} className="attachment" href={safeHref(api.abs(a.url))} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {a.name} <span className="muted">({fmtSize(a.size)})</span></a>
                  ))}
                  {r.snapshot.previews.map((p) => <div key={p.url} className="muted small">{t("report.preview")}: {p.title ?? p.url}{p.description ? ` – ${p.description}` : ""}</div>)}
                </>
              )}
              {r.kind === "member" && <div className="muted small">{r.snapshot.name}{r.snapshot.handle ? ` (${r.snapshot.handle})` : ""}</div>}
            </div>
          ) : <p className="muted small">{t("report.snapshotGone")}</p>}
          {r.status === "open" ? (
            <div className="row report-actions">
              {r.kind === "message" && r.messageExists && canDelete && <button className="danger small" onClick={() => void run(async () => { if (await askConfirm({ title: t("report.deleteTitle"), text: t("report.deleteText"), confirmLabel: t("common.delete"), danger: true })) await close(r, "delete"); })}><Icon name="trash-2" /> {t("report.actionDelete")}</button>}
              {r.reportedUserId && canDelete && <button className="secondary small" onClick={() => void run(async () => { const h = await askDeleteRecentHours(t("report.deleteRecentTitle", { name: r.reportedName })); if (h && h !== "none") await close(r, "deleteRecent", { hours: h }); })}><Icon name="trash-2" /> {t("report.actionDeleteRecent")}</button>}
              {r.reportedUserId && canKick && <button className="secondary small" onClick={() => void run(async () => { if (await askConfirm({ title: t("members.kickTitle", { name: r.reportedName }), text: t("members.kickText"), confirmLabel: t("members.kick"), danger: true })) { await api.kickMember(r.reportedUserId!); await close(r, "kick"); } })}><Icon name="user-x" /> {t("members.kick")}</button>}
              {r.reportedUserId && canBan && <button className="danger small" onClick={() => void run(async () => {
                const reason = await askInput({ title: t("members.banTitle", { name: r.reportedName }), text: t("members.banText"), label: t("members.reason"), placeholder: t("members.reasonPlaceholder"), optional: true, confirmLabel: t("members.ban"), danger: true });
                if (reason === null) return;
                const h = await askDeleteRecentHours(t("report.deleteRecentTitle", { name: r.reportedName }));
                if (h === null) return;
                await api.banMember(r.reportedUserId!, reason || null, h === "none" ? undefined : h);
                await close(r, "ban", h === "none" ? {} : { hours: h });
              })}><Icon name="ban" /> {t("members.ban")}</button>}
              <button className="secondary small" onClick={() => void close(r, "dismiss")}><Icon name="x" /> {t("report.actionDismiss")}</button>
            </div>
          ) : (
            <p className="muted small">{t(`report.result.${r.action ?? "none"}`)} · {r.closedByName === REPORT_CLOSED_BY_SYSTEM ? t("report.closedBySystem") : (r.closedByName ?? "?")} · {r.closedAt ? fmtDateTime(r.closedAt) : ""}{r.note ? ` · ${r.note}` : ""}</p>
          )}
        </article>
      ))}
      <h3>{t("report.logHeading")}</h3>
      <span className="muted small">{t("report.logHint")}</span>
      {log?.entries.length === 0 && <p className="muted">{t("report.logEmpty")}</p>}
      {log?.entries.map((e) => (
        <div key={e.id} className="row small mod-log-line">
          <span className="muted">{fmtDateTime(e.at)}</span>
          <span><strong>{e.actorName}</strong> {t(`report.log.${e.action}`, { target: e.targetName ?? "?", channel: e.channelName ?? "?", count: String(e.detail.count ?? e.detail.deleted ?? ""), hours: String(e.detail.hours ?? ""), minutes: e.detail.minutes === null ? t("members.blockPermanent") : String(e.detail.minutes ?? ""), result: tOr(`report.result.${String(e.detail.result ?? "none")}`, String(e.detail.result ?? "")) })}{typeof e.detail.reason === "string" && e.detail.reason ? ` (${e.detail.reason})` : ""}</span>
        </div>
      ))}
      {log?.hasMore && <button className="secondary small" onClick={() => void moreLog()}>{t("report.logMore")}</button>}
    </div>
  );
}
