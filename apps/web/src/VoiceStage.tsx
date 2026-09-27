import { VideoStatsButton, VideoStatsOverlay } from "./VideoStatsOverlay";
import { viewersOf } from "./voice/shareViewers";
import { ShareViewers } from "./ShareViewers";
import { FullscreenButton, TrackVideo } from "./VideoWindows";
import { VideoAudioControls } from "./VideoAudioControls";
import { Avatar } from "./Avatar";
import { Permission, displayNameOf, hasPermission, type Channel, type Member, type RadioStation, type VoiceMember } from "@squorli/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { MenuAnchor } from "./ContextMenu";
import { VoiceMemberMenu } from "./VoiceMemberMenu";
import { RadioControl } from "./RadioControl";
import { PushToTalkButton } from "./PushToTalkButton";
import { EmbedSlot } from "./EmbedPlayer";
import type { ServerApi } from "./api";
import type { RadioPlayer } from "./voice/radioPlayer";
import { VoiceClient, explainScreenAudio, isChromium, type VideoTile, type VoiceParticipant, type VoiceState } from "./voice/voiceClient";
import { Icon } from "./Icon";
import { t } from "./i18n";
import { platform } from "./platform";
import { useVoiceSettings } from "./voice/useVoiceSettings";
import { feedId, videoActive } from "./voice/videoWatch";

type Props = {
  client: VoiceClient;
  voice: VoiceState;
  channel: Channel;
  members: Member[];
  myPermissions: number;
  /** Web radio: the voice server's API, the local player and the server's stations (undefined = a server without radio). */
  api: ServerApi;
  radio: RadioPlayer;
  radioStations: RadioStation[] | undefined;
  /** What the channel's station is playing right now, null = unknown. */
  radioTitle: string | null;
  /** The channel's radio is a Twitch or YouTube source and the user has not turned the radio off: its player gets a tile (the source's key, else null). */
  playerTile: string | null;
  /** The channel's radio is a Twitch or YouTube source and the user HAS turned the radio off: a tile says that it runs and turns the radio back on. */
  playerOff: "twitch" | "youtube" | null;
  /** The user does not want that tile: gone until the next video starts (App.tsx). */
  onDismissPlayerOff: () => void;
  /** The player is open in a window of its own: the tile says so and offers to bring it back. */
  playerPopped: boolean;
  onRestorePlayer: () => void;
  /** Camera on/off; asks when there are several cameras (App.tsx). */
  onToggleCamera: () => Promise<void>;
  onToggleBlur: () => Promise<void>;
  onLeave: () => Promise<void>;
  /** A sticky channel holds the user: leaving is refused with the reason (App.tsx), the button says so. */
  locked?: boolean;
  /** `opener`: the window the click happened in (a browser lets only that one open a window). */
  onPopout: (tile: VideoTile, opener?: Window) => void;
  poppedIds: Set<string>;
  onRestore: (id: string) => void;
  /** This stage is the one in a window of its own (StageWindow.tsx); the button in the head then brings it back. */
  detached: boolean;
  /** Move the whole stage into a window of its own, or back. May throw with a text for the user (window refused). */
  onToggleWindow: () => void;
  /** For the tiles' context menu, the same as the sidebar's (VoiceMemberMenu.tsx): the voice server's rosters, channels, my
   * permissions per channel (null = server-wide) and the vote kick (docs/features/votekick.md). */
  myUserId: string;
  roster: Record<string, VoiceMember[]>;
  channels: Channel[];
  channelPermissions: (channelId: string | null) => number;
  voteKickAllowed: Record<string, boolean>;
  onVoteKick: (userId: string, channelId: string) => void;
};

type Layout = "grid" | "focus";
/** `off`: the participant sends this feed, the user may see it and does not watch it (voiceClient.setVideoWatching): the tile offers to turn it on. */
/** A participant with the avatar of the matching member (null for identities that are no members: bots, "external"). */
type StageParticipant = VoiceParticipant & { avatarUrl: string | null };
type Item = { key: string; participant: StageParticipant; tile: VideoTile | null; kind: "camera" | "screen"; off: boolean } | { key: string; participant: null; tile: null; kind: "player" | "playerOff"; off: false };

