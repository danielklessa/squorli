import { directoryServerUrl } from "@squorli/protocol";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { moveInOrder } from "./serverOrder";

/** Entry in the server rail: `key` = key in the store (own server = the host in the address bar), `host` = host from the directory. */
export type RailServer = { key: string; host: string; name: string; sub: string | null; iconUrl: string | null };
/** Live state per server from the store: unread items, running voice connection, connection state. */
/** `muted`: I have muted this server (no unread mark); `canMute`: the server is connected and keeps mutes. */
/** `people`: how many sit in its voice channels right now, AFK channel left out (railServers.ts `voiceActivity`). */
/** `reports`: open reports on that server for me as a moderator (0 for everybody else; docs/features/reports.md). */
export type RailState = Record<string, { unread: boolean; mentions: number; voice: boolean; people: number; connection: string; muted: boolean; canMute: boolean; reports: number;
  /** The server does not answer right now (docs/features/offline.md): a red mark on the entry, the tooltip says so. */
  unreachable: boolean;
  /** The directory's operator refused the server (docs/features/reports.md): the same red mark, the tooltip says that instead. */
  refused?: boolean }>;

type Menu = { key: string; host: string; name: string; index: number; x: number; y: number };

/** A drag of a rail entry by the pointer: `active` once the pointer moved far enough, `over` = where it would be dropped (insertion index). */
type Drag = { key: string; index: number; startY: number; active: boolean; over: number | null };
/** Movement before a press becomes a drag (a click wobbles a little). */
const DRAG_START_PX = 6;
/** Near the rail's top or bottom edge the list scrolls along while dragging. */
const DRAG_SCROLL_EDGE_PX = 28;
const DRAG_SCROLL_STEP_PX = 10;

/**
 * Server rail on the far left (M6d): your own server and every chat server your handle has signed in on according to the
 * directory (AccountStatus.servers). A click switches the displayed server in the client (multi-server client) without leaving
 * the page; a running voice connection survives (green dot on the server it runs on). Icons come
 * exclusively from the directory (GET /api/servers/<host>/icon), never from the foreign server; without an icon, initials.
 * Right-click on a server opens a small menu: open, move up or down, mute (no unread mark for it), and delete your account on
 * that server (through the directory). A server the directory's operator refused stays in the rail with a red mark
 * (docs/features/reports.md); its menu offers "Aus der Liste entfernen" instead of the report and the account deletion.
 * The order is the user's (22 September 2026): drag an entry with the mouse or pen to another place (a line shows where it
 * lands), or use the menu's "Nach oben"/"Nach unten" or Alt+arrow keys on a focused entry; `onReorder` gets the hosts in the
 * new order (serverOrder.ts, kept in the settings and the directory account). A touch cannot drag here (it scrolls the rail),
 * so the menu is the way on a phone.
 * At the bottom: "discover servers" opens the public server directory.
 */
