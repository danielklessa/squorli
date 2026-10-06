import { Avatar } from "./Avatar";
import { Permission, handleLabel, hasPermission, type Channel, type Member, type Role, type VoiceMember } from "@squorli/protocol";
import { useState, type MouseEvent, type ReactNode } from "react";
import { ContextMenu, ContextSubmenu, type MenuAnchor } from "./ContextMenu";
import type { ServerApi } from "./api";
import type { BlockControls } from "./blocked";
import { askConfirm, askInput } from "./dialogs";
import { Icon } from "./Icon";
import { GameLine } from "./GameLine";
import { t } from "./i18n";
import { assignableRoles, canSetRolesOf, rolesByRank, topRoleOf } from "./memberRank";
import { VoiceMemberActions } from "./VoiceMemberActions";
import { MemberProfile, type ProfileFriends } from "./MemberProfile";
import { ReportDialog, type ReportTarget } from "./ReportDialog";
import { askDeleteRecentHours } from "./ReportsTab";
import { platform } from "./platform";

type Props = {
  api: ServerApi;
  /** ownerId = first owner (cannot be revoked); further owners carry isOwner. */
  members: Member[]; roles: Role[]; myUserId: string; myPermissions: number; ownerId: string | null;
  /** My permissions per channel (docs/features/channel-permissions.md); undefined on a server from before. */
  channelPermissions?: Record<string, number> | undefined;
  /** Voice channel presence (channelId -> members) and channels for moderation (moving). */
  voice: Record<string, VoiceMember[]>; channels: Channel[];
  /** The server takes reports (docs/features/reports.md): "Melden" in the member menu. */
  canReport?: boolean; serverName?: string;
  /** A member's directory account (name, picture) can be reported to the directory's operator; null = not offered. */
  onReportAccount?: ((publicKey: string, name: string) => void) | null;
  /** M7: friends via the directory; null = no directory socket (then no entries in the menu). */
  friends: (ProfileFriends & { onMessage: (publicKey: string) => void; onRemove: (publicKey: string, name: string) => void }) | null;
  /** Blocking a member for me (docs/features/reports.md, stage 3): the menu's entry and the mark in the row; null = not signed in here. */
  blocked?: BlockControls | null;
  /** Phone: the list is a panel slid in from the right; a header with this close button sits on top. null = the desktop column. */
  onClose?: (() => void) | null;
  /** Vote kick (docs/features/votekick.md): per voice channel whether the server would take a vote right now. */
  voteKickAllowed: Record<string, boolean>;
  onVoteKick: (userId: string, channelId: string) => void;
  /** The running vote's box, at the top of this list (user's wish, 23 September 2026); null = none right now. */
  voteKickBox: ReactNode;
};

