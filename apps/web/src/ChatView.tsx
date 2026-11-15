import { AutoGrowTextarea } from "./AutoGrowTextarea";
import { Avatar } from "./Avatar";
import { Permission, hasPermission, pluginText, type Channel, type Member, type Message, type PluginCommand, type PluginSurface, type PluginText, type Role } from "@squorli/protocol";
import { ApiError } from "./api";
import { pluginProblem, reactionErrorText } from "./apiErrorText";
import type { BlockControls } from "./blocked";
import { slowmodeLabel, slowmodeRemaining } from "./channelPerms";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { askConfirm } from "./dialogs";
import { EmojiButton, EmojiPicker } from "./EmojiPicker";
import { Icon } from "./Icon";
import { Reactions } from "./Reactions";
import { ReactionRolesDialog } from "./ReactionRolesDialog";
import { LinkPreviews } from "./LinkPreviews";
import { PluginCard } from "./PluginCard";
import { MentionContext, MessageText } from "./MessageText";
import { useMentionSuggest } from "./MentionSuggest";
import { useCommandSuggest } from "./CommandSuggest";
import { PluginFormDialog, PluginProblemText } from "./PluginFormDialog";
import { parseCommandDraft, usableCommands } from "./pluginFields";
import { decodeMentions, encodeMentions, mentionsUser } from "./mentions";
import { pastedFiles } from "./pasteFiles";
import { safeHref } from "./safeHref";
import { ReportDialog, reportEvidence, type DirectorySide, type ReportTarget } from "./ReportDialog";
import type { ChannelMessages } from "./store";
import type { ServerConnection } from "./serverConnection";
import { fmtDay, fmtTime, locale, t } from "./i18n";

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
  /** Reaction roles (docs/features/reactions.md): the shield in a message's toolbar, MANAGE_ROLES against a server that does reactions. */
  canReactionRoles?: boolean;
  /** The server's roles, for the chips' tooltips and the rules dialog. */
  roles?: readonly Role[];
  /**
   * What the enabled plugins add (docs/features/plugins.md): their slash commands in the composer. undefined = a server
   * without plugins. `channels` = the channels this member sees, for a command's form.
   */
  plugins?: PluginSurface | undefined;
  channels?: readonly Channel[];
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

