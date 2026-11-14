import type { BackgroundProcessorWrapper } from "@livekit/track-processors";
import { VideoPresets, createLocalVideoTrack, type LocalVideoTrack } from "livekit-client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { t } from "./i18n";
import { retryCameraBusy } from "./voice/cameraRetry";
import { VoiceClient, blurProcessor } from "./voice/voiceClient";
import { mirrorsOwnCamera } from "./videoDisplay";

export type CameraPreviewHandle = {
  /** Let the camera go at once (the picker calls it before the channel opens the camera, src/voice/AGENTS.md "Opening a camera on Firefox"). */
  release: () => void;
};

type Props = {
  /** The camera to show; null = the system's default. */
  deviceId: string | null;
  /** Background blur (0 = off), the same processor as in the channel. */
  blur: number;
  /** The user's switch "show my picture mirrored" (videoDisplay.ts). */
  mirror: boolean;
  /**
   * The camera already runs in a channel: show that published track (it carries the channel's processor) instead of opening the
   * camera a second time, which Firefox cannot do.
   */
  live?: LocalVideoTrack | null;
};

/**
 * Live picture of a camera with the background blur, for the picker at switch-on (CameraPicker.tsx) and Einstellungen > Kamera
 * (14 November 2026, docs/features/voice-video.md). Without `live` it opens an unpublished LiveKit track of its own and runs
 * `blurProcessor` on it, so the picture looks exactly as it later will in the channel.
 */
export const CameraPreview = forwardRef<CameraPreviewHandle, Props>(function CameraPreview({ deviceId, blur, mirror, live = null }, ref) {
  const [err, setErr] = useState<string | null>(null);
  const [track, setTrack] = useState<LocalVideoTrack | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const processor = useRef<BackgroundProcessorWrapper | null>(null);
  const preview = useRef<{ alive: boolean; track: LocalVideoTrack | null } | null>(null);
  const canBlur = VoiceClient.supportsBlur();

  const release = () => {
    const p = preview.current;
    if (!p) return;
    p.alive = false;
    processor.current = null;
    if (p.track) { p.track.detach(); void p.track.stopProcessor().catch(() => {}); p.track.stop(); p.track = null; }
    preview.current = null;
  };
  useImperativeHandle(ref, () => ({ release: () => { release(); setTrack(null); } }));

  // The published track of a running camera: attach and detach this one element only, the stage's tile keeps its own.
  useEffect(() => {
    const el = videoRef.current;
    if (!live || !el) return;
    live.attach(el);
    return () => { live.detach(el); };
  }, [live]);

  // A capture of its own; released again when the camera changes and when the preview goes.
  useEffect(() => {
    if (live) return;
    const p = { alive: true, track: null as LocalVideoTrack | null };
    preview.current = p;
    setErr(null);
    // Firefox may still be releasing the camera that was just switched off; retry once (voice/cameraRetry.ts).
    retryCameraBusy(() => createLocalVideoTrack({ ...(deviceId ? { deviceId } : {}), resolution: VideoPresets.h360.resolution }))
      .then((tr) => { if (!p.alive) { tr.stop(); return; } p.track = tr; setTrack(tr); if (videoRef.current) tr.attach(videoRef.current); })
      .catch((e: unknown) => { if (p.alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { if (preview.current === p) release(); else p.alive = false; setTrack(null); };
  }, [deviceId, live]);

  // The blur on the own capture (the published track gets it from the voice client).
  useEffect(() => {
    if (!track || !canBlur) return;
    let cancelled = false;
    (async () => {
      try {
        if (blur <= 0) { if (processor.current) { await track.stopProcessor(); processor.current = null; } }
        else if (processor.current) await processor.current.switchTo({ mode: "background-blur", blurRadius: blur });
        else { const p = blurProcessor(blur); await track.setProcessor(p); if (!cancelled) processor.current = p; }
        if (!cancelled) setErr(null);
      } catch (e) { if (!cancelled) setErr(t("camera.bgError", { err: e instanceof Error ? e.message : String(e) })); }
    })();
    return () => { cancelled = true; };
  }, [track, blur, canBlur]);

  const shown = live ?? track;
  return (
    <div className="camera-preview">
      <video ref={videoRef} autoPlay playsInline muted className={mirrorsOwnCamera(shown?.mediaStreamTrack.getSettings().facingMode, mirror) ? "mirror" : ""} />
      {err && <p className="error small">{err}</p>}
    </div>
  );
});
