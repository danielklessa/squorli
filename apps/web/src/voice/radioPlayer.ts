/**
 * Web radio of the voice channel you are in. The stream does not come through LiveKit: every client plays the station's
 * address itself in a plain <audio> element, so everyone chooses their own volume or turns the radio off for themselves.
 * Volume, "off" and the stage's equalizer are stored per device (`chat.radio.v2`): like the per-person volumes they
 * depend on the headset in front of this browser. The volume is only stored once the user has set it, so until then the
 * default applies (and a later change of the default reaches everyone who never touched the slider). Turned off means disconnected: no data is loaded and the station never
 * sees this listener. Deafening only silences the element, so the radio is back at once afterwards.
 * The element asks with CORS first (14 October 2026, the equalizer needs the samples; most stations allow it) and loads
 * once more without it when that fails before anything played, so a station without CORS plays as before. The equalizer
 * reads a copy of the element's sound (`captureStream`, Chromium only) and never sits in its way: the element keeps its
 * volume and its output device. Never use `createMediaElementSource` for this (it takes the sound out of the element).
 */
const KEY = "chat.radio.v2";
/** v1 (first day of the radio, never released) always stored the volume, also the default of that day: dropped. */
const OLD_KEY = "chat.radio.v1";
/** Stations are mastered much louder than a voice: 5 % until the user sets their own volume (user's requirement). */
export const RADIO_DEFAULT_VOLUME = 0.05;
const RETRY_MS = [2000, 5000, 15000, 30000];

export type RadioSettings = { volume: number; muted: boolean };
export type RadioStatus = "off" | "connecting" | "playing" | "blocked" | "error";
/**
 * `visual` = the stage's equalizer is wanted (stored per device; off until the user turns it on, user's decision of
 * 14 October 2026); `visualFront` = it is drawn over the tiles instead of behind them (stored per device, off by default, the
 * user's wish of 14 October 2026); `analysable` = the sound can be read right now (playing with CORS in a browser with `captureStream`).
 */
export type RadioState = RadioSettings & { status: RadioStatus; visual: boolean; visualFront: boolean; analysable: boolean };

/** Stored JSON -> settings; broken or foreign data yields the defaults. */
export function parseRadioSettings(raw: string | null): RadioSettings {
  const fallback = { volume: RADIO_DEFAULT_VOLUME, muted: false };
  if (!raw) return fallback;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return fallback;
    const { volume, muted } = data as Record<string, unknown>;
    return { volume: typeof volume === "number" && Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : RADIO_DEFAULT_VOLUME, muted: muted === true };
  } catch { return fallback; }
}

/** Has the user set a volume of their own? Only then it is stored. */
export function hasOwnVolume(raw: string | null): boolean {
  try { const v = (JSON.parse(raw ?? "null") as { volume?: unknown } | null)?.volume; return typeof v === "number" && Number.isFinite(v); } catch { return false; }
}

/** The equalizer as the user set it; null = never chosen (then the default applies). */
export function parseRadioVisual(raw: string | null): boolean | null {
  try { const v = (JSON.parse(raw ?? "null") as { visual?: unknown } | null)?.visual; return typeof v === "boolean" ? v : null; } catch { return null; }
}

/** The equalizer over the tiles: only an explicit `true` counts, everything else is behind them (the default). */
export function parseRadioVisualFront(raw: string | null): boolean {
  try { return (JSON.parse(raw ?? "null") as { visualFront?: unknown } | null)?.visualFront === true; } catch { return false; }
}

/** What is written to the device: the off switch always, the volume and the equalizer only when they are the user's own, the equalizer's place only when it is in front. */
export function storedRadioSettings(settings: RadioSettings, ownVolume: boolean, visual: boolean | null = null, visualFront = false): { volume?: number; muted: boolean; visual?: boolean; visualFront?: boolean } {
  const stored: { volume?: number; muted: boolean; visual?: boolean; visualFront?: boolean } = ownVolume ? { volume: settings.volume, muted: settings.muted } : { muted: settings.muted };
  if (visual !== null) stored.visual = visual;
  if (visualFront) stored.visualFront = true;
  return stored;
}