export function ChatView({ channel, messages, members, myUserId, myPermissions, typing, conn, canReport = false, serverName = "", blocked = null, passOn = null, canReactionRoles = false, roles = [], plugins, channels = [] }: Props) {
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  // Reactions (docs/features/reactions.md): the picker opened from a message's toolbar, and the rules dialog of a message.
  const [pickerFor, setPickerFor] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [rulesFor, setRulesFor] = useState<Message | null>(null);
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
  // Slash commands of the plugins (docs/features/plugins.md): the ones whose permission the member holds in THIS channel
  // (`myPermissions` is the channel's mask); none while files are attached, a command takes none.
  const commands = useMemo(() => (files.length > 0 ? [] : usableCommands(plugins, myPermissions)), [plugins, myPermissions, files.length]);
  /** A command with a form whose dialog is open. */
  const [commandForm, setCommandForm] = useState<PluginCommand | null>(null);
  /** What a command answered: for the caller only, shown above the composer until dismissed. */
  const [commandNote, setCommandNote] = useState<{ plugin: PluginText; text: string; detail: string | null; failed: boolean } | null>(null);
  const command = useCommandSuggest({ inputRef, commands, onAccept: (c) => {
    if (c.input === "form") { setDraft(""); setCommandForm(c); return; }
    if (c.input === "text") {
      // The composer keeps "/name " and Enter sends what follows as the command's text.
      const next = `/${c.name} `;
      setDraft(next);
      requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(next.length, next.length); });
      return;
    }
    setDraft("");
    void runCommand(c);
  } });
  const canSend = hasPermission(myPermissions, Permission.SEND_MESSAGES);
  const canAttach = hasPermission(myPermissions, Permission.ATTACH_FILES);
  const canManage = hasPermission(myPermissions, Permission.MANAGE_MESSAGES);
  const canReact = hasPermission(myPermissions, Permission.ADD_REACTIONS);
  // Notices (docs/features/notices.md): the megaphone in a message's toolbar turns it into a notice and back.
  const canNotice = hasPermission(myPermissions, Permission.MANAGE_NOTICES);
  const me = useMemo(() => members.find((m) => m.userId === myUserId), [members, myUserId]);
  const react = (m: Message, emoji: string, on: boolean) => conn.react(channel.id, m.id, emoji, on).catch((e) => { setErr(reactionErrorText(e)); throw e; });
  /** Who reacted with one emoji, as names: me as "Du", a former member by that name. */
  const whoOf = (messageId: string) => async (emoji: string) => {
    const r = await conn.api.reactionUsers(messageId, emoji);
    return { names: r.userIds.map((id) => (id === myUserId ? t("chat.reactionYou") : nameOf.get(id) ?? t("chat.formerMember"))), more: r.total - r.userIds.length };
  };
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
  useEffect(() => { stickToBottom.current = true; setDraft(""); setFiles([]); setEditing(null); setLastSentAt(null); setPickerFor(null); setRulesFor(null); setCommandForm(null); setCommandNote(null); mention.picked.clear(); mention.close(); command.close(); editMention.close(); }, [channel.id]);
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

  /**
   * Run a plugin's command in this channel instead of posting a message. The answer's `message` is for the caller only
   * (the line above the composer); what the plugin posts publicly arrives like any message. true = it ran.
   */
  async function runCommand(c: PluginCommand, text?: string): Promise<boolean> {
    if (sending) return false;
    setSending(true); setErr(null); setCommandNote(null);
    try {
      const r = await conn.api.runCommand(channel.id, { plugin: c.plugin, name: c.name, ...(text !== undefined ? { text } : {}) });
      const said = pluginText(r.message, locale);
      if (said || !r.ok) setCommandNote({ plugin: c.pluginName, text: said || t("plugin.notDone"), detail: null, failed: !r.ok });
      return r.ok;
    } catch (e) {
      const problem = pluginProblem(e);
      setCommandNote({ plugin: c.pluginName, text: problem.text, detail: problem.detail, failed: true });
      return false;
    } finally { setSending(false); inputRef.current?.focus(); }
  }

  async function submit() {
    const content = draft.trim();
    // "/name" or "/name rest" with the name of a command the member may use here runs it; any other draft that starts
    // with a slash ("//…", an unknown name) is a message as it always was.
    const asCommand = parseCommandDraft(draft, commands);
    if (asCommand) {
      if (sending) return;
      command.close();
      if (asCommand.command.input === "form") { setDraft(""); setCommandForm(asCommand.command); return; }
      if (await runCommand(asCommand.command, asCommand.command.input === "text" ? asCommand.text : undefined)) setDraft("");
      return;
    }
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
    if (command.onKeyDown(e)) return;   // the command list first: it is only open while the draft is a "/name"
    if (mention.onKeyDown(e)) return;   // the suggestion list takes arrows, Enter, Tab and Escape while it is open
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
    // No "is typing" while a command is being written (from its slash on): nobody else gets to see it.
    else if (!(commands.length > 0 && (draft === "" ? e.key === "/" : draft.startsWith("/") && !draft.startsWith("//"))) && Date.now() - lastTyping.current > 2500) { lastTyping.current = Date.now(); conn.typing(channel.id); }
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
          // Written by a plugin (docs/features/plugins.md): checked BEFORE the notice, because the server sends such a message
          // with `notice: true` for apps from before plugins. Here it is a normal row whose head names the plugin.
          const plugin = m.plugin ?? null;
          const notice = m.notice && !plugin;
          // A notice never groups: it carries no author, and the message after it needs its head again. A plugin counts as an
          // author of its own, per member who caused the message (the head names that member).
          const authorOf = (x: Message) => (x.plugin ? `plugin:${x.plugin.id}:${x.plugin.by ?? ""}` : x.authorId);
          const grouped = prev && !(prev.notice && !prev.plugin) && !notice && authorOf(prev) === authorOf(m) && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS;
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
              <article className={`msg ${notice ? "notice" : ""} ${plugin ? "from-plugin" : ""} ${grouped && !newDay ? "grouped" : ""} ${mentioned ? "mentions-me" : ""} ${pickerFor?.id === m.id ? "picker-open" : ""}`}>
                {/* A notice shows no author: only the time, where the avatar normally stands (user's wish, 6 October 2026). */}
                {notice && <time className="muted notice-time" dateTime={m.createdAt} title={t("chat.notice")}>{fmtTime(m.createdAt)}</time>}
                {!notice && !(grouped && !newDay) && (plugin ? (
                  // The plugin's name as plain text, the one icon all plugins share where the avatar stands, and who caused it.
                  <div className="msg-head">
                    <span className="user-avatar plugin-avatar" aria-hidden="true"><Icon name="puzzle" /></span>
                    <strong>{pluginText(plugin.name, locale) || plugin.id}</strong>
                    <span className="badge plugin-badge">{t("plugin.badge")}</span>
                    {plugin.by && <span className="muted small">{t("plugin.triggeredBy", { name: nameOf.get(plugin.by) ?? t("chat.formerMember") })}</span>}
                    <time className="muted" dateTime={m.createdAt}>{fmtTime(m.createdAt)}</time>
                  </div>
                ) : (
                  <div className="msg-head">
                    <Avatar name={nameOf.get(m.authorId) ?? t("chat.formerMember")} src={avatarOf.get(m.authorId)} />
                    <strong>{nameOf.get(m.authorId) ?? t("chat.formerMember")}</strong>
                    <time className="muted" dateTime={m.createdAt}>{fmtTime(m.createdAt)}</time>
                  </div>
                ))}
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
                      {/* A plugin's card stands in the place of the text (which is what an app from before cards shows) and of the link previews. */}
                      {plugin?.card
                        ? <PluginCard card={plugin.card} image={plugin.card.image ? conn.api.abs(plugin.card.image) : null} thumbnail={plugin.card.thumbnail ? conn.api.abs(plugin.card.thumbnail) : null} />
                        : m.content && <MessageText text={m.content} edited={m.editedAt !== null} />}
                      {m.attachments.map((a) => (
                        a.mimeType.startsWith("image/")
                          ? <a key={a.id} href={safeHref(conn.api.abs(a.url))} target="_blank" rel="noreferrer"><img className="attachment-img" src={conn.api.abs(a.url)} alt={a.name} loading="lazy" /></a>
                          : <a key={a.id} className="attachment" href={safeHref(conn.api.abs(a.url))} target="_blank" rel="noreferrer"><Icon name="paperclip" /> {a.name} <span className="muted">({fmtSize(a.size)})</span></a>
                      ))}
                      {m.previews && !plugin?.card && <LinkPreviews messageId={m.id} previews={m.previews} mine={mine} conn={conn} onError={setErr} />}
                      {m.reactions && m.reactions.length > 0 && <Reactions chips={m.reactions} canReact={canReact} roles={roles} onToggle={(emoji, on) => react(m, emoji, on)} whoOf={whoOf(m.id)} onError={setErr} />}
                    </>
                  )}
                </div>
                {(mine || canManage || (canNotice && !plugin) || canReport || fromBlocked || (m.reactions && (canReact || canReactionRoles))) && editing?.id !== m.id && (
                  <div className="msg-actions">
                    {/* Not on a plugin's message: its `notice` is only how apps from before plugins show it, and the server keeps it. */}
                    {canNotice && !plugin && (m.notice
                      ? <button className="icon" title={t("chat.unmakeNotice")} onClick={() => conn.api.setNotice(m.id, false).catch((e: unknown) => setErr(String(e)))}><Icon name="megaphone-off" /></button>
                      : <button className="icon" title={t("chat.makeNotice")} onClick={() => conn.api.setNotice(m.id, true).catch((e: unknown) => setErr(String(e)))}><Icon name="megaphone" /></button>)}
                    {m.reactions && canReact && !m.reactions.some((c) => c.roleId) && <button className="icon" title={t("chat.react")} aria-haspopup="dialog" aria-expanded={pickerFor?.id === m.id} onClick={(e) => setPickerFor((cur) => (cur?.id === m.id ? null : { id: m.id, anchor: e.currentTarget }))}><Icon name="smile-plus" /></button>}
                    {m.reactions && canReactionRoles && me && <button className="icon" title={t("chat.reactionRoles")} onClick={() => setRulesFor(m)}><Icon name="shield-plus" /></button>}
                    {fromBlocked && <button className="icon" title={t("block.hide")} onClick={() => setRevealed((prev) => { const next = new Set(prev); next.delete(m.id); return next; })}><Icon name="eye-off" /></button>}
                    {!mine && canReport && <button className="icon" title={t("report.reportMessage")} onClick={() => {
                      const text = m.content ? decodeMentions(m.content, members).text : t("chat.attachments", { n: m.attachments.length });
                      // A plugin's message is reported like any other; its author shows as the plugin's name.
                      const authorName = plugin ? pluginText(plugin.name, locale) || plugin.id : nameOf.get(m.authorId) ?? "?";
                      setReportedMessage({ text, authorName, authorKey: members.find((x) => x.userId === m.authorId)?.publicKey ?? null, channelName: channel.name, sentAt: m.createdAt });
                      setReportTarget({ kind: "message", messageId: m.id, authorId: m.authorId, authorName, excerpt: text.slice(0, 200) });
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
      {pickerFor && <EmojiPicker anchor={pickerFor.anchor} onPick={(emoji) => { const m = messages.list.find((x) => x.id === pickerFor.id); setPickerFor(null); if (m) void react(m, emoji, true).catch(() => undefined); }} onClose={() => setPickerFor(null)} onDismiss={() => setPickerFor(null)} />}
      {rulesFor && me && <ReactionRolesDialog message={messages.list.find((x) => x.id === rulesFor.id) ?? rulesFor} roles={roles} me={me} api={conn.api} onClose={() => setRulesFor(null)} />}
      {reportTarget && <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)}
        directory={passOn && reportedMessage ? { store: passOn.store, host: passOn.host, passOn: { serverHost: passOn.serverHost, evidence: reportEvidence(reportedMessage) } } : null}
        server={{ api: conn.api, name: serverName, block: (() => { const a = blocked && reportTarget.kind === "message" ? members.find((x) => x.userId === reportTarget.authorId) : null; return a && blocked && !blocked.has(a.publicKey) ? { name: a.displayName, onBlock: () => blocked.onBlock(a.publicKey, a.displayName, !!a.handle) } : null; })() }} />}

      {commandForm && <PluginFormDialog pluginName={commandForm.pluginName} title={`/${commandForm.name}`} intro={<p className="muted small">{pluginText(commandForm.description, locale)}</p>}
        fields={commandForm.fields} context={{ roles, channels, members, me: me ?? null }} onClose={() => { setCommandForm(null); inputRef.current?.focus(); }}
        onSubmit={(values) => conn.api.runCommand(channel.id, { plugin: commandForm.plugin, name: commandForm.name, values })} />}

      <footer className="composer">
        {mention.popup}
        {command.popup}
        {err && <p className="error">{err}</p>}
        {/* A command's answer (docs/features/plugins.md): only the caller sees it, so it stands here and not in the channel. */}
        {commandNote && (
          <div className={`plugin-note${commandNote.failed ? " failed" : ""}`} role="status">
            <span className="plugin-note-icon"><Icon name="puzzle" /></span>
            <div className="plugin-note-body">
              <div className="plugin-note-head"><strong>{pluginText(commandNote.plugin, locale)}</strong><span className="badge plugin-badge">{t("plugin.badge")}</span><span className="muted small">{t("plugin.onlyYou")}</span></div>
              {commandNote.failed ? <PluginProblemText problem={{ text: commandNote.text, detail: commandNote.detail }} /> : <p className="plugin-note-text">{commandNote.text}</p>}
            </div>
            <button className="icon" title={t("common.dismiss")} aria-label={t("common.dismiss")} onClick={() => setCommandNote(null)}><Icon name="x" /></button>
          </div>
        )}
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
            onChange={(e) => { setDraft(e.target.value); mention.sync(); command.sync(); }}
            onKeyDown={onKey}
            onKeyUp={() => { mention.sync(); command.sync(); }}
            onClick={() => { mention.sync(); command.sync(); }}
            onBlur={() => { mention.close(); command.close(); }}
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
