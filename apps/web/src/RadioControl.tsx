import { RadioUrl, youtubePlaylistOf, type Channel, type RadioStation } from "@squorli/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, type ServerApi } from "./api";
import { ContextMenu, type MenuAnchor } from "./ContextMenu";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { fitsInstead } from "./radioLabel";
import type { RadioPlayer, RadioState } from "./voice/radioPlayer";
import { resolveYoutubePlaylist } from "./youtubePlaylist";

function explain(err: unknown): string {
  const code = err instanceof ApiError ? err.code : null;
  if (code === "radio_unreachable") return t("radio.errUnreachable");
  if (code === "radio_empty_playlist") return t("radio.errEmptyPlaylist");
  if (code === "radio_forbidden_host") return t("radio.errForbiddenHost");
  if (code === "radio_unknown_video") return t("radio.errUnknownVideo");
  if (code === "radio_not_embeddable") return t("radio.errNotEmbeddable");
  if (code === "radio_playlist_unresolved") return t("radio.errPlaylist");
  if (code === "forbidden") return t("radio.errForbidden");
  return err instanceof Error ? err.message : String(err);
}

/**
 * Radio button in the head of the voice stage with its menu. Members who may control the radio always see it (choose a
 * station for everyone, turn it off); listeners only while a station is playing (their own volume and off switch).
 * `nowPlaying` = what the station plays right now ("Artist - Title" from the server): the button shows it instead of the
 * station's name when it fits into the head's free space, the menu always shows both.
 */
