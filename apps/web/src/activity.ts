import { AFK_AFTER_MS } from "@squorli/protocol";

/**
 * AFK detection (17 September 2026, user's requirement): after AFK_AFTER_MS without activity the user counts as absent.
 * The client measures it, because only it sees input; the store reports every change to the chat servers and to the
 * directory (`activity` events), which turn the reports of all of a user's connections into the state others see.
 *
 * What counts as activity (user's decisions):
 * - input in a Squorli window: pointer, keys, wheel, touch (`watchActivity`), which includes the push-to-talk key;
 * - speaking: the open speech gate of an unmuted microphone (App.tsx feeds `touch()` from the voice client), so somebody
 *   who plays a game and talks is not moved away;
 * - with the Idle Detection API (Chromium, needs the user's permission, idleDetection.ts): input anywhere in the system.
 *   While the detector reports the user active they are never idle; once it reports idle (or the screen is locked) the
 *   rule above decides. Without a detector (`systemIdle` null) only the first two count.
 * - in the desktop app (systemActivity.ts, user's decisions of 20 September 2026): controller input, fed as `touch()`, and
 *   a playing video: watching needs no input, so while one plays the user stays present, but for at most
 *   VIDEO_ACTIVE_MAX_MS since they were last seen (autoplay, a viewer who fell asleep);
 * - a stream watched inside Squorli (20 November 2026): a share or the radio's video in fullscreen, or pinned large in the
 *   speaker view (`setWatching`, fed by the stage's tiles and the pop-out windows), with the same four-hour limit.
 */
export const VIDEO_ACTIVE_MAX_MS = 4 * 60 * 60_000;
/** A video that stopped still counts this long: the gap between two videos of a playlist, an advertisement, buffering. */
export const VIDEO_GAP_MS = 2 * 60_000;

export class ActivityTracker {
  private last: number;
  /** When the user was last really there: input or speech, or the system-wide detector saying so. The video rule's four hours count from here. */
  private lastPresent: number;
  private video = false;
  private videoEndedAt: number | null = null;
  private readonly watched = new Set<string>();
  private systemIdle: boolean | null = null;
  private idleNow = false;
  private readonly listeners = new Set<(idle: boolean) => void>();

  constructor(private readonly idleMs: number = AFK_AFTER_MS, private readonly now: () => number = () => Date.now()) {
    this.last = this.now();
    this.lastPresent = this.last;
  }

  get idle(): boolean { return this.idleNow; }

  subscribe(fn: (idle: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Input or speech just happened. */
  touch(): void {
    this.last = this.now();
    this.lastPresent = this.last;
    this.check();
  }

  /** Some program plays a video (the desktop shell's "display required" state, never Squorli's own video). */
  setVideoPlaying(on: boolean): void {
    if (on === this.video) return;
    this.video = on;
    if (!on) this.videoEndedAt = this.now();
    this.check();
  }

  /** The system-wide detector's verdict: true = no input anywhere (or screen locked), false = in use, null = no detector. */
  setSystemIdle(idle: boolean | null): void {
    this.systemIdle = idle;
    this.check();
  }

  /**
   * The user watches a stream inside Squorli (user's wish, 20 November 2026: a share or the radio's video in fullscreen, or
   * pinned large in the speaker view): watching needs no input, so they stay present like with a video in another program,
   * for at most VIDEO_ACTIVE_MAX_MS since they were last seen. One key per place that shows such a stream (a tile, a pop-out).
   */
  setWatching(key: string, on: boolean): void {
    if (on === this.watched.has(key)) return;
    if (on) this.watched.add(key); else this.watched.delete(key);
    this.check();
  }

  /** Re-evaluate; call regularly, because turning idle happens without any event. */
  check(): void {
    const now = this.now();
    if (this.systemIdle === false) this.lastPresent = now;
    const stream = this.video || this.watched.size > 0 || (this.videoEndedAt !== null && now - this.videoEndedAt < VIDEO_GAP_MS);
    const watching = stream && now - this.lastPresent < VIDEO_ACTIVE_MAX_MS;
    const idle = (this.systemIdle ?? true) && now - this.last >= this.idleMs && !watching;
    if (idle === this.idleNow) return;
    this.idleNow = idle;
    for (const fn of this.listeners) fn(idle);
  }
}

/** The one tracker of this page: the store reports it, App.tsx and the video pop-outs feed it. */
export const activity = new ActivityTracker();

const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
const CHECK_MS = 5_000;

/** Feed a tracker from the input events of a window (the main page, a video pop-out) and keep it checking. Returns the cleanup. */
export function watchActivity(tracker: ActivityTracker, win: Window = window): () => void {
  let lastTouch = 0;
  const onInput = () => {
    // Pointer moves arrive by the hundred; once a second is plenty for a five-minute rule.
    const t = Date.now();
    if (t - lastTouch < 1000 && !tracker.idle) return;
    lastTouch = t;
    tracker.touch();
  };
  for (const name of INPUT_EVENTS) win.addEventListener(name, onInput, { capture: true, passive: true });
  const timer = win.setInterval(() => tracker.check(), CHECK_MS);
  return () => {
    for (const name of INPUT_EVENTS) win.removeEventListener(name, onInput, { capture: true });
    win.clearInterval(timer);
  };
}
