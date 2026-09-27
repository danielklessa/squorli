import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { VoiceClient } from "./voice/voiceClient";
import { activity, watchActivity } from "./activity";
import { usePushToTalk } from "./usePushToTalk";
import { isOpen, openPopoutWindow, type Entry } from "./VideoWindows";
import { platform } from "./platform";

/** The stage window's name: the desktop shell finds it by that to bring it to the front, a browser by `window.open("", name)`. */
const STAGE_WINDOW = "squorli-stage";

/**
 * The whole voice stage in a window of its own (user's wish: the stage on one monitor, the chat in the main window).
 * Same technique as the video pop-outs (VideoWindows.tsx `openPopoutWindow`): an empty window with the client's styles,
 * the stage is rendered into it through a portal, so it stays ONE client with one voice connection. Lives at App level:
 * the window survives switching channels, servers and the home view, and goes when the voice channel is left or the
 * main window closes. While it is open the main window shows no stage (App.tsx), closing the window brings it back.
 * What a window of another document needs is handled where it happens: menus (ContextMenu.tsx), observers
 * (VoiceStage.tsx, RadioControl.tsx), push-to-talk and AFK input here, the camera and screen dialogs (App.tsx `pickWindow`),
 * opening further windows from it (`opener`), and the web radio's player, which stays in the main window (VoiceStage.tsx).
 */
export function useStageWindow(client: VoiceClient, available: boolean, title: string) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  useEffect(() => {
    const close = () => entryRef.current?.window.close();
    window.addEventListener("pagehide", close);
    return () => { window.removeEventListener("pagehide", close); close(); };
  }, []);
  // The user closed the window: the stage is the main window's again.
  useEffect(() => {
    if (!entry) return;
    const timer = window.setInterval(() => { if (!isOpen(entry)) setEntry((old) => old === entry ? null : old); }, 500);
    return () => window.clearInterval(timer);
  }, [entry]);
  const close = () => { entryRef.current?.window.close(); setEntry(null); };
  // Nothing to show any more (left the voice channel): the window goes.
  useEffect(() => { if (!available) close(); }, [available]);

  const popped = entry !== null && isOpen(entry);
  return {
    popped,
    /** Throws with a text for the user when the browser refuses the window. Must be called inside the user's click. */
    open: () => {
      const current = entryRef.current;
      if (current && isOpen(current)) { current.window.focus(); return; }
      const size = { width: Math.min(1280, window.screen.availWidth), height: Math.max(1, Math.min(800, window.screen.availHeight - 120)) };
      const popup = openPopoutWindow(size, "stage-window-body", window, STAGE_WINDOW);
      setEntry({ id: "stage", window: popup, document: popup.document });
    },
    close,
    /**
     * Bring the window to the front ("Fenster zeigen"). `focus()` on another window is ignored by most systems; the desktop
     * shell does it for the client, a browser raises a named window that `open` targets inside the user's click.
     */
    focus: () => {
      const current = entryRef.current;
      if (!current || !isOpen(current)) return;
      if (platform.window.focusPopout) { platform.window.focusPopout(STAGE_WINDOW); return; }
      try { window.open("", STAGE_WINDOW)?.focus(); } catch { /* the browser refused: the plain focus below */ }
      current.window.focus();
    },
    /** The stage's window while the user is working in it, else null: dialogs the stage asks for are shown there. */
    focusedWindow: (): Window | null => { const current = entryRef.current; return current && isOpen(current) && current.document.hasFocus() ? current.window : null; },
    render: (stage: ReactNode) => entry && popped ? <StageWindow entry={entry} client={client} title={title}>{stage}</StageWindow> : null,
  };
}
export type StageWindowControl = ReturnType<typeof useStageWindow>;

function StageWindow({ entry, client, title, children }: { entry: Entry; client: VoiceClient; title: string; children: ReactNode }) {
  // AFK detection and push-to-talk: input in this window counts like input in the main window.
  useEffect(() => watchActivity(activity, entry.window), [entry.window]);
  usePushToTalk(entry.window, client, client.state.status !== "disconnected", false);
  useEffect(() => { entry.document.title = title; }, [entry.document, title]);
  return createPortal(children, entry.document.body);
}