export function RadioControl({ api, player, channel, stations, nowPlaying, canControl }: { api: ServerApi; player: RadioPlayer; channel: Channel; stations: RadioStation[]; nowPlaying: string | null; canControl: boolean }) {
  const [radio, setRadio] = useState<RadioState>(player.state);
  useEffect(() => player.subscribe(setRadio), [player]);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  // The menu closes on pointerdown outside of it, which includes this button: the click that follows must not reopen it.
  const closedAt = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const urlOk = RadioUrl.safeParse(url).success;
  const playing = channel.radio;
  // A Twitch or YouTube source: shown by the official player (EmbedPlayer.tsx), not played by the radio player.
  const video = playing?.twitchChannel ? "twitch" : playing?.youtubeVideo ? "youtube" : null;
  const title = playing ? nowPlaying : null;
  const showTitle = useFits(title, playing?.name ?? null);
  const [readingList, setReadingList] = useState(false);
  // Every hook stands above this line: a listener's button comes and goes with the radio, and a hook below it would run
  // in one render and not in the next, which React answers by taking the whole client down (28 September 2026).
  if (!playing && !canControl) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(explain(err)); } finally { setBusy(false); }
  };
  /**
   * A YouTube playlist: this client reads its videos from YouTube's player and hands them to the server, which plays them
   * as a queue (youtubePlaylist.ts). An address that also names a video still plays that one when the list cannot be read.
   */
  const start =(address: string, send: (videoIds?: string[]) => Promise<unknown>) => act(async () => {
    const list = youtubePlaylistOf(address);
    if (!list) return send();
    setReadingList(true);
    const videoIds = await resolveYoutubePlaylist(list.listId, list.videoId).finally(() => setReadingList(false));
    if (!videoIds && !list.videoId) throw new Error(t("radio.errPlaylist"));
    return send(videoIds ?? undefined);
  });
  const queue = playing?.queue ?? null;
  const skip = (step: 1 | -1) => { if (playing?.youtubeVideo) void act(() => api.advanceRadio(channel.id, { from: playing.youtubeVideo!, step })); };
  const percent = Math.round(radio.volume * 100);
  const volumeLabel = t("radio.volume");
  const tooltip = !playing ? t("radio.button") : title ? t("radio.buttonPlaying", { name: playing.name, title }) : t("radio.buttonOn", { name: playing.name });

  return (
    <>
      <button ref={showTitle.button} className={`radio-toggle ${playing ? "on" : ""} ${playing && radio.muted ? "silenced" : ""}`} title={tooltip} aria-label={tooltip} aria-haspopup="menu" aria-expanded={anchor !== null}
        onClick={(event) => { if (performance.now() - closedAt.current < 400) return; const box = event.currentTarget.getBoundingClientRect(); setError(null); setAnchor({ trigger: event.currentTarget, x: box.left, y: box.bottom + 6 }); }}>
        <Icon name="radio" />{playing && <span ref={showTitle.label}>{showTitle.fits && title ? title : playing.name}</span>}
        {/* Never visible: only there to know how wide the title is at full length. */}
        {title && <span ref={showTitle.measure} className="radio-toggle-measure" aria-hidden="true">{title}</span>}
      </button>
      {anchor && (
        <ContextMenu anchor={anchor} label={t("radio.title")} onClose={() => { closedAt.current = performance.now(); setAnchor(null); }}>
          <div className="radio-now" role="presentation">
            <Icon name="radio" />
            <div><strong>{playing ? playing.name : t("radio.title")}</strong><span className="muted small">{playing ? (video && !radio.muted ? t(video === "twitch" ? "radio.statusTwitch" : "radio.statusYoutube") : statusText(radio)) : t("radio.nothingPlaying")}</span></div>
          </div>
          {title && <div className="radio-track" role="presentation"><span className="muted small">{t("radio.nowPlaying")}</span><span>{title}</span></div>}
          {queue && (
            <div className="radio-queue" role="group" aria-label={t("radio.queue")}>
              <span className="muted small">{t("radio.queuePosition", { n: queue.index + 1, total: queue.length })}</span>
              {canControl && <>
                <button role="menuitem" className="icon" disabled={busy} title={t("radio.queuePrevious")} aria-label={t("radio.queuePrevious")} onClick={() => skip(-1)}><Icon name="skip-back" /></button>
                <button role="menuitem" className="icon" disabled={busy} title={t("radio.queueNext")} aria-label={t("radio.queueNext")} onClick={() => skip(1)}><Icon name="skip-forward" /></button>
              </>}
            </div>
          )}
          {video === "youtube" && !radio.muted && <div className="radio-track" role="presentation"><span className="muted small">{t(canControl ? "radio.syncControl" : "radio.syncFollow")}</span></div>}
          {playing && !video && (radio.status === "blocked" || radio.status === "error") && (
            <button role="menuitem" onClick={() => player.resume()}><Icon name={radio.status === "blocked" ? "play" : "rotate-ccw"} /> {radio.status === "blocked" ? t("dock.unblockAudio") : t("radio.retry")}</button>
          )}
          {playing && (
            <div className="user-volume" role="group" aria-label={volumeLabel}>
              <span className="muted small">{volumeLabel}</span>
              <div className="user-volume-row">
                <button role="menuitem" className="icon" aria-pressed={radio.muted} title={radio.muted ? t("radio.unmute") : t("radio.mute")} aria-label={radio.muted ? t("radio.unmute") : t("radio.mute")}
                  onClick={() => player.setMuted(!radio.muted)}><Icon name={radio.muted ? "volume-x" : "volume-2"} /></button>
                <input type="range" data-menu-item min={0} max={100} step={1} value={radio.muted ? 0 : percent} title={volumeLabel} aria-label={volumeLabel} aria-valuetext={`${radio.muted ? 0 : percent} %`}
                  // Home/End belong to the slider here, not to the menu's item navigation.
                  onKeyDown={(event) => { if (event.key === "Home" || event.key === "End") event.stopPropagation(); }}
                  // Moving the slider turns the radio back on: nobody looks for a second switch.
                  onChange={(event) => { player.setVolume(Number(event.target.value) / 100); if (radio.muted) player.setMuted(false); }} />
                <output>{radio.muted ? 0 : percent} %</output>
              </div>
              <span className="muted small">{video ? t("radio.onlyMeVideo") : t("radio.onlyMe")}</span>
            </div>
          )}
          {canControl && (
            <div className="radio-stations" role="group" aria-label={t("radio.stations")}>
              <span className="muted small">{t("radio.stationsForAll")}</span>
              {stations.length === 0 && <p className="muted small">{t("radio.noStations")}</p>}
              {stations.map((s) => (
                <button key={s.id} role="menuitemradio" aria-checked={playing?.stationId === s.id} disabled={busy} onClick={() => { void start(s.url, (videoIds) => api.startRadio(channel.id, s.id, videoIds)); }}>
                  <Icon name={playing?.stationId === s.id ? "check" : "play"} /> <span>{s.name}</span>
                </button>
              ))}
              {/* Any address instead of a station. The field keeps its keys to itself: the menu would take arrows, Home and End. */}
              <form className="radio-url" onSubmit={(event) => { event.preventDefault(); if (urlOk && !busy) void start(url.trim(), async (videoIds) => { await api.startRadioUrl(channel.id, url.trim(), videoIds); setUrl(""); }); }}>
                <input type="url" inputMode="url" value={url} maxLength={2048} placeholder={t("radio.urlPlaceholder")} aria-label={t("radio.urlLabel")} title={t("radio.urlLabel")}
                  onChange={(event) => setUrl(event.target.value)} onKeyDown={(event) => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }} />
                <button type="submit" className="icon" disabled={!urlOk || busy} title={t("radio.urlPlay")} aria-label={t("radio.urlPlay")}><Icon name="play" /></button>
              </form>
              {url.trim() !== "" && !urlOk && <span className="error small">{t("admin.radio.invalidUrl")}</span>}
              {readingList && <span className="muted small" role="status">{t("radio.readingPlaylist")}</span>}
              {playing && <button role="menuitem" className="danger" disabled={busy} onClick={() => { void act(() => api.stopRadio(channel.id)); }}><Icon name="square" /> {t("radio.stop")}</button>}
            </div>
          )}
          {error && <p className="error small" role="alert">{error}</p>}
        </ContextMenu>
      )}
    </>
  );
}