/** Can this browser copy an element's sound without taking it away (Chromium's `captureStream`; Firefox's `mozCaptureStream` silences the element)? */
type CapturingAudio = HTMLAudioElement & { captureStream?: () => MediaStream };
function canCapture(el: HTMLAudioElement): boolean {
  return typeof (el as CapturingAudio).captureStream === "function";
}

/** Why the element is (not) loading: the radio runs only with an address, and not while the user has turned it off. */
export function shouldLoad(url: string | null, settings: RadioSettings): boolean {
  return url !== null && !settings.muted;
}

export class RadioPlayer {
  state: RadioState;
  private listeners = new Set<(s: RadioState) => void>();
  private el: HTMLAudioElement | null = null;
  private url: string | null = null;
  private deafened = false;
  private sinkId: string | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unblock: (() => void) | null = null;
  private ownVolume: boolean;
  /** The equalizer as the user set it (null = the default). */
  private visualChoice: boolean | null;
  /** The current address failed with CORS before it ever played: it loads without, and cannot be analysed. */
  private noCors = false;
  /** The current address played with CORS once: a later error is the station's, not CORS. */
  private corsPlayed = false;
  /** Context of the equalizer's analysis only: never connected to an output. */
  private visualCtx: AudioContext | null = null;
  private analysis: { stream: MediaStream; source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null = null;
  private ctxUnlock: (() => void) | null = null;

  constructor() {
    let stored: string | null = null;
    try { stored = localStorage.getItem(KEY); localStorage.removeItem(OLD_KEY); } catch { /* blocked storage: defaults */ }
    this.visualChoice = parseRadioVisual(stored);
    this.state = { ...parseRadioSettings(stored), status: "off", visual: this.visualChoice ?? false, visualFront: parseRadioVisualFront(stored), analysable: false };
    this.ownVolume = hasOwnVolume(stored);
  }

  subscribe(fn: (s: RadioState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private patch(p: Partial<RadioState>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(storedRadioSettings(this.state, this.ownVolume, this.visualChoice, this.state.visualFront))); } catch { /* still applies for this session */ }
  }

  /** What the voice channel plays; null = no radio (or not in a voice channel). */
  setStream(url: string | null) {
    if (url === this.url) return;
    this.url = url;
    this.attempts = 0;
    this.noCors = false;
    this.corsPlayed = false;
    this.apply();
  }

  /** The stage's equalizer on or off (this device). */
  setVisual(on: boolean) {
    this.visualChoice = on;
    this.patch({ visual: on });
    this.save();
  }

  /** The equalizer over the tiles or behind them (this device). */
  setVisualFront(on: boolean) {
    this.patch({ visualFront: on });
    this.save();
  }

  /**
   * The equalizer's view of the sound, or null while it cannot be read. Built on first use after the element started
   * playing (a captured stream has its audio track only then) and again after every new start.
   */
  analyser(): AnalyserNode | null {
    if (!this.state.analysable || !this.el) return null;
    if (this.analysis) return this.analysis.analyser;
    try {
      const stream = (this.el as CapturingAudio).captureStream!();
      if (stream.getAudioTracks().length === 0) return null;
      const ctx = this.visualCtx ??= new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      this.analysis = { stream, source, analyser };
      this.wakeCtx(ctx);
      return analyser;
    } catch { return null; }
  }

  /** A context made without a gesture may start suspended: try now, else with the next click or key. */
  private wakeCtx(ctx: AudioContext) {
    if (ctx.state === "running" || this.ctxUnlock) return;
    void ctx.resume().catch(() => {});
    const go = () => { this.ctxUnlock?.(); this.ctxUnlock = null; void ctx.resume().catch(() => {}); };
    document.addEventListener("pointerdown", go, { once: true, capture: true });
    document.addEventListener("keydown", go, { once: true, capture: true });
    this.ctxUnlock = () => { document.removeEventListener("pointerdown", go, true); document.removeEventListener("keydown", go, true); };
  }

  private dropAnalysis() {
    const a = this.analysis;
    if (!a) return;
    this.analysis = null;
    a.source.disconnect();
    for (const track of a.stream.getTracks()) track.stop();
  }

  setVolume(volume: number) {
    const v = Math.max(0, Math.min(1, volume));
    this.ownVolume = true;
    this.patch({ volume: v });
    if (this.el) this.el.volume = v;
    this.save();
  }

  /** The user's own off switch: disconnects from the station, the channel's radio keeps running for everyone else. */
  setMuted(muted: boolean) {
    if (muted === this.state.muted) return;
    this.patch({ muted });
    this.save();
    this.attempts = 0;
    this.apply();
  }

  /** Follows the voice client's deafen. */
  setDeafened(on: boolean) {
    this.deafened = on;
    if (this.el) this.el.muted = on;
  }

  /** Same output device as the voices (Chromium only; elsewhere the system default). */
  setOutputDevice(deviceId: string | null) {
    this.sinkId = deviceId;
    this.applySink();
  }

  /** From a click: start playback the browser blocked, or try again at once after an error. */
  resume() {
    this.attempts = 0;
    this.apply();
  }

  private applySink() {
    const el = this.el as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el?.setSinkId) void el.setSinkId(this.sinkId ?? "").catch(() => {});
  }

