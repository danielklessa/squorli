import { useEffect, useRef } from "react";

/**
 * What the system's back button closes (Android's in the mobile app, `platform.window.back`; docs/features/mobile.md):
 * every dialog, menu and sheet registers here while it is open (`useBackClose`), as Escape closes it on a keyboard. Back
 * closes the newest overlay; with none open it goes one page back in the phone layout (App.tsx: from a chat or the stage
 * to the channel list); with nothing left it answers false and the platform sends the app to the background.
 */
export type BackKind = "overlay" | "page";

export function createBackStack() {
  const entries: { kind: BackKind; close: () => void }[] = [];
  return {
    /** Register `close` until the returned function is called. */
    push(close: () => void, kind: BackKind = "overlay"): () => void {
      const entry = { kind, close };
      entries.push(entry);
      return () => { const i = entries.indexOf(entry); if (i >= 0) entries.splice(i, 1); };
    },
    /** One step back: the newest overlay, else the newest page; false = nothing was open. */
    back(): boolean {
      const entry = entries.filter((e) => e.kind === "overlay").at(-1) ?? entries.at(-1);
      if (!entry) return false;
      entry.close();
      return true;
    },
  };
}

/** The page's one stack. */
export const backStack = createBackStack();

/** While `active`, the back button calls the newest `close` (read at the press, so it may change with every render). */
export function useBackClose(close: () => void, active = true, kind: BackKind = "overlay"): void {
  const ref = useRef(close);
  useEffect(() => { ref.current = close; });
  useEffect(() => (active ? backStack.push(() => ref.current(), kind) : undefined), [active, kind]);
}
