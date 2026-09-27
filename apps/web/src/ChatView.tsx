import { AutoGrowTextarea } from "./AutoGrowTextarea";
import { Avatar } from "./Avatar";
import { Permission, hasPermission, type Channel, type Member, type Message } from "@squorli/protocol";
import { ApiError } from "./api";
import type { BlockControls } from "./blocked";
import { slowmodeLabel, slowmodeRemaining } from "./channelPerms";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { askConfirm } from "./dialogs";
import { EmojiButton } from "./EmojiPicker";
import { Icon } from "./Icon";
import { LinkPreviews } from "./LinkPreviews";
import { MentionContext, MessageText } from "./MessageText";
import { useMentionSuggest } from "./MentionSuggest";
import { decodeMentions, encodeMentions, mentionsUser } from "./mentions";
import { pastedFiles } from "./pasteFiles";
import { safeHref } from "./safeHref";
import { ReportDialog, reportEvidence, type DirectorySide, type ReportTarget } from "./ReportDialog";
import type { ChannelMessages } from "./store";
import type { ServerConnection } from "./serverConnection";
import { fmtDay, fmtTime, t } from "./i18n";

type Props = {
  channel: Channel;
  messages: ChannelMessages;
  members: Member[];
  myUserId: string;
  myPermissions: number;
  typing: Record<string, number>;
  conn: ServerConnection;
  /** The server takes reports (docs/features/reports.md): "Melden" on other people's messages. */
  canReport?: boolean;
  serverName?: string;
  /** Blocked people (stage 3 of the reports): their messages fold, and the report dialog offers to block; null = not signed in here. */
  blocked?: BlockControls | null;
  /**
   * A message's report may go to the directory's operator instead of the server's moderators (docs/features/reports.md):
   * the directory, and this server's host there. null = not offered (no directory account, or the directory takes none).
   */
  passOn?: (Omit<DirectorySide, "passOn"> & { serverHost: string }) | null;
};

const GROUP_MS = 5 * 60_000;