/**
 * Does the title fit, in full, where the station's name stands (radioLabel.ts)? Measured, because it depends on the window: the head's free space
 * is the width of its `.spacer`, the title's width comes from a hidden copy. Checked again whenever the head, the
 * button or the texts change; decided before the browser paints, so the label never flickers between the two.
 */
function useFits(title: string | null, name: string | null) {
  const button = useRef<HTMLButtonElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const head = button.current?.parentElement;
    if (!title || !head || !button.current) { setFits(false); return; }
    const check = () => {
      const b = button.current, l = label.current, m = measure.current;
      if (!b || !l || !m) return;
      const spacer = head.querySelector<HTMLElement>(":scope > .spacer");
      const style = getComputedStyle(b);
      const chrome = b.getBoundingClientRect().width - l.getBoundingClientRect().width; // icon, gap, padding
      const limit = parseFloat(style.maxWidth);
      setFits(fitsInstead({ wanted: m.getBoundingClientRect().width, shown: l.getBoundingClientRect().width, truncated: l.scrollWidth - l.clientWidth > 1, free: spacer?.getBoundingClientRect().width ?? 0, max: (Number.isFinite(limit) ? limit : Infinity) - chrome }));
    };
    check();
    // The window the head lives in (the stage can be in a window of its own): an observer of another window is not reliable.
    const observer = new (head.ownerDocument.defaultView ?? window).ResizeObserver(check);
    observer.observe(head); observer.observe(button.current);
    return () => observer.disconnect();
  }, [title, name]);
  return { button, label, measure, fits };
}

function statusText(radio: RadioState): string {
  if (radio.muted) return t("radio.statusMuted");
  switch (radio.status) {
    case "playing": return t("radio.statusPlaying");
    case "blocked": return t("stage.audioBlocked");
    case "error": return t("radio.statusError");
    default: return t("radio.statusConnecting");
  }
}