/** Right column: owners at the very top, then members grouped by highest role, online first. Context actions depending on permissions. */
export function MemberList({ api, members, roles, myUserId, myPermissions, ownerId, channelPermissions, voice, channels, friends, blocked = null, onClose = null, voteKickAllowed, onVoteKick, voteKickBox, canReport = false, serverName = "", onReportAccount = null }: Props) {
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [open, setOpen] = useState<({ userId: string } & MenuAnchor) | null>(null);
  const openMenu = (event: MouseEvent<HTMLButtonElement>, userId: string) => {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    setOpen({ userId, trigger: event.currentTarget, x: event.type === "contextmenu" && event.clientX ? event.clientX : box.left, y: event.type === "contextmenu" && event.clientY ? event.clientY : box.bottom });
  };
  const [err, setErr] = useState<string | null>(null);
  // Left click (not on a phone, where a tap opens the menu): the small profile with a line to write (user's wish, 24 September 2026).
  const [profile, setProfile] = useState<({ userId: string } & MenuAnchor) | null>(null);
  const openProfile = (event: MouseEvent<HTMLButtonElement>, userId: string) => {
    const box = event.currentTarget.getBoundingClientRect();
    setOpen(null);
    setProfile({ userId, trigger: event.currentTarget, x: box.left, y: box.top });
  };
  const profileMember = profile ? members.find((m) => m.userId === profile.userId) ?? null : null;
  /** Roles ticked in the open menu before the server's answer came back; later ticks build on them, not on the old list. */
  const [draft, setDraft] = useState<{ userId: string; roleIds: string[] } | null>(null);
  const closeMenu = () => { setOpen(null); setDraft(null); };
  const menuMember = open ? members.find((m) => m.userId === open.userId) ?? null : null;
  const topRole = (m: Member) => topRoleOf(m, roles);
  const groups = new Map<string, { name: string; color: string | null; position: number; members: Member[] }>();
  for (const m of members) {
    const r = topRole(m);
    const key = m.isOwner ? "_owner" : m.online ? (r?.id ?? "_online") : "_offline";
    const g = groups.get(key) ?? (m.isOwner
      ? { name: t("members.owners"), color: null, position: Number.MAX_SAFE_INTEGER, members: [] }
      : { name: m.online ? (r?.name ?? t("members.online")) : t("members.offline"), color: m.online ? (r?.color ?? null) : null, position: m.online ? (r?.position ?? 0) : -1, members: [] });
    g.members.push(m);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.position - a.position);
  const canKick = hasPermission(myPermissions, Permission.KICK_MEMBERS);
  const canBan = hasPermission(myPermissions, Permission.BAN_MEMBERS);
  const canRoles = hasPermission(myPermissions, Permission.MANAGE_ROLES);
  // The voice entries ask per channel (VoiceMemberActions.tsx): an overwrite may give the moderation rights in one channel only.
  const permsIn = (channelId: string | null) => (channelId ? channelPermissions?.[channelId] : undefined) ?? myPermissions;
  const meMember = members.find((m) => m.userId === myUserId) ?? null;
  const iAmOwner = meMember?.isOwner ?? false;
  // Only what the server would accept is offered (memberRank.ts): roles below my own, and members I may act on.
  const myRoles = meMember && canRoles ? assignableRoles(meMember, roles) : [];

  async function run(fn: () => Promise<unknown>, explain: (e: unknown) => string = String) {
    setErr(null);
    closeMenu();
    try { await fn(); } catch (e) { setErr(explain(e)); }
  }
  /** Giving or taking a role keeps the menu open (user's wish, 24 September 2026). */
  function toggleRole(m: Member, current: string[], roleId: string) {
    const next = current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId];
    setErr(null);
    setDraft({ userId: m.userId, roleIds: next });
    api.setMemberRoles(m.userId, next).catch((e: unknown) => { setErr(String(e)); setDraft(null); });
  }

  return (
    <aside className="members-col" aria-label={t("members.title")}>
      {onClose && <header className="members-head"><strong>{t("members.title")} · {members.length}</strong><button className="icon" title={t("members.close")} aria-label={t("members.close")} onClick={onClose}><Icon name="x" /></button></header>}
      {voteKickBox}
      {err && <p className="error small">{err}</p>}
      {ordered.map((g) => (
        <section key={g.name + g.position}>
          <h4 style={g.color ? { color: g.color } : undefined}>{g.name} · {g.members.length}</h4>
          <ul>
            {g.members.map((m) => {
              const r = topRole(m);
              const isMe = m.userId === myUserId;
              return (
                <li key={m.userId} className={`member ${m.online ? "" : "offline"}`}>
                  <button className="member-btn" aria-haspopup="menu" aria-expanded={open?.userId === m.userId} onContextMenu={(e) => openMenu(e, m.userId)} onClick={(e) => (platform.mobile ? openMenu(e, m.userId) : openProfile(e, m.userId))}>
                    <Avatar name={m.displayName} src={m.avatarUrl} online={m.online} afk={m.afk} />
                    <span className="member-identity"><span style={r?.color ? { color: r.color } : undefined}>{m.displayName}</span><GameLine game={m.online ? m.game : null} fallback={(handleLabel(m) || isMe) && <small>{handleLabel(m)}{handleLabel(m) && isMe && " "}{isMe && t("members.you")}</small>} /></span>
                    {m.online && m.afk && <Icon name="moon" className="afk" title={t("members.afk")} />}
                    {m.isOwner && <Icon name="crown" className="owner" title={t("members.owner")} />}
                    {m.streamBlocked && <Icon name="video-off" className="muted" title={t("members.streamBlocked")} />}
                    {blocked?.has(m.publicKey) && <Icon name="ban" className="muted" title={t("members.blocked")} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {profile && profileMember && <MemberProfile anchor={profile} member={profileMember} isMe={profileMember.userId === myUserId} friends={friends} blocked={blocked} onClose={() => setProfile(null)} />}
      {open && menuMember && (() => {
        // The menu lives outside the rows: a role given here can move the member into another group, and the menu (with its
        // open roles submenu) must stay where it is so several roles can be ticked in a row (user's wish, 24 September 2026).
        const m = menuMember;
        const isMe = m.userId === myUserId;
        const roleIds = draft?.userId === m.userId ? draft.roleIds : m.roleIds;
        return (
          <ContextMenu anchor={open} label={m.displayName} onClose={closeMenu}>
            <div className="context-identity" role="presentation"><Avatar name={m.displayName} src={m.avatarUrl} online={m.online} afk={m.afk} /><div><strong>{m.displayName}</strong><GameLine game={m.online ? m.game : null} /></div></div>
            <div className="muted small">{handleLabel(m) && <><strong>{handleLabel(m)}</strong> · </>}{m.publicKey.slice(0, 16)}…</div>
            {friends && !isMe && (() => {
              // M7: add friend / write a message. Without a handle the member has no directory account, so friendship is not possible.
              const st = friends.stateOf(m.publicKey);
              return (
                <div className="row friend-row">
                  {st === "accepted" && <button role="menuitem" className="secondary small" onClick={() => { closeMenu(); friends.onMessage(m.publicKey); }}><Icon name="message-circle" /> {t("members.writeMessage")}</button>}
                  {st === "accepted" && <button role="menuitem" className="secondary small danger" onClick={() => { closeMenu(); friends.onRemove(m.publicKey, m.displayName); }}><Icon name="user-minus" /> {t("friends.remove")}</button>}
                  {st === "pending_out" && <span className="muted small">{t("members.requestSent")}</span>}
                  {st === "pending_in" && <button role="menuitem" className="secondary small" onClick={() => { closeMenu(); friends.onMessage(m.publicKey); }}>{t("members.wantsFriend")}</button>}
                  {st === "blocked" && <span className="muted small">{t("members.blocked")}</span>}
                  {st === null && (m.handle
                    ? <button role="menuitem" className="secondary small" onClick={() => { closeMenu(); friends.onRequest(m.publicKey); }}><Icon name="user-plus" /> {t("home.addFriend")}</button>
                    : <span className="muted small" title={t(m.localHandle ? "members.localNoDmHint" : "home.noAccountHint")}>{t(m.localHandle ? "members.localNoDm" : "members.noDirectoryAccount")}</span>)}
                </div>
              );
            })()}
            {/* Blocking for me (stage 3): a view of this client, no server action; hence outside the "Server" section below. */}
            {blocked && !isMe && (blocked.has(m.publicKey)
              ? <button role="menuitem" className="secondary small" onClick={() => { closeMenu(); blocked.onUnblock(m.publicKey); }}><Icon name="undo-2" /> {t("block.unblock")}</button>
              : <button role="menuitem" className="secondary small danger" onClick={() => { closeMenu(); blocked.onBlock(m.publicKey, m.displayName, !!m.handle); }}><Icon name="ban" /> {t("block.block")}</button>)}
            {/* The directory account as it shows everywhere (name, picture): to the directory's operator, not to this server's moderators. */}
            {onReportAccount && !isMe && m.handle && <button role="menuitem" className="secondary small" onClick={() => { closeMenu(); onReportAccount(m.publicKey, `@${m.handle}`); }}><Icon name="flag" /> {t("report.reportAccount")}</button>}
            <VoiceMemberActions api={api} member={m} myUserId={myUserId} permsIn={permsIn} voice={voice} channels={channels}
              voteKickAllowed={voteKickAllowed} onVoteKick={onVoteKick} onClose={closeMenu} onError={setErr} />
            {/* Everything that acts on the whole server, not on a channel (user's wishes, 24 September 2026): roles, owner status,
                kick and ban under one "Server" title. */}
            {(() => {
              // One's own roles only as an owner (canSetRolesOf); everybody else sees their own roles read-only (user's wish,
              // 6 October 2026: "damit ich weiß welche Rollen ich selbst habe").
              const canRolesOf = !!meMember && myRoles.length > 0 && canSetRolesOf(meMember, m, roles, ownerId);
              const ownRoles = isMe && !canRolesOf ? rolesByRank(roles.filter((r) => !r.isDefault && roleIds.includes(r.id))) : null;
              const canOwnerOf = iAmOwner && !isMe && (!m.isOwner || m.userId !== ownerId);
              const canRemove = !isMe && !m.isOwner && (canKick || canBan);
              const canReportThis = canReport && !isMe;
              return (canRolesOf || ownRoles || canOwnerOf || canRemove || canReportThis) && (
                <div className="stack server-actions">
                  <span className="muted small menu-section-title" title={t("members.serverActionsHint")}><Icon name="server" /> {t("members.serverActions")}</span>
                  {canRolesOf && (
                    <ContextSubmenu label={t("members.roles")}>
                      {myRoles.map((x) => (
                        <button key={x.id} role="menuitemcheckbox" aria-checked={roleIds.includes(x.id)} onClick={() => toggleRole(m, roleIds, x.id)}>
                          <span style={x.color ? { color: x.color } : undefined}>{x.name}</span>
                          {roleIds.includes(x.id) && <Icon name="check" />}
                        </button>
                      ))}
                    </ContextSubmenu>
                  )}
                  {ownRoles && (
                    <ContextSubmenu label={t("members.roles")}>
                      {ownRoles.length === 0 && <span className="muted small menu-note">{t("members.noRoles")}</span>}
                      {ownRoles.map((x) => (
                        <button key={x.id} role="menuitemcheckbox" aria-checked disabled title={t("members.ownRolesHint")}>
                          <span style={x.color ? { color: x.color } : undefined}>{x.name}</span>
                          <Icon name="check" />
                        </button>
                      ))}
                      <span className="muted small menu-note">{t("members.ownRolesHint")}</span>
                    </ContextSubmenu>
                  )}
                  {canOwnerOf && <button role="menuitem" className="secondary small" onClick={() => run(async () => {
                    const ok = await askConfirm(m.isOwner
                      ? { title: t("members.revokeOwnerTitle", { name: m.displayName }), text: t("members.revokeOwnerText"), confirmLabel: t("members.revoke"), danger: true }
                      : { title: t("members.makeOwnerTitle", { name: m.displayName }), text: t("members.makeOwnerText"), confirmLabel: t("members.appoint") });
                    if (ok) await api.setOwner(m.userId, !m.isOwner);
                  })}><Icon name="crown" /> {m.isOwner ? t("members.revokeOwner") : t("members.makeOwner")}</button>}
                  {canRemove && <>
                    {canKick && <button role="menuitem" className="secondary small" onClick={() => run(async () => { if (await askConfirm({ title: t("members.kickTitle", { name: m.displayName }), text: t("members.kickText"), confirmLabel: t("members.kick"), danger: true })) await api.kickMember(m.userId); })}><Icon name="user-x" /> {t("members.kick")}</button>}
                    {canBan && <button role="menuitem" className="danger small" onClick={() => run(async () => { const reason = await askInput({ title: t("members.banTitle", { name: m.displayName }), text: t("members.banText"), label: t("members.reason"), placeholder: t("members.reasonPlaceholder"), optional: true, confirmLabel: t("members.ban"), danger: true }); if (reason === null) return; const h = await askDeleteRecentHours(t("report.deleteRecentTitle", { name: m.displayName })); if (h === null) return; await api.banMember(m.userId, reason || null, h === "none" ? undefined : h); })}><Icon name="ban" /> {t("members.ban")}</button>}
                  </>}
                  {canReportThis && <button role="menuitem" className="secondary small" onClick={() => { closeMenu(); setReportTarget({ kind: "member", userId: m.userId, name: m.displayName }); }}><Icon name="flag" /> {t("report.reportMember")}</button>}
                </div>
              );
            })()}
          </ContextMenu>
        );
      })()}
      {reportTarget && <ReportDialog target={reportTarget} onClose={() => setReportTarget(null)}
        server={{ api, name: serverName, block: (() => { const x = blocked && reportTarget.kind === "member" ? members.find((y) => y.userId === reportTarget.userId) : null; return x && blocked && !blocked.has(x.publicKey) ? { name: x.displayName, onBlock: () => blocked.onBlock(x.publicKey, x.displayName, !!x.handle) } : null; })() }} />}
    </aside>
  );
}
