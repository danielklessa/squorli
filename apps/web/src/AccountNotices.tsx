import type { AccountNotice, ReportReason } from "@squorli/protocol";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { fmtDateTime, t } from "./i18n";
import { platform } from "./platform";
import { safeHref } from "./safeHref";

/**
 * Notices about measures of the directory's operator (docs/features/reports.md, 27 September 2026): a warning, the picture
 * or the display name removed, a suspension and its end. The wording is fixed in both languages (the user's decision):
 * what was done, the reason from the reports' list, never who reported and no text of the operator's. The same texts as
 * on the directory's account page.
 */
export function noticeText(n: Pick<AccountNotice, "kind" | "reason" | "until">, handle: string): string {
  const reason = t(`notice.reason.${n.reason}`);
  return t(`notice.${n.kind}`, { handle, reason, until: n.until ? fmtDateTime(n.until) : "" });
}

/** Where the contact address is: the directory's address of the operator's legal notice. */
const legalUrl = (directoryUrl: string): string => `${directoryUrl.replace(/\/+$/, "")}/impressum`;

function LegalLine({ directoryUrl }: { directoryUrl: string }) {
  const href = safeHref(legalUrl(directoryUrl));
  return (
    <p className="muted small">
      {t("notice.closing")}{" "}
      {href === undefined ? t("notice.legal")
        : platform.home ? <a href={href} target="_blank" rel="noreferrer">{t("notice.legal")}</a>
          : <button className="link" onClick={() => platform.links.openExternal(href)}>{t("notice.legal")}</button>}
      .
    </p>
  );
}

/**
 * The unread notices as a modal, one after the other the newest first: "Verstanden" marks the one on screen as read
 * (in the account, so it counts on every device). Closing without it leaves the notice unread; it comes back at the
 * next start.
 */
export function NoticesDialog({ notices, handle, directoryUrl, onRead, onClose }: { notices: AccountNotice[]; handle: string; directoryUrl: string; onRead: (id: string) => Promise<void>; onClose: () => void }) {
  const unread = notices.filter((n) => n.readAt === null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const current = unread[0];
  if (!current) return null;
  const read = async () => {
    setBusy(true); setErr(null);
    try { await onRead(current.id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onClose}>
      <div className="modal dialog notice-dialog" role="dialog" aria-modal="true" aria-labelledby="notice-title" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="notice-title">{t("notice.title")}</h2>
          <span className="spacer" />
          <button className="icon" onClick={onClose} title={t("common.close")}><Icon name="x" /></button>
        </header>
        <div className="dialog-body stack">
          <p className="muted small">{fmtDateTime(current.createdAt)}{unread.length > 1 ? ` · ${t("notice.more", { n: unread.length - 1 })}` : ""}</p>
          <p className={current.kind === "suspend" ? "notice-text suspended" : "notice-text"}>{noticeText(current, handle)}</p>
          {current.kind === "suspend" && <p className="small">{t("notice.suspendServers")}</p>}
          <LegalLine directoryUrl={directoryUrl} />
          {err && <p className="error">{err}</p>}
          <div className="dialog-actions">
            <button className="secondary" onClick={onClose}>{t("notice.later")}</button>
            <button disabled={busy} onClick={() => void read()}>{t("notice.ack")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The suspended state where friends and direct messages would be (the friends view): until when, why, what it means,
 * and a button that asks the directory again (a suspension that was lifted ends at once, one that ran out by itself).
 */
export function SuspendedNote({ until, reason, handle, directoryUrl, onCheck }: { until: string; reason: ReportReason | null; handle: string; directoryUrl: string | null; onCheck: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="account-suspended stack" role="status">
      <strong><Icon name="ban" /> {t("notice.suspendedTitle")}</strong>
      <p className="small">{until ? noticeText({ kind: "suspend", reason: reason ?? "other", until }, handle) : t("notice.suspendedNoDate", { handle })}</p>
      <p className="small">{t("notice.suspendServers")}</p>
      {directoryUrl && <LegalLine directoryUrl={directoryUrl} />}
      <button className="secondary small" disabled={busy} onClick={() => { setBusy(true); void onCheck().finally(() => setBusy(false)); }}>{t("notice.checkAgain")}</button>
    </div>
  );
}
