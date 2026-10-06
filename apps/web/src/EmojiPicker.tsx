import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { menuPosition } from "./menuPosition";
import { emojiWithTone, entriesOf, firstShortcode, insertAt, loadRecent, loadTone, pushRecent, saveRecent, saveTone, searchEmoji, SKIN_TONES, type SkinTone } from "./emoji/picker";
import type { EmojiEntry, EmojiGroup } from "./emoji/types";
import { locale, t, type MessageKey } from "./i18n";

/** Columns of the grid (styles.css `.emoji-grid`); arrow up/down move by this many. */
const COLUMNS = 8;
const TONE_SAMPLE = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"] as const;
const GROUP_META: Record<string, { icon: string; label: MessageKey }> = {
  "smileys-emotion": { icon: "smile", label: "emoji.group.smileys" },
  "people-body": { icon: "hand", label: "emoji.group.people" },
  "animals-nature": { icon: "leaf", label: "emoji.group.nature" },
  "food-drink": { icon: "utensils", label: "emoji.group.food" },
  "travel-places": { icon: "plane", label: "emoji.group.travel" },
  activities: { icon: "trophy", label: "emoji.group.activities" },
  objects: { icon: "lightbulb", label: "emoji.group.objects" },
  symbols: { icon: "heart", label: "emoji.group.symbols" },
  flags: { icon: "flag", label: "emoji.group.flags" },
};
const RECENT = { icon: "clock", label: "emoji.group.recent" } as const;

/** Names and keywords in the client's language; a chunk of its own that is fetched when the picker opens for the first time. */
let cache: Promise<EmojiGroup[]> | null = null;
const loadGroups = () => (cache ??= (locale === "de" ? import("./emoji/data.de") : import("./emoji/data.en")).then((m) => m.GROUPS).catch((e) => { cache = null; throw e; }));

/**
 * Smiley button of a message input with its picker. Inserts at the caret of `inputRef` (replacing a selection) and gives
 * the focus back to the input. Shift+click or Shift+Enter keeps the picker open for several emoji.
 */
export function EmojiButton({ inputRef, value, onChange, disabled = false }: {
  inputRef: MutableRefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const focusInput = useCallback((caret?: number) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (caret !== undefined) el.setSelectionRange(caret, caret);
    });
  }, [inputRef]);
  const pick = useCallback((emoji: string, keepOpen: boolean) => {
    const el = inputRef.current, current = valueRef.current;
    const next = insertAt(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, emoji);
    onChange(next.value);
    if (keepOpen) {
      // The input is not focused: move its caret behind the emoji so the next one lands after it.
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.caret, next.caret));
    } else { setOpen(false); focusInput(next.caret); }
  }, [inputRef, onChange, focusInput]);
  const close = useCallback(() => { setOpen(false); focusInput(); }, [focusInput]);

  return (
    <>
      <button ref={button} type="button" className="icon emoji-open" title={t("emoji.open")} aria-label={t("emoji.open")} aria-haspopup="dialog" aria-expanded={open}
        disabled={disabled} onClick={() => setOpen((o) => !o)}><Icon name="smile" /></button>
      {open && button.current && <EmojiPicker anchor={button.current} onPick={pick} onClose={close} onDismiss={() => setOpen(false)} />}
    </>
  );
}

/**
 * `onClose`: closed from inside (Escape, picked), the input gets the focus. `onDismiss`: a click elsewhere, the focus stays where
 * the user put it. Exported since 6 October 2026 for the reactions (Reactions.tsx, ReactionRolesDialog.tsx): the same picker
 * opens from a message's toolbar and from the rules dialog, anchored at that button, above it with the right edges aligned.
 */
