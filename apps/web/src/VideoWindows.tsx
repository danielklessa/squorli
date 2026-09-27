import { VideoStatsButton, VideoStatsOverlay } from "./VideoStatsOverlay";
import { ShareViewers, type ShareViewer } from "./ShareViewers";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { VoiceClient, VideoTile } from "./voice/voiceClient";
import { Icon } from "./Icon";
import { VideoAudioControls } from "./VideoAudioControls";
import { t } from "./i18n";
import { platform } from "./platform";
import { activity, watchActivity } from "./activity";
import { attachVideoView, fitVideoWindow, mirrorsOwnCamera, toggleVideoFullscreen, watchDocumentHidden } from "./videoDisplay";

export function TrackVideo({ tile }: { tile: VideoTile }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Attached only while the window this view lives in (the page or a pop-out) can be seen: videoDisplay.ts `watchDocumentHidden`.
  const [unseen, setUnseen] = useState(false);
  useEffect(() => watchDocumentHidden(ref.current!.ownerDocument, setUnseen), []);
  useEffect(() => {
    if (unseen) return;
    const element = ref.current!;
    return attachVideoView(tile.track, element);
  }, [tile.track, unseen]);
  const mirror = tile.isLocal && tile.source === "camera" && mirrorsOwnCamera(tile.track.mediaStreamTrack?.getSettings().facingMode);
  return <video ref={ref} className={mirror ? "mirror" : ""} autoPlay playsInline muted />;
}

export function FullscreenButton({ target, onError }: { target: () => HTMLElement | null; onError: (message: string) => void }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const element = target();
    const doc = element?.ownerDocument;
    const update = () => setActive(!!element && doc?.fullscreenElement === element);
    update(); doc?.addEventListener("fullscreenchange", update);
    return () => doc?.removeEventListener("fullscreenchange", update);
  }, [target]);
  const toggle = async () => {
    const element = target();
    if (!element) return;
    onError("");
    try {
      if (!await toggleVideoFullscreen(element)) onError(t("stage.fullscreenUnavailable"));
    } catch { onError(t("stage.fullscreenFailed")); }
  };
  return <button className="icon" title={t(active ? "stage.exitFullscreen" : "stage.fullscreen")} aria-label={t(active ? "stage.exitFullscreen" : "stage.fullscreen")}
    onClick={(event) => { event.stopPropagation(); void toggle(); }}><Icon name={active ? "minimize" : "maximize"} /></button>;
}

export type Entry = { id: string; window: Window; document: Document };
export function isOpen(entry: Entry) {
  try { return !entry.window.closed && entry.window.document === entry.document; } catch { return false; }
}

/**
 * A window of the client's own for a part of it (one video, or the whole stage: StageWindow.tsx): an empty page that gets
 * the client's styles, React renders into its body through a portal. Must run synchronously inside the user's click,
 * before any asynchronous work. `opener` = the window that click happened in: a browser lets only that one open a window.
 */
export function openPopoutWindow(size: { width: number; height: number }, bodyClass: string, opener: Window = window, name = "_blank"): Window {
  const popup = opener.open("about:blank", name, platform.window.popoutFeatures(size));
  if (!popup) throw new Error(t("stage.popupBlocked"));
  try {
    const base = popup.document.createElement("base"); base.href = document.baseURI; popup.document.head.appendChild(base);
    popup.document.documentElement.lang = document.documentElement.lang;
    for (const source of document.querySelectorAll('link[rel="stylesheet"], style')) {
      const copy = source.cloneNode(true) as HTMLElement;
      if (source instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = source.href;
      popup.document.head.appendChild(copy);
    }
    popup.document.body.className = bodyClass;
    return popup;
  } catch { popup.close(); throw new Error(t("stage.popupFailed")); }
}

/** Lives at App level so windows survive switching between the stage and text channels. */
/** `viewers`: who watches the user's own screen share, shown in its pop-out (ShareViewers.tsx). */
export function useVideoWindows(tiles: VideoTile[], client: VoiceClient, viewers: readonly ShareViewer[] = []) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    const close = () => { for (const entry of entriesRef.current) entry.window.close(); };
    window.addEventListener("pagehide", close);
    return () => { window.removeEventListener("pagehide", close); close(); };
  }, []);
  useEffect(() => {
    if (entries.length === 0) return;
    const timer = window.setInterval(() => setEntries((old) => old.some((entry) => !isOpen(entry)) ? old.filter(isOpen) : old), 500);
    return () => window.clearInterval(timer);
  }, [entries.length]);
  useEffect(() => {
    const removed = entriesRef.current.filter((entry) => !tiles.some((tile) => tile.id === entry.id));
    for (const entry of removed) entry.window.close();
    if (removed.length) setEntries((old) => old.filter((entry) => !removed.includes(entry)));
  }, [tiles]);
  /** `opener`: the window the click happened in, when that is not the main one (the stage in a window of its own). */
  const open = (tile: VideoTile, opener: Window = window) => {
    const existing = entriesRef.current.find((entry) => entry.id === tile.id && isOpen(entry));
    if (existing) { existing.window.focus(); return; }
    // Must be synchronous inside the user's click, before any asynchronous work.
    const settings = tile.track.mediaStreamTrack.getSettings();
    const video = Array.from(opener.document.querySelectorAll("video")).find((element) =>
      element.srcObject instanceof MediaStream && element.srcObject.getVideoTracks().includes(tile.track.mediaStreamTrack));
    const ratio = video?.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight
      : settings.width && settings.height ? settings.width / settings.height : 16 / 9;
    const size = fitVideoWindow(ratio, 960, window.screen.availWidth, Math.max(1, window.screen.availHeight - 120));
    const popup = openPopoutWindow(size, "video-window-body", opener);
    setEntries((old) => [...old.filter((entry) => entry.id !== tile.id), { id: tile.id, window: popup, document: popup.document }]);
  };
  const restore = (id: string) => {
    entriesRef.current.find((entry) => entry.id === id)?.window.close();
    setEntries((old) => old.filter((entry) => entry.id !== id));
  };
  const windows = entries.map((entry) => {
    const tile = tiles.find((tile) => tile.id === entry.id);
    return tile && isOpen(entry) ? <VideoWindow key={entry.id} entry={entry} tile={tile} client={client} viewers={viewers} onClose={() => restore(entry.id)} /> : null;
  });
  return { open, windows, restore, poppedIds: new Set(entries.filter(isOpen).map((entry) => entry.id)) };
}