/**
 * Stage of a voice channel (M3): one tile per participant (camera or avatar) plus one per screen share.
 * The default is the tile view; the tile size is computed so that all of them fit into the visible area
 * (no scrolling). Clicking a tile enlarges it (focus), clicking the large tile goes back.
 * "Speaker" follows the active speaker or the newest screen share the user watches, without pinning.
 * Others' feeds are the user's choice (19 September 2026): a screen share shows a tile that offers to watch it and is only
 * received after that; a camera shows by itself; both can be turned off for yourself from the tile or its context menu.
 * The tile view can hide participants without video while any video is being sent; that choice is never stored.
 * Receive quality follows the tile size (adaptiveStream in the voice core); here the <video> only has to have the right size.
 */
export function VoiceStage({ client, voice, channel, members, myPermissions, api, radio, radioStations, radioTitle, playerTile, playerOff, onDismissPlayerOff, playerPopped, onRestorePlayer, onToggleCamera, onToggleBlur, onLeave, locked = false, onPopout, poppedIds, onRestore, detached, onToggleWindow, myUserId, roster, channels, channelPermissions, voteKickAllowed, onVoteKick }: Props) {
  // Names from the server's member list (arrives via WS immediately on every rename), not from the LiveKit token,
  // which is only created on joining. Unknown identities (bots, "external") keep the LiveKit name.
  const participants = voice.participants.map((p) => {
    const m = members.find((x) => x.userId === p.identity);
    return m ? { ...p, name: displayNameOf(m), avatarUrl: m.avatarUrl } : { ...p, avatarUrl: null };
  });
  // Who watches my own screen share (shareViewers.ts), shown on its tile.
  const myIdentity = participants.find((p) => p.isLocal)?.identity ?? null;
  const myViewers = myIdentity ? viewersOf(participants, myIdentity) : [];
  const [layout, setLayout] = useState<Layout>("grid"); // always start with tiles
  const [pinned, setPinned] = useState<string | null>(null);
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const canStream = hasPermission(myPermissions, Permission.STREAM_VIDEO) && channel.allowVideo && !voice.afkRoom; // nothing is sent in the AFK channel, nor where the channel forbids video
  // Without VIEW_VIDEO others' camera and screen never arrive; say so while somebody is sharing, instead of just showing avatars.
  const mayView = hasPermission(myPermissions, Permission.VIEW_VIDEO);
  const hiddenStreams = !mayView && participants.some((p) => !p.isLocal && (p.cameraOn || p.screenOn));

  // Others win over yourself; whether you are featured at all while only you speak is the user's choice (settings > view).
  const { featureSelfInSpeakerView, mode } = useVoiceSettings();
  // A phone or tablet with push-to-talk: a hold button above the bar instead of a key (PushToTalkButton.tsx), and the mute
  // button leaves the bar (user's wish, 22 September 2026), except while muted: the dock is out of sight on a phone, so
  // the stage must still offer the way back.
  const touchPtt = platform.mobile && mode === "ptt";
  useEffect(() => {
    const s = participants.find((p) => p.speaking && !p.isLocal) ?? (featureSelfInSpeakerView ? participants.find((p) => p.speaking) : undefined);
    if (s) setLastSpeaker(s.identity);
  }, [voice.participants, featureSelfInSpeakerView]);

  const notWatched = (p: VoiceParticipant, source: "camera" | "screen") => !p.isLocal && mayView && (source === "camera" ? p.cameraOn : p.screenOn) && !client.isVideoWatching(feedId(p.identity, source));
  const items: Item[] = [];
  for (const p of participants) {
    const cam = voice.tiles.find((t) => t.identity === p.identity && t.source === "camera") ?? null;
    items.push({ key: feedId(p.identity, "camera"), participant: p, tile: cam, kind: "camera", off: notWatched(p, "camera") });
  }
  // A Twitch or YouTube source of the radio is shown like a screen share (user's decision); real shares come after it, so the newest of them wins the focus.
  if (playerTile) items.push({ key: `player:${playerTile}`, participant: null, tile: null, kind: "player", off: false });
  // The same source while the user has the radio turned off: nothing plays and nothing is loaded, so a tile tells them that
  // a video runs (user's wish). It is no video: it never takes the focus by itself and does not count for "video only".
  else if (playerOff && channel.radio) items.push({ key: "player:off", participant: null, tile: null, kind: "playerOff", off: false });
  for (const t of voice.tiles.filter((t) => t.source === "screen")) {
    const participant = participants.find((p) => p.identity === t.identity);
    if (participant) items.push({ key: t.id, participant, tile: t, kind: "screen", off: false });
  }
  // Shares the user does not watch (the default for every new share): a tile that offers to watch it, never the picture.
  for (const p of participants) {
    if (notWatched(p, "screen") && !items.some((i) => i.key === feedId(p.identity, "screen"))) items.push({ key: feedId(p.identity, "screen"), participant: p, tile: null, kind: "screen", off: true });
  }
  // A new screen share the user watches automatically moves into focus as long as nothing is pinned.
  const screens = items.filter((i) => (i.kind === "screen" && !i.off) || i.kind === "player");
  const lastScreen = screens[screens.length - 1];
  // With "feature myself" off your own camera tile only becomes the large one by pinning it, or when nobody else is there.
  const mayFeature = (i: Item) => i.kind !== "playerOff" && (featureSelfInSpeakerView || !i.participant?.isLocal);
  const focusKey = (pinned && items.some((i) => i.key === pinned) ? pinned : null)
    ?? lastScreen?.key
    ?? (lastSpeaker ? items.find((i) => i.kind === "camera" && i.participant.identity === lastSpeaker && mayFeature(i))?.key : undefined)
    ?? items.find((i) => i.tile && mayFeature(i))?.key
    ?? items.find(mayFeature)?.key
    ?? items.find((i) => i.tile)?.key
    ?? items[0]?.key
    ?? null;
  const focus = items.find((i) => i.key === focusKey) ?? null;
  // The strip scrolls sideways with many participants: the notice that a video runs comes first, or nobody would see it there.
  const rest = [...items.filter((i) => i.kind === "playerOff"), ...items.filter((i) => i.key !== focusKey && i.kind !== "playerOff")];
  const screenHint = explainScreenAudio(voice, platform.kind === "desktop" ? { audioPossible: platform.os === "windows" } : undefined);
  // Tile view: hide participants without video. Only while a video is being sent at all, and never stored: it is gone
  // with the last video and with the stage (user's requirement).
  const anyVideo = videoActive(participants, !!playerTile);
  const [videoOnly, setVideoOnly] = useState(false);
  useEffect(() => { if (!anyVideo) setVideoOnly(false); }, [anyVideo]);
  const gridItems = videoOnly && anyVideo ? items.filter((i) => i.kind !== "camera" || i.participant.cameraOn) : items;
  const grid = useFittedGrid(gridItems.length);

  // A share's audio plays for who watches that share (user, 26 September 2026: "sollte da sein sobald ich das Ansehen
  // starte"): since a share is only received after "Ansehen" (19 September 2026), that click is the choice the rule of
  // 18 September 2026 asked for, so the stage listens to every share the user watches, pinned or not, in either layout.
  // Pop-out windows listen on their own (VideoWindows.tsx). Leaving the stage ends the listening.
  const screenIds = voice.tiles.filter((tile) => tile.source === "screen" && !tile.isLocal).map((tile) => tile.id).join(" ");
  useEffect(() => {
    const ids = screenIds ? screenIds.split(" ") : [];
    for (const id of ids) client.setScreenAudioListening(id, "stage", true);
    return () => { for (const id of ids) client.setScreenAudioListening(id, "stage", false); };
  }, [client, screenIds]);

  // Click a tile: show it large. Click the large tile: back to the tiles.
  const focusOn = (key: string) => { setPinned(key); setLayout("focus"); };
  const unfocus = () => { setPinned(null); setLayout("grid"); };

  // Right-click a tile of another member: the sidebar's voice member menu. Bots have no member entry and get no menu.
  const [menu, setMenu] = useState<({ identity: string } & MenuAnchor) | null>(null);
  const menuMember = menu ? members.find((m) => m.userId === menu.identity) ?? null : null;
  const openMenu = (item: Item, event: ReactMouseEvent<HTMLElement>) => {
    if (!item.participant || item.participant.isLocal || !members.some((m) => m.userId === item.participant.identity)) return;
    if (event.currentTarget.ownerDocument.fullscreenElement) return; // the menu lives in the body, behind a fullscreen tile
    event.preventDefault();
    setMenu({ identity: item.participant.identity, trigger: event.currentTarget, x: event.clientX, y: event.clientY });
  };

  const playerTileOf = (i: Extract<Item, { participant: null }>, big = false) => i.kind === "playerOff" && playerOff
    ? <PlayerOffTile key={i.key} big={big} kind={playerOff} name={channel.radio?.name ?? ""} radio={radio} onDismiss={onDismissPlayerOff} />
    : <PlayerTile key={i.key} big={big} popped={playerPopped} elsewhere={detached} onRestore={onRestorePlayer} />;

  return (
    <section className="stage">
      <header className="chat-head">
        <span className="channel-icon"><Icon name="volume-2" /></span><strong>{channel.name}</strong>
        <span className="muted small">· {t("stage.participants", { n: voice.participants.length })}{voice.audioProfile && ` · Opus ${voice.audioProfile.bitrate} kbit/s ${voice.audioProfile.stereo ? t("stage.stereo") : t("stage.mono")}`}</span>
        <span className="spacer" />
        {radioStations && !voice.afkRoom && <RadioControl api={api} player={radio} channel={channel} stations={radioStations} nowPlaying={radioTitle} canControl={hasPermission(myPermissions, Permission.CONTROL_RADIO)} />}
        {layout === "grid" && anyVideo && (
          <button className={`icon ${videoOnly ? "on" : ""}`} aria-pressed={videoOnly} title={t(videoOnly ? "stage.showAll" : "stage.videoOnly")} aria-label={t(videoOnly ? "stage.showAll" : "stage.videoOnly")}
            onClick={() => setVideoOnly(!videoOnly)}><Icon name={videoOnly ? "user-x" : "user"} /></button>
        )}
        <div className="seg">
          <button className={layout === "focus" ? "active" : ""} title={t("stage.speakerHint")} onClick={() => setLayout("focus")}>{t("stage.speaker")}</button>
          <button className={layout === "grid" ? "active" : ""} title={t("stage.gridHint")} onClick={() => setLayout("grid")}>{t("stage.grid")}</button>
        </div>
        <button className="icon" title={t(detached ? "stage.restoreStage" : "stage.popoutStage")} aria-label={t(detached ? "stage.restoreStage" : "stage.popoutStage")}
          onClick={() => { try { onToggleWindow(); } catch (error) { client.setNotice(error instanceof Error ? error.message : t("stage.popupFailed")); } }}><Icon name={detached ? "undo-2" : "external-link"} /></button>
      </header>

      {voice.afkRoom && <p className="warn-box small stage-hint"><Icon name="moon" /> {t("dock.afkChannel")}</p>}
      {screenHint && <p className="warn-box small stage-hint">{screenHint}</p>}
      {hiddenStreams && <p className="warn-box small stage-hint">{t("stage.noViewPermission")}</p>}
      {!voice.canPlayback && <p className="warn-box small stage-hint">{t("stage.audioBlocked")} <button className="small" onClick={() => client.startAudio()}>{t("dock.unblockAudio")}</button></p>}

      {items.length === 0 ? (
        <div className="stage-empty muted">{t("stage.empty")}</div>
      ) : layout === "grid" || !focus ? (
        <div className="stage-grid" ref={grid.ref}>
          <div className="stage-grid-inner" style={{ gridTemplateColumns: `repeat(${grid.cols}, ${grid.tileWidth}px)` }}>
            {gridItems.map((i) => i.participant === null ? playerTileOf(i)
              : <Tile key={i.key} item={i} client={client} viewers={myViewers} onPopout={onPopout} poppedIds={poppedIds} onRestore={onRestore} onMenu={openMenu} pinned={false} onClick={() => focusOn(i.key)} />)}
          </div>
        </div>
      ) : (
        <div className="stage-focus">
          <div className="stage-main">{focus.participant === null ? playerTileOf(focus, true)
            : <Tile item={focus} client={client} viewers={myViewers} onPopout={onPopout} poppedIds={poppedIds} onRestore={onRestore} onMenu={openMenu} big pinned={pinned === focus.key} onClick={unfocus} />}</div>
          {rest.length > 0 && (
            <div className="stage-strip">
              {rest.map((i) => i.participant === null ? playerTileOf(i)
                : <Tile key={i.key} item={i} client={client} viewers={myViewers} onPopout={onPopout} poppedIds={poppedIds} onRestore={onRestore} onMenu={openMenu} pinned={false} onClick={() => focusOn(i.key)} />)}
            </div>
          )}
        </div>
      )}

      {/* The same menu as on the sidebar's voice members (VoiceMemberMenu.tsx); a refusal comes back as a notice. */}
      {menu && menuMember && <VoiceMemberMenu anchor={menu} member={menuMember} client={client} voiceState={voice} api={api} myUserId={myUserId}
        permsIn={channelPermissions} voice={roster} channels={channels} voteKickAllowed={voteKickAllowed} onVoteKick={onVoteKick}
        onClose={() => setMenu(null)} onError={(text) => { if (text) client.setNotice(text); }} />}

      {touchPtt && <div className="stage-ptt"><PushToTalkButton client={client} disabled={voice.afkRoom || voice.micMuted} /></div>}
      <footer className="stage-bar">
        {!(touchPtt && !voice.micMuted) && <button className={`bar-btn ${voice.micMuted ? "off" : ""}`} disabled={voice.afkRoom} title={voice.afkRoom ? t("dock.afkChannel") : voice.micMuted ? (voice.deafened ? t("voice.unmuteAll") : t("voice.unmute")) : t("voice.mute")} onClick={() => client.setMuted(!voice.micMuted)}><Icon name={voice.micMuted ? "mic-off" : "mic"} /></button>}
        <button className={`bar-btn ${voice.deafened ? "off" : ""}`} disabled={voice.afkRoom} title={voice.afkRoom ? t("dock.afkChannel") : voice.deafened ? t("voice.undeafen") : t("voice.deafen")} onClick={() => client.setDeafened(!voice.deafened)}><Icon name={voice.deafened ? "headphone-off" : "headphones"} /></button>
        <button className={`bar-btn ${voice.cameraOn ? "on" : ""}`} disabled={!canStream} title={voice.afkRoom ? t("dock.afkChannel") : canStream ? (voice.cameraOn ? t("voice.cameraOff") : t("voice.cameraOnBtn")) : t("stage.noStreamPermission")}
          onClick={() => { void onToggleCamera(); }}><Icon name={voice.cameraOn ? "video" : "video-off"} /></button>
        {voice.cameraOn && VoiceClient.supportsBlur() && (
          <button className={`bar-btn ${voice.cameraBlur > 0 ? "on" : ""}`} title={voice.cameraBlur > 0 ? t("stage.unblur") : t("stage.blur")} onClick={() => { void onToggleBlur(); }}><Icon name="wand-sparkles" /></button>
        )}
        {/* Phones and tablets cannot share a screen (no getDisplayMedia): no button instead of one that only fails. */}
        {VoiceClient.supportsScreenShare() && <button className={`bar-btn ${voice.screenOn ? "on" : ""}`} disabled={!canStream} title={voice.afkRoom ? t("dock.afkChannel") : canStream ? (voice.screenOn ? t("stage.stopShare") : isChromium() ? t("stage.shareWithAudio") : t("stage.shareNoAudio")) : t("stage.noStreamPermission")}
          onClick={() => client.setScreenShareEnabled(!voice.screenOn)}><Icon name={voice.screenOn ? "screen-share-off" : "screen-share"} /></button>}
        <button className={`bar-btn leave${locked ? " locked" : ""}`} aria-disabled={locked} title={locked ? t("voice.stickyNotice") : t("voice.leave")} onClick={() => onLeave()}><Icon name={locked ? "lock" : "phone"} rotate={locked ? 0 : 135} /></button>
      </footer>
    </section>
  );
}