export function EmojiPicker({ anchor, onPick, onClose, onDismiss }: { anchor: HTMLElement; onPick: (emoji: string, keepOpen: boolean) => void; onClose: () => void; onDismiss: () => void }) {
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState<SkinTone>(loadTone);
  const [tonesOpen, setTonesOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [preview, setPreview] = useState<{ emoji: string; name: string; code: string } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => { let alive = true; loadGroups().then((g) => { if (alive) setGroups(g); }, () => { if (alive) setFailed(true); }); return () => { alive = false; }; }, []);

  // Above the button, right edges aligned, kept inside the window.
  useLayoutEffect(() => {
    const el = panel.current!;
    const place = () => {
      const a = anchor.getBoundingClientRect(), box = el.getBoundingClientRect();
      setPosition(menuPosition({ x: a.right - box.width, y: a.top - 8, above: true }, box, { width: window.innerWidth, height: window.innerHeight }));
    };
    place();
    search.current?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor]);

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.contains(target)) dismissRef.current();   // the button toggles by itself
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [anchor]);

  const results = useMemo(() => (groups && query.trim() ? searchEmoji(groups, query) : null), [groups, query]);
  const recentEntries = useMemo(() => (groups ? entriesOf(groups, recent) : []), [groups, recent]);

  const choose = useCallback((emoji: string, keepOpen: boolean) => {
    setRecent((list) => { const next = pushRecent(list, emoji); saveRecent(next); return next; });
    onPick(emoji, keepOpen);
  }, [onPick]);
  const onGridClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const emoji = (event.target as HTMLElement).closest<HTMLElement>("button[data-emoji]")?.dataset.emoji;
    if (emoji) choose(emoji, event.shiftKey);
  }, [choose]);
  const onGridPoint = useCallback((event: { target: EventTarget }) => {
    const data = (event.target as HTMLElement).closest<HTMLElement>("button[data-emoji]")?.dataset;
    if (data?.emoji) setPreview({ emoji: data.emoji, name: data.name ?? "", code: data.code ?? "" });
  }, []);

  function buttons(): HTMLButtonElement[] { return [...(body.current?.querySelectorAll<HTMLButtonElement>("button[data-emoji]") ?? [])]; }
  function onGridKey(event: KeyboardEvent<HTMLElement>) {
    const steps: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const all = buttons(), index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (index + step < 0) search.current?.focus(); else all[Math.min(index + step, all.length - 1)]?.focus();
  }
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); buttons()[0]?.focus(); }
    if (event.key === "Enter") { event.preventDefault(); const first = results?.[0]; if (first) choose(emojiWithTone(first, tone), event.shiftKey); }
  }
  function jump(key: string) {
    setQuery("");
    requestAnimationFrame(() => body.current?.querySelector(`[data-group="${key}"]`)?.scrollIntoView({ block: "start" }));
  }

  return createPortal(
    <div ref={panel} className="emoji-picker" role="dialog" aria-label={t("emoji.title")} style={position ?? { left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
      <div className="emoji-head">
        <label className="emoji-search"><Icon name="search" />
          <input ref={search} type="search" value={query} placeholder={t("emoji.search")} aria-label={t("emoji.search")} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
        </label>
        <button type="button" className="icon emoji emoji-tone" title={t("emoji.tone")} aria-label={t("emoji.tone")} aria-expanded={tonesOpen} onClick={() => setTonesOpen((o) => !o)}>{TONE_SAMPLE[tone]}</button>
      </div>
      {tonesOpen && (
        <div className="emoji-tones" role="radiogroup" aria-label={t("emoji.tone")}>
          {SKIN_TONES.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={n === tone} aria-label={t(`emoji.tone.${n}`)} title={t(`emoji.tone.${n}`)} className={`icon emoji ${n === tone ? "active" : ""}`}
              onClick={() => { setTone(n); saveTone(n); setTonesOpen(false); }}>{TONE_SAMPLE[n]}</button>
          ))}
        </div>
      )}
      {groups && !results && (
        <nav className="emoji-nav" aria-label={t("emoji.groups")}>
          {recentEntries.length > 0 && <button type="button" className="icon" title={t(RECENT.label)} aria-label={t(RECENT.label)} onClick={() => jump("recent")}><Icon name={RECENT.icon} /></button>}
          {groups.map((g) => { const meta = GROUP_META[g.key]; return meta && <button key={g.key} type="button" className="icon" title={t(meta.label)} aria-label={t(meta.label)} onClick={() => jump(g.key)}><Icon name={meta.icon} /></button>; })}
        </nav>
      )}
      <div ref={body} className="emoji-body" onClick={onGridClick} onMouseOver={onGridPoint} onFocus={onGridPoint} onKeyDown={onGridKey}>
        {failed && <p className="error center">{t("emoji.loadFailed")}</p>}
        {!groups && !failed && <p className="muted center">{t("common.loading")}</p>}
        {results && (results.length > 0 ? <EmojiGrid entries={results} tone={tone} /> : <p className="muted center">{t("emoji.none")}</p>)}
        {groups && !results && (
          <>
            {recentEntries.length > 0 && <EmojiSection group="recent" title={t(RECENT.label)} entries={recentEntries} tone={0} />}
            {groups.map((g) => <EmojiSection key={g.key} group={g.key} title={GROUP_META[g.key] ? t(GROUP_META[g.key]!.label) : g.key} entries={g.emojis} tone={tone} />)}
          </>
        )}
      </div>
      <div className="emoji-foot" aria-live="polite">
        {preview
          ? <><span className="emoji emoji-preview">{preview.emoji}</span><span className="emoji-preview-text"><strong>{preview.name}</strong>{preview.code && <span className="muted">:{preview.code}:</span>}</span></>
          : <span className="muted small">{t("emoji.hint")}</span>}
      </div>
    </div>, document.body,
  );
}

/** Memoized: pointing at an emoji re-renders the picker (preview), the almost 2000 buttons must not follow. */
const EmojiSection = memo(function EmojiSection({ group, title, entries, tone }: { group: string; title: string; entries: EmojiEntry[]; tone: SkinTone }) {
  return (
    <section className="emoji-section" data-group={group} aria-label={title}>
      <h3>{title}</h3>
      <EmojiGrid entries={entries} tone={tone} />
    </section>
  );
});

const EmojiGrid = memo(function EmojiGrid({ entries, tone }: { entries: EmojiEntry[]; tone: SkinTone }) {
  return (
    <div className="emoji-grid">
      {entries.map((entry) => {
        const emoji = emojiWithTone(entry, tone);
        return <button key={emoji} type="button" tabIndex={-1} className="emoji" title={entry[1]} aria-label={entry[1]} data-emoji={emoji} data-name={entry[1]} data-code={firstShortcode(entry) ?? ""}>{emoji}</button>;
      })}
    </div>
  );
});