function VideoWindow({ entry, tile, client, viewers, onClose }: { entry: Entry; tile: VideoTile; client: VoiceClient; viewers: readonly ShareViewer[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const target = useCallback(() => ref.current, []);
  const volume = client.getVideoAudioVolume(tile.id);
  const [error, setError] = useState("");
  // The viewer's statistics of a received share (VideoStatsOverlay.tsx), as on the stage's tile.
  const [stats, setStats] = useState(false);
  const canStats = tile.source === "screen" && !tile.isLocal;
  const [focused, setFocused] = useState(() => entry.document.hasFocus());
  // AFK detection: input in a pop-out counts like input in the main window.
  useEffect(() => watchActivity(activity, entry.window), [entry.window]);
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    entry.window.addEventListener("focus", focus);
    entry.window.addEventListener("blur", blur);
    setFocused(entry.document.hasFocus());
    return () => {
      entry.window.removeEventListener("focus", focus);
      entry.window.removeEventListener("blur", blur);
    };
  }, [entry]);
  useEffect(() => client.setVideoAudioHost(tile.id, audioRef.current!), [client, tile.id]);
  // A popped-out share is one the user chose to watch: its audio plays (voiceClient.setScreenAudioListening).
  useEffect(() => {
    if (tile.source !== "screen" || tile.isLocal) return;
    client.setScreenAudioListening(tile.id, "popout", true);
    return () => client.setScreenAudioListening(tile.id, "popout", false);
  }, [client, tile.id, tile.source, tile.isLocal]);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { entry.document.title = tile.name + " | Squorli"; }, [entry.document, tile.name]);

  const fullscreen = async () => {
    try { if (ref.current && !await toggleVideoFullscreen(ref.current)) setError(t("stage.fullscreenUnavailable")); }
    catch { setError(t("stage.fullscreenFailed")); }
  };
  return createPortal(<div ref={ref} className={`video-window${focused ? " focused" : ""}${volume !== null ? " has-volume" : ""}`} tabIndex={0} aria-label={t("stage.popupVideoHint")}
    onDoubleClick={() => { void fullscreen(); }} onClick={() => { void client.startAudio(); }}
    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key.toLowerCase() === "f" || event.key === "Enter")) { event.preventDefault(); void fullscreen(); } }}>
    <TrackVideo tile={tile} />
    <div ref={audioRef} hidden />
    <div className="tile-label" title={tile.name}>
      {tile.source === "screen" && <><Icon name="monitor" /> </>}
      {tile.name}{tile.isLocal && ` ${t("members.you")}`}
    </div>
    {canStats && stats && <VideoStatsOverlay client={client} tileId={tile.id} />}
    {tile.source === "screen" && tile.isLocal && <ShareViewers viewers={viewers} />}
    <div className="tile-window-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {canStats && <VideoStatsButton on={stats} onToggle={() => setStats(!stats)} />}
      <button className="icon" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}><Icon name="x" /></button>
      <FullscreenButton target={target} onError={setError} />
    </div>
    <VideoAudioControls client={client} tile={tile} />
    {error && <div className="video-window-notice" role="alert">{error}<button className="icon" title={t("common.dismiss")} onClick={() => setError("")}><Icon name="x" /></button></div>}
    {!client.state.canPlayback && <button className="video-window-notice" onClick={() => { void client.startAudio(); }}>{t("dock.unblockAudio")}</button>}
  </div>, entry.document.body);
}