/** Computes columns and tile width (16:9) so n tiles fit into the container without scrolling. */
function useFittedGrid(n: number) {
  // Callback ref instead of useRef: the container is only mounted once participants are there, and is recreated
  // when switching views. Only this way is it measured every time (otherwise the tiles would stay at the fallback size).
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    // The observer of the window the stage lives in (it can be one of its own): another window's is not reliable.
    const ro = new (el.ownerDocument.defaultView ?? window).ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const gap = 8, pad = 12;
  const W = Math.max(0, size.w - 2 * pad), H = Math.max(0, size.h - 2 * pad);
  // Without a measured height (first frame) divide by width only, so the result is never 0 px.
  let best = { cols: Math.max(1, Math.ceil(Math.sqrt(n))), tileWidth: Math.max(160, Math.floor(W / Math.max(1, Math.ceil(Math.sqrt(n))))) };
  if (n > 0 && W > 0 && H > 0) {
    let bestArea = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const byWidth = (W - gap * (cols - 1)) / cols;
      const byHeight = ((H - gap * (rows - 1)) / rows) * (16 / 9);
      const tileWidth = Math.max(1, Math.floor(Math.min(byWidth, byHeight)));
      if (tileWidth * tileWidth > bestArea) { bestArea = tileWidth * tileWidth; best = { cols, tileWidth }; }
    }
  }
  return { ref, ...best };
}

