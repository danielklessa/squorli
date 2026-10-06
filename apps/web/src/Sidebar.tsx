import { platform } from "./platform";
import { Avatar } from "./Avatar";
import { Permission, hasPermission, type Channel, type ServerState, type VoiceMember } from "@squorli/protocol";
import { useMemo, useState } from "react";
import type { ServerApi } from "./api";
import { moveErrorText } from "./apiErrorText";
import { categorySummary, loadCollapsed, pruneCollapsed, saveCollapsed, toggleCollapsed } from "./collapsedCategories";
import { ContextMenu, ContextSubmenu, type MenuAnchor } from "./ContextMenu";
import { askConfirm, askInput } from "./dialogs";
import type { ChannelDialogTarget } from "./ChannelDialog";
import type { VoiceClient, VoiceState } from "./voice/voiceClient";
import { Icon } from "./Icon";
import { t, tOr } from "./i18n";
import { VoiceMemberMenu } from "./VoiceMemberMenu";

type Props = {
  server: ServerState;
  api: ServerApi;
  /** The server's key in the store: the collapsed categories are kept per server and user on this device (collapsedCategories.ts). */
  host: string;
  /** The channel shown in the main area (text channel or the voice channel's stage): only it is highlighted. */
  currentChannelId: string | null;
  voice: Record<string, VoiceMember[]>;
  /** Your own voice connection if it belongs to this server; otherwise null (multi-server client). */
  voiceState: VoiceState | null;
  /** For the per-person playback volume in the voice members' context menu. */
  client: VoiceClient;
  unread: Record<string, boolean>;
  /** How many unread messages per channel (the sum on a collapsed category's heading). */
  unreadCount: Record<string, number>;
  /** Unseen messages that mention me, per channel. */
  mentions: Record<string, number>;
  /** Channels I have muted; `canMute` = the server keeps mutes (offers the context menu). */
  muted: Record<string, boolean>;
  /** Web radio: what a channel's station is playing right now (tooltip of the radio mark). */
  radioTitles: Record<string, string>;
  canMute: boolean;
  onMuteChannel: (channelId: string, muted: boolean) => void;
  /** Right-click "Kanal bearbeiten" / "Kategorie bearbeiten" (docs/features/channel-permissions.md): App.tsx opens the channel dialog. */
  onOpenChannelDialog: (target: ChannelDialogTarget) => void;
  connection: string;
  onSelect: (channelId: string) => void;
  onJoinVoice: (channelId: string) => void;
  onOpenAdmin: () => void;
  myUserId: string;
  /** Phone: opens the member list over the navigation (button at the right end of the header); null = not offered. */
  onOpenMembers: (() => void) | null;
  /** Vote kick (docs/features/votekick.md): per voice channel whether the server would take a vote right now. */
  voteKickAllowed: Record<string, boolean>;
  onVoteKick: (userId: string, channelId: string) => void;
};

