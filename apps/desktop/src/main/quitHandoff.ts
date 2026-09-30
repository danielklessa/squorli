/**
 * The hand-off before the app goes away (pure, no Electron import; docs/features/desktop.md, 30 September 2026): a window
 * close or a quit is held once, the client is asked to finish (it leaves its voice channel, so the leave cue sounds), and
 * the held action is carried out when the client answers or after `timeoutMs`, whichever comes first. A client that
 * cannot be asked (none loaded, an update installing) is not waited for.
 */
export type QuitHandoff = {
  /**
   * A close or quit attempt. True = it may go ahead now. False = it was held: the client is being asked, and `proceed`
   * is called later (once), so the caller repeats the attempt from there. A second attempt while the first is held is
   * swallowed; the first one's `proceed` still runs.
   */
  attempt(proceed: () => void): boolean;
  /** The client's answer to the request with this id; another id is ignored. */
  answer(requestId: number): void;
  /** Nothing to ask any more: every attempt from now on goes ahead at once. */
  skip(): void;
  /** Whether a request waits for an answer right now. */
  pending(): boolean;
};

export type QuitHandoffOptions = {
  /** Ask the client; false = there is no client to ask (the attempt then goes ahead). */
  ask: (requestId: number) => boolean;
  timeoutMs: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export function createQuitHandoff(opts: QuitHandoffOptions): QuitHandoff {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state: "idle" | "asking" | "done" = "idle";
  let requestId = 0;
  let timer: unknown = null;
  let held: (() => void) | null = null;

  const finish = () => {
    if (state !== "asking") return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    state = "done";
    const go = held;
    held = null;
    go?.();
  };

  return {
    attempt(proceed) {
      if (state === "done") return true;
      if (state === "asking") return false;
      requestId += 1;
      let asked = false;
      try { asked = opts.ask(requestId); } catch { asked = false; }
      if (!asked) { state = "done"; return true; }
      state = "asking";
      held = proceed;
      timer = setTimer(finish, opts.timeoutMs);
      return false;
    },
    answer(id) { if (state === "asking" && id === requestId) finish(); },
    skip() { if (state === "asking") { if (timer !== null) { clearTimer(timer); timer = null; } held = null; } state = "done"; },
    pending: () => state === "asking",
  };
}
