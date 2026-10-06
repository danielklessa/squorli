import { emojiKey, type ReactionChip, type Role } from "@squorli/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { menuPosition } from "./menuPosition";
import { platform } from "./platform";
import { t } from "./i18n";

/** Who reacted with one emoji: names oldest first and how many more there are than the names. */
export type WhoOf = (emoji: string) => Promise<{ names: string[]; more: number }>;

const HOVER_MS = 400;
const PRESS_MS = 500;

/**
 * The chips under a message (docs/features/reactions.md): emoji and count, mine highlighted, a configured emoji nobody used
 * yet dimmed with count 0. A click toggles my own reaction. A chip I may not add (no right, no reaction role) is shown
 * disabled and says so inline. Hovering a chip (or holding it on a phone, or focusing it) shows who reacted and, for a
 * reaction role, which role it gives; the popover is a body portal next to the chip. Shared by the channel chat and the
 * direct messages, which differ only in `whoOf`.
 */
export function Reactions({ chips, canReact, roles, onToggle, whoOf, onError }: {
  chips: readonly ReactionChip[]; canReact: boolean; roles: readonly Role[];
  onToggle: (emoji: string, on: boolean) => Promise<void>; whoOf: WhoOf; onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [who, setWho] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clearTimer = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clearTimer, []);

  const open = (chip: ReactionChip, anchor: HTMLElement) => setWho({ key: emojiKey(chip.emoji), anchor });
  const close = useCallback(() => { clearTimer(); setWho(null); }, []);

  const toggle = async (chip: ReactionChip) => {
    const key = emojiKey(chip.emoji);
    if (busy === key) return;
    if (!chip.me && !canReact && !chip.roleId) { onError(t("chat.reactForbidden")); return; }
    setBusy(key);
    try { await onToggle(chip.emoji, !chip.me); } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const onPointerEnter = (chip: ReactionChip) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== "mouse") return;
    const anchor = e.currentTarget;
    clearTimer();
    timer.current = window.setTimeout(() => open(chip, anchor), HOVER_MS);
  };
  const onPointerDown = (chip: ReactionChip) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!platform.mobile || e.pointerType === "mouse") return;
    const anchor = e.currentTarget;
    longPressed.current = false;
    clearTimer();
    timer.current = window.setTimeout(() => { longPressed.current = true; open(chip, anchor); }, PRESS_MS);
  };
  const endPress = () => { clearTimer(); };

  return (
    <div className="reactions">
      {chips.map((chip) => {
        const key = emojiKey(chip.emoji);
        const role = chip.roleId ? roles.find((r) => r.id === chip.roleId) : undefined;
        const allowed = chip.me || canReact || !!chip.roleId;
        const label = role ? t("chat.reactionRoleHint", { emoji: chip.emoji, role: role.name }) : chip.me ? t("chat.reactRemove", { emoji: chip.emoji }) : t("chat.reactAdd", { emoji: chip.emoji });
        return (
          <button key={key} type="button" className={`reaction${chip.me ? " mine" : ""}${chip.count === 0 ? " empty" : ""}${chip.roleId ? " role" : ""}`}
            aria-pressed={chip.me} aria-disabled={!allowed} aria-label={label} disabled={busy === key}
            onClick={() => { if (longPressed.current) { longPressed.current = false; return; } void toggle(chip); }}
            onContextMenu={(e) => { if (platform.mobile) e.preventDefault(); }}
            onPointerEnter={onPointerEnter(chip)} onPointerLeave={close} onPointerDown={onPointerDown(chip)} onPointerUp={endPress} onPointerCancel={endPress}
            onFocus={(e) => open(chip, e.currentTarget)} onBlur={close}>
            <span className="emoji">{chip.emoji}</span>
            {chip.count > 0 && <span className="reaction-count">{chip.count}</span>}
          </button>
        );
      })}
      {who && <ReactionWho anchor={who.anchor} chip={chips.find((c) => emojiKey(c.emoji) === who.key)} roles={roles} whoOf={whoOf} onClose={close} />}
    </div>
  );
}

/** The popover: who reacted (fetched when it opens), and the role a reaction role gives. Not interactive: leaving the chip closes it. */
function ReactionWho({ anchor, chip, roles, whoOf, onClose }: { anchor: HTMLElement; chip: ReactionChip | undefined; roles: readonly Role[]; whoOf: WhoOf; onClose: () => void }) {
  const [names, setNames] = useState<{ names: string[]; more: number } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const emoji = chip?.emoji ?? null;
  // Fetched once per opened chip. `whoOf` is a fresh closure on every render of the chat (the user's report of 6 October 2026:
  // the names flickered, because every render refetched and showed "loading" in between), so it lives in a ref, not in the deps.
  const whoOfRef = useRef(whoOf);
  whoOfRef.current = whoOf;
  useEffect(() => {
    let alive = true;
    setNames(null);
    if (emoji === null) return;
    whoOfRef.current(emoji).then((r) => { if (alive) setNames(r); }, () => { if (alive) setNames({ names: [], more: 0 }); });
    return () => { alive = false; };
  }, [emoji]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect(), b = el.getBoundingClientRect();
      setPosition(menuPosition({ x: a.left, y: a.bottom + 6 }, b, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, names]);
  // On a phone the popover was opened by holding: the next touch anywhere closes it.
  useEffect(() => {
    if (!platform.mobile) return;
    const away = () => onClose();
    window.addEventListener("pointerdown", away, { once: true });
    return () => window.removeEventListener("pointerdown", away);
  }, [onClose]);
  if (!chip) return null;
  const role = chip.roleId ? roles.find((r) => r.id === chip.roleId) : undefined;
  return createPortal(
    <div ref={box} className="reaction-who" role="tooltip" style={position ? { left: position.left, top: position.top } : { left: -9999, top: -9999 }}>
      <div className="reaction-who-head"><span className="emoji">{chip.emoji}</span>{role && <span className="muted">{t("chat.reactionRole", { role: role.name })}</span>}</div>
      {chip.count > 0 && (
        <p>{names === null ? t("common.loading") : names.names.length === 0 ? "" : names.names.join(", ")}{names && names.more > 0 ? ` ${t("chat.reactionMore", { n: names.more })}` : ""}</p>
      )}
      {chip.count === 0 && role && <p className="muted">{t("chat.reactionNobodyYet")}</p>}
    </div>,
    document.body,
  );
}