export function Sidebar({ server, api, host, currentChannelId, voice, voiceState, client, unread, unreadCount, mentions, muted, radioTitles, canMute, onMuteChannel, onOpenChannelDialog, connection, onSelect, onJoinVoice, onOpenAdmin, myUserId, onOpenMembers, voteKickAllowed, onVoteKick }: Props) {
  // Right-click on a voice member: how loud to play them back (not for yourself).
  const [menu, setMenu] = useState<({ userId: string } & MenuAnchor) | null>(null);
  // Right-click on a channel: mute it for myself, edit or delete it (with the right in that channel).
  const [channelMenu, setChannelMenu] = useState<({ channelId: string } & MenuAnchor) | null>(null);
  // Right-click (or a click) on a category's heading: edit, create a channel inside, delete.
  const [categoryMenu, setCategoryMenu] = useState<({ categoryId: string } & MenuAnchor) | null>(null);
  // Collapsed categories (collapsedCategories.ts, 6 October 2026): this device's choice per server and user; the tick makes
  // the memo read the storage again after a toggle, so a switch to another server shows that server's choice at once.
  const [collapsedTick, setCollapsedTick] = useState(0);
  const collapsed = useMemo(() => loadCollapsed(host, myUserId), [host, myUserId, collapsedTick]);
  const toggleCategory = (id: string) => {
    saveCollapsed(host, myUserId, pruneCollapsed(toggleCollapsed(collapsed, id), server.categories.map((k) => k.id)));
    setCollapsedTick((n) => n + 1);
  };
  const menuChannel = channelMenu ? server.channels.find((c) => c.id === channelMenu.channelId) ?? null : null;
  const menuCategory = categoryMenu ? server.categories.find((k) => k.id === categoryMenu.categoryId) ?? null : null;
  const menuMember = menu ? server.members.find((m) => m.userId === menu.userId) ?? null : null;
  // Voice rows carry only id and name (VoiceMember); the avatar comes from the member list.
  const avatarOf = new Map(server.members.map((m) => [m.userId, m.avatarUrl]));
  // My permissions in a channel or category (docs/features/channel-permissions.md); a server from before knows only the server-wide mask.
  const permsIn = (id: string) => server.myChannelPermissions?.[id] ?? server.myPermissions;
  const canManage = (id: string) => hasPermission(permsIn(id), Permission.MANAGE_CHANNELS);
  // Only against a server that does channel permissions: the dialog would find no routes on an older one.
  const dialogOffered = server.myChannelPermissions !== undefined;
  // Drag & drop: drag a voice participant onto another voice channel (yourself always, others with MOVE_MEMBERS in the channel they sit in).
  const [dragging, setDragging] = useState<{ userId: string; from: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragErr, setDragErr] = useState<string | null>(null);
  const isOwner = (userId: string) => server.members.find((m) => m.userId === userId)?.isOwner ?? false;
  const canDrag = (userId: string, from: string) => userId === myUserId || (hasPermission(permsIn(from), Permission.MOVE_MEMBERS) && !isOwner(userId));
  const lock = server.myVoiceLock ?? null;
  const openChannelMenu = (c: Channel, trigger: HTMLElement, x: number, y: number) => {
    const items = (c.kind === "text" && canMute ? 1 : 0) + (dialogOffered && canManage(c.id) ? 1 : 0);
    if (items > 0) setChannelMenu({ channelId: c.id, trigger, x, y });
  };
  const createChannel = async (kind: "text" | "voice", categoryId: string) => {
    const name = await askInput({ title: t("sidebar.createChannel"), label: t("sidebar.newChannelName"), confirmLabel: t("admin.create") });
    if (name?.trim()) await api.createChannel({ kind, name: name.trim(), categoryId }).catch((e: unknown) => setDragErr(e instanceof Error ? e.message : String(e)));
  };
  const onDrop = (channelId: string) => {
    const d = dragging;
    setDragging(null); setDropTarget(null);
    if (!d || d.from === channelId) return;
    if (d.userId === myUserId) { onJoinVoice(channelId); return; }
    setDragErr(null);
    api.moveMember(d.userId, channelId).catch((e: unknown) => setDragErr(moveErrorText(e)));
  };
  const canAdmin = hasPermission(server.myPermissions, Permission.MANAGE_CHANNELS) || hasPermission(server.myPermissions, Permission.MANAGE_ROLES)
    || hasPermission(server.myPermissions, Permission.MANAGE_SERVER) || hasPermission(server.myPermissions, Permission.BAN_MEMBERS)
    || hasPermission(server.myPermissions, Permission.KICK_MEMBERS) || hasPermission(server.myPermissions, Permission.CREATE_INVITES);
  const groups: { id: string | null; name: string; channels: Channel[] }[] = [
    { id: null, name: "", channels: server.channels.filter((c) => c.categoryId === null || !server.categories.some((k) => k.id === c.categoryId)) },
    ...server.categories.map((k) => ({ id: k.id, name: k.name, channels: server.channels.filter((c) => c.categoryId === k.id) })),
  ].filter((g) => g.channels.length > 0 || g.id !== null);

  const afkOf = new Set(server.members.filter((m) => m.afk).map((m) => m.userId));
  const renderChannel = (c: Channel) => {
    const members = voice[c.id] ?? [];
    const isAfkChannel = c.kind === "voice" && server.settings.afkChannelId === c.id;
    const active = c.id === currentChannelId;
    const joined = c.kind === "voice" && voiceState?.channelId === c.id;
    const droppable = c.kind === "voice" && dragging !== null && dragging.from !== c.id;
    // Held by a sticky channel: the other voice channels are out of reach (the server refuses them; App.tsx says so on a click).
    const lockedOut = c.kind === "voice" && !!lock && lock.channelId !== c.id;
    // Visible but not enterable (no CONNECT_VOICE there): a red lock in place of the speaker, the title says why, and the
    // click still asks the server, whose refusal comes back as the same sentence (apiErrorText.ts).
    const noEntry = c.kind === "voice" && !lockedOut && !hasPermission(permsIn(c.id), Permission.CONNECT_VOICE);
    const full = c.kind === "voice" && c.userLimit !== null && members.length >= c.userLimit && !joined;
    return (
      <li key={c.id} className={`channel ${active ? "active" : ""} ${joined ? "joined" : ""} ${unread[c.id] && !muted[c.id] ? "unread" : ""} ${(mentions[c.id] ?? 0) > 0 ? "mentioned" : ""} ${muted[c.id] ? "muted-channel" : ""} ${droppable ? "droppable" : ""} ${dropTarget === c.id ? "drop-target" : ""} ${lockedOut ? "locked-out" : ""} ${noEntry ? "no-entry" : ""}`}
        onDragOver={(e) => { if (droppable) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dropTarget !== c.id) setDropTarget(c.id); } }}
        onDragLeave={(e) => { if (dropTarget === c.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null); }}
        onDrop={(e) => { if (droppable) { e.preventDefault(); onDrop(c.id); } }}>
        <button className="channel-btn" aria-current={active ? "page" : undefined} onClick={() => (c.kind === "text" ? onSelect(c.id) : onJoinVoice(c.id))} title={lockedOut ? t("voice.stickyBlocked") : noEntry ? t("voice.joinErr.forbidden") : full ? t("sidebar.full") : isAfkChannel ? t("sidebar.afkChannel") : c.topic ?? undefined}
          onContextMenu={(e) => { e.preventDefault(); openChannelMenu(c, e.currentTarget, e.clientX, e.clientY); }}>
          {/* A voice channel one sees but may not enter shows a red lock (user's wish, 6 October 2026); otherwise a lock means private. */}
          <span className={`channel-icon${noEntry ? " no-entry" : ""}`}><Icon name={c.kind === "text" ? "hash" : isAfkChannel ? "moon" : c.private || noEntry ? "lock" : "volume-2"} /></span>
          <span className="channel-name">{c.name}</span>
          {c.private && c.kind === "text" && <span className="channel-flag" title={t("sidebar.private")}><Icon name="lock" /></span>}
          {/* A lock stands for "private" only (user's rule, 23 September 2026), so a sticky channel gets a pin. */}
          {c.sticky && <span className="channel-flag" title={t("sidebar.sticky")}><Icon name="pin" /></span>}
          {c.radio && <span className="channel-radio" title={radioTitles[c.id] ? t("radio.inChannelPlaying", { name: c.radio.name, title: radioTitles[c.id] ?? "" }) : t("radio.inChannel", { name: c.radio.name })}><Icon name="radio" /></span>}
          {c.kind === "voice" && (members.length > 0 || c.userLimit !== null) && <span className={`count${full ? " full" : ""}`}>{c.userLimit !== null ? `${members.length}/${c.userLimit}` : members.length}</span>}
          {onOpenMembers && dialogOffered && canManage(c.id) && <span className="channel-menu-btn" role="button" tabIndex={0} aria-label={t("sidebar.channelMenu")} title={t("sidebar.channelMenu")}
            onClick={(e) => { e.stopPropagation(); openChannelMenu(c, e.currentTarget, e.clientX, e.clientY); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openChannelMenu(c, e.currentTarget, r.left, r.bottom); } }}><Icon name="ellipsis-vertical" /></span>}
          {muted[c.id] && <span className="channel-muted" title={t("sidebar.muted")}><Icon name="bell-off" /></span>}
          {(mentions[c.id] ?? 0) > 0 && <span className="mention-badge" title={t("sidebar.mentions", { n: mentions[c.id] ?? 0 })}>{mentions[c.id]}</span>}
        </button>
        {c.kind === "voice" && members.length > 0 && (
          <ul className="voice-members">
            {members.map((m) => {
              const p = voiceState?.channelId === c.id ? voiceState.participants.find((x) => x.identity === m.userId) : undefined;
              // Mute, sound off, camera and screen: from LiveKit while in the same room (media state, at once), otherwise what
              // the member's client told the server (voice.join/voice.status), so the whole server sees it (23 September 2026).
              const micMuted = p ? p.micMuted : m.micMuted, deafened = p ? p.deafened : m.deafened, cameraOn = p ? p.cameraOn : m.cameraOn, screenOn = p ? p.screenOn : m.screenOn;
              const draggable = canDrag(m.userId, c.id);
              return <li key={m.userId} className={`${p?.speaking ? "speaking" : ""} ${draggable ? "draggable" : ""} ${dragging?.userId === m.userId ? "dragging" : ""} ${menu?.userId === m.userId ? "menu-open" : ""}`}
                draggable={draggable} title={draggable ? t("sidebar.dragHint") : undefined}
                onContextMenu={(e) => { if (m.userId === myUserId) return; e.preventDefault(); setMenu({ userId: m.userId, trigger: e.currentTarget, x: e.clientX, y: e.clientY }); }}
                onDragStart={(e) => { if (!draggable) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", m.userId); setDragging({ userId: m.userId, from: c.id }); }}
                onDragEnd={() => { setDragging(null); setDropTarget(null); }}><Avatar name={m.displayName} src={avatarOf.get(m.userId)} size="small" /><span className="member-name">{m.displayName}</span>{afkOf.has(m.userId) && <Icon name="moon" className="afk" title={t("members.afk")} />}{micMuted && <Icon name="mic-off" className="muted" title={t("voice.micMuted")} />}{deafened && <Icon name="headphone-off" className="muted" title={t("voice.deafened")} />}{cameraOn && <Icon name="video" title={t("voice.cameraOn")} />}{screenOn && <Icon name="screen-share" title={t("voice.sharingScreen")} />}</li>;
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <nav className="sidebar">
      <header className="server-head">
        <img className={`brand-mark ${server.settings.iconUrl ? "server-icon" : ""}`} src={server.settings.iconUrl ? api.abs(server.settings.iconUrl) : "/brand/squorli-icon-small.svg"} alt="" width="22" height="22" />
        <strong>{server.settings.name}</strong>
        {connection !== "connected" && <span className="muted"> · {tOr(`conn.${connection}`, connection)}</span>}
        {canAdmin && <button className="icon" title={t("sidebar.admin")} onClick={onOpenAdmin}><Icon name="settings" /></button>}
        {onOpenMembers && <button className="icon" title={t("sidebar.members")} aria-label={t("sidebar.members")} onClick={onOpenMembers}><Icon name="users" /></button>}
      </header>
      {channelMenu && menuChannel && (
        <ContextMenu anchor={channelMenu} label={menuChannel.name} onClose={() => setChannelMenu(null)}>
          {menuChannel.kind === "text" && canMute && <button role="menuitem" onClick={() => { onMuteChannel(menuChannel.id, !muted[menuChannel.id]); setChannelMenu(null); }}>
            <Icon name={muted[menuChannel.id] ? "bell" : "bell-off"} /> {muted[menuChannel.id] ? t("sidebar.unmuteChannel") : t("sidebar.muteChannel")}
          </button>}
          {dialogOffered && canManage(menuChannel.id) && <>
            <button role="menuitem" onClick={() => { onOpenChannelDialog({ kind: "channel", id: menuChannel.id }); setChannelMenu(null); }}><Icon name="pencil" /> {t("sidebar.editChannel")}</button>
            <button role="menuitem" className="danger" onClick={() => { setChannelMenu(null); void askConfirm({ title: t("admin.deleteChannelTitle", { name: menuChannel.name }), text: menuChannel.kind === "text" ? t("admin.deleteTextChannelText") : t("admin.deleteVoiceChannelText"), confirmLabel: t("common.delete"), danger: true })
              .then((ok) => { if (ok) return api.deleteChannel(menuChannel.id); }).catch((e: unknown) => setDragErr(e instanceof Error ? e.message : String(e))); }}><Icon name="trash-2" /> {t("sidebar.deleteChannel")}</button>
          </>}
        </ContextMenu>
      )}
      {categoryMenu && menuCategory && (
        <ContextMenu anchor={categoryMenu} label={menuCategory.name} onClose={() => setCategoryMenu(null)}>
          <button role="menuitem" onClick={() => { onOpenChannelDialog({ kind: "category", id: menuCategory.id }); setCategoryMenu(null); }}><Icon name="pencil" /> {t("sidebar.editCategory")}</button>
          <ContextSubmenu label={t("sidebar.createChannel")}>
            <button role="menuitem" onClick={() => { setCategoryMenu(null); void createChannel("text", menuCategory.id); }}><Icon name="hash" /> {t("sidebar.newTextChannel")}</button>
            <button role="menuitem" onClick={() => { setCategoryMenu(null); void createChannel("voice", menuCategory.id); }}><Icon name="volume-2" /> {t("sidebar.newVoiceChannel")}</button>
          </ContextSubmenu>
          <button role="menuitem" className="danger" onClick={() => { setCategoryMenu(null); void askConfirm({ title: t("admin.deleteCategoryTitle", { name: menuCategory.name }), text: t("admin.deleteCategoryText"), confirmLabel: t("common.delete"), danger: true })
            .then((ok) => { if (ok) return api.deleteCategory(menuCategory.id); }).catch((e: unknown) => setDragErr(e instanceof Error ? e.message : String(e))); }}><Icon name="trash-2" /> {t("sidebar.deleteCategory")}</button>
        </ContextMenu>
      )}
      {/* The same menu as on the stage's tiles (VoiceMemberMenu.tsx). */}
      {menu && menuMember && <VoiceMemberMenu anchor={menu} member={menuMember} client={client} voiceState={voiceState} api={api} myUserId={myUserId}
        permsIn={(id) => (id ? permsIn(id) : server.myPermissions)} voice={voice} channels={server.channels}
        voteKickAllowed={voteKickAllowed} onVoteKick={onVoteKick} onClose={() => setMenu(null)} onError={setDragErr} />}
      {dragErr && <p className="error small" style={{ padding: "0 0.9rem" }}>{dragErr}</p>}
      <div className="channel-list">
        {groups.map((g) => {
          const isCollapsed = g.id !== null && collapsed.has(g.id);
          // Collapsed: the heading sums up what the folded channels would show; only the channel on screen stays in the list.
          const sum = isCollapsed ? categorySummary(g.channels, { unread, unreadCount, mentions, muted, voice, afkChannelId: server.settings.afkChannelId ?? null }) : null;
          const shown = isCollapsed ? g.channels.filter((c) => c.id === currentChannelId) : g.channels;
          const menuOffered = g.id !== null && dialogOffered && canManage(g.id);
          const openCategoryMenu = (trigger: HTMLElement, x: number, y: number) => setCategoryMenu({ categoryId: g.id!, trigger, x, y });
          return (
            <section key={g.id ?? "none"} className={isCollapsed ? "collapsed" : undefined}>
              {g.id !== null && (
                // A button inside the heading keeps its semantics and makes the category reachable by keyboard: Enter folds it,
                // the context menu key (Shift+F10) opens the menu. Context menus open on a right-click only (user's rule,
                // 24 September 2026); a phone has none, so there the menu has a button of its own at the right.
                <h3 className={`category-head${isCollapsed ? " collapsed" : ""}${sum && sum.unread > 0 ? " unread" : ""}${sum && sum.mentions > 0 ? " mentioned" : ""}`}>
                  <button className="category-btn" aria-expanded={!isCollapsed} title={isCollapsed ? t("sidebar.expandCategory") : t("sidebar.collapseCategory")}
                    onClick={() => toggleCategory(g.id!)}
                    onContextMenu={menuOffered ? (e) => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); openCategoryMenu(e.currentTarget, e.clientX || r.left, e.clientY || r.bottom); } : undefined}>
                    <Icon name="chevron-down" className="category-chevron" />
                    <span className="category-name">{g.name}</span>
                    {sum && sum.voice > 0 && <span className="category-voice" title={t("sidebar.categoryVoice", { n: sum.voice })} aria-label={t("sidebar.categoryVoice", { n: sum.voice })}><Icon name="volume-2" />{sum.voice}</span>}
                    {sum && sum.unread > 0 && <span className="category-unread" title={t("sidebar.categoryUnread", { n: sum.unread })} aria-label={t("sidebar.categoryUnread", { n: sum.unread })}>{sum.unread}</span>}
                    {sum && sum.mentions > 0 && <span className="mention-badge" title={t("sidebar.mentions", { n: sum.mentions })} aria-label={t("sidebar.mentions", { n: sum.mentions })}>{sum.mentions}</span>}
                  </button>
                  {menuOffered && platform.mobile && <button className="icon category-menu-btn" aria-haspopup="menu" aria-label={t("sidebar.categoryMenu", { name: g.name })} title={t("sidebar.categoryMenu", { name: g.name })}
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openCategoryMenu(e.currentTarget, r.left, r.bottom); }}><Icon name="ellipsis-vertical" /></button>}
                </h3>
              )}
              <ul>{shown.map(renderChannel)}</ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