/**
 * Twitch's or YouTube's player as a tile. The tile only reserves the room: the player (EmbedPlayer, mounted in App) lays itself over it
 * completely and brings its own controls; ours is the pop-out button it shows on hover. Enlarging works through the
 * "Sprecher" view, where this tile counts like a screen share.
 * `elsewhere`: this stage is in a window of its own. The player is one iframe of the main window and moving it would
 * reload it, so it stays there (floating, or in its own window) and the tile only says so.
 */
function PlayerTile({ big, popped, elsewhere, onRestore }: { big?: boolean; popped: boolean; elsewhere: boolean; onRestore: () => void }) {
  return (
    <div className={`tile screen embed ${big ? "big" : ""}`}>
      {elsewhere ? <div className="tile-popped"><Icon name="radio" /><span>{t(popped ? "stage.poppedOut" : "stage.playerInMain")}</span></div>
        : popped ? <div className="tile-popped"><Icon name="external-link" /><span>{t("stage.poppedOut")}</span><button className="secondary small" onClick={onRestore}>{t("stage.restoreVideo")}</button></div> : <EmbedSlot />}
    </div>
  );
}

/**
 * The radio plays a Twitch or YouTube source while the user has the radio turned off for themselves: no player and no
 * connection (EmbedPlayer.tsx), so without this tile nothing would tell them that a video runs. It turns the radio back
 * on: the button at the volume as it stands, the slider at the one it is dragged to. The slider applies when it is let go
 * (the input's native "change"), not while it moves: turning the radio on replaces this tile with the player, which would
 * take the slider away from under the pointer. From the keyboard every step is such a "change", so keys only set the
 * value and Enter or the button turns the radio on. The x dismisses the tile until the next video starts (user's wish).
 */
