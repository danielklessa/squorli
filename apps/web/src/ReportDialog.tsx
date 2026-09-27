import { DM_REPORT_CONTEXT_MAX, REPORT_REASONS, REPORT_TEXT_MAX, type ReportReason } from "@squorli/protocol";
import { useEffect, useState } from "react";
import type { ServerApi } from "./api";
import { ApiError } from "./api";
import { askBlockFriend } from "./friendActions";
import { Icon } from "./Icon";
import { t } from "./i18n";
import type { Store } from "./store";

/** What is being reported on a chat server: a message (the text shown as a reminder; `authorId` for the offer to block afterwards) or a member. */
export type ReportTarget = { kind: "message"; messageId: string; authorName: string; excerpt: string; authorId?: string } | { kind: "member"; userId: string; name: string };
/** A friend's direct message, reported to the directory's operator (`peer` = the friend, the message's author). */
export type DmReportTarget = { kind: "dm"; peer: string; name: string; messageId: string; excerpt: string };
/** `block`: after the report the dialog offers to block the person (stage 3); null = not offered (already blocked, or no member to block). */
type ServerProps = { target: ReportTarget; api: ServerApi; serverName: string; block?: { name: string; onBlock: () => void } | null };
/** `directoryHost` names who gets it; the store sends the report (`reportDm`) and, afterwards, the dialog offers to block. */
type DirectoryProps = { target: DmReportTarget; store: Store; directoryHost: string };

/**
 * The report dialog (docs/features/reports.md): reason from the fixed list, a free text, and who gets it: this server's
 * moderators for a message or a member, the directory's operator for a direct message (stage 4; with the checkbox that
 * sends the preceding messages along, on by default). An own modal like every dialog of the client, no browser dialog.
 */
export function ReportDialog(props: (ServerProps | DirectoryProps) & { onClose: () => void }) {
  const { target, onClose } = props;
  const server = "api" in props ? props : null;
  const directory = "store" in props ? props : null;
  const [reason, setReason] = useState<ReportReason>("spam");
  const [text, setText] = useState("");
  const [withContext, setWithContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const free = text.trim() || undefined;
      if (directory) await directory.store.reportDm(directory.target.peer, directory.target.messageId, withContext, reason, free);
      else if (server) await server.api.createReport(server.target.kind === "message" ? { kind: "message", messageId: server.target.messageId, reason, text: free } : { kind: "member", userId: server.target.userId, reason, text: free });
      setDone(true);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "already_reported" ? t("report.alreadyReported") : e instanceof ApiError && e.code === "rate_limited" ? t("report.rateLimited") : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const title = target.kind === "message" ? t("report.titleMessage", { name: target.authorName }) : target.kind === "dm" ? t("report.titleDm", { name: target.name }) : t("report.titleMember", { name: target.name });
  const excerpt = target.kind === "member" ? "" : target.excerpt;
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="report-title">{title}</h2>
          <span className="spacer" />
          <button className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        <div className="dialog-body stack">
          {done ? (
            <>
              <p>{directory ? t("report.sentDirectory", { name: directory.target.name }) : t("report.sent", { server: server?.serverName ?? "" })}</p>
              <div className="dialog-actions">
                {directory && <button className="secondary" onClick={() => { onClose(); askBlockFriend(directory.store, directory.target.peer, directory.target.name); }}><Icon name="ban" /> {t("friends.block")}</button>}
                {server?.block && <button className="secondary" onClick={() => { onClose(); server.block?.onBlock(); }}><Icon name="ban" /> {t("block.block")}</button>}
                <button onClick={onClose}>{t("common.close")}</button>
              </div>
            </>
          ) : (
            <>
              {excerpt && <blockquote className="report-excerpt muted">{excerpt}</blockquote>}
              <p className="muted small">{directory ? t("report.goesToDirectory", { host: directory.directoryHost, name: directory.target.name }) : t("report.goesTo", { server: server?.serverName ?? "" })}</p>
              <div className="stack report-reasons" role="radiogroup" aria-label={t("report.reason")}>
                {REPORT_REASONS.map((r) => (
                  <label key={r} className="check"><input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} /> {t(`report.reason.${r}`)}</label>
                ))}
              </div>
              <label className="stack">{t("report.text")}
                <textarea value={text} maxLength={REPORT_TEXT_MAX} rows={3} placeholder={t("report.textPlaceholder")} onChange={(e) => setText(e.target.value)} />
              </label>
              {directory && <label className="check"><input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} /> {t("report.dmContext", { n: DM_REPORT_CONTEXT_MAX })}</label>}
              {err && <p className="error">{err}</p>}
              <div className="dialog-actions">
                <button className="secondary" onClick={onClose}>{t("common.cancel")}</button>
                <button className="danger" disabled={busy} onClick={() => void submit()}>{busy ? t("report.sending") : t("report.send")}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