export function ServerRail({ servers, serverState, activeKey, onSelect, onDiscover, onAdd, onLeave, onMute, onReorder, home, serverAccounts, onSignOutAccount, onReport = null, onRemoveRefused }: {
  servers: RailServer[]; serverState: RailState; activeKey: string | null; onSelect: (key: string, host: string) => void;
  /** Open the public server directory; null = the client knows no directory. */
  onDiscover: (() => void) | null;
  /** Add a server by address or link (client without a home server: the desktop app); null = not offered. */
  onAdd: (() => void) | null;
  /** Delete your account on `host` (asks for confirmation itself). */
  onLeave: (host: string, name: string) => void;
  /** Mute or unmute the server `key` for myself. */
  onMute: (key: string, muted: boolean) => void;
  /** The user arranged the servers: their hosts in the new order (all of them). null = the order cannot be changed here. */
  onReorder: ((hosts: string[]) => void) | null;
  /** M7: home view (friends + direct messages); null = no directory socket (no account). badge = incoming requests + unread DMs. */
  home: { open: boolean; badge: number; onToggle: () => void } | null;
  /** Servers this client signs in to with a server account (`~name`, docs/features/local-accounts.md): key -> handle. */
  serverAccounts: Record<string, string>;
  /** Sign out of the server account of `key` on this device (the key is forgotten, name and password bring it back). */
  onSignOutAccount: (key: string) => void;
  /** Report the server `host` to the directory's operator (docs/features/reports.md); null = not offered. */
  onReport?: ((host: string, name: string) => void) | null;
  /** Remove the entry of a server the directory's operator refused (its menu offers that instead of reporting it or deleting the account there). */
  onRemoveRefused: (key: string) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** A drag just ended on this button: the click that follows the pointer up must not open the server. */
  const swallowClick = useRef(false);
  // The menu closes on any click elsewhere or Escape (it is positioned at the pointer, outside the rail's scroll box).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); window.removeEventListener("resize", close); };
  }, [menu]);
  const openMenu = (s: RailServer, index: number) => (e: MouseEvent) => {
    e.preventDefault();
    setMenu({ key: s.key, host: s.host, name: s.name, index, x: Math.min(e.clientX, window.innerWidth - 260), y: Math.min(e.clientY, window.innerHeight - 100) });
  };
  const sortable = !!onReorder && servers.length > 1;
  /** Move the entry at `from` so that it sits in front of the entry at `to` (`to` = servers.length: last). */
  const move = (from: number, to: number) => {
    if (!onReorder) return;
    const next = moveInOrder(servers.map((s) => s.host), from, to);
    if (next.some((h, i) => h !== servers[i]!.host)) onReorder(next);
  };
  const moveBy = (index: number, delta: -1 | 1) => { move(index, delta < 0 ? index - 1 : index + 2); };

  /** Where a pointer at `y` would drop: in front of the first entry whose middle lies below it, else behind the last. */
  const insertionIndex = (y: number): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const items = Array.from(rail.querySelectorAll<HTMLElement>("[data-rail-index]"));
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return Number(el.dataset.railIndex);
    }
    return items.length;
  };
  const onPointerDown = (index: number, key: string) => (e: PointerEvent<HTMLButtonElement>) => {
    // A touch scrolls the rail; it cannot drag here (the menu moves entries on a phone).
    if (!sortable || e.button !== 0 || e.pointerType === "touch") return;
    dragRef.current = { key, index, startY: e.clientY, active: false, over: null };
  };
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < DRAG_START_PX) return;
      d.active = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const rail = railRef.current;
    if (rail) {
      const r = rail.getBoundingClientRect();
      if (e.clientY < r.top + DRAG_SCROLL_EDGE_PX) rail.scrollTop -= DRAG_SCROLL_STEP_PX;
      else if (e.clientY > r.bottom - DRAG_SCROLL_EDGE_PX) rail.scrollTop += DRAG_SCROLL_STEP_PX;
    }
    const over = insertionIndex(e.clientY);
    if (over !== d.over) { d.over = over; setDrag({ ...d }); }
  };
  const endDrag = (e: PointerEvent<HTMLButtonElement>, drop: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.active) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDrag(null);
    // The click after this pointer up belongs to the drag, not to the server. The flag clears itself in case no click comes.
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 0);
    if (drop && d.over !== null) move(d.index, d.over);
  };
  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!sortable || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    moveBy(index, e.key === "ArrowUp" ? -1 : 1);
  };
  const dropOf = (index: number): DropMark => {
    if (!drag?.active) return null;
    if (drag.key === servers[index]?.key) return "source";
    if (drag.over === index) return "before";
    if (drag.over === servers.length && index === servers.length - 1) return "after";
    return null;
  };
  return (
    <nav ref={railRef} className={`rail ${drag?.active ? "reordering" : ""}`} aria-label={t("rail.label")}>
      {home && (
        <>
          <button className={`rail-item home ${home.open ? "current" : ""}`} title={t("rail.home")} aria-current={home.open ? "page" : undefined} onClick={home.onToggle}>
            <img src="/brand/squorli-icon.svg" alt="" width="32" height="32" />
            {home.badge > 0 && <span className="rail-badge">{home.badge > 99 ? "99+" : home.badge}</span>}
          </button>
          <span className="rail-sep" />
        </>
      )}
      {servers.map((s, index) => {
        const st = serverState[s.key];
        return <RailEntry key={s.key} host={s.host} name={s.name} sub={s.sub} iconUrl={s.iconUrl} current={s.key === activeKey}
          voice={st?.voice ?? false} people={st?.people ?? 0} unread={st?.unread ?? false} mentions={st?.mentions ?? 0} muted={st?.muted ?? false} reports={st?.reports ?? 0} unreachable={st?.unreachable ?? false} refused={st?.refused ?? false}
          onOpen={() => { if (swallowClick.current) return; onSelect(s.key, s.host); }} onMenu={openMenu(s, index)} drop={dropOf(index)}
          attrs={sortable ? { "data-rail-index": index, onPointerDown: onPointerDown(index, s.key), onPointerMove, onPointerUp: (e) => endDrag(e, true), onPointerCancel: (e) => endDrag(e, false), onKeyDown: onKeyDown(index) } : { "data-rail-index": index }} />;
      })}
      <span className="rail-sep" />
      {onAdd && <button className="rail-item discover" title={t("rail.add")} onClick={onAdd}><Icon name="plus" /></button>}
      {onDiscover && <button className="rail-item discover" title={t("rail.discover")} onClick={onDiscover}><Icon name="compass" /></button>}
      {menu && (
        <div className="rail-menu" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="muted small rail-menu-head">{menu.name}<br />{menu.host}{serverAccounts[menu.key] && <><br />~{serverAccounts[menu.key]}</>}</div>
          <button role="menuitem" className="secondary small" onClick={() => { setMenu(null); onSelect(menu.key, menu.host); }}><Icon name="external-link" /> {t("common.open")}</button>
          {sortable && (
            <>
              <button role="menuitem" className="secondary small" disabled={menu.index === 0} onClick={() => { setMenu(null); moveBy(menu.index, -1); }}><Icon name="chevron-up" /> {t("rail.moveUp")}</button>
              <button role="menuitem" className="secondary small" disabled={menu.index === servers.length - 1} onClick={() => { setMenu(null); moveBy(menu.index, 1); }}><Icon name="chevron-down" /> {t("rail.moveDown")}</button>
            </>
          )}
          {serverState[menu.key]?.canMute && (
            <button role="menuitem" className="secondary small" onClick={() => { const muted = serverState[menu.key]?.muted ?? false; setMenu(null); onMute(menu.key, !muted); }}>
              <Icon name={serverState[menu.key]?.muted ? "bell" : "bell-off"} /> {serverState[menu.key]?.muted ? t("rail.unmute") : t("rail.mute")}
            </button>
          )}
          {serverAccounts[menu.key] && <button role="menuitem" className="secondary small" onClick={() => { setMenu(null); onSignOutAccount(menu.key); }}><Icon name="log-out" /> {t("rail.signOutAccount")}</button>}
          {serverState[menu.key]?.refused ? (
            // Refused by the directory's operator: the directory reaches it no more, so no account deletion there and no report.
            <button role="menuitem" className="secondary small" onClick={() => { setMenu(null); onRemoveRefused(menu.key); }}><Icon name="x" /> {t("refused.remove")}</button>
          ) : (
            <>
              {onReport && <button role="menuitem" className="secondary small" onClick={() => { setMenu(null); onReport(menu.host, menu.name); }}><Icon name="flag" /> {t("report.reportServer")}</button>}
              <button role="menuitem" className="danger small" onClick={() => { setMenu(null); onLeave(menu.host, menu.name); }}><Icon name="user-x" /> {t("rail.menuLeave")}</button>
            </>
          )}
        </div>
      )}
    </nav>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length >= 2 ? `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}` : name.trim().slice(0, 2);
  return s.toUpperCase();
}