function PlayerOffTile({ big, kind, name, radio, onDismiss }: { big: boolean; kind: "twitch" | "youtube"; name: string; radio: RadioPlayer; onDismiss: () => void }) {
  const [percent, setPercent] = useState(() => Math.round(radio.state.volume * 100));
  const slider = useRef<HTMLInputElement>(null);
  const live = useRef({ percent, moved: false, byPointer: false });
  live.current.percent = percent;
  // A volume is only stored as the user's own once they set one (radioPlayer.ts): the button alone keeps the default.
  const turnOn = useCallback(() => { if (live.current.moved) radio.setVolume(live.current.percent / 100); radio.setMuted(false); }, [radio]);
  useEffect(() => {
    const el = slider.current;
    if (!el) return;
    const released = () => { if (live.current.byPointer) { live.current.percent = Number(el.value); turnOn(); } };
    el.addEventListener("change", released);
    return () => el.removeEventListener("change", released);
  }, [turnOn]);
  const volumeLabel = t("radio.volume");
  return (
    <div className={`tile screen player-off ${big ? "big" : ""}`}>
      <div className="tile-popped">
        <Icon name="volume-x" />
        <span className="player-off-title" title={name}>{t(kind === "twitch" ? "radio.offTileTwitch" : "radio.offTileYoutube", { name })}</span>
        <span className="player-off-hint small">{t("radio.offTileHint")}</span>
        <div className="user-volume-row">
          <input ref={slider} type="range" min={0} max={100} step={1} value={percent} title={volumeLabel} aria-label={volumeLabel} aria-valuetext={`${percent} %`}
            onPointerDown={() => { live.current.byPointer = true; }}
            onKeyDown={(event) => { live.current.byPointer = false; if (event.key === "Enter") turnOn(); }}
            onChange={(event) => { live.current.moved = true; setPercent(Number(event.target.value)); }} />
          <output>{percent} %</output>
        </div>
        <button className="small" title={t("radio.unmute")} onClick={turnOn}><Icon name="volume-2" /> {t("radio.turnOn")}</button>
      </div>
      <button className="icon player-off-close" title={t("radio.offTileDismiss")} aria-label={t("radio.offTileDismiss")} onClick={onDismiss}><Icon name="x" /></button>
    </div>
  );
}

