import { DM_REPORT_CONTEXT_MAX, REPORT_REASONS, REPORT_TEXT_MAX, SERVER_REPORT_EVIDENCE_TEXT_MAX, type ReportReason, type ServerReportEvidence } from "@squorli/protocol";
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
/** A directory account as it shows (name, picture), reported to the directory's operator. */
export type AccountReportTarget = { kind: "account"; publicKey: string; name: string };
/** A chat server as a whole, by its host, reported to the directory's operator. */
export type ServerReportTarget = { kind: "server"; host: string; name: string };
export type DirectoryReportTarget = AccountReportTarget | ServerReportTarget;

/** The chat server a message or a member is reported on. `block`: the offer to block afterwards (stage 3); null = not offered. */
type ServerSide = { api: ServerApi; name: string; block?: { name: string; onBlock: () => void } | null };
/**
 * The directory: who gets a direct message's, an account's or a chat server's report (`host` names it). `passOn`: a message
 * of a chat server may go to the directory's operator instead of the server's moderators; it then is a report of that
 * server with the message as evidence, built by this client from what it shows.
 */
export type DirectorySide = { store: Store; host: string; passOn?: { serverHost: string; evidence: ServerReportEvidence } | null };

/** The message a report passes on, as this client shows it (the text cut to what a report carries). */
export const reportEvidence = (m: { text: string; authorName: string; authorKey: string | null; channelName: string; sentAt: string }): ServerReportEvidence =>
  ({ text: m.text.slice(0, SERVER_REPORT_EVIDENCE_TEXT_MAX), authorName: m.authorName.slice(0, 80), authorKey: m.authorKey, channelName: m.channelName.slice(0, 80), sentAt: m.sentAt });

/**
 * The report dialog (docs/features/reports.md): reason from the fixed list, a free text, and who gets it. A message or a
 * member of a chat server goes to that server's moderators; a direct message, a directory account and a chat server go to
 * the directory's operator. For a message of a chat server the reporter chooses (the user's decision of 27 September
 * 2026): the moderators, or the directory's operator when they do nothing or are the problem. An own modal like every
 * dialog of the client, no browser dialog.
 */
export function ReportDialog({ target, server = null, directory = null, onClose }: { target: ReportTarget | DmReportTarget | DirectoryReportTarget; server?: ServerSide | null; directory?: DirectorySide | null; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason>("spam");
  const [text, setText] = useState("");
  const [withContext, setWithContext] = useState(true);
  const passOn = target.kind === "message" && server ? directory?.passOn ?? null : null;
  const [receiver, setReceiver] = useState<"server" | "directory">("server");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  /** Where this report goes: a chat server's moderators, or the directory's operator. */
  const toDirectory = target.kind === "dm" || target.kind === "account" || target.kind === "server" || (passOn !== null && receiver === "directory");
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const free = text.trim() || undefined;
      if (target.kind === "dm") await directory?.store.reportDm(target.peer, target.messageId, withContext, reason, free);
      else if (target.kind === "account") await directory?.store.reportAccount(target.publicKey, reason, free);
      else if (target.kind === "server") await directory?.store.reportServer(target.host, reason, free, null);
      else if (target.kind === "message" && passOn && receiver === "directory") await directory?.store.reportServer(passOn.serverHost, reason, free, passOn.evidence);
      else if (server) await server.api.createReport(target.kind === "message" ? { kind: "message", messageId: target.messageId, reason, text: free } : { kind: "member", userId: target.userId, reason, text: free });
      setDone(true);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      setErr(code === "already_reported" ? t(target.kind === "account" ? "report.alreadyReportedAccount" : target.kind === "server" || (toDirectory && target.kind === "message") ? "report.alreadyReportedServer" : "report.alreadyReported")
        : code === "rate_limited" ? t("report.rateLimited") : code === "own_account" ? t("dir.own_account") : code === "account_suspended" ? t("report.suspended")
          : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const dirHost = directory?.host ?? "";
  const title = target.kind === "message" ? t("report.titleMessage", { name: target.authorName }) : target.kind === "dm" ? t("report.titleDm", { name: target.name })
    : target.kind === "account" ? t("report.titleAccount", { name: target.name }) : target.kind === "server" ? t("report.titleServer", { name: target.name }) : t("report.titleMember", { name: target.name });
  const excerpt = target.kind === "message" || target.kind === "dm" ? target.excerpt : "";
  const goesTo = target.kind === "dm" ? t("report.goesToDirectory", { host: dirHost, name: target.name })
    : target.kind === "account" ? t("report.goesToDirectoryAccount", { host: dirHost, name: target.name })
      : target.kind === "server" ? t("report.goesToDirectoryServer", { host: dirHost, server: target.host })
        : toDirectory ? t("report.goesToDirectoryPassOn", { host: dirHost, server: passOn?.serverHost ?? "" })
          : t("report.goesTo", { server: server?.name ?? "" });
  const sent = target.kind === "dm" ? t("report.sentDirectory", { name: target.name })
    : target.kind === "account" ? t("report.sentDirectoryAccount")
      : toDirectory ? t("report.sentDirectoryServer")
        : t("report.sent", { server: server?.name ?? "" });
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
              <p>{sent}</p>
              <div className="dialog-actions">
                {target.kind === "dm" && directory && <button className="secondary" onClick={() => { onClose(); askBlockFriend(directory.store, target.peer, target.name); }}><Icon name="ban" /> {t("friends.block")}</button>}
                {server?.block && <button className="secondary" onClick={() => { onClose(); server.block?.onBlock(); }}><Icon name="ban" /> {t("block.block")}</button>}
                <button onClick={onClose}>{t("common.close")}</button>
              </div>
            </>
          ) : (
            <>
              {excerpt && <blockquote className="report-excerpt muted">{excerpt}</blockquote>}
              {passOn && (
                <fieldset className="stack report-receiver">
                  <legend>{t("report.receiver")}</legend>
                  <label className="check"><input type="radio" name="report-receiver" checked={receiver === "server"} onChange={() => setReceiver("server")} /> {t("report.receiverServer", { server: server?.name ?? "" })}</label>
                  <label className="check"><input type="radio" name="report-receiver" checked={receiver === "directory"} onChange={() => setReceiver("directory")} /> {t("report.receiverDirectory", { host: dirHost })}</label>
                  <span className="muted small">{t("report.receiverHint")}</span>
                </fieldset>
              )}
              <p className="muted small">{goesTo}</p>
              <div className="stack report-reasons" role="radiogroup" aria-label={t("report.reason")}>
                {REPORT_REASONS.map((r) => (
                  <label key={r} className="check"><input type="radio" name="report-reason" checked={reason === r} onChange={() => setReason(r)} /> {t(`report.reason.${r}`)}</label>
                ))}
              </div>
              <label className="stack">{t("report.text")}
                <textarea value={text} maxLength={REPORT_TEXT_MAX} rows={3} placeholder={t("report.textPlaceholder")} onChange={(e) => setText(e.target.value)} />
              </label>
              {target.kind === "dm" && <label className="check"><input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} /> {t("report.dmContext", { n: DM_REPORT_CONTEXT_MAX })}</label>}
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