/** While an entry is dragged: the dragged one, and the one in front of which (or behind which, for the last) it would land. */
export type DropMark = "source" | "before" | "after" | null;

/** Round server entry: icon from the directory or initials. With `onOpen` a button (switch within the client), otherwise a link to the server. */
export function RailEntry({ host, name, sub, iconUrl, current, voice = false, people = 0, unread = false, mentions = 0, muted = false, reports = 0, unreachable = false, refused = false, onOpen = null, onMenu, drop = null, attrs }: {
  host: string; name: string; sub: string | null; iconUrl: string | null; current: boolean; voice?: boolean;
  /** People in the server's voice channels: a speaker at the bottom left (the number only in the tooltip), so the rail shows where something is going on; not where my own voice connection runs. */
  people?: number; unread?: boolean; mentions?: number; muted?: boolean; onOpen?: (() => void) | null;
  /** Open reports for me as a moderator of that server (docs/features/reports.md): an amber badge at the top left, on the current server too. */
  reports?: number;
  /** The server does not answer right now (docs/features/offline.md): dimmed, a red mark at the bottom right, the tooltip says so. */
  unreachable?: boolean;
  /** The directory's operator refused the server (docs/features/reports.md): marked like one that does not answer, the tooltip says why. */
  refused?: boolean;
  /** Right-click: context menu (rail only). */
  onMenu?: (e: MouseEvent) => void;
  /** Drag and drop mark (rail only). */
  drop?: DropMark;
  /** Further attributes of the button (the rail's pointer and key handlers for sorting). */
  attrs?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | number>;
}) {
  // Where my own voice connection runs, the green speaker at the right says enough: no activity mark there (the tooltip keeps the count).
  const activity = people > 0 && !voice;
  const title = `${name}${sub ? ` · ${sub}` : ""}\n${host}${people > 0 ? `\n${t("rail.inVoice", { n: people })}` : ""}${voice ? `\n${t("rail.voiceConnected")}` : ""}${muted ? `\n${t("rail.muted")}` : ""}${refused ? `\n${t("rail.refused")}` : unreachable ? `\n${t("rail.unreachable")}` : ""}`;
  const content = (
    <>
      {iconUrl ? <img src={iconUrl} alt="" draggable={false} /> : <span className="rail-initials">{initials(name)}</span>}
      {activity && <span className="rail-people" aria-label={t("rail.inVoice", { n: people })}><Icon name="volume-2" /></span>}
      {voice && <span className="rail-voice" aria-label={t("rail.voiceConnected")}><Icon name="volume-2" /></span>}
      {unread && !current && <span className="rail-unread" aria-label={t("rail.unread")} />}
      {mentions > 0 && !current && <span className="rail-badge rail-mentions" aria-label={t("sidebar.mentions", { n: mentions })}>{mentions > 99 ? "99+" : mentions}</span>}
      {(unreachable || refused) && <span className="rail-badge rail-off" aria-label={t(refused ? "rail.refused" : "rail.unreachable")}>!</span>}
      {reports > 0 && <span className="rail-badge rail-reports" aria-label={t("report.railOpen", { n: reports })} title={t("report.railOpen", { n: reports })}>{reports > 99 ? "99+" : reports}</span>}
    </>
  );
  const cls = `rail-item ${current ? "current" : ""} ${muted ? "muted" : ""} ${unreachable || refused ? "unreachable" : ""} ${drop ? `drop-${drop}` : ""}`;
  return onOpen
    ? <button {...attrs} className={cls} title={title} aria-current={current ? "page" : undefined} onClick={onOpen} onContextMenu={onMenu}>{content}</button>
    : <a className={cls} href={directoryServerUrl(host)} title={title}>{content}</a>;
}
