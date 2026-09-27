import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { t } from "./i18n";
import type { ScreenCodec, ScreenOffer, ScreenPick, ScreenSource } from "./platform";
import { localeTag } from "./i18n";
import { defaultAudio, defaultCodec, movingCodec, PLACEHOLDER_TILES, sortWindows } from "./screenPick";

type Tab = "window" | "screen";

/**
 * Which window or screen to share. Only the desktop app shows it: a browser brings its own picker, Electron has none, so
 * the shell lists the sources and asks the client (`platform.screen.setPicker`, App.tsx). Two tabs, windows first (user's
 * wish, 21 September 2026). Audio: for a window it is what that window's application plays and is ticked from the start, for
 * a screen what the computer plays, off until ticked (`source.audio` says whether the shell can deliver it; Windows only, and
 * never for the app's own windows). Codec: the standing one (VP8) or the one for moving pictures, preselected for a detected
 * game's window: H.265 where this computer can send it (`h265`, its graphics unit encodes it), else H.264.
 * The dialog opens before the shell knows what there is (user's wish, 28 September 2026: no wait for the thumbnails): `offer`
 * fills up while it is shown, first placeholder tiles, then the list with names and icons, then the pictures
 * (`ScreenSource.pending`). A source can be chosen and shared as soon as it is listed.
 */
export function ScreenPicker({ offer, h265, audioPossible = false, onPick, onCancel, win = window }: { offer: ScreenOffer; /** This system can send a share's audio at all (Windows): the audio tick has its place before the list says so, so the dialog does not jump when the list comes. */ audioPossible?: boolean; /** This computer can send H.265 (`VoiceClient.supportsH265()`). */ h265: boolean; onPick: (pick: ScreenPick) => void; onCancel: () => void; /** The window the dialog is shown in (the stage's own window, StageWindow.tsx). */ win?: Window }) {
  const { sources, listing } = useSyncExternalStore(offer.subscribe, offer.current);
  const screens = sources.filter((s) => s.kind === "screen");
  const windows = sortWindows(sources.filter((s) => s.kind === "window"), localeTag);
  const onlyScreen = screens.length === 1 ? screens[0]!.id : null;
  // null = not touched: the windows, or the screens when there is no window (the list may arrive after the dialog opened).
  const [tabChoice, setTabChoice] = useState<Tab | null>(null);
  const tab: Tab = tabChoice ?? (windows.length > 0 || screens.length === 0 ? "window" : "screen");
  const list = tab === "window" ? windows : screens;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked !== null && list.some((s) => s.id === picked) ? picked : tab === "screen" ? onlyScreen : null;
  // null = not touched: the default for the chosen source applies.
  const [audioChoice, setAudioChoice] = useState<boolean | null>(null);
  const [codecChoice, setCodecChoice] = useState<ScreenCodec | null>(null);
  const chosen = sources.find((s) => s.id === selected) ?? null;
  const audio = (source: ScreenSource | null) => !!source?.audio && (audioChoice ?? defaultAudio(source));
  const moving = movingCodec(h265);
  const codec = (source: ScreenSource | null) => codecChoice ?? defaultCodec(source, h265);
  const anyAudio = listing ? audioPossible : sources.some((s) => s.audio);
  const pick = (id = selected) => { const s = sources.find((x) => x.id === id); if (s) onPick({ sourceId: s.id, audio: audio(s), codec: codec(s) }); };
  // The audio tick belongs to the kind of source: what was set for a window says nothing about the whole computer's sound.
  const openTab = (next: Tab) => { if (next === tab) return; setTabChoice(next); setPicked(null); setAudioChoice(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } if (e.key === "Enter" && selected) pick(); };
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }); // deliberately without dependencies: always reads the current state

  const shownCodec = codec(chosen);
  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={onCancel}>
      <div className="modal dialog screen-picker" role="dialog" aria-modal="true" aria-labelledby="screen-picker-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="screen-picker-title">{t("screenPick.title")}</h2>
        <div className="tabs screen-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "window"} className={tab === "window" ? "active" : ""} onClick={() => openTab("window")}><Icon name="app-window" /> {t("screenPick.windows")}</button>
          <button role="tab" aria-selected={tab === "screen"} className={tab === "screen" ? "active" : ""} onClick={() => openTab("screen")}><Icon name="monitor" /> {t("screenPick.screens")}</button>
        </div>
        <div className="screen-picker-body" role="tabpanel" aria-busy={listing}>
          {listing && <p className="sr-only" role="status">{t("screenPick.listing")}</p>}
          {!listing && list.length === 0 && <p className="muted">{t("screenPick.none")}</p>}
          <ul className="screen-grid">
            {listing && Array.from({ length: PLACEHOLDER_TILES }, (_, i) => (
              <li key={i} className="screen-option screen-placeholder" aria-hidden="true"><span className="screen-thumb loading" /><span className="screen-name"><span className="screen-name-bar" /></span></li>
            ))}
            {list.map((s) => (
              <li key={s.id}>
                <button className={`screen-option ${selected === s.id ? "active" : ""}`} title={s.name} onClick={() => setPicked(s.id)} onDoubleClick={() => pick(s.id)}>
                  <span className={`screen-thumb ${!s.thumbnail && s.pending ? "loading" : ""}`}>{s.thumbnail ? <img src={s.thumbnail} alt="" /> : s.pending ? null : <Icon name={s.kind === "screen" ? "monitor" : "app-window"} />}</span>
                  <span className="screen-name">{s.icon && <img src={s.icon} alt="" width="16" height="16" />}<span>{s.name}</span>{s.gameId && <span className="screen-game" title={t("screenPick.game")}><Icon name="gamepad-2" /></span>}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {anyAudio && (
          <label className="check"><input type="checkbox" checked={chosen ? audio(chosen) : audioChoice ?? tab === "window"} disabled={chosen !== null && !chosen.audio} onChange={(e) => setAudioChoice(e.target.checked)} /> {tab === "window" ? t("screenPick.audioWindow") : t("screenPick.audio")}</label>
        )}
        {anyAudio && <span className="muted small">{chosen && !chosen.audio ? t("screenPick.audioNone") : tab === "window" ? t("screenPick.audioWindowHint") : t("screenPick.audioHint")}</span>}
        <fieldset className="screen-codec">
          <legend>{t("screenPick.codec")}</legend>
          <div className="screen-codec-options">
            <label className="check"><input type="radio" name="screen-codec" checked={shownCodec === "vp8"} onChange={() => setCodecChoice("vp8")} /> {t("screenPick.codecVp8")}</label>
            <label className="check"><input type="radio" name="screen-codec" checked={shownCodec === moving} onChange={() => setCodecChoice(moving)} /> {moving === "h265" ? t("screenPick.codecH265") : t("screenPick.codecH264")}</label>
          </div>
          <span className="muted small" role="status">{shownCodec === "h265" ? t("screenPick.codecH265Hint") : shownCodec === "h264" ? t("screenPick.codecH264Hint") : t("screenPick.codecVp8Hint")}</span>
        </fieldset>
        <div className="dialog-actions">
          <button className="secondary" onClick={onCancel}>{t("common.cancel")}</button>
          <button disabled={!selected} onClick={() => pick()}>{t("screenPick.share")}</button>
        </div>
      </div>
    </div>
  );
}