const fmtSize = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`);

/** A file waiting in the composer: its name, a small preview for a picture (so a pasted one can be seen before sending), and the x. */
function PendingFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/")) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <span className="chip">
      {preview && <img className="chip-thumb" src={preview} alt="" />}
      {file.name} <button className="icon" title={t("common.remove")} onClick={onRemove}><Icon name="x" /></button>
    </span>
  );
}

export function ChatView({ channel, messages, members, myUserId, myPermissions, typing, conn, canReport = false, serverName = "", blocked = null, passOn = null }: Props) {
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  /** The reported message as it shows here, in case the report is passed on to the directory's operator. */
  const [reportedMessage, setReportedMessage] = useState<{ text: string; authorName: string; authorKey: string | null; channelName: string; sentAt: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);
  const lastTyping = useRef(0);
  const nameOf = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName])), [members]);
  const avatarOf = useMemo(() => new Map(members.map((m) => [m.userId, m.avatarUrl])), [members]);
  const mentionCtx = useMemo(() => ({ names: nameOf, me: myUserId }), [nameOf, myUserId]);
  const mention = useMentionSuggest({ inputRef, value: draft, onChange: setDraft, members });
  // The edit field has its own list; its `picked` starts with the people the message already mentions (startEdit).
  const editMention = useMentionSuggest({ inputRef: editRef, value: editing?.text ?? "", onChange: (text) => setEditing((cur) => cur && { ...cur, text }), members, below: true });
  const canSend = hasPermission(myPermissions, Permission.SEND_MESSAGES);
  const canAttach = hasPermission(myPermissions, Permission.ATTACH_FILES);
  const canManage = hasPermission(myPermissions, Permission.MANAGE_MESSAGES);
  // Slowmode (docs/features/channel-permissions.md): the wait since my last message here, counted down only while it runs;
  // whoever manages messages in the channel is exempt, as on the server. A 429 from the server sets the clock right.
  const slowmode = canManage ? 0 : channel.slowmodeSeconds;
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const waitLeft = slowmodeRemaining(now, lastSentAt, slowmode);
  useEffect(() => {
    if (waitLeft <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waitLeft]);

  // Stay at the bottom when switching channels and on new messages, unless the user has scrolled up.
  useEffect(() => { stickToBottom.current = true; setDraft(""); setFiles([]); setEditing(null); setLastSentAt(null); mention.picked.clear(); mention.close(); editMention.close(); }, [channel.id]);
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.list, channel.id]);
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
    if (el.scrollTop < 60 && messages.hasMore && !messages.loading && messages.loaded) {
      const before = el.scrollHeight;
      void conn.loadHistory(channel.id, true).then(() => { requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - before; }); });
    }
  }

  async function submit() {
    const content = draft.trim();
    if ((!content && files.length === 0) || sending || waitLeft > 0) return;
    setSending(true); setErr(null);
    try {
      await conn.sendMessage(channel.id, encodeMentions(content, members, mention.picked), files);
      setDraft(""); setFiles([]); mention.picked.clear();
      stickToBottom.current = true;
      if (slowmode > 0) { setLastSentAt(Date.now()); setNow(Date.now()); }
    } catch (e) {
      const retry = e instanceof ApiError && e.code === "slowmode" && typeof e.body.retryAfter === "number" ? e.body.retryAfter : null;
      if (retry !== null) { setLastSentAt(Date.now() - Math.max(0, slowmode - retry) * 1000); setNow(Date.now()); }
      else if (e instanceof ApiError && e.code === "rate_limited") setErr(t("err.rateLimited"));
      else setErr(String(e));
    } finally { setSending(false); inputRef.current?.focus(); }   // keep writing right away, also after a click on "Senden"
  }

  /**
   * A paste anywhere in the chat (Ctrl+V, or "Einfügen" in the desktop app's context menu) that carries files, such as a
   * picture from a screenshot tool: they join the composer's files, as if chosen with the paper clip (pasteFiles.ts).
   * Plain text pastes as ever; a paste into the field that edits a message is left alone (an edit cannot add files).
   */
  function onPaste(e: ClipboardEvent<HTMLElement>) {
    if (!canAttach || !canSend || sending || e.target === editRef.current) return;
    const pasted = pastedFiles(e.clipboardData);
    if (pasted.length === 0) return;
    e.preventDefault();
    setFiles((cur) => [...cur, ...pasted]);
    inputRef.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention.onKeyDown(e)) return;   // the suggestion list takes arrows, Enter, Tab and Escape while it is open
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
    else if (Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); conn.typing(channel.id); }
  }

  function startEdit(m: { id: string; content: string }) {
    const { text, picked } = decodeMentions(m.content, members);
    editMention.picked.clear();
    for (const [label, userId] of picked) editMention.picked.set(label, userId);
    editMention.close();
    setEditing({ id: m.id, text });
  }

  async function saveEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    try { await conn.api.editMessage(editing.id, encodeMentions(text, members, editMention.picked)); setEditing(null); editMention.close(); } catch (e) { setErr(String(e)); }
  }

  // Blocked people (docs/features/reports.md, stage 3): their messages are folded to one line; "Anzeigen" opens one for this view.
  const blockedAuthors = useMemo(() => new Set(blocked ? members.filter((m) => blocked.has(m.publicKey)).map((m) => m.userId) : []), [blocked, members]);
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const typers = Object.entries(typing).filter(([uid, t]) => uid !== myUserId && !blockedAuthors.has(uid) && Date.now() - t < 4000).map(([uid]) => nameOf.get(uid) ?? t("chat.someone"));

  return (
    <section className="chat" onPaste={onPaste}>
      <header className="chat-head">
        <span className="channel-icon"><Icon name="hash" /></span><strong>{channel.name}</strong>
        {channel.topic && <span className="muted topic">{channel.topic}</span>}
      </header>

      <MentionContext.Provider value={mentionCtx}>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {messages.loading && <p className="muted center">{t("common.loading")}</p>}
        {messages.loaded && !messages.hasMore && <p className="muted center">{t("chat.beginning", { name: channel.name })}</p>}
        {messages.list.map((m, i) => {
          const prev = messages.list[i - 1];
          const grouped = prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
          const newDay = !prev || fmtDay(prev.createdAt) !== fmtDay(m.createdAt);
          const mine = m.authorId === myUserId;
          const fromBlocked = blockedAuthors.has(m.authorId);
          const mentioned = !mine && !fromBlocked && mentionsUser(m.content, myUserId);
          if (fromBlocked && !revealed.has(m.id)) {
            return (
              <div key={m.id}>
                {newDay && <div className="day-sep"><span>{fmtDay(m.createdAt)}</span></div>}
                <article className={`msg blocked-msg ${grouped && !newDay ? "grouped" : ""}`}>
                  <div className="blocked-fold"><Icon name="ban" /> <span>{t("block.folded", { name: nameOf.get(m.authorId) ?? t("chat.formerMember") })}</span><button className="secondary small" onClick={() => setRevealed((prev) => new Set(prev).add(m.id))}>{t("block.show")}</button></div>
                </article>
              </div>
            );
          }
          return (
            <div key={m.id}>
              {newDay && <div className="day-sep"><span>{fmtDay(m.createdAt)}</span></div>}
              <article className={`msg ${grouped && !newDay ? "grouped" : ""} ${mentioned ? "mentions-me" : ""}`}>
                {!(grouped && !newDay) && (
                  <div className="msg-head">
                    <Avatar name={nameOf.get(m.authorId) ?? t("chat.formerMember")} src={avatarOf.get(m.authorId)} />
                    <strong>{nameOf.get(m.authorId) ?? t("chat.formerMember")}</strong>
                    <time className="muted" dateTime={m.createdAt}>{fmtTime(m.createdAt)}</time>
                  </div>
                )}
                <div className="msg-body">
                  {editing?.id === m.id ? (
                    <div className="edit-box">
                      <AutoGrowTextarea value={editing.text} autoFocus rows={2} inputRef={editRef} onChange={(e) => { setEditing((cur) => cur && { ...cur, text: e.target.value }); editMention.sync(); }}
                        onKeyUp={editMention.sync} onClick={editMention.sync} onBlur={editMention.close}
                        onKeyDown={(e) => {
                          if (editMention.onKeyDown(e)) return;   // the open list takes Enter, Tab, arrows and Escape first
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void saveEdit(); }
                          if (e.key === "Escape") setEditing(null);
                        }} />
                      {editMention.popup}
                      <span className="muted">{t("chat.editHint")}</span>
                    </div>
                  ) : (
                    <>
                      {m.content && <MessageText text={m.content} edited={m.editedAt !== null} />}
                      {m.attachments.map((a) => (
                        a.mimeType.startsWith("image/")
                          ? <a key={a.id} href={safeHref(conn.api.abs(a.url))} target="_blank" rel="noreferrer"><img className="attachment-img" src={conn.api.abs(a.url)} alt={a.name} loading="lazy" /></a>
                          : <a key={a.id} className="attachment" href={safeHref(conn.api.abs(a.url))} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {a.name} <span className="muted">({fmtSize(a.size)})</span></a>
                      ))}
                      {m.previews && <LinkPreviews messageId={m.id} previews={m.previews} mine={mine} conn={conn} onError={setErr} />}
                    </>
                  )}
                </div>
                {(mine || canManage || canReport || fromBlocked) && editing?.id !== m.id && (
                  <div className="msg-actions">
                    {fromBlocked && <button className="icon" title={t("block.hide")} onClick={() => setRevealed((prev) => { const next = new Set(prev); next.delete(m.id); return next; })}><Icon name="eye-off" /></button>}
                    {!mine && canReport && <button className="icon" title={t("report.reportMessage")} onClick={() => {
                      const text = m.content ? decodeMentions(m.content, members).text : t("chat.attachments", { n: m.attachments.length });
                      setReportedMessage({ text, authorName: nameOf.get(m.authorId) ?? "?", authorKey: members.find((x) => x.userId === m.authorId)?.publicKey ?? null, channelName: channel.name, sentAt: m.createdAt });
                      setReportTarget({ kind: "message", messageId: m.id, authorId: m.authorId, authorName: nameOf.get(m.authorId) ?? "?", excerpt: text.slice(0, 200) });
                    }}><Icon name="flag" /></button>}
                    {mine && m.content && <button className="icon" title={t("chat.edit")} onClick={() => startEdit(m)}><Icon name="pencil" /></button>}
                    {(mine || canManage) && <button className="icon" title={t("common.delete")} onClick={() => { void askConfirm({ title: t("chat.deleteTitle"), text: m.content ? ((c) => c.slice(0, 160) + (c.length > 160 ? "…" : ""))(decodeMentions(m.content, members).text) : t("chat.attachments", { n: m.attachments.length }), confirmLabel: t("common.delete"), danger: true }).then((ok) => { if (ok) return conn.api.deleteMessage(m.id); }).catch((e) => setErr(String(e))); }}><Icon name="trash-2" /></button>}
                  </div>
                )}
              </article>
            </div>
          );
        })}
      </div>
      </MentionContext.Provider>
      {reportTarget && <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)}
        directory={passOn && reportedMessage ? { store: passOn.store, host: passOn.host, passOn: { serverHost: passOn.serverHost, evidence: reportEvidence(reportedMessage) } } : null}
        server={{ api: conn.api, name: serverName, block: (() => { const a = blocked && reportTarget.kind === "message" ? members.find((x) => x.userId === reportTarget.authorId) : null; return a && blocked && !blocked.has(a.publicKey) ? { name: a.displayName, onBlock: () => blocked.onBlock(a.publicKey, a.displayName, !!a.handle) } : null; })() }} />}

      <footer className="composer">
        {mention.popup}
        {err && <p className="error">{err}</p>}
        {files.length > 0 && (
          <div className="pending-files">
            {files.map((f, i) => <PendingFile key={i} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />)}
          </div>
        )}
        {/* Above the input, so that the input stands on the same base line as the dock with the mini profile (user's wish, 21 September 2026). */}
        <div className="typing">{typers.length > 0 && t(typers.length === 1 ? "chat.typingOne" : "chat.typingMany", { names: typers.join(", ") })}</div>
        <div className="composer-row">
          {canAttach && (
            <label className="icon-btn" title={t("chat.attach")}>
              <Icon name="paperclip" title={t("chat.attach")} /><input type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
            </label>
          )}
          <AutoGrowTextarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); mention.sync(); }}
            onKeyDown={onKey}
            onKeyUp={mention.sync}
            onClick={mention.sync}
            onBlur={mention.close}
            rows={1}
            placeholder={!canSend ? t("chat.noPermission") : slowmode > 0 ? t("chat.slowmodePlaceholder", { label: slowmodeLabel(slowmode, { s: t("chan.unit.s"), min: t("chan.unit.min"), h: t("chan.unit.h") }) }) : t("chat.placeholder", { name: channel.name })}
            disabled={!canSend}
            readOnly={sending}
            inputRef={inputRef}
          />
          <EmojiButton inputRef={inputRef} value={draft} onChange={setDraft} disabled={!canSend || sending} />
          <button onClick={submit} disabled={!canSend || sending || waitLeft > 0 || (!draft.trim() && files.length === 0)} title={waitLeft > 0 ? t("chat.slowmodePlaceholder", { label: slowmodeLabel(slowmode, { s: t("chan.unit.s"), min: t("chan.unit.min"), h: t("chan.unit.h") }) }) : undefined}>{waitLeft > 0 ? t("chat.slowmodeWait", { s: waitLeft }) : t("chat.send")}</button>
        </div>
      </footer>
    </section>
  );
}
