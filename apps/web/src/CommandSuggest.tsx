import { pluginText, type PluginCommand } from "@squorli/protocol";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { Icon } from "./Icon";
import { locale, t } from "./i18n";
import { commandQueryAt, matchCommands } from "./pluginFields";

/**
 * The plugins' slash commands while a "/name" is being typed at the start of the composer (docs/features/plugins.md).
 * The same contract as `useMentionSuggest`: the owner calls `sync()` whenever text or caret may have changed, lets
 * `onKeyDown` see the keys first (arrows choose, Enter or Tab accept, Escape dismisses; true = handled, so Enter does not
 * send) and renders `popup` inside a positioned parent above the input. `commands` are the ones the member may use in this
 * channel (pluginFields.ts `usableCommands`); an empty list (also: files are attached, no plugins) keeps it closed.
 * `onAccept` gets the chosen command; what happens then depends on its `input` and is the composer's business.
 */
export function useCommandSuggest({ inputRef, commands, onAccept }: {
  inputRef: MutableRefObject<HTMLTextAreaElement | null>; commands: readonly PluginCommand[]; onAccept: (command: PluginCommand) => void;
}): { popup: ReactNode; sync: () => void; close: () => void; onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean } {
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  /** Escape dismissed the list for this draft's command word; it comes back once the draft stops being a command. */
  const dismissed = useRef(false);
  const lastKey = useRef<string | null>(null);

  const sync = useCallback(() => {
    // After the event: the caret is where the key or click put it.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      const next = el && document.activeElement === el && el.selectionStart === el.selectionEnd ? commandQueryAt(el.value, el.selectionStart) : null;
      if (next === null) dismissed.current = false;
      const shown = dismissed.current ? null : next;
      // Arrow keys also end up here (keyup): the choice only starts over when the query really changed.
      if (shown === lastKey.current) return;
      lastKey.current = shown;
      setQuery(shown);
      setIndex(0);
    });
  }, [inputRef]);
  const close = useCallback(() => { lastKey.current = null; setQuery(null); }, []);

  const hits = useMemo(() => (query === null ? [] : matchCommands(commands, query)), [commands, query]);
  const open = query !== null && hits.length > 0;
  const accept = (command: PluginCommand) => { close(); onAccept(command); };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => (i + (event.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length); return true; }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); accept(hits[Math.min(index, hits.length - 1)]!); return true; }
    if (event.key === "Escape") { event.preventDefault(); dismissed.current = true; close(); return true; }
    return false;
  };

  const popup = open ? (
    <ul className="mention-suggest command-suggest" role="listbox" aria-label={t("plugin.commandSuggest")}>
      {hits.map((c, i) => (
        // mousedown, not click: the input must keep the focus (and its caret).
        <li key={`${c.plugin}:${c.name}`} role="option" aria-selected={i === index} className={i === index ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); accept(c); }} onMouseEnter={() => setIndex(i)}>
          <span className="command-suggest-name">/{c.name}{c.input === "text" && c.textHint && <span className="muted command-suggest-hint"> {pluginText(c.textHint, locale)}</span>}</span>
          <span className="command-suggest-desc">{pluginText(c.description, locale)}</span>
          <span className="muted small command-suggest-plugin"><Icon name="puzzle" /> {pluginText(c.pluginName, locale)}</span>
        </li>
      ))}
    </ul>
  ) : null;

  return { popup, sync, close, onKeyDown };
}
