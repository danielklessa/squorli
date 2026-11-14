import type { ElementInfo } from "livekit-client";

/** Fullscreen must be requested on the element's own document (which may be a pop-out). */
export async function toggleVideoFullscreen(element: {
  requestFullscreen?: () => Promise<void>;
  ownerDocument: { fullscreenElement: unknown; exitFullscreen: () => Promise<void> };
}): Promise<boolean> {
  if (element.ownerDocument.fullscreenElement) await element.ownerDocument.exitFullscreen();
  else if (element.requestFullscreen) await element.requestFullscreen();
  else return false;
  return true;
}

/**
 * What LiveKit's adaptiveStream needs to know about a video view in a POP-OUT window, reported from that window.
 * LiveKit's own `HTMLElementInfo` watches every attached element with one IntersectionObserver created in the main window
 * (`root: null`). Firefox never reports an element of another window as intersecting (the implicit root is the observer's
 * own top-level document), so adaptiveStream took the pop-out for invisible and paused the track: the camera froze on its
 * first frames as soon as it was popped out (user's report, 18 September 2026). Chrome measures against the element's own
 * document and was fine. Registered before `attach()`, so LiveKit skips its own info for the element.
 */
export class PopoutElementInfo implements ElementInfo {
  /** The window shows nothing but this video; a window hidden for a while detaches the view (`watchDocumentHidden`). */
  visible = true;
  pictureInPicture = false;
  visibilityChangedAt: number | undefined = undefined;
  handleResize?: () => void;
  handleVisibilityChanged?: () => void;
  private observer: ResizeObserver | null = null;
  constructor(readonly element: HTMLElement) {}
  width() { return this.element.clientWidth; }
  height() { return this.element.clientHeight; }
  observe() {
    // The pop-out's own ResizeObserver, not the main window's: the simulcast layer follows the window's size.
    const win = this.element.ownerDocument.defaultView;
    if (!win?.ResizeObserver) return;
    this.observer = new win.ResizeObserver(() => this.handleResize?.());
    this.observer.observe(this.element);
  }
  stopObserving() { this.observer?.disconnect(); this.observer = null; }
}

type ViewTrack<T> = { attach: (element: T) => unknown; detach: (element: T) => unknown; observeElementInfo?: (info: ElementInfo) => void };
/** An element that lives in another window than the client (a pop-out). */
const inOtherWindow = (element: unknown): element is HTMLElement => {
  const view = (element as { ownerDocument?: { defaultView?: unknown } } | null)?.ownerDocument?.defaultView;
  return !!view && (typeof window === "undefined" || view !== window);
};

/** Detach only this view, never stop the shared track or detach the other windows. */
export function attachVideoView<T>(track: ViewTrack<T>, element: T) {
  // Remote tracks only (local ones have no adaptiveStream); `detach()` stops the info again.
  if (track.observeElementInfo && inOtherWindow(element)) track.observeElementInfo(new PopoutElementInfo(element));
  track.attach(element);
  return () => { track.detach(element); };
}
/**
 * Stop receiving a video nobody can see, decided per window. LiveKit's own rule (adaptiveStream `pauseVideoInBackground`)
 * only looks at the MAIN page: five seconds after that is hidden (another tab, minimized, or on Windows completely covered
 * by other windows) it pauses every received video, also one that is showing in a pop-out window, perhaps in fullscreen on
 * a second monitor (user's report: "manchmal bleibt ein Screenshare hängen, wenn er ausgepoppt oder im Vollbild ist"). So
 * that rule is turned off (voiceClient.ts) and each video view detaches itself while ITS OWN document has been hidden for
 * a while: a track without an attached element is paused by adaptiveStream, one that still shows in a visible window plays on.
 * Calls `onChange(true)` once the document has been hidden for `delayMs`, `onChange(false)` as soon as it is visible again.
 */
/**
 * Is the own camera shown mirrored? Yes, like a mirror, as every video app does, EXCEPT a phone's rear camera
 * (`facingMode: "environment"` in the track's settings): what it shows is in front of the user, and mirrored text there reads backwards.
 * `mirror` is the user's switch (`VoiceSettings.cameraMirror`, 14 November 2026): off shows the picture as the others get it. Only the
 * own view is ever mirrored; what is sent never is.
 */
export const mirrorsOwnCamera = (facingMode: string | undefined, mirror = true): boolean => mirror && facingMode !== "environment";

export const HIDDEN_PAUSE_DELAY_MS = 5000;
export function watchDocumentHidden(doc: { hidden: boolean; addEventListener: (type: "visibilitychange", fn: () => void) => void; removeEventListener: (type: "visibilitychange", fn: () => void) => void },
  onChange: (hiddenForLong: boolean) => void, delayMs = HIDDEN_PAUSE_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  const report = (value: boolean) => { if (value !== reported) { reported = value; onChange(value); } };
  const update = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (doc.hidden) timer = setTimeout(() => { timer = null; report(true); }, delayMs);
    else report(false);
  };
  update();
  doc.addEventListener("visibilitychange", update);
  return () => { if (timer !== null) clearTimeout(timer); doc.removeEventListener("visibilitychange", update); };
}

/** Fit the video content within the available space, preserving its aspect ratio. */
export function fitVideoWindow(ratio: number, preferredWidth: number, maxWidth: number, maxHeight: number) {
  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
  const width = Math.max(1, Math.min(preferredWidth, maxWidth, maxHeight * aspect));
  return { width: Math.round(width), height: Math.max(1, Math.round(width / aspect)) };
}
