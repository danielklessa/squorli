import { handleLabel, type Friend, type Member } from "@squorli/protocol";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AutoGrowTextarea } from "./AutoGrowTextarea";
import { Avatar } from "./Avatar";
import type { BlockControls } from "./blocked";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { EmojiButton } from "./EmojiPicker";
import { GameLine } from "./GameLine";
import { Icon } from "./Icon";
import { t } from "./i18n";

export type ProfileFriends = {
  stateOf: (publicKey: string) => Friend["state"] | null;
  onRequest: (publicKey: string) => void;
  onAccept: (publicKey: string) => void;
  /** Sends a direct message and opens the conversation in the friends view. */
  onSend: (publicKey: string, text: string) => Promise<void>;
};

/**
 * The small profile a left click on a member opens (user's wish, 24 September 2026): avatar, name, handle, game; for a
 * friend a line to write (with emoji) that sends a direct message and switches to the friends view with that friend open;
 * otherwise a button to send a friend request. The context menu stays on the right click. `blocked`: block or unblock the
 * person for me (docs/features/reports.md, stage 3); null = not signed in here.
 */
export function MemberProfile({ anchor, member, isMe, friends, blocked = null, onClose }: { anchor: MenuAnchor; member: Member; isMe: boolean; friends: ProfileFriends | null; blocked?: BlockControls | null; onClose: () => void }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const m = member;
  const st = friends && !isMe ? friends.stateOf(m.publicKey) : null;
  // After the menu's own focus (it takes the first entry when it opens): the line to write gets it.
  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit() {
    const text = draft.trim();
    if (!text || sending || !friends) return;
    setSending(true); setErr(null);
    try { await friends.onSend(m.publicKey, text); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSending(false); }
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
  }

  return (
    <ContextMenu anchor={anchor} label={m.displayName} onClose={onClose}>
      <div className="context-identity" role="presentation"><Avatar name={m.displayName} src={m.avatarUrl} online={m.online} afk={m.afk} /><div><strong>{m.displayName}</strong>{handleLabel(m) && <div className="muted small">{handleLabel(m)}</div>}<GameLine game={m.online ? m.game : null} /></div></div>
      {friends && !isMe && (
        // Arrows, Home/End and Tab belong to the line and its buttons here, not to the menu's item order or its Tab-to-close.
        <div className="member-profile-action" onKeyDown={(e) => { if (["ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(e.key)) e.stopPropagation(); }}>
          {st === "accepted" && (
            <div className="member-profile-compose">
              <AutoGrowTextarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={1} placeholder={t("profile.placeholder")} readOnly={sending} inputRef={inputRef} />
              <EmojiButton inputRef={inputRef} value={draft} onChange={setDraft} disabled={sending} />
              <button className="icon" title={t("profile.send")} aria-label={t("profile.send")} disabled={!draft.trim() || sending} onClick={() => void submit()}><Icon name="send" /></button>
            </div>
          )}
          {st === null && (m.handle
            ? <button role="menuitem" className="small" onClick={() => { friends.onRequest(m.publicKey); onClose(); }}><Icon name="user-plus" /> {t("profile.sendRequest")}</button>
            : <span className="muted small" title={t(m.localHandle ? "members.localNoDmHint" : "home.noAccountHint")}>{t(m.localHandle ? "members.localNoDm" : "members.noDirectoryAccount")}</span>)}
          {st === "pending_out" && <span className="muted small">{t("members.requestSent")}</span>}
          {st === "pending_in" && <button role="menuitem" className="small" onClick={() => { friends.onAccept(m.publicKey); onClose(); }}><Icon name="check" /> {t("profile.acceptRequest")}</button>}
          {st === "blocked" && <span className="muted small">{t("members.blocked")}</span>}
          {err && <p className="error small">{err}</p>}
        </div>
      )}
      {blocked && !isMe && (blocked.has(m.publicKey)
        ? <button role="menuitem" className="secondary small" onClick={() => { onClose(); blocked.onUnblock(m.publicKey); }}><Icon name="undo-2" /> {t("block.unblock")}</button>
        : <button role="menuitem" className="secondary small danger" onClick={() => { onClose(); blocked.onBlock(m.publicKey, m.displayName, !!m.handle); }}><Icon name="ban" /> {t("block.block")}</button>)}
    </ContextMenu>
  );
}
