import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBackClose } from "./backStack";
import { Icon } from "./Icon";
import { menuPosition, submenuPosition } from "./menuPosition";

/** `above`: open upwards with the bottom edge at `y` instead of downwards from it. `width`: fixed width in px instead of the menu's own (to match the element it belongs to). */
export type MenuAnchor = { x: number; y: number; trigger: HTMLElement; above?: boolean; width?: number };

function navigate(event: KeyboardEvent<HTMLElement>) {
  const panel = (event.target as HTMLElement).closest<HTMLElement>('[role="menu"]');
  if (!panel) return;
  // data-menu-item: controls that are no buttons (the volume slider) but belong to the arrow-key order.
  const items = [...panel.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[role^="menuitem"], [data-menu-item]')]
    .filter((item) => !item.disabled && item.closest('[role="menu"]') === panel);
  const index = items.indexOf(panel.ownerDocument.activeElement as HTMLButtonElement);
  let next: number;
  switch (event.key) {
    case "ArrowDown": next = (index + 1) % items.length; break;
    case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
    case "Home": next = 0; break;
    case "End": next = items.length - 1; break;
    default: return;
  }
  event.preventDefault(); event.stopPropagation(); items[next]?.focus();
}

/**
 * A body portal keeps the menu outside the member column's scrolling/clipping area. The body is the one of the window the
 * trigger lives in: the voice stage can be in a window of its own (StageWindow.tsx).
 */
export function ContextMenu({ anchor, label, onClose, children }: {
  anchor: MenuAnchor; label: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBackClose(onClose);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const doc = anchor.trigger.ownerDocument;
  const win: Window & typeof globalThis = doc.defaultView ?? window;
  useLayoutEffect(() => {
    const menu = ref.current!;
    const place = () => {
      const box = menu.getBoundingClientRect();
      setPosition(menuPosition(anchor, box, { width: win.innerWidth, height: win.innerHeight }));
    };
    place();
    (menu.querySelector<HTMLElement>('[role^="menuitem"]') ?? menu).focus();
    const observer = new win.ResizeObserver(place); observer.observe(menu);
    return () => observer.disconnect();
  }, [anchor, win]);
  useEffect(() => {
    const close = () => closeRef.current();
    // The emoji picker (a portal of its own, opened from a line inside the menu) counts as inside.
    const outside = (event: Event) => { const target = event.target as Node; if (!ref.current?.contains(target) && !(target instanceof Element && target.closest(".emoji-picker"))) close(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); anchor.trigger.focus(); close(); }
      if (event.key === "Tab") { anchor.trigger.focus(); close(); }
    };
    win.addEventListener("pointerdown", outside);
    win.addEventListener("focusin", outside);
    win.addEventListener("scroll", outside, true);
    win.addEventListener("resize", close);
    win.addEventListener("keydown", key);
    return () => {
      win.removeEventListener("pointerdown", outside); win.removeEventListener("focusin", outside);
      win.removeEventListener("scroll", outside, true); win.removeEventListener("resize", close); win.removeEventListener("keydown", key);
    };
  }, [anchor, win]);
  return createPortal(
    <div ref={ref} className="user-context-menu" role="menu" aria-label={label} tabIndex={-1} style={anchor.width ? { ...position, width: anchor.width } : position}
      onKeyDown={navigate} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      {children}
    </div>, doc.body,
  );
}

/**
 * Hover, click and ArrowRight all open the same submenu; it flips at the screen edge. With `onActivate` the entry is an
 * action of its own: a click runs it, and the submenu opens on hover, ArrowRight or a click on the arrow (touch).
 */
export function ContextSubmenu({ label, children, onActivate, className }: { label: string; children: ReactNode; onActivate?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    const box = trigger.current!.getBoundingClientRect();
    const menu = panel.current!.getBoundingClientRect();
    const view = trigger.current!.ownerDocument.defaultView ?? window;
    setPosition(submenuPosition(box, menu, { width: view.innerWidth, height: view.innerHeight }));
    if (focusOnOpen.current) { panel.current!.querySelector<HTMLElement>('[role^="menuitem"]')?.focus(); focusOnOpen.current = false; }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const parent = trigger.current?.closest('[role="menu"]');
    const close = () => setOpen(false);
    parent?.addEventListener("scroll", close);
    return () => parent?.removeEventListener("scroll", close);
  }, [open]);
  return <div className="context-submenu" role="none" onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true); }}
    onPointerLeave={() => setOpen(false)}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
    <button ref={trigger} role="menuitem" aria-haspopup="menu" aria-expanded={open} className={className}
      onClick={(e) => {
        const onArrow = (e.target as Element).closest?.(".submenu-arrow");
        if (onActivate && !onArrow) { onActivate(); return; }
        focusOnOpen.current = true; setOpen(true); if (open) panel.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
      }}
      onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); focusOnOpen.current = true; setOpen(true); if (open) panel.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus(); } }}>
      <span>{label}</span><span className="submenu-arrow"><Icon name="chevron-down" rotate={270} /></span>
    </button>
    {open && <div ref={panel} className="user-context-menu context-submenu-panel" role="menu" aria-label={label} style={position}
      onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); trigger.current?.focus(); setOpen(false); } else navigate(e); }}>
      {children}
    </div>}
  </div>;
}