function Tile({ item, client, viewers, big, pinned, onClick, onPopout, poppedIds, onRestore, onMenu }: { item: Extract<Item, { participant: StageParticipant }>; client: VoiceClient; viewers: StageParticipant[]; big?: boolean; pinned: boolean; onClick: () => void; onPopout: (tile: VideoTile, opener?: Window) => void; poppedIds: Set<string>; onRestore: (id: string) => void; onMenu: (item: Item, event: ReactMouseEvent<HTMLElement>) => void }) {
  const { participant: p, tile } = item;
  const ref = useRef<HTMLDivElement>(null);
  const target = useCallback(() => ref.current, []);
  const [error, setError] = useState("");
  // The viewer's statistics of a share (VideoStatsOverlay.tsx): only of a received one, the own share has no inbound side.
  const [stats, setStats] = useState(false);
  const canStats = item.kind === "screen" && !!tile && !tile.isLocal;
  const hasAudioControls = item.kind === "screen" && !!tile && !tile.isLocal && client.getVideoAudioVolume(tile.id) !== null;
  const popped = !!tile && poppedIds.has(tile.id);
  // A share shown in fullscreen counts as selected, also from a small tile: its audio plays (voiceClient.setScreenAudioListening).
  const listenId = item.kind === "screen" && tile && !tile.isLocal ? tile.id : null;
  useEffect(() => {
    const doc = ref.current?.ownerDocument;
    if (!listenId || !doc) return;
    const update = () => client.setScreenAudioListening(listenId, "fullscreen", doc.fullscreenElement === ref.current);
    update(); doc.addEventListener("fullscreenchange", update);
    return () => { doc.removeEventListener("fullscreenchange", update); client.setScreenAudioListening(listenId, "fullscreen", false); };
  }, [client, listenId]);
  const cls = ["tile", item.kind, hasAudioControls ? "has-volume" : "", p.speaking && item.kind === "camera" ? "speaking" : "", big ? "big" : "", tile && !popped ? "" : "avatar"].join(" ");
  // Turned off while it fills the screen: leave fullscreen, an avatar has no business there.
  const watch = (on: boolean) => { const doc = ref.current?.ownerDocument; if (!on && doc?.fullscreenElement === ref.current) void doc?.exitFullscreen().catch(() => {}); client.setVideoWatching(item.key, on); };
  // A share nobody turned on for themselves: the whole tile is the switch, there is nothing to enlarge yet.
  const shareOff = item.kind === "screen" && item.off;
  return (
    <div ref={ref} className={cls} onClick={() => { if (shareOff) watch(true); else if (!ref.current?.ownerDocument.fullscreenElement) onClick(); }} onContextMenu={(event) => onMenu(item, event)} title={shareOff ? t("stage.screenOn") : big ? t("stage.backToGrid") : t("stage.enlarge")}>
      {shareOff ? <div className="tile-popped"><Icon name="monitor" /><span>{t("stage.shareOffered", { name: p.name })}</span><button className="small" onClick={(event) => { event.stopPropagation(); watch(true); }}><Icon name="eye" /> {t("stage.watch")}</button></div>
        : popped ? <div className="tile-popped"><Icon name="external-link" /><span>{t("stage.poppedOut")}</span><button className="secondary small" onClick={(event) => { event.stopPropagation(); onRestore(tile!.id); }}>{t("stage.restoreVideo")}</button></div> : tile ? <TrackVideo tile={tile} /> : <Avatar name={p.name} src={p.avatarUrl} size="large" />}
      {item.kind === "camera" && item.off && <div className="tile-window-actions" onClick={(event) => event.stopPropagation()}>
        <button className="icon" title={t("stage.cameraOn")} aria-label={t("stage.cameraOn")} onClick={() => watch(true)}><Icon name="eye" /></button>
      </div>}
      {canStats && stats && !popped && <VideoStatsOverlay client={client} tileId={tile!.id} />}
      {item.kind === "screen" && tile?.isLocal && <ShareViewers viewers={viewers} />}
      {tile && !popped && <div className="tile-window-actions" onClick={(event) => event.stopPropagation()}>
        {canStats && <VideoStatsButton on={stats} onToggle={() => setStats(!stats)} />}
        {!tile.isLocal && <button className="icon" title={t(item.kind === "screen" ? "stage.screenOff" : "stage.cameraOff")} aria-label={t(item.kind === "screen" ? "stage.screenOff" : "stage.cameraOff")} onClick={() => watch(false)}><Icon name="eye-off" /></button>}
        <button className="icon" title={t("stage.popout")} aria-label={t("stage.popout")} onClick={() => { setError(""); try { onPopout(tile, ref.current?.ownerDocument.defaultView ?? undefined); } catch (error) { setError(error instanceof Error ? error.message : t("stage.popupFailed")); } }}><Icon name="external-link" /></button>
        <FullscreenButton target={target} onError={setError} />
      </div>}
      {error && <div className="tile-window-error" role="alert" onClick={(event) => event.stopPropagation()}>{error}<button className="icon" title={t("common.dismiss")} onClick={() => setError("")}><Icon name="x" /></button></div>}
      <div className="tile-label">
        <span>{item.kind === "screen" && <><Icon name="monitor" /> </>}{p.isLocal ? `${p.name} ${t("members.you")}` : p.name}</span>
        {item.kind === "camera" && p.micMuted && <> <Icon name="mic-off" title={t("voice.micMuted")} /></>}
        {item.kind === "camera" && item.off && <> <Icon name="eye-off" title={t("stage.cameraOffByMe")} /></>}
        {item.kind === "camera" && p.deafened && <> <Icon name="headphone-off" title={t("voice.deafened")} /></>}
        {item.kind === "screen" && tile?.hasAudio && <> {tile.isLocal || client.isScreenAudioListening(tile.id) ? <Icon name="volume-2" title={t("stage.withAudio")} /> : <Icon name="volume-x" title={t("stage.audioOnSelect")} />}</>}
        {pinned && <> <Icon name="pin" title={t("stage.pinned")} /></>}
      </div>
      {hasAudioControls && tile && <VideoAudioControls client={client} tile={tile} />}
    </div>
  );
}
