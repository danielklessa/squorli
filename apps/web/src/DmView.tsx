import { AutoGrowTextarea } from "./AutoGrowTextarea";
import { Avatar } from "./Avatar";
import { DM_DELETE_BOTH_MS, type Friend } from "@squorli/protocol";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { askConfirm } from "./dialogs";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { askBlockFriend, askRemoveFriend } from "./friendActions";
import { EmojiButton } from "./EmojiPicker";
import { GameLine } from "./GameLine";
import { friendName } from "./Home";
import { Icon } from "./Icon";
import { DmPreviews } from "./LinkPreviews";
import { visibleDms } from "./dmPreviews";
import { useVoiceSettings } from "./voice/useVoiceSettings";
import { MessageText } from "./MessageText";
import { ReportDialog, type DmReportTarget } from "./ReportDialog";
import type { DmThread, Store } from "./store";
import { fmtDay, fmtTime, t } from "./i18n";

/**
 * Conversation with a friend (M7): history (older messages when scrolling up), grouping as in the channel chat, composer without
 * attachments. Deleting: your own messages within 5 minutes for both sides, otherwise only for me (user decision). Reporting a
 * friend's message goes to the directory's operator (`reportHost`, null where the directory takes none; docs/features/reports.md).
 */
const GROUP_MS = 5 * 60_000;

export function DmView({ friend, thread, myKey, store, avatarUrl, myAvatarUrl, reportHost }: { friend: Friend; thread: DmThread; myKey: string; store: Store; avatarUrl: string | null; myAvatarUrl: string | null; reportHost: string | null }) {
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [reportTarget, setReportTarget] = useState<DmReportTarget | null>(null);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);
  const name = friendName(friend);
  // Switched off (Einstellungen > Ansicht): no previews at all, sent or received; their pictures are not even fetched.
  const previewsOn = useVoiceSettings().dmLinkPreviews;
  // Instructions (a preview taken away) are no messages, and what their author removed is not shown.
  const list = useMemo(() => visibleDms(thread.list), [thread.list]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread.list]);
  // The input grows and shrinks (AutoGrowTextarea): the newest message stays in view.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (stickToBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onScroll() {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 60 && thread.hasMore && !thread.loading && thread.loaded) {
      const before = el.scrollHeight;
      void store.loadDmHistory(friend.publicKey, true).then(() => { requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - before; }); });
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true); setErr(null);
    try { await store.sendDm(friend.publicKey, text); setDraft(""); stickToBottom.current = true; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSending(false); inputRef.current?.focus(); }   // keep writing right away, also after a click on "Senden"
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
  }

  return (
    <section className="chat">
      <header className="chat-head">
        <Avatar name={name} src={avatarUrl} online={friend.online} afk={friend.afk} /><strong>{name}</strong>
        <span className="muted topic">@{friend.handle}{friend.online ? ` · ${t(friend.afk ? "dm.afk" : "dm.online")}` : ""}</span>
        <GameLine game={friend.online ? friend.game : null} className="muted" />
        <span className="spacer" />
        {/* Remove or block the friend (user's wish, 24 September 2026). */}
        <button className="icon" title={t("friends.menu")} aria-label={t("friends.menu")} aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ trigger: e.currentTarget, x: r.left, y: r.bottom }); }}><Icon name="ellipsis-vertical" /></button>
        {menu && (
          <ContextMenu anchor={menu} label={name} onClose={() => setMenu(null)}>
            <button role="menuitem" className="danger" onClick={() => { setMenu(null); askRemoveFriend(store, friend.publicKey, name); }}><Icon name="user-minus" /> {t("friends.remove")}</button>
            <button role="menuitem" className="danger" onClick={() => { setMenu(null); askBlockFriend(store, friend.publicKey, name); }}><Icon name="ban" /> {t("friends.block")}</button>
          </ContextMenu>
        )}
        <button className="icon" title={t("dm.clearTitle")} onClick={() => { void askConfirm({ title: t("dm.clearConfirmTitle", { name }), text: t("dm.clearConfirmText"), confirmLabel: t("common.delete"), danger: true }).then((ok) => { if (ok) store.clearDm(friend.publicKey); }); }}><Icon name="trash-2" /></button>
      </header>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {thread.loading && <p className="muted center">{t("common.loading")}</p>}
        {thread.loaded && !thread.hasMore && <p className="muted center"><Icon name="lock" /> {t("dm.e2e", { name })}</p>}
        {list.map((m, i) => {
          const prev = list[i - 1];
          const grouped = prev && prev.from === m.from && new Date(m.sentAt).getTime() - new Date(prev.sentAt).getTime() < GROUP_MS;
          const newDay = !prev || fmtDay(prev.sentAt) !== fmtDay(m.sentAt);
          const mine = m.from === myKey;
          const both = mine && Date.now() - new Date(m.sentAt).getTime() < DM_DELETE_BOTH_MS;
          return (
            <div key={m.id}>
              {newDay && <div className="day-sep"><span>{fmtDay(m.sentAt)}</span></div>}
              <article className={`msg ${grouped && !newDay ? "grouped" : ""}`}>
                {!(grouped && !newDay) && (
                  <div className="msg-head">
                    <Avatar name={mine ? t("dm.you") : name} src={mine ? myAvatarUrl : avatarUrl} />
                    <strong>{mine ? t("dm.you") : name}</strong>
                    <time className="muted" dateTime={m.sentAt}>{fmtTime(m.sentAt)}</time>
                  </div>
                )}
                <div className="msg-body">
                  {m.text === null
                    ? <p className="muted"><Icon name="lock" /> {t("dm.undecryptable")}</p>
                    : <MessageText text={m.text} />}
                  {previewsOn && <DmPreviews messageId={m.id} peer={friend.publicKey} previews={m.shown} mine={mine} store={store} onError={setErr} />}
                </div>
                <div className="msg-actions">
                  {!mine && m.text !== null && reportHost && <button className="icon" title={t("report.reportMessage")} onClick={() => setReportTarget({ kind: "dm", peer: friend.publicKey, name, messageId: m.id, excerpt: m.text?.slice(0, 200) ?? "" })}><Icon name="flag" /></button>}
                  <button className="icon" title={both ? t("dm.deleteBoth") : t("dm.deleteMine")} onClick={() => {
                    void askConfirm({ title: both ? t("dm.deleteBothTitle") : t("dm.deleteMineTitle"), text: both ? t("dm.deleteBothText") : t("dm.deleteMineText"), confirmLabel: t("common.delete"), danger: true })
                      .then((ok) => { if (ok) store.deleteDm(friend.publicKey, m.id); });
                  }}><Icon name="trash-2" /></button>
                </div>
              </article>
            </div>
          );
        })}
      </div>

      {reportTarget && reportHost && <ReportDialog target={reportTarget} store={store} directoryHost={reportHost} onClose={() => setReportTarget(null)} />}
      <footer className="composer">
        {err && <p className="error">{err}</p>}
        <div className="typing" />
        <div className="composer-row">
          <AutoGrowTextarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={1} placeholder={t("dm.placeholder", { name })} readOnly={sending} inputRef={inputRef} />
          <EmojiButton inputRef={inputRef} value={draft} onChange={setDraft} disabled={sending} />
          <button onClick={submit} disabled={sending || !draft.trim()}>{t("chat.send")}</button>
        </div>
      </footer>
    </section>
  );
}
