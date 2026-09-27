import { Avatar } from "./Avatar";
import { directoryAvatarUrl, type Friend, type FriendSearchResult, type Member } from "@squorli/protocol";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { askBlockFriend, askRemoveFriend } from "./friendActions";
import { platform } from "./platform";
import { DmView } from "./DmView";
import { GameLine } from "./GameLine";
import { Icon } from "./Icon";
import type { State, Store } from "./store";
import { t } from "./i18n";
import { SuspendedNote } from "./AccountNotices";

/**
 * Home view (M7, the Squorli mark in the server rail): friends, requests and search on the left, the conversation with the
 * selected friend on the right (end-to-end encrypted through the directory). Replaces the channel list, chat and member list;
 * voice keeps running in the dock below. Names: the friend exposes their global display name, otherwise the handle.
 */
export const friendName = (f: Friend) => f.displayName ?? `@${f.handle}`;
/** Address of a friend's avatar at the directory (null = none, or no directory known). */
export const friendAvatar = (directoryUrl: string | null, f: { publicKey: string; avatarUpdatedAt: string | null }) => (directoryUrl ? directoryAvatarUrl(directoryUrl, f.publicKey, f.avatarUpdatedAt) : null);

export function HomeSidebar({ state, store, members, onOpenChat, onReportAccount = null }: { state: State; store: Store; members: Member[]; onOpenChat: () => void;
  /** A friend's account (name, picture) can be reported to the directory's operator; null = not offered. */
  onReportAccount?: ((publicKey: string, name: string) => void) | null }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FriendSearchResult[]>([]);
  // Right-click on a friend (a tap on the dots on a phone): write, remove, block (user's wish, 24 September 2026).
  const [menu, setMenu] = useState<({ publicKey: string } & MenuAnchor) | null>(null);
  const openMenu = (e: MouseEvent<HTMLElement>, publicKey: string) => {
    e.preventDefault(); e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ publicKey, trigger: e.currentTarget, x: e.clientX || r.left, y: e.clientY || r.bottom });
  };
  const friends = state.friends ?? [];
  const byKey = useMemo(() => new Map(friends.map((f) => [f.publicKey, f])), [friends]);
  const incoming = friends.filter((f) => f.state === "pending_in");
  const outgoing = friends.filter((f) => f.state === "pending_out");
  const blocked = friends.filter((f) => f.state === "blocked");
  const accepted = friends.filter((f) => f.state === "accepted").sort((a, b) => {
    const ua = state.conversations[a.publicKey]?.unread ?? 0; const ub = state.conversations[b.publicKey]?.unread ?? 0;
    if ((ua > 0) !== (ub > 0)) return ua > 0 ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    const ta = state.conversations[a.publicKey]?.lastAt ?? ""; const tb = state.conversations[b.publicKey]?.lastAt ?? "";
    if (ta !== tb) return tb < ta ? -1 : 1;
    return friendName(a).localeCompare(friendName(b));
  });

  // Search: handles at the directory (prefix, debounced) and names in the member list of the connected server.
  const query = q.trim().replace(/^@/, "").toLowerCase();
  useEffect(() => {
    if (query.length < 2) { setHits([]); return; }
    const t = setTimeout(() => { void store.searchHandles(query).then(setHits); }, 250);
    return () => clearTimeout(t);
  }, [query, store]);
  const me = state.identity?.publicKey;
  const localHits = query.length < 2 ? [] : members.filter((m) => m.publicKey !== me && (m.displayName.toLowerCase().includes(query) || (m.handle ?? "").includes(query))).slice(0, 10);
  const seen = new Set(localHits.map((m) => m.publicKey));
  const dirHits = hits.filter((h) => h.publicKey !== me && !seen.has(h.publicKey));

  // A suspended account has no socket (docs/features/reports.md): the note says so instead of "no connection".
  const suspended = state.suspendedUntil !== null;
  const linkText = suspended || state.directoryLink === "connected" ? null : state.directoryLink === "connecting" ? t("home.connecting") : state.directoryLinkError ?? t("home.noLink");

  return (
    <div className="home-side">
      <header className="server-head"><img className="brand-mark" src="/brand/squorli-icon-small.svg" alt="" width="22" height="22" /><strong>{t("home.friends")}</strong></header>
      <div className="home-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("home.searchPlaceholder")} spellCheck={false} aria-label={t("home.searchLabel")} />
        {q && <button className="icon" title={t("home.clearSearch")} onClick={() => setQ("")}><Icon name="x" /></button>}
      </div>
      {suspended && <SuspendedNote until={state.suspendedUntil ?? ""} reason={state.suspendedReason} handle={state.directoryAccount?.handle ?? ""} directoryUrl={state.directoryUrl} onCheck={() => store.refreshDirectory()} />}
      {linkText && <p className="muted small home-note">{linkText}</p>}
      {state.friendsError && <p className="error small home-note">{state.friendsError}</p>}
      <div className="channel-list home-list">
        {query.length >= 2 && (
          <section>
            <h3>{t("home.search")}</h3>
            {localHits.length === 0 && dirHits.length === 0 && <p className="muted small home-note">{t("home.nothingFound")}</p>}
            <ul>
              {localHits.map((m) => <SearchRow key={m.publicKey} publicKey={m.publicKey} title={m.displayName} sub={m.handle ? `@${m.handle}` : t("home.noHandle")} state={byKey.get(m.publicKey)?.state ?? null} canAdd={!!m.handle} store={store} />)}
              {dirHits.map((h) => <SearchRow key={h.publicKey} publicKey={h.publicKey} title={`@${h.handle}`} sub={t("home.directory")} state={byKey.get(h.publicKey)?.state ?? null} canAdd store={store} />)}
            </ul>
          </section>
        )}
        {incoming.length > 0 && (
          <section>
            <h3>{t("home.requests")} · {incoming.length}</h3>
            <ul>{incoming.map((f) => (
              <li key={f.publicKey} className="friend request">
                <span className="friend-name">@{f.handle}</span>
                <button className="icon ok" title={t("home.accept")} onClick={() => store.acceptFriend(f.publicKey)}><Icon name="check" /></button>
                <button className="icon danger" title={t("home.decline")} onClick={() => store.declineFriend(f.publicKey)}><Icon name="x" /></button>
              </li>
            ))}</ul>
          </section>
        )}
        <section>
          <h3>{t("home.friends")} · {accepted.length}</h3>
          {accepted.length === 0 && state.directoryLink === "connected" && <p className="muted small home-note">{t("home.noFriends")}</p>}
          <ul>{accepted.map((f) => {
            const unread = state.conversations[f.publicKey]?.unread ?? 0;
            return (
              <li key={f.publicKey} className={`channel friend ${state.currentPeer === f.publicKey ? "active" : ""} ${unread ? "unread" : ""} ${f.online ? "" : "offline"}`}>
                <button className="channel-btn" onClick={() => { store.selectPeer(f.publicKey); onOpenChat(); }} onContextMenu={(e) => openMenu(e, f.publicKey)} title={`@${f.handle}`}>
                  <Avatar name={friendName(f)} src={friendAvatar(state.directoryUrl, f)} online={f.online} afk={f.afk} />
                  <span className="friend-identity"><span className="channel-name">{friendName(f)}</span><GameLine game={f.online ? f.game : null} /></span>
                  {f.online && f.afk && <Icon name="moon" className="afk" title={t("members.afk")} />}
                  {unread > 0 && <span className="count">{unread}</span>}
                  {platform.mobile && <span className="channel-menu-btn" role="button" tabIndex={0} aria-label={t("friends.menu")} title={t("friends.menu")} onClick={(e) => openMenu(e, f.publicKey)}><Icon name="ellipsis-vertical" /></span>}
                </button>
              </li>
            );
          })}</ul>
        </section>
        {menu && (() => {
          const f = byKey.get(menu.publicKey);
          if (!f || f.state !== "accepted") return null;
          const name = friendName(f);
          return (
            <ContextMenu anchor={menu} label={name} onClose={() => setMenu(null)}>
              <button role="menuitem" onClick={() => { setMenu(null); store.selectPeer(f.publicKey); onOpenChat(); }}><Icon name="message-circle" /> {t("members.writeMessage")}</button>
              <button role="menuitem" className="danger" onClick={() => { setMenu(null); askRemoveFriend(store, f.publicKey, name); }}><Icon name="user-minus" /> {t("friends.remove")}</button>
              <button role="menuitem" className="danger" onClick={() => { setMenu(null); askBlockFriend(store, f.publicKey, name); }}><Icon name="ban" /> {t("friends.block")}</button>
              {onReportAccount && <button role="menuitem" onClick={() => { setMenu(null); onReportAccount(f.publicKey, `@${f.handle}`); }}><Icon name="flag" /> {t("report.reportAccount")}</button>}
            </ContextMenu>
          );
        })()}
        {outgoing.length > 0 && (
          <section>
            <h3>{t("home.sentRequests")} · {outgoing.length}</h3>
            <ul>{outgoing.map((f) => (
              <li key={f.publicKey} className="friend request">
                <span className="friend-name muted">@{f.handle}</span>
                <button className="icon" title={t("home.withdraw")} onClick={() => store.removeFriend(f.publicKey)}><Icon name="x" /></button>
              </li>
            ))}</ul>
          </section>
        )}
        {blocked.length > 0 && (
          <section>
            <h3>{t("home.blocked")} · {blocked.length}</h3>
            <ul>{blocked.map((f) => (
              <li key={f.publicKey} className="friend request">
                <span className="friend-name muted">@{f.handle}</span>
                <button className="secondary small" onClick={() => store.unblockFriend(f.publicKey)}>{t("home.unblock")}</button>
              </li>
            ))}</ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** Search hit: add as a friend or show the state; without a handle (no directory account) no request is possible. */
function SearchRow({ publicKey, title, sub, state, canAdd, store }: { publicKey: string; title: string; sub: string; state: Friend["state"] | null; canAdd: boolean; store: Store }) {
  const label = state ? t(`friend.${state}`) : null;
  return (
    <li className="friend request">
      <span className="friend-name">{title} <span className="muted small">{sub}</span></span>
      {label ? <span className="muted small">{label}</span>
        : canAdd ? <button className="icon ok" title={t("home.addFriend")} onClick={() => store.requestFriend(publicKey)}><Icon name="user-plus" /></button>
          : <span className="muted small" title={t("home.noAccountHint")}>{t("home.noAccount")}</span>}
    </li>
  );
}

/** The directory's host for texts ("goes to the operator of ..."); the address itself when it is no address. */
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };

export function HomeMain({ state, store }: { state: State; store: Store }) {
  const friend = state.currentPeer ? (state.friends ?? []).find((f) => f.publicKey === state.currentPeer) ?? null : null;
  if (!state.currentPeer || !friend || friend.state !== "accepted") {
    return (
      <section className="chat empty home-empty">
        <img src="/brand/squorli-icon.svg" alt="" width="72" height="72" />
        <p className="muted">{t("home.pickFriend")}</p>
      </section>
    );
  }
  return <DmView key={friend.publicKey} friend={friend} thread={state.dms[friend.publicKey] ?? { list: [], hasMore: true, loaded: false, loading: false }} myKey={state.identity?.publicKey ?? ""} store={store}
    avatarUrl={friendAvatar(state.directoryUrl, friend)} myAvatarUrl={state.directoryAccount ? friendAvatar(state.directoryUrl, state.directoryAccount) : null}
    reportHost={state.dmReports && state.directoryUrl ? hostOf(state.directoryUrl) : null} />;
}
