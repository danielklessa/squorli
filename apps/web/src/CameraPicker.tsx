import { useEffect, useRef, useState } from "react";
import { useBackClose } from "./backStack";
import { CameraPreview, type CameraPreviewHandle } from "./CameraPreview";
import { Icon } from "./Icon";
import { VoiceClient } from "./voice/voiceClient";
import { t } from "./i18n";

type Props = {
  cameras: MediaDeviceInfo[];
  /** Preselection (last used camera), otherwise the first one. */
  initial: string | null;
  /** Preselected background blur (0 = off). */
  initialBlur: number;
  /** The user's switch "show my picture mirrored", and its change (stored at once: it is a view setting, not part of the pick). */
  mirror: boolean;
  onMirror: (mirror: boolean) => void;
  onPick: (deviceId: string, blur: number) => void;
  onCancel: () => void;
  /** The window the dialog is shown in (the stage's own window, StageWindow.tsx). */
  win?: Window;
};

export const BLUR_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: t("blur.normal") },
  { value: 10, label: t("blur.light") },
  { value: 20, label: t("blur.strong") },
];

/**
 * Camera picker at switch-on time (as the user specified: always ask when there are several cameras), including the background.
 * Own modal with a live preview (CameraPreview.tsx: an unpublished LiveKit track with the channel's blur processor). No browser dialog.
 */
export function CameraPicker({ cameras, initial, initialBlur, mirror, onMirror, onPick, onCancel, win = window }: Props) {
  const [selected, setSelected] = useState(() => (initial && cameras.some((c) => c.deviceId === initial) ? initial : cameras[0]?.deviceId ?? ""));
  const [blur, setBlur] = useState(VoiceClient.supportsBlur() ? initialBlur : 0);
  const preview = useRef<CameraPreviewHandle>(null);
  const canBlur = VoiceClient.supportsBlur();

  // Release the preview first, then switch on: otherwise the camera is grabbed twice. Must happen here and synchronously:
  // the effect cleanup runs only when React unmounts the dialog, after `onPick` has already asked LiveKit for the camera,
  // and Firefox then failed with "Starting videoinput failed" (18 September 2026).
  const pick = () => { if (!selected) return; preview.current?.release(); onPick(selected, blur); };

  useBackClose(onCancel);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); if (e.key === "Enter" && selected) pick(); };
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }); // deliberately without dependencies: always reads the current state

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onCancel}>
      <div className="modal dialog camera-picker" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{t("camera.title")}</h2>
        <CameraPreview ref={preview} deviceId={selected || null} blur={blur} mirror={mirror} />
        <label className="check">
          <input type="checkbox" className="switch" role="switch" checked={mirror} onChange={(e) => onMirror(e.target.checked)} />
          {t("camera.mirror")}
        </label>
        <h3>{t("camera.camera")}</h3>
        <ul className="camera-list">
          {cameras.map((c, i) => (
            <li key={c.deviceId}>
              <button className={`camera-option ${selected === c.deviceId ? "active" : ""}`} onClick={() => setSelected(c.deviceId)} onDoubleClick={pick}>
                <Icon name="video" />{c.label || t("camera.n", { n: i + 1 })}
              </button>
            </li>
          ))}
        </ul>
        <h3>{t("camera.background")}</h3>
        {canBlur ? (
          <div className="seg wide">
            {BLUR_OPTIONS.map((o) => <button key={o.value} className={blur === o.value ? "active" : ""} onClick={() => setBlur(o.value)}>{o.label}</button>)}
          </div>
        ) : <p className="muted small">{t("camera.noBlur")}</p>}
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>{t("common.cancel")}</button>
          <button disabled={!selected} onClick={pick}>{t("camera.title")}</button>
        </div>
      </div>
    </div>
  );
}