  private clearTimers() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.unblock) { this.unblock(); this.unblock = null; }
  }

  private apply() {
    this.clearTimers();
    this.dropAnalysis();
    if (!shouldLoad(this.url, this.state)) { this.unload(); this.patch({ status: "off", analysable: false }); return; }
    const el = this.element();
    el.volume = this.state.volume;
    el.muted = this.deafened;
    if (this.noCors) el.removeAttribute("crossorigin"); else el.crossOrigin = "anonymous";
    el.src = this.url!;
    this.patch({ status: "connecting", analysable: false });
    this.applySink();
    const url = this.url;
    el.play().catch((err: unknown) => {
      if (url !== this.url || this.state.muted) return; // superseded meanwhile (a new src aborts the old play())
      if (err instanceof DOMException && err.name === "NotAllowedError") this.blocked();
      // Everything else also arrives as the element's "error" event, which schedules the retry.
    });
  }

  /** Autoplay refused (no gesture in this document yet): the next click or key anywhere starts the radio. */
  private blocked() {
    this.patch({ status: "blocked" });
    const go = () => this.resume();
    document.addEventListener("pointerdown", go, { once: true, capture: true });
    document.addEventListener("keydown", go, { once: true, capture: true });
    this.unblock = () => { document.removeEventListener("pointerdown", go, true); document.removeEventListener("keydown", go, true); };
  }

  /** A live stream that ends or fails is reconnected, slower each time; the menu shows the error from the third failure on. */
  private failed() {
    if (!shouldLoad(this.url, this.state) || this.retryTimer) return;
    const delay = RETRY_MS[Math.min(this.attempts, RETRY_MS.length - 1)]!;
    this.attempts++;
    this.patch({ status: this.attempts >= 3 ? "error" : "connecting" });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.apply(); }, delay);
  }

  private element(): HTMLAudioElement {
    if (this.el) return this.el;
    const el = new Audio();
    el.preload = "none";
    el.addEventListener("playing", () => {
      this.attempts = 0;
      const cors = el.crossOrigin === "anonymous";
      if (cors) this.corsPlayed = true;
      this.dropAnalysis(); // a new start may bring new tracks: the next analyser() call captures afresh
      this.patch({ status: "playing", analysable: cors && canCapture(el) });
    });
    el.addEventListener("waiting", () => { if (this.state.status === "playing") this.patch({ status: "connecting" }); });
    el.addEventListener("error", () => {
      // Asked with CORS and failed before it ever played: most likely a station without CORS, so once more without at once.
      if (el.crossOrigin === "anonymous" && !this.corsPlayed && !this.noCors && shouldLoad(this.url, this.state)) { this.noCors = true; this.apply(); return; }
      this.failed();
    });
    el.addEventListener("ended", () => this.failed());
    this.el = el;
    return el;
  }

  /** Really close the connection: pausing alone keeps a live stream downloading. */
  private unload() {
    this.dropAnalysis();
    if (this.visualCtx?.state === "running") void this.visualCtx.suspend().catch(() => {});
    const el = this.el;
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
}
