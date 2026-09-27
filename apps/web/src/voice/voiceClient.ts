import { readInboundVideo, type InboundVideoSample } from "./videoStats";
import {
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoPresets,
  supportsH265,
  type AudioCaptureOptions,
  type LocalTrack,
  type LocalTrackPublication,
  type Participant as LkParticipant,
  type RemoteTrack,
  type TrackPublishOptions,
} from "livekit-client";
import { BackgroundProcessor, supportsBackgroundProcessors, type BackgroundProcessorWrapper } from "@livekit/track-processors";
import { VoiceGate, contextNeedsResume, rmsLevel } from "./gate";
import { boostLimits, type MicBoostSettings } from "./micBoost";
import { MicPipeline, openMic, type GateMode, type OpenedMic } from "./micPipeline";
import { micPermissionState, micRefusal } from "./micPermission";
import { isCameraBusy, retryCameraBusy } from "./cameraRetry";
import { cameraSwitch, type CameraRequest } from "./cameraSwitch";
import type { VoiceSettings } from "./settings";
import { DEFAULT_SOUND_SETTINGS, FEEDBACK_TONES, applyCueOutput, contextSinkSupported, normalizeSoundSettings, playCue, playTones, setContextSink, shouldPlayCue, type SoundCue, type SoundSettings } from "./sounds";
import { USER_VOLUME_MAX, clampUserVolume, loadUserVolumes, saveUserVolumes, withUserVolume, type UserVolumes } from "./userVolumes";
import { screenSharePublish } from "./screenShareOptions";
import { subscriptionPermissions, type VideoAccess } from "./videoAccess";
import { VideoWatch, parseFeedId, type VideoSource } from "./videoWatch";
import { parseWatchingAttribute, watchingAttribute } from "./shareViewers";
import { t } from "../i18n";
import type { PlatformMedia } from "../platform/types";

/**
 * MediaPipe's files for the background blur, from the origin this client was loaded from (the chat server, or app://squorli
 * in the desktop app) instead of jsdelivr and Google Storage: the WASM is copied there by vite.config.ts, the model lives in
 * public/mediapipe/ (apps/web/src/voice/AGENTS.md).
 */
function blurAssets(): { tasksVisionFileSet: string; modelAssetPath: string } {
  return { tasksVisionFileSet: new URL("/mediapipe/wasm", location.href).href, modelAssetPath: new URL("/mediapipe/selfie_segmenter.tflite", location.href).href };
}

/**
 * Voice channel client without a UI dependency (UI-free core, apps/web/AGENTS.md): LiveKit room, microphone pipeline,
 * playback of the other participants, speaker indication, device selection, statistics for the debug view.
 * M3: camera (simulcast, adaptiveStream picks the layer by tile size), screen sharing with audio
 * as its own audio track (docs/features/voice-video.md, screen share audio matrix), video tiles for the stage.
 */
export type VoiceParticipant = {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  /** Deafened (hears nobody); visible to others via LiveKit attributes. */
  deafened: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  quality: string;
  /** Whose screen shares this participant watches, by identity (LiveKit attribute `watching`, shareViewers.ts): the sharer sees who looks. */
  watching: string[];
};

/** One video feed for the stage: a participant's camera or screen. The track object is displayed via attach(). */
export type VideoTile = {
  /** identity + source, stable across re-renders */
  id: string;
  identity: string;
  name: string;
  isLocal: boolean;
  source: "camera" | "screen";
  track: LocalVideoTrack | RemoteVideoTrack;
  /** Screen audio (remote only; locally you do not hear yourself) */
  audio: RemoteAudioTrack | null;
  /** The screen share carries audio (known locally as well) */
  hasAudio: boolean;
};

export type VoiceStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export type VoiceState = {
  status: VoiceStatus;
  channelId: string | null;
  /** Connected to the server's AFK channel (JoinOptions.afk): nothing is sent or heard there, the controls are locked. */
  afkRoom: boolean;
  participants: VoiceParticipant[];
  /** Microphone effectively muted (manually or because of deafening); visible to others. */
  micMuted: boolean;
  /** Deafened: incoming audio muted, microphone forcibly muted. */
  deafened: boolean;
  /** Voice activation / PTT gate open (local only). */
  gateOpen: boolean;
  level: number;
  /** Microphone boost applied right now (1 = none; micBoost.ts), for the settings and the debug view. */
  micBoost: number;
  /** Stereo channel: the one channel of the capture that carries the signal and is put on both sides (oneSided.ts); "stereo" = both do, or a mono channel. */
  micSide: "stereo" | "left" | "right";
  /** Raw microphone level in front of the boost (RMS 0..1), for the debug view: tells a quiet capture from a boost that does not reach. */
  micInput: number;
  /** Microphone test running (Einstellungen): you hear yourself, and nothing of it is sent into the channel (the microphone counts as muted). */
  micTest: boolean;
  /** false = the browser blocks autoplay; the user has to click once. */
  canPlayback: boolean;
  /** State of the Web Audio context (microphone gate, level metering): "running" is mandatory, "suspended" = the browser blocks until a user gesture. */
  audioContext: string;
  inputDeviceId: string | null;
  cameraOn: boolean;
  /** Active blur radius of the camera (0 = off). */
  cameraBlur: number;
  screenOn: boolean;
  /** After starting a screen share: did an audio track come along? null = no share active. */
  screenAudio: boolean | null;
  tiles: VideoTile[];
  /** Notice from a moderator (moved, camera stopped); the user can dismiss it. */
  notice: string | null;
  /** Output device for screen audio, how many tracks it carries and which way they play (debug): "webaudio" = through the screen context on the separate device, "element" = LiveKit's element on the voice device (applyShareAudio). */
  screenSink: { deviceId: string | null; tracks: number; error: string | null; via: "element" | "webaudio" };
  /** Active voice profile of the channel (bitrate in kbit/s, stereo). */
  audioProfile: AudioProfile | null;
  /** Last used LiveKit URL (debug). */
  rtcUrl: string | null;
  /** Recent room events with timestamps (debug), newest last. */
  events: string[];
  error: string | null;
};

/** 0.1 s of silence (WAV): playing it once inside a user gesture unlocks <audio> playback for the document. */
const SILENT_WAV = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
/** Speaker highlight for others: RMS threshold and hangover of the local level metering. */
const REMOTE_SPEAK_THRESHOLD = 0.015;
const REMOTE_SPEAK_HANGOVER_MS = 250;
const EVENTS_MAX = 40;
/** Quiet period after connecting: participants reported within it were already in the room. */
const PEER_CUE_GRACE_MS = 1500;
/** The message cue waits this long for an audio context that is not running yet; later it would only be noise at the wrong time. */
const MESSAGE_CUE_WAIT_MS = 1000;

/** Selected ICE path per transport direction, e.g. "udp srflx->host" or "relay (TURN)". */
export type IcePath = { publisher: string | null; subscriber: string | null };

/** Voice quality of the channel (Opus bitrate in kbit/s, stereo), coming from the channel settings. */
export type AudioProfile = { bitrate: number; stereo: boolean };
export const DEFAULT_AUDIO_PROFILE: AudioProfile = { bitrate: 64, stereo: false };

export type JoinOptions = {
  /** "relay" forces the browser onto TURN (a test for blocked UDP/TCP). */
  iceTransportPolicy?: "all" | "relay";
  audio?: AudioProfile;
  /** Permission VIEW_VIDEO: who may receive our camera/screen, and whether we may receive others' (see setVideoAccess). */
  video?: { access: VideoAccess; mayView: boolean };
  /** LiveKit identity (user id on this server) -> public key, for the per-person playback volume (see setPeerKeys). */
  peerKeys?: Record<string, string>;
  /**
   * The server's AFK channel: its token carries no publish or subscribe grant. The client asks for no microphone, shows
   * microphone and audio as off and refuses camera, screen and the mute buttons until another channel is joined.
   */
  afk?: boolean;
};

/** `codec` and `encoder` = what is really sent and what encodes it (a share that fell back to its backup codec shows both senders, the first one idle). */
export type VideoSendStat = { source: "camera" | "screen"; rid: string; codec: string; encoder?: string | undefined; width: number; height: number; fps: number; bytesSent: number; limitation?: string | undefined };
export type VideoRecvStat = { identity: string; source: "camera" | "screen"; width?: number | undefined; height?: number | undefined; framesDecoded: number; bytesReceived: number; packetsLost?: number | undefined };

export type AudioStats = {
  path: IcePath;
  sender: { packetsSent?: number | undefined; packetsLost?: number | undefined; jitter?: number | undefined; roundTripTime?: number | undefined; bytesSent?: number | undefined } | null;
  receivers: { identity: string; packetsReceived?: number | undefined; packetsLost?: number | undefined; jitter?: number | undefined; bytesReceived?: number | undefined }[];
  /** M3: per simulcast layer (rid) when sending, per track when receiving. Bytes are cumulative; bitrate = the difference per interval. */
  videoSend: VideoSendStat[];
  videoRecv: VideoRecvStat[];
};

/** Chromium browsers can include tab/system audio with a screen share; all others cannot (docs/features/voice-video.md, screen share audio matrix). */
export const isChromium = () => typeof (window as { chrome?: unknown }).chrome !== "undefined";

/** Explains why a screen share is running without audio; empty when audio is included or no share is active. */
/** `app`: the desktop app, where audio is a choice in the app's own picker (ScreenPicker.tsx) and exists on Windows only; omitted = a browser. */
export function explainScreenAudio(state: Pick<VoiceState, "screenOn" | "screenAudio">, app?: { audioPossible: boolean }): string {
  if (!state.screenOn || state.screenAudio !== false) return "";
  if (app) return t(app.audioPossible ? "voice.screenNoAudioApp" : "voice.screenNoAudioAppOs");
  return isChromium() ? t("voice.screenNoAudioChromium") : t("voice.screenNoAudioOther");
}

export class VoiceClient {
  private room: Room | null = null;
  private mic: MicPipeline | null = null;
  private publication: LocalTrackPublication | null = null;
  private readonly audioHost: HTMLElement;
  private readonly remoteAudio = new Map<RemoteTrack, { element: HTMLMediaElement; identity: string }>();
  private readonly videoAudioHosts = new Map<string, HTMLElement>();
  /** Screen tiles whose audio the user listens to, with the reasons why (watched in the stage, fullscreen, popped out); see setScreenAudioListening. */
  private readonly screenListening = new Map<string, Set<string>>();
  private readonly listeners = new Set<(s: VoiceState) => void>();
  state: VoiceState = {
    status: "disconnected", channelId: null, afkRoom: false, participants: [], micMuted: false, deafened: false, gateOpen: false, level: 0, micBoost: 1, micInput: 0, micSide: "stereo", micTest: false,
    canPlayback: true, audioContext: "none", inputDeviceId: null, cameraOn: false, cameraBlur: 0, screenOn: false, screenAudio: null, tiles: [], notice: null, screenSink: { deviceId: null, tracks: 0, error: null, via: "element" }, audioProfile: null, rtcUrl: null, events: [], error: null,
  };
  private audioProfile: AudioProfile = DEFAULT_AUDIO_PROFILE;
  private micSettings: VoiceSettings | null = null;
  /** Output device for screen audio (separate from voice); null = default/same as voice. */
  private screenSinkId: string | null = null;
  /**
   * The context that plays screen audio on its separate device (Chromium's AudioContext.setSinkId); null where the browser
   * cannot give a context its own device. Created when a device is chosen, kept across rooms like `audioCtx`. See applyShareAudio().
   */
  private screenCtx: AudioContext | null = null;
  /** The screen context's sink IS the chosen device (setSinkId resolved); until then, and after a refusal, the shares play through their elements. */
  private screenSinkReady = false;
  private screenSinkError: string | null = null;
  /** The Web Audio path of each received share's audio while it plays on the separate device: source -> gain -> screenCtx.destination. */
  private readonly shareRoutes = new Map<RemoteTrack, { source: MediaStreamAudioSourceNode; gain: GainNode }>();
  /** Playback volume of each participant's share audio (0..1), in memory only; on the Web Audio path the element cannot hold it (it stays at 0). */
  private readonly shareVolumes = new Map<string, number>();
  /** Microphone mute set by the user themselves, independent of deafening. */
  private micMutedByUser = false;
  /** Microphone test: the capture opened for it while in no channel (in a channel the test listens to `mic`), and its playback. */
  private testMic: MicPipeline | null = null;
  private testAudio: HTMLAudioElement | null = null;
  private micTestWanted = false;
  /** Last requested camera settings (for switching on again). */
  private camera: { deviceId: string | null; quality: "360p" | "720p"; blur: number } = { deviceId: null, quality: "720p", blur: 0 };
  /** With which device and resolution the published camera track was opened (null = none published, or not by us); see cameraSwitch.ts. */
  private cameraOpened: CameraRequest | null = null;
  /** A share is being captured or published: a second click must not open a second picker. */
  private screenStarting = false;
  /** Background processor (MediaPipe segmentation, running in the browser); kept around for toggling. */
  private blur: BackgroundProcessorWrapper | null = null;
  /** One AudioContext for everything (microphone gate, other participants' levels); created inside a user gesture, see prepareAudio(). */
  private audioCtx: AudioContext | null = null;
  private unlocked = false;
  /** The microphone asked for inside the user's gesture, waiting for join() to take it over (prepareMic()). */
  private preMic: { deviceId: string | null; stereo: boolean; opened: Promise<OpenedMic> } | null = null;
  /** Level meter per remote microphone track: speaker highlight without the delay of LiveKit's report (~0.5-1 s). */
  private readonly meters = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; gate: VoiceGate; samples: Float32Array<ArrayBuffer>; boost: GainNode | null }>();
  private meterTimer: number | null = null;
  /** Cues for joining/leaving (per device, from the voice settings). */
  private sounds: SoundSettings = { ...DEFAULT_SOUND_SETTINGS };
  private cueSinkId: string | null = null;
  /** join() replaces a running room: the room change is one move, so it gets no leave cue. */
  private switchingRoom = false;
  /** No cues for other participants before this time: the ones already in the room are not arrivals. */
  private peerCuesFrom = 0;
  /** A room was fully joined (the join cue played), so leaving it earns the leave cue. */
  private cueJoined = false;
  /** Permission VIEW_VIDEO: who may receive our camera/screen (null = not told yet, LiveKit's default "everyone" stays). */
  private videoAccess: VideoAccess | null = null;
  /** Whether we may receive others' camera/screen ourselves. */
  private mayViewVideo = true;
  /** Which feeds of others the user watches: cameras until turned off, screen shares once turned on (videoWatch.ts). */
  private readonly videoWatch = new VideoWatch();
  /** The `watching` attribute as last sent (shareViewers.ts); null = not sent in this room yet. */
  private watchingSent: string | null = null;
  /** Last subscription permissions sent to LiveKit, to skip identical updates. */
  private sentVideoAccess = "";
  /** Playback volume per person (0..2), keyed by public key and stored per device (userVolumes.ts). */
  private userVolumes: UserVolumes = loadUserVolumes();
  /** People blocked by the identity of the server we sit on (App.tsx, docs/features/reports.md stage 3): silent here, whatever their volume. */
  private blocked = new Set<string>();
  /** LiveKit identity -> public key for the members of the voice connection's server. */
  private peerKeys: Record<string, string> = {};

  /** `media` = what differs between browser and desktop app (`platform/`); tests leave it out. */
  constructor(audioHost?: HTMLElement, private readonly media: PlatformMedia | null = null) {
    this.audioHost = audioHost ?? VoiceClient.makeHost();
    // Fallback: any gesture in the document may unblock audio after the fact (resume the context, start playback).
    document.addEventListener("pointerdown", () => this.unlockOnGesture(), { capture: true, passive: true });
    document.addEventListener("keydown", () => this.unlockOnGesture(), { capture: true, passive: true });
  }

  /**
   * Call in the click handler BEFORE the first await (App.joinVoice): creates the AudioContext inside the user gesture and plays
   * silence once, so browsers with a strict autoplay policy (Safari, partly Firefox) unlock the microphone gate and playback.
   * Without this the context was only created after the token and the connection: the level stayed 0 (nobody heard you) and <audio> stayed silent.
   */
  prepareAudio(): void {
    const ctx = this.ensureCtx();
    if (contextNeedsResume(ctx.state)) void ctx.resume().catch(() => {});
    this.resumeScreenCtx();
    if (!this.unlocked) {
      const el = document.createElement("audio");
      el.src = SILENT_WAV;
      el.play().then(() => { this.unlocked = true; }).catch(() => { /* no gesture: try again later */ });
    }
    if (this.room && !this.room.canPlaybackAudio) void this.startAudio();
    this.patch({ audioContext: ctx.state });
  }

  /**
   * Ask for the microphone INSIDE the user's gesture, before the first await of joining (`App.joinVoice()`), like prepareAudio().
   *
   * Why (user's report, 19 September 2026: no channel can be joined from the iPhone's home screen app, "Mikrofon: The request
   * is not allowed by the user agent or the platform in the current context"): WebKit only shows its microphone prompt while
   * the tap still counts, and join() opens the microphone after the token and the LiveKit connection, seconds later. In
   * Safari itself the site's stored permission hid that; a home screen app has no stored permission and asks every time.
   * join() takes this capture over when device and mode still match, and releases it otherwise; whoever calls this and
   * then does not reach join() calls releasePreparedMic().
   */
  prepareMic(deviceId: string | null, channelStereo: boolean): void {
    this.releasePreparedMic();
    const stereo = this.capturesStereo(channelStereo);
    const opened = openMic((c) => navigator.mediaDevices.getUserMedia(c), deviceId, stereo);
    opened.catch(() => { /* reported by join(), which awaits the same promise */ });
    this.preMic = { deviceId, stereo, opened };
  }

  /**
   * Is the microphone captured in stereo, that is raw, without the browser's echo cancellation, noise suppression and gain
   * control? Only in a stereo channel and never on a phone or tablet (user's reports, 19 September 2026: with the iPhone on
   * its loudspeaker the others heard themselves back, and its mono microphone arrived on one side only). A phone has one
   * microphone next to its loudspeaker: nothing is gained by raw stereo there and the echo cancellation is needed. The
   * channel's Opus settings stay as they are (publish options); the mono capture is spread to both sides.
   */
  private capturesStereo(channelStereo: boolean): boolean { return channelStereo && !(this.media?.mobile ?? false); }

  releasePreparedMic(): void {
    const pre = this.preMic;
    this.preMic = null;
    void pre?.opened.then((o) => o.stream.getTracks().forEach((track) => track.stop())).catch(() => {});
  }

  private ensureCtx(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === "closed") {
      this.audioCtx = new AudioContext();
      if (this.cueSinkId) applyCueOutput(this.audioCtx, this.cueSinkId);
      // Volumes above 100 % run through this context; while it is not running they fall back to 100 % (applyUserVolumes).
      this.audioCtx.onstatechange = () => {
        this.applyUserVolumes();
        this.patch({ audioContext: this.audioCtx?.state ?? "none" });
        // The context stopped while a microphone runs through it (iOS: "interrupted" by the microphone prompt, the start of
        // the capture, a phone call): ask for it back at once. A capturing page may do that without a gesture; where it may
        // not, nothing changes and the dock's "Mikrofon freigeben" and the next tap remain.
        const ctx = this.audioCtx;
        if (ctx && (this.mic || this.testMic) && contextNeedsResume(ctx.state)) void ctx.resume().then(() => this.log("audio-kontext wieder gestartet")).catch(() => {});
      };
    }
    return this.audioCtx;
  }

  /** The screen context, made when a separate device is first chosen; null where a context cannot have its own device. */
  private ensureScreenCtx(): AudioContext | null {
    if (!contextSinkSupported()) return null;
    if (!this.screenCtx || this.screenCtx.state === "closed") {
      const ctx = new AudioContext();
      this.screenCtx = ctx;
      // Suspended (no gesture yet) = the shares play through their elements meanwhile; running again = back on the separate device.
      ctx.onstatechange = () => { if (this.screenCtx === ctx) this.applyShareAudio(); };
    }
    return this.screenCtx;
  }

  private resumeScreenCtx(): void {
    const ctx = this.screenCtx;
    if (ctx && contextNeedsResume(ctx.state)) void ctx.resume().catch(() => {});
  }

  /** Point the screen context at the chosen device; the shares move over once the browser has accepted it, and stay on their elements when it refuses. */
  private async applyScreenCtxSink(): Promise<void> {
    const wanted = this.screenSinkId;
    this.screenSinkReady = false;
    this.screenSinkError = null;
    const ctx = wanted !== null ? this.ensureScreenCtx() : null;
    if (!ctx) { this.applyShareAudio(); return; }
    try {
      await setContextSink(ctx, wanted);
      if (this.screenCtx === ctx && this.screenSinkId === wanted) this.screenSinkReady = true;
    } catch (err) {
      if (this.screenCtx === ctx && this.screenSinkId === wanted) this.screenSinkError = errorText(err);
    }
    this.applyShareAudio();
  }

  private unlockOnGesture(): void {
    const ctx = this.audioCtx;
    if (ctx && contextNeedsResume(ctx.state)) void ctx.resume().then(() => this.log("audio-kontext freigegeben (klick)")).catch(() => {});
    this.resumeScreenCtx();
    if (this.room && !this.room.canPlaybackAudio) void this.startAudio();
  }

  private static makeHost() {
    const el = document.createElement("div");
    el.id = "voice-audio";
    el.style.display = "none";
    document.body.appendChild(el);
    return el;
  }

  subscribe(fn: (s: VoiceState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private patch(p: Partial<VoiceState>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }

  private log(text: string) {
    const line = `${new Date().toLocaleTimeString()} ${text}`;
    this.patch({ events: [...this.state.events.slice(-(EVENTS_MAX - 1)), line] });
  }

  /** Take over the cue settings (settings dialog and join); also routes the cues to the chosen output device. */
  setSoundSettings(s: SoundSettings): void {
    this.sounds = normalizeSoundSettings(s);
  }

  /**
   * Play one cue if the settings allow it. `force` is the preview in the settings dialog: it ignores the
   * switch for that cue, but deafening and volume 0 still keep everything silent.
   */
  playSound(cue: SoundCue, force = false): void {
    if (!shouldPlayCue(cue, this.sounds, { deafened: this.state.deafened, force })) return;
    const ctx = this.ensureCtx();
    // The message cue comes without a click (the others follow one). A browser keeps the context waiting until the user
    // did something in the page, and tones scheduled meanwhile would all sound at that first click: play it only if the
    // context runs, or starts within a moment.
    if (cue === "message" && !force && ctx.state !== "running") {
      const asked = Date.now();
      void ctx.resume().then(() => { if (Date.now() - asked < MESSAGE_CUE_WAIT_MS) playCue(ctx, cue, this.sounds.volume); }).catch(() => {});
      return;
    }
    playCue(ctx, cue, this.sounds.volume);
  }

  /**
   * Confirmation of a global shortcut or a command from outside the window (docs/features/hotkeys.md): a short tone for
   * the state it left behind (on = rising, off = falling), whoever pressed it cannot see the window. Deafened or not; only
   * the common volume at 0 keeps it quiet.
   */
  playFeedback(on: boolean): void {
    if (this.sounds.volume <= 0) return;
    playTones(this.ensureCtx(), on ? FEEDBACK_TONES.on : FEEDBACK_TONES.off, this.sounds.volume);
  }

  /** Output device of the cues outside a voice room (the message cue); a join and `setOutputDevice` set it as before. */
  setCueOutput(deviceId: string | null): void {
    this.cueSinkId = deviceId;
    if (this.audioCtx && this.audioCtx.state !== "closed") applyCueOutput(this.audioCtx, deviceId);
  }

  async join(channelId: string, url: string, token: string, settings: VoiceSettings, opts: JoinOptions = {}): Promise<void> {
    await this.stopMicTest();
    this.setSoundSettings(settings.sounds);
    applyCueOutput(this.ensureCtx(), settings.outputDeviceId);
    if (this.room) { this.switchingRoom = true; try { await this.leave(); } finally { this.switchingRoom = false; } }
    this.audioProfile = opts.audio ?? DEFAULT_AUDIO_PROFILE;
    this.micSettings = settings;
    this.videoAccess = opts.video?.access ?? null;
    this.mayViewVideo = opts.video?.mayView ?? true;
    this.sentVideoAccess = "";
    this.peerKeys = opts.peerKeys ?? {};
    const afk = opts.afk === true;
    this.patch({ status: "connecting", channelId, afkRoom: afk, rtcUrl: url, error: null, audioProfile: this.audioProfile });

    // adaptiveStream: receive quality depending on the size of the <video> element (simulcast layer), pauses invisible tracks.
    // dynacast: the sender turns off layers nobody subscribes to. Together: simulcast layers depending on tile size (bandwidth: deploy/AGENTS.md).
    // pauseVideoInBackground off: LiveKit would pause every video once the main page is hidden, also one showing in a pop-out
    // window; each video view handles that for its own window instead (videoDisplay.ts `watchDocumentHidden`).
    const room = new Room({
      adaptiveStream: { pauseVideoInBackground: false },
      dynacast: true,
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      publishDefaults: {
        simulcast: true,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        videoCodec: "vp8", // decodable everywhere, no backup codec needed
        screenShareEncoding: ScreenSharePresets.h1080fps30.encoding, // 1080p, 30 fps, up to 5 Mbit/s
        dtx: true,
        red: true,
      },
    });
    this.room = room;
    // LiveKit's room.startAudio() unmutes EVERY attached audio element, and LiveKit runs it by itself whenever a local audio
    // track is published (the own screen share's audio too). That would play shares the user has not selected, and voices
    // while deafened. The unmute happens synchronously in LiveKit's listener, so the rule is put back in a microtask after it,
    // before any sound is rendered.
    room.localParticipant.on(ParticipantEvent.AudioStreamAcquired, () => queueMicrotask(() => this.applyAudioMuted()));
    this.log(`verbinde mit ${url}${opts.iceTransportPolicy === "relay" ? " (nur TURN/relay)" : ""}`);
    room
      .on(RoomEvent.ParticipantConnected, (p) => { this.log(`teilnehmer da: ${p.identity.slice(0, 8)}`); this.peerCue("peerJoin"); this.applyVideoAccess(); this.refreshParticipants(); })
      // refreshParticipants: a share nobody watches yet is never subscribed, so `screenOn` is all the stage has to show its tile.
      .on(RoomEvent.TrackPublished, () => { this.applyVideoSubscriptions(); this.refreshParticipants(); })
      .on(RoomEvent.ParticipantDisconnected, (p) => { this.videoWatch.forgetParticipant(p.identity); this.log(`teilnehmer weg: ${p.identity.slice(0, 8)}`); this.peerCue("peerLeave"); this.refreshParticipants(); })
      .on(RoomEvent.Reconnecting, () => this.log("verbindung unterbrochen, versuche erneut"))
      .on(RoomEvent.Reconnected, () => this.log("wieder verbunden"))
      .on(RoomEvent.MediaDevicesError, (e) => this.log(`Gerätefehler: ${e.message}`))
      .on(RoomEvent.ActiveSpeakersChanged, () => this.refreshParticipants())
      // A camera turned off is a MUTED track that stays published (LiveKit's setCameraEnabled(false)); the tile goes with the mute.
      .on(RoomEvent.TrackMuted, () => { this.refreshParticipants(); this.refreshTiles(); })
      .on(RoomEvent.TrackUnmuted, () => { this.refreshParticipants(); this.refreshTiles(); })
      .on(RoomEvent.ConnectionQualityChanged, () => this.refreshParticipants())
      .on(RoomEvent.ParticipantAttributesChanged, () => this.refreshParticipants())
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => { this.attachRemote(track, p.identity); if (track.kind === Track.Kind.Video) this.log(`video von ${p.identity.slice(0, 8)}: ${track.source}`); this.refreshTiles(); })
      // LiveKit emits TrackUnsubscribed before clearing publication.track, so exclude the ended track explicitly;
      // otherwise the tile survives with a stopped track and the viewers keep a black frame.
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => { if (track.kind === Track.Kind.Audio) { track.detach().forEach((el) => el.remove()); this.dropShareRoute(track); this.remoteAudio.delete(track); this.dropMeter(p.identity); this.applyShareAudio(); } this.refreshTiles(track); })
      .on(RoomEvent.TrackUnpublished, (pub, p) => {
        this.log(`${p.identity.slice(0, 8)} beendet ${pub.source}`);
        // The choice ends with the feed: a share started again has to be turned on again.
        if (pub.source === Track.Source.Camera) this.videoWatch.forget(p.identity, "camera");
        if (pub.source === Track.Source.ScreenShare) this.videoWatch.forget(p.identity, "screen");
        this.refreshParticipants();
        this.refreshTiles();
      })
      // The microphone's track id is part of the subscription permissions (republishing changes it).
      .on(RoomEvent.LocalTrackPublished, (pub) => { this.log(`sende ${pub.source}`); this.applyVideoAccess(); this.refreshTiles(); })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        this.log(`beendet ${pub.source}`);
        this.applyVideoAccess();
        // Also end up here when the browser itself stops the share (the "stop sharing" bar).
        if (pub.source === Track.Source.ScreenShare) {
          this.patch({ screenOn: false, screenAudio: null });
          // Audio the platform captured itself (desktop app) was published by us, so its end is ours too, also when the
          // share ended by itself (the shared window closed).
          this.media?.stopScreenAudio();
          const audio = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
          if (audio) void this.room?.localParticipant.unpublishTrack(audio).catch(() => {});
        }
        if (pub.source === Track.Source.Camera) { this.cameraOpened = null; this.patch({ cameraOn: false }); }
        this.refreshTiles();
      })
      .on(RoomEvent.TrackStreamStateChanged, () => this.refreshTiles())
      // On device changes LiveKit points every element at the voice output device (right: that is their device); the shares' own route is checked again.
      .on(RoomEvent.MediaDevicesChanged, () => this.applyShareAudio())
      .on(RoomEvent.ActiveDeviceChanged, (kind) => { if (kind === "audiooutput") this.applyShareAudio(); })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.patch({ canPlayback: room.canPlaybackAudio }))
      .on(RoomEvent.ConnectionStateChanged, (s) => { this.log(`status: ${s}`); this.patch({ status: mapState(s) }); })
      .on(RoomEvent.Disconnected, (reason) => {
        const why = explainDisconnect(reason);
        this.log(`getrennt: ${why.short}`);
        void this.leave().then(() => {
          if (why.unexpected) this.patch({ error: why.long });
          // Wait a moment for the reason from the chat server (App.tsx sets its own notice), else say it plainly.
          if (why.removed) window.setTimeout(() => { if (!this.room && !this.state.notice) this.setNotice(t("voice.disc.removed")); }, 1500);
        });
      });

    // A failing microphone is no connection problem: it must not come with the proxy hint of explainConnectError().
    let micFailed = false;
    try {
      await room.connect(url, token, opts.iceTransportPolicy ? { rtcConfig: { iceTransportPolicy: opts.iceTransportPolicy } } : {});
      // VIEW_VIDEO before anything is published: restricted members start with nothing and get the microphone once it has a track id.
      this.applyVideoAccess();
      this.applyVideoSubscriptions();
      if (afk) {
        this.releasePreparedMic(); // the AFK channel uses no microphone
        // AFK channel: nothing to publish and nothing to hear. Shown as muted and deafened, also to the others in the room.
        this.micMutedByUser = false;
        this.patch({ status: mapState(room.state), canPlayback: true, inputDeviceId: null, micMuted: true, deafened: true });
        await room.localParticipant.setAttributes({ deafened: "1" }).catch(() => {});
        this.refreshParticipants();
        this.cueJoined = true;
        return;
      }
      // The capture starts only after connecting; the permission prompt came with the user's tap already (prepareMic()).
      const mic = new MicPipeline(settings.vadThreshold, settings.vadHangoverMs, this.ensureCtx(), boostLimits(this.media?.mobile ?? false));
      this.mic = mic;
      mic.onState = (s) => {
        const changed = s.open !== this.state.gateOpen;
        this.patch({ level: s.level, gateOpen: s.open, micBoost: s.boost, micInput: s.input, micSide: s.side });
        if (changed) this.refreshParticipants(); // own speaker highlight immediately, not only once LiveKit reports it
      };
      mic.setMode(settings.mode);
      mic.setBoost(settings.micBoost);
      // The capture opened inside the user's gesture, if it is the one wanted here (prepareMic()); otherwise it is released.
      const pre = this.preMic?.deviceId === settings.inputDeviceId && this.preMic.stereo === this.capturesStereo(this.audioProfile.stereo) ? this.preMic.opened : undefined;
      if (pre) this.preMic = null;
      else this.releasePreparedMic();
      const track = await mic.start(settings.inputDeviceId, this.capturesStereo(this.audioProfile.stereo), pre).catch((err) => { micFailed = true; throw err; });
      if (mic.deviceFallback) this.log("gewaehltes mikrofon nicht gefunden, nutze das standardmikrofon");
      this.publication = await room.localParticipant.publishTrack(track, this.micPublishOptions());
      this.log(`opus ${this.audioProfile.bitrate} kbit/s ${this.audioProfile.stereo ? "stereo" : "mono, dtx+red"}`);
      this.screenSinkId = settings.screenOutputDeviceId;
      if (settings.outputDeviceId) await this.setOutputDevice(settings.outputDeviceId).catch(() => {});
      void this.applyScreenCtxSink();
      this.micMutedByUser = false;
      this.patch({ status: mapState(room.state), canPlayback: room.canPlaybackAudio, audioContext: mic.contextState(), inputDeviceId: mic.activeDeviceId(), micMuted: false, deafened: false });
      this.log(`audio-kontext ${mic.contextState()}, wiedergabe ${room.canPlaybackAudio ? "frei" : "blockiert (klicken)"}`);
      this.startMeters();
      this.refreshParticipants();
      this.cueJoined = true;
      this.playSound("selfJoin");
      // Participants already in the room arrive as subscriptions right after connecting, not as arrivals: no cue for them.
      this.peerCuesFrom = Date.now() + PEER_CUE_GRACE_MS;
    } catch (err) {
      const message = errorText(err);
      this.releasePreparedMic();
      await this.leave();
      // A refused microphone: WebKit has one text for every cause, so the browser's permission state picks ours (micPermission.ts).
      const refused = micFailed && isPermissionRefused(err) ? micRefusal(await micPermissionState()) : null;
      const text = refused === "denied" ? t("voice.errMicDenied") : refused === "notAsked" ? t("voice.errMicNotAsked") : refused === "system" ? t("voice.errMicSystem") : micFailed ? t("voice.errMic", { err: message }) : explainConnectError(message, url, this.media?.blocksInsecureMedia ?? false);
      this.patch({ error: text, rtcUrl: url });
      throw err;
    }
  }

  async leave(): Promise<void> {
    const room = this.room;
    // Only a room actually joined gets a leave cue: a failed connection attempt and a channel switch stay silent.
    const wasJoined = this.cueJoined;
    this.cueJoined = false;
    this.peerCuesFrom = 0;
    if (wasJoined && !this.switchingRoom) this.playSound("selfLeave");
    this.room = null;
    this.publication = null;
    this.cameraOpened = null;
    this.stopMeters();
    await this.stopMicTest();
    await this.mic?.stop();
    this.mic = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect().catch(() => {});
    }
    for (const { element } of this.remoteAudio.values()) element.remove();
    for (const track of [...this.shareRoutes.keys()]) this.dropShareRoute(track);
    this.remoteAudio.clear();
    this.applyShareAudio();
    this.videoAudioHosts.clear();
    this.screenListening.clear();
    this.videoWatch.clear();
    this.watchingSent = null;
    this.audioHost.replaceChildren();
    this.micMutedByUser = false;
    // Switching rooms (join() while in one) never shows "disconnected": App.tsx takes that for the end of voice and closes
    // the stage, so after the first join every further channel landed on the first text channel (user's report, 24 September 2026).
    this.patch({ status: this.switchingRoom ? "connecting" : "disconnected", channelId: null, afkRoom: false, participants: [], gateOpen: false, level: 0, micBoost: 1, micInput: 0, micSide: "stereo", micMuted: false, deafened: false, inputDeviceId: null, cameraOn: false, screenOn: false, screenAudio: null, tiles: [] });
  }

  // ---------- Permission VIEW_VIDEO: who receives camera and screen

  /**
   * Take over who may receive camera/screen (from the server state; App.tsx calls this on every role or member change)
   * and whether we may ourselves. Takes effect on a running connection.
   */
  setVideoAccess(access: VideoAccess, mayView: boolean): void {
    this.videoAccess = access;
    this.mayViewVideo = mayView;
    this.applyVideoAccess();
    this.applyVideoSubscriptions();
    this.refreshTiles();
  }

  /**
   * Sender side, enforced by LiveKit: members without VIEW_VIDEO may only subscribe to our microphone (videoAccess.ts).
   * LiveKit keeps the list per sender and the SDK sends it again after a reconnect.
   */
  private applyVideoAccess(): void {
    const room = this.room;
    const access = this.videoAccess;
    if (!room || !access || room.state === ConnectionState.Disconnected || room.state === ConnectionState.Connecting) return;
    const micSids = [...room.localParticipant.audioTrackPublications.values()].filter((p) => p.source !== Track.Source.ScreenShareAudio).map((p) => p.trackSid);
    const { allAllowed, list } = subscriptionPermissions(access, micSids, [...room.remoteParticipants.values()].map((p) => p.identity));
    const key = JSON.stringify([allAllowed, list]);
    if (key === this.sentVideoAccess) return;
    this.sentVideoAccess = key;
    room.localParticipant.setTrackSubscriptionPermissions(allAllowed, list);
    this.log(allAllowed ? "video fuer alle freigegeben" : `video nur fuer ${access.viewers.length} mitglieder, ${list.length - access.viewers.length} nur mikrofon`);
  }

  /**
   * Receiver side: without VIEW_VIDEO we do not ask for camera, screen or screen audio at all. LiveKit refuses them anyway
   * when the sender runs this client; this keeps the interface and the bandwidth in step and covers older senders.
   */
  private applyVideoSubscriptions(): void {
    const room = this.room;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        const stream = pub.kind === Track.Kind.Video || pub.source === Track.Source.ScreenShareAudio;
        if (!stream) continue;
        // A share's audio goes with its picture: not watching the share means receiving neither.
        const want = this.mayViewVideo && this.videoWatch.watching(p.identity, pub.source === Track.Source.Camera ? "camera" : "screen");
        if (pub.isDesired !== want) pub.setSubscribed(want);
      }
    }
    this.publishWatching();
  }
  /** The screen shares the user watches right now: turned on ("Ansehen") and still running, with VIEW_VIDEO. */
  private watchedScreens(): string[] {
    const room = this.room;
    if (!room || !this.mayViewVideo) return [];
    return [...room.remoteParticipants.values()].filter((p) => p.isScreenShareEnabled && this.videoWatch.watching(p.identity, "screen")).map((p) => p.identity);
  }
  /** Tell the room whose shares the user watches (shareViewers.ts), when that changed. */
  private publishWatching(): void {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    const value = watchingAttribute(this.watchedScreens());
    if (value === this.watchingSent) return;
    this.watchingSent = value;
    room.localParticipant.setAttributes({ watching: value }).catch(() => { this.watchingSent = null; });
  }

  /**
   * Watch or stop watching one feed of another participant, for yourself only (user's requirement, 19 September 2026):
   * a screen share is never shown by itself, the user turns it on; a camera shows by itself and can be turned off. Not
   * watching = not subscribed, so it costs no bandwidth. Kept in memory only (videoWatch.ts).
   */
  setVideoWatching(tileId: string, on: boolean): void {
    const { identity, source } = parseFeedId(tileId);
    if (this.videoWatch.watching(identity, source) === on) return;
    this.videoWatch.set(identity, source, on);
    this.log(`${source} von ${identity.slice(0, 8)}: ${on ? "ansehen" : "fuer mich aus"}`);
    this.applyVideoSubscriptions();
    this.refreshTiles();
  }
  isVideoWatching(tileId: string): boolean {
    const { identity, source } = parseFeedId(tileId);
    return this.videoWatch.watching(identity, source);
  }

  // ---------- Camera and screen (M3)

  async setCameraEnabled(on: boolean, deviceId?: string | null, quality?: "360p" | "720p", blur?: number): Promise<void> {
    if (on && this.state.afkRoom) return;
    const room = this.room;
    if (!room) return;
    if (deviceId !== undefined) this.camera.deviceId = deviceId;
    if (quality) this.camera.quality = quality;
    if (blur !== undefined) this.camera.blur = blur;
    try {
      const resolution = (this.camera.quality === "360p" ? VideoPresets.h360 : VideoPresets.h720).resolution;
      if (!on) this.blur = null; // the track is ended, and the processor with it
      const options = on ? { resolution, ...(this.camera.deviceId ? { deviceId: this.camera.deviceId } : {}) } : undefined;
      // A camera switched off is a muted track that stays published, and LiveKit's setCameraEnabled(true, options) only
      // unmutes it with its OLD constraints: the camera picked in the dialog was ignored (user's report, 19 September 2026).
      // So a track of another camera or resolution is dealt with first (cameraSwitch.ts).
      const existing = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      const wanted: CameraRequest = { deviceId: this.camera.deviceId, quality: this.camera.quality };
      const change = on ? cameraSwitch(existing instanceof LocalVideoTrack ? { muted: existing.isMuted, opened: this.cameraOpened } : null, wanted) : "enable";
      if (change === "republish" && existing instanceof LocalVideoTrack) {
        this.blur = null; // the track is ended, and the processor with it
        await room.localParticipant.unpublishTrack(existing, true);
        this.log("kamera gewechselt: spur neu veroeffentlicht");
      } else if (change === "restart" && existing instanceof LocalVideoTrack) {
        await retryCameraBusy(() => existing.restartTrack({ resolution, ...(wanted.deviceId ? { deviceId: { exact: wanted.deviceId } } : {}) }));
      }
      // Firefox may still be releasing the camera (picker preview, or off -> on); one retry after a pause covers that.
      await retryCameraBusy(() => room.localParticipant.setCameraEnabled(on, options));
      if (on) this.cameraOpened = { deviceId: this.activeCameraId() ?? wanted.deviceId, quality: wanted.quality };
      this.patch({ cameraOn: on, cameraBlur: 0, error: null });
      if (on && this.camera.blur > 0) await this.setCameraBlur(this.camera.blur);
    } catch (err) {
      // No picker dialog for a camera: only a refused permission is the user's own doing. AbortError = the device could not start.
      if (isCameraBusy(err)) this.patch({ error: t("voice.errCameraBusy", { err: errorText(err) }) });
      else if (!isPermissionRefused(err)) this.patch({ error: t("voice.errCamera", { err: errorText(err) }) });
      this.patch({ cameraOn: room.localParticipant.isCameraEnabled });
    }
    this.refreshTiles();
    this.refreshParticipants();
  }

  /** Can this browser share a screen at all? Phones and tablets cannot (no getDisplayMedia); the stage then shows no button. */
  static supportsScreenShare(): boolean { return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function"; }

  /** Can this computer send H.265? Chromium offers it only with an encoder in the graphics unit (it ships no software one). */
  static supportsH265(): boolean { try { return supportsH265(); } catch { return false; } }

  /** Can this browser blur the background (WebGL2/WASM, MediaStreamTrackProcessor)? */
  static supportsBlur(): boolean { try { return supportsBackgroundProcessors(); } catch { return false; } }

  /** Set the background blur of the running camera (0 = off). Model and WASM come from the client's own origin on first use (blurAssets). */
  async setCameraBlur(radius: number): Promise<void> {
    this.camera.blur = radius;
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!(track instanceof LocalVideoTrack)) return;
    try {
      if (radius <= 0) {
        if (this.blur) { await track.stopProcessor(); this.blur = null; }
      } else if (this.blur) {
        await this.blur.switchTo({ mode: "background-blur", blurRadius: radius });
      } else {
        this.blur = BackgroundProcessor({ mode: "background-blur", blurRadius: radius, assetPaths: blurAssets() });
        await track.setProcessor(this.blur);
      }
      this.patch({ cameraBlur: radius, error: null });
      this.log(radius > 0 ? `hintergrund unscharf (${radius})` : "hintergrund normal");
    } catch (err) {
      this.blur = null;
      this.patch({ cameraBlur: 0, error: t("voice.errBlur", { err: errorText(err) }) });
    }
  }

  /** Opus settings from the channel profile: bitrate; mono with DTX (silence costs nothing) and RED (redundancy against loss). */
  private micPublishOptions(): TrackPublishOptions {
    const p = this.audioProfile;
    // The return type matters: livekit-client takes the bitrate as `audioPreset.maxBitrate`. An unknown key (it was
    // `audioBitrate` until 17 September 2026) is ignored silently and every channel ran at the SDK default of 48 kbit/s.
    return {
      source: Track.Source.Microphone,
      name: "microphone",
      audioPreset: { maxBitrate: p.bitrate * 1000 },
      dtx: !p.stereo,
      red: !p.stereo,
      forceStereo: p.stereo,
    };
  }

  /** The channel profile changed (admin): republish the microphone with the new Opus parameters. */
  async setAudioProfile(profile: AudioProfile): Promise<void> {
    const same = profile.bitrate === this.audioProfile.bitrate && profile.stereo === this.audioProfile.stereo;
    this.audioProfile = profile;
    this.patch({ audioProfile: profile });
    const room = this.room; const mic = this.mic; const pub = this.publication;
    if (same || !room || !mic || !pub || !this.micSettings) return;
    try {
      const wasMuted = this.state.micMuted;
      if (pub.track) await room.localParticipant.unpublishTrack(pub.track, false);
      const track = await mic.start(this.micSettings.inputDeviceId, this.capturesStereo(profile.stereo));
      this.publication = await room.localParticipant.publishTrack(track, this.micPublishOptions());
      if (wasMuted && this.publication.track instanceof LocalAudioTrack) await this.publication.track.mute();
      this.log(`opus umgestellt: ${profile.bitrate} kbit/s ${profile.stereo ? "stereo" : "mono"}`);
    } catch (err) {
      this.patch({ error: t("voice.errProfile", { err: errorText(err) }) });
    }
  }

  async setCameraDevice(deviceId: string | null): Promise<void> {
    this.camera.deviceId = deviceId;
    if (this.state.cameraOn && this.room) {
      await this.room.switchActiveDevice("videoinput", deviceId ?? "default").catch(() => {});
      if (this.cameraOpened) this.cameraOpened = { ...this.cameraOpened, deviceId: this.activeCameraId() ?? deviceId };
    }
  }

  /** The camera the published track really captures from, as the browser reports it (null = no track, or the browser does not say). */
  private activeCameraId(): string | null {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    return track instanceof LocalVideoTrack ? track.mediaStreamTrack.getSettings().deviceId || null : null;
  }

  /** Share the screen; audio is always requested and published as its own track (docs/features/voice-video.md, screen share audio matrix). Whether it arrives is up to the browser. */
  async setScreenShareEnabled(on: boolean): Promise<void> {
    if (on && (this.state.afkRoom || this.screenStarting)) return;
    const room = this.room;
    if (!room) return;
    try {
      // No simulcast for the screen: with small tiles adaptiveStream would fetch the coarse layer and only scale up
      // seconds after enlarging; text needs the full layer. contentHint "detail" keeps the
      // resolution and sacrifices frames per second instead when bandwidth is tight (a share of moving pictures turns both
      // around: screenShareOptions.ts).
      // The own tab can be shared too (selfBrowserSurface). restrictOwnAudio (Chromium 141+, ignored elsewhere) keeps this
      // tab's playback out of the captured audio, otherwise the others would hear their own voices back as screen audio.
      // Capture and publish are two steps (not LiveKit's setScreenShareEnabled(true)): the desktop app's picker also chooses
      // the codec, which is known only after the capture (`screenSharePublishOverrides`, asked in between).
      if (!on) await room.localParticipant.setScreenShareEnabled(false);
      else if (!room.localParticipant.isScreenShareEnabled) {
        this.screenStarting = true;
        let tracks: LocalTrack[] = [];
        try {
          tracks = await room.localParticipant.createScreenTracks({
            audio: { restrictOwnAudio: true } as AudioCaptureOptions,
            systemAudio: "include",
            selfBrowserSurface: "include",
            surfaceSwitching: "include",
            contentHint: "detail",
            resolution: ScreenSharePresets.h1080fps30.resolution,
          });
          const { options, contentHint } = screenSharePublish(this.media?.screenSharePublishOverrides());
          // Moving pictures (H.264/H.265, a game): the capture asked for "detail" before the codec was known.
          for (const track of tracks) if (track instanceof LocalVideoTrack && "contentHint" in track.mediaStreamTrack) track.mediaStreamTrack.contentHint = contentHint;
          if (this.room !== room) throw new DOMException("left the channel", "AbortError");
          await Promise.all(tracks.map((track) => room.localParticipant.publishTrack(track, options)));
          this.log(`bildschirm codec: ${options.videoCodec ?? "vp8"}`);
        } catch (err) {
          for (const track of tracks) track.stop();
          throw err;
        } finally { this.screenStarting = false; }
      }
      // Desktop app on Windows: the shell captured the audio itself (one window's, or the system's without the app); it becomes
      // the share's audio track. Stereo without DTX: it is programme material, not speech.
      const captured = on && room.localParticipant.isScreenShareEnabled ? await this.media?.takeScreenAudio() ?? null : null;
      if (captured && !room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)) {
        await room.localParticipant.publishTrack(captured, { source: Track.Source.ScreenShareAudio, dtx: false, red: false, forceStereo: true, audioPreset: { maxBitrate: 128_000 } });
      }
      if (!on) this.media?.stopScreenAudio();
      const hasAudio = on && !!room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
      this.patch({ screenOn: on && room.localParticipant.isScreenShareEnabled, screenAudio: on ? hasAudio : null, error: null });
      if (on) this.log(hasAudio ? "bildschirm mit ton" : "bildschirm ohne ton");
    } catch (err) {
      // Cancelling in the picker dialog is not an error.
      if (!isUserCancel(err)) this.patch({ error: t("voice.errScreen", { err: errorText(err) }) });
      this.patch({ screenOn: room.localParticipant.isScreenShareEnabled });
    }
    this.refreshTiles();
    this.refreshParticipants();
  }

  /** Volume of a participant's screen audio (0..1); adjustable separately from the microphone. */
  setScreenAudioVolume(identity: string, volume: number): void {
    this.setVideoAudioVolume(`${identity}:screen`, volume);
  }

  private videoAudioTrack(tileId: string): RemoteAudioTrack | undefined {
    for (const [track, { identity }] of this.remoteAudio) {
      const kind = track.source === Track.Source.ScreenShareAudio ? "screen" : "camera";
      // remoteAudio is populated only for audio tracks by attachRemote().
      if (`${identity}:${kind}` === tileId) return track as RemoteAudioTrack;
    }
    return undefined;
  }

  /**
   * Volume of the audio that belongs to a tile. Screen audio has its own volume (0..1); a camera tile's audio is the
   * person's microphone, so it is the per-person volume (0..2, stored) and the same value as in the context menus.
   */
  getVideoAudioVolume(tileId: string): number | null {
    const track = this.videoAudioTrack(tileId);
    if (!track) return null;
    return tileId.endsWith(":screen") ? this.shareVolumes.get(tileId.slice(0, -":screen".length)) ?? 1 : this.userVolumes[this.volumeKey(tileId.slice(0, -":camera".length))] ?? 1;
  }

  private readonly videoAudioPreviousVolume = new WeakMap<RemoteAudioTrack, number>();

  toggleVideoAudioMuted(tileId: string): void {
    const track = this.videoAudioTrack(tileId);
    const volume = this.getVideoAudioVolume(tileId);
    if (!track || volume === null) return;
    if (volume > 0) this.videoAudioPreviousVolume.set(track, volume);
    this.setVideoAudioVolume(tileId, volume > 0 ? 0 : this.videoAudioPreviousVolume.get(track) ?? 1);
  }

  setVideoAudioVolume(tileId: string, volume: number): void {
    if (!Number.isFinite(volume)) return;
    const track = this.videoAudioTrack(tileId);
    const before = this.getVideoAudioVolume(tileId);
    if (track && before !== null && before > 0) this.videoAudioPreviousVolume.set(track, before);
    if (!tileId.endsWith(":screen")) { this.setUserVolume(this.volumeKey(tileId.slice(0, -":camera".length)), volume); return; }
    this.shareVolumes.set(tileId.slice(0, -":screen".length), Math.max(0, Math.min(1, volume)));
    if (track) this.applyShareAudio(track);
    this.patch({});
  }

  // ---------- Playback volume per person (0..200 %)

  /** Members of the voice connection's server (identity -> public key); App.tsx keeps this current. */
  setPeerKeys(keys: Record<string, string>): void {
    this.peerKeys = keys;
    this.applyUserVolumes();
  }

  /** Participants who are no members (bots) have no public key; their identity stands in. */
  private volumeKey(identity: string): string {
    return this.peerKeys[identity] ?? `id:${identity}`;
  }

  getUserVolume(publicKey: string): number {
    return this.userVolumes[publicKey] ?? 1;
  }

  /** The blocked people (by public key) of the identity used on the server we sit on; their voice and screen sound stay silent for us. */
  setBlocked(publicKeys: Iterable<string>): void {
    const next = new Set(publicKeys);
    if (next.size === this.blocked.size && [...next].every((k) => this.blocked.has(k))) return;
    this.blocked = next;
    this.applyUserVolumes();
    this.applyAudioMuted();
  }
  isBlocked(publicKey: string): boolean {
    return this.blocked.has(publicKey);
  }

  /** Set and store how loud this person is played back here (0..2). Works without a connection too; it applies on the next join. */
  setUserVolume(publicKey: string, volume: number): void {
    this.userVolumes = withUserVolume(this.userVolumes, publicKey, volume);
    saveUserVolumes(this.userVolumes);
    this.applyUserVolumes();
    this.patch({});
  }

  private applyUserVolumes(): void {
    for (const [track, { identity }] of this.remoteAudio) this.applyUserVolume(track, identity);
  }

  /**
   * Up to 100 % the <audio> element's volume does it. An element cannot go above 1, so louder than that runs through a
   * GainNode on the meter's source into the shared AudioContext (which follows the voice output device where the browser
   * can do that) while the element stays attached but silent; Chromium only feeds a remote stream into Web Audio
   * while an element plays it. Without a running context the boost would be silence, so it falls back to 100 %.
   */
  private applyUserVolume(remote: RemoteTrack, identity: string): void {
    if (remote.source === Track.Source.ScreenShareAudio) return;
    const track = remote as RemoteAudioTrack; // remoteAudio only ever holds audio tracks (attachRemote)
    const volume = this.blocked.has(this.volumeKey(identity)) ? 0 : clampUserVolume(this.userVolumes[this.volumeKey(identity)]);
    const meter = this.meters.get(identity);
    const ctx = this.audioCtx;
    if (volume > 1 && meter && ctx?.state === "running") {
      if (!meter.boost) {
        meter.boost = ctx.createGain();
        meter.source.connect(meter.boost);
        meter.boost.connect(ctx.destination);
      }
      meter.boost.gain.value = this.state.deafened ? 0 : Math.min(USER_VOLUME_MAX, volume);
      track.setVolume(0);
      return;
    }
    track.setVolume(Math.min(1, volume));
    if (meter?.boost) { meter.source.disconnect(meter.boost); meter.boost.disconnect(); meter.boost = null; }
  }

  /** @param ended a track that is going away right now but is still referenced by its publication (see TrackUnsubscribed) */
  private refreshTiles(ended?: RemoteTrack) {
    const room = this.room;
    if (!room) return;
    const tiles: VideoTile[] = [];
    const all: LkParticipant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const p of all) {
      const isLocal = p === room.localParticipant;
      if (!isLocal && !this.mayViewVideo) continue; // without VIEW_VIDEO only your own feeds
      // A feed the user does not watch loses its tile at once, not only when LiveKit has ended the subscription.
      const watching = (source: VideoSource) => isLocal || this.videoWatch.watching(p.identity, source);
      const cam = p.getTrackPublication(Track.Source.Camera)?.track;
      if ((cam instanceof LocalVideoTrack || cam instanceof RemoteVideoTrack) && cam !== ended && !cam.isMuted && watching("camera")) {
        tiles.push({ id: `${p.identity}:camera`, identity: p.identity, name: p.name || p.identity, isLocal, source: "camera", track: cam, audio: null, hasAudio: false });
      }
      const scr = p.getTrackPublication(Track.Source.ScreenShare)?.track;
      if ((scr instanceof LocalVideoTrack || scr instanceof RemoteVideoTrack) && scr !== ended && watching("screen")) {
        const audioPub = p.getTrackPublication(Track.Source.ScreenShareAudio);
        const audio = audioPub?.track instanceof RemoteAudioTrack ? audioPub.track : null;
        tiles.push({ id: `${p.identity}:screen`, identity: p.identity, name: p.name || p.identity, isLocal, source: "screen", track: scr, audio, hasAudio: !!audioPub });
      }
    }
    this.patch({ tiles });
  }

  /** Lift the browser's autoplay block; must be called from within a user action. */
  async startAudio(): Promise<void> {
    // room.startAudio() unmutes every element synchronously before its first await; put deafen and "not listening" back at once.
    const started = this.room?.startAudio();
    this.applyAudioMuted();
    await started;
    const playback = await Promise.allSettled([...this.remoteAudio.values()].map(({ element }) => element.play()));
    this.patch({ canPlayback: (this.room?.canPlaybackAudio ?? true) && playback.every((result) => result.status === "fulfilled") });
  }

  /**
   * Microphone mute/unmute by hand. While deafened, a click on the microphone lifts both (as in Discord),
   * because an active microphone with the audio turned off makes no sense.
   */
  async setMuted(muted: boolean): Promise<void> {
    if (this.state.afkRoom) return; // the AFK channel keeps microphone and audio off
    if (!muted && this.state.deafened) { this.micMutedByUser = false; await this.setDeafened(false); return; }
    this.micMutedByUser = muted;
    await this.applyMic();
  }

  /**
   * Deafen on/off: incoming audio muted, microphone forcibly muted. When turning the audio back on,
   * the microphone stays muted only if it had been muted by hand before.
   */
  async setDeafened(on: boolean): Promise<void> {
    if (this.state.afkRoom) return;
    this.patch({ deafened: on });
    this.applyAudioMuted();
    this.applyUserVolumes(); // the boosted path (above 100 %) bypasses the elements and is silenced there
    await this.applyMic();
    await this.room?.localParticipant.setAttributes({ deafened: on ? "1" : "" }).catch(() => {});
    this.log(on ? "ton aus (mikrofon mit stumm)" : `ton an (mikrofon ${this.micMutedByUser ? "bleibt stumm" : "wieder an"})`);
    this.refreshParticipants();
  }

  /**
   * Microphone test (Einstellungen): plays your own microphone back to you, behind the boost and whatever the gate does.
   * In a channel it listens to the running capture and mutes the published track for as long as it runs (user's
   * requirement: nothing of the test reaches the channel; the others see the microphone as muted). In no channel it opens
   * a capture of its own. Call inside the click (AudioContext). Throws when the microphone cannot be opened.
   */
  async startMicTest(settings: VoiceSettings): Promise<void> {
    if (this.micTestWanted) return;
    this.micTestWanted = true;
    const ctx = this.ensureCtx();
    if (contextNeedsResume(ctx.state)) void ctx.resume().catch(() => {});
    let own: MicPipeline | null = null;
    try {
      if (!this.mic) {
        own = new MicPipeline(settings.vadThreshold, settings.vadHangoverMs, ctx, boostLimits(this.media?.mobile ?? false));
        own.onState = (s) => this.patch({ level: s.level, micBoost: s.boost, micInput: s.input });
        own.setBoost(settings.micBoost);
        this.testMic = own;
        await own.start(settings.inputDeviceId);
      }
      // Ended while the browser asked for the microphone: the capture that opened after all is closed again.
      if (!this.micTestWanted) { await own?.stop(); this.patch({ level: 0, micBoost: 1, micInput: 0 }); return; }
      // Mute first, listen second: not a word of the test goes out.
      this.patch({ micTest: true });
      if (!this.state.afkRoom) await this.applyMic();
      const stream = (this.mic ?? this.testMic)?.setMonitor(true) ?? null;
      if (!stream) throw new Error("kein Mikrofon");
      const el = document.createElement("audio");
      el.srcObject = stream;
      this.testAudio = el;
      await this.setMicTestOutput(settings.outputDeviceId);
      await el.play();
      this.log("mikrofontest an");
    } catch (err) {
      await this.endMicTest();
      throw new Error(t("voice.errMic", { err: errorText(err) }));
    }
  }

  async stopMicTest(): Promise<void> {
    if (!this.micTestWanted) return;
    await this.endMicTest();
    this.log("mikrofontest aus");
  }

  private async endMicTest(): Promise<void> {
    this.micTestWanted = false;
    if (this.testAudio) { this.testAudio.pause(); this.testAudio.srcObject = null; this.testAudio = null; }
    this.mic?.setMonitor(false);
    const own = this.testMic;
    this.testMic = null;
    await own?.stop();
    const was = this.state.micTest;
    this.patch({ micTest: false, ...(own ? { level: 0, micBoost: 1, micInput: 0 } : {}) });
    if (was && !this.state.afkRoom) await this.applyMic();
  }

  /** Where the microphone test plays (the voice output device; Chromium only, elsewhere the default device). */
  async setMicTestOutput(deviceId: string | null): Promise<void> {
    const el = this.testAudio as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    await el?.setSinkId?.(deviceId ?? "").catch(() => {});
  }

  private async applyMic(): Promise<void> {
    const muted = this.micMutedByUser || this.state.deafened || this.state.micTest;
    const track = this.publication?.track;
    if (track instanceof LocalAudioTrack) {
      if (muted) await track.mute(); else await track.unmute();
    }
    this.patch({ micMuted: muted });
    this.refreshParticipants();
  }

  setMode(mode: GateMode) { this.mic?.setMode(mode); }
  setThreshold(t: number) { this.mic?.setThreshold(t); }
  setHangover(ms: number) { this.mic?.setHangover(ms); }
  setMicBoost(b: MicBoostSettings) { this.mic?.setBoost(b); this.testMic?.setBoost(b); }
  setPttHeld(held: boolean) { this.mic?.setPttHeld(held); }

  async setInputDevice(deviceId: string | null): Promise<void> {
    if (this.testMic) {
      // Microphone test in no channel: test the newly chosen microphone (the monitor output survives the restart).
      try { await this.testMic.start(deviceId); this.patch({ error: null }); } catch (err) { this.patch({ error: t("voice.errMic", { err: errorText(err) }) }); }
      return;
    }
    if (!this.mic || !this.publication) return;
    try {
      const track = await this.mic.start(deviceId, this.capturesStereo(this.audioProfile.stereo));
      if (this.mic.deviceFallback) this.log("gewaehltes mikrofon nicht gefunden, nutze das standardmikrofon");
      const local = this.publication.track;
      if (local instanceof LocalAudioTrack) await local.replaceTrack(track, true);
      this.patch({ inputDeviceId: this.mic.activeDeviceId(), error: null });
    } catch (err) {
      this.patch({ error: t("voice.errMic", { err: errorText(err) }) });
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    applyCueOutput(this.ensureCtx(), deviceId || null);
    // Every element, the shares' too: in Chromium they all share ONE output sink anyway (applyShareAudio); a share's separate
    // device is not an element's sink but its own context.
    await this.room?.switchActiveDevice("audiooutput", deviceId);
    this.applyShareAudio();
  }

  /** Route screen audio to a separate output device (e.g. speakers instead of a headset). Chromium only; no effect elsewhere. */
  async setScreenOutputDevice(deviceId: string | null): Promise<void> {
    this.screenSinkId = deviceId;
    await this.applyScreenCtxSink();
  }

  /**
   * Where a received share's audio plays (user's report, 26 September 2026: with a separate device for screen audio every
   * voice moved to that device too). Chromium plays ALL remote WebRTC tracks of a page through one shared renderer with ONE
   * output device (`WebRtcAudioRenderer`: `setSinkId` on any of their elements replaces that one sink, the last call wins),
   * so a share on another device cannot go through its element. It runs through `screenCtx` instead, which has a sink of
   * its own: the track's source into a gain (the share's volume; 0 for deafen and "not listening", `audioMuted()`) into the
   * context's destination, while LiveKit's element keeps playing at volume 0, because Chromium feeds a remote track into
   * Web Audio only while an element plays it (the frame reaches Web Audio before the element's volume is applied, so 0 is
   * enough; the >100 % boost in applyUserVolume() rests on the same rule). Without a separate device, while the context does
   * not run (no gesture yet), or where the browser refused the device, the element plays as before, on the voice device.
   * Never call `setSinkId` on a remote track or its element with anything but the voice device.
   */
  private applyShareAudio(only?: RemoteTrack): void {
    const ctx = this.screenCtx;
    const separate = this.screenSinkId !== null && !!ctx && ctx.state === "running" && this.screenSinkReady;
    let tracks = 0;
    for (const [remote, { identity }] of this.remoteAudio) {
      if (remote.source !== Track.Source.ScreenShareAudio) continue;
      tracks++;
      if (only && remote !== only) continue;
      const track = remote as RemoteAudioTrack; // remoteAudio only ever holds audio tracks (attachRemote)
      const volume = this.shareVolumes.get(identity) ?? 1;
      if (separate && ctx) {
        let route = this.shareRoutes.get(remote);
        if (!route) {
          try {
            const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
            const gain = ctx.createGain();
            source.connect(gain);
            gain.connect(ctx.destination);
            route = { source, gain };
            this.shareRoutes.set(remote, route);
          } catch (err) {
            this.log(`bildschirm-ton von ${identity.slice(0, 8)} nicht ueber den eigenen kontext: ${errorText(err)}`);
          }
        }
        if (route) {
          route.gain.gain.value = this.audioMuted(remote, identity) ? 0 : volume;
          track.setVolume(0);
          continue;
        }
      }
      this.dropShareRoute(remote);
      track.setVolume(volume);
    }
    const next = { deviceId: this.screenSinkId, tracks, error: this.screenSinkError, via: separate ? "webaudio" as const : "element" as const };
    const prev = this.state.screenSink;
    if (prev.deviceId === next.deviceId && prev.tracks === next.tracks && prev.error === next.error && prev.via === next.via) return;
    this.patch({ screenSink: next });
    if (tracks || next.error) this.log(`bildschirm-ton -> ${next.deviceId ? `geraet ${next.deviceId.slice(0, 8)} (${next.via === "webaudio" ? "eigener kontext" : "element, kontext nicht bereit"})` : "wie sprache"} (${tracks} spuren${next.error ? `, fehler: ${next.error}` : ""})`);
  }

  private dropShareRoute(track: RemoteTrack): void {
    const route = this.shareRoutes.get(track);
    if (!route) return;
    try { route.source.disconnect(); route.gain.disconnect(); } catch { /* already gone */ }
    this.shareRoutes.delete(track);
  }

  setNotice(text: string | null) { this.patch({ notice: text }); if (text) this.log(`hinweis: ${text}`); }
  /** The error was shown (the modal in App.tsx closed): gone, so the same text can come again. */
  clearError() { this.patch({ error: null }); }

  /** requestCamera = true asks for camera permission once so the device names are readable (for the picker at switch-on time). */
  static async listDevices(requestCamera = false): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
    const [inputs, outputs, cameras] = await Promise.all([
      Room.getLocalDevices("audioinput", false),
      Room.getLocalDevices("audiooutput", false),
      Room.getLocalDevices("videoinput", requestCamera),
    ]);
    return { inputs, outputs, cameras };
  }

  async stats(): Promise<AudioStats> {
    const room = this.room;
    if (!room) return { path: { publisher: null, subscriber: null }, sender: null, receivers: [], videoSend: [], videoRecv: [] };
    const pm = room.engine.pcManager;
    const path: IcePath = {
      publisher: pm ? await icePathOf(pm.publisher.getStats()) : null,
      subscriber: pm?.subscriber ? await icePathOf(pm.subscriber.getStats()) : null,
    };
    const local = this.publication?.track;
    const sender = local instanceof LocalAudioTrack ? (await local.getSenderStats()) ?? null : null;
    const receivers: AudioStats["receivers"] = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) {
        const t = pub.track;
        if (t instanceof RemoteAudioTrack) {
          const s = await t.getReceiverStats();
          receivers.push({ identity: p.identity, packetsReceived: s?.packetsReceived, packetsLost: s?.packetsLost, jitter: s?.jitter, bytesReceived: s?.bytesReceived });
        }
      }
    }
    const videoSend: VideoSendStat[] = [];
    for (const pub of room.localParticipant.videoTrackPublications.values()) {
      const t = pub.track;
      if (!(t instanceof LocalVideoTrack)) continue;
      const source = pub.source === Track.Source.ScreenShare ? "screen" : "camera";
      // The raw reports of every sender (LiveKit's getSenderStats() knows neither the codec nor the backup codec's sender).
      const senders = [t.sender, ...[...t.simulcastCodecs.values()].map((c) => c.sender)].filter((s): s is RTCRtpSender => !!s);
      for (const sender of new Set(senders)) {
        const report = await sender.getStats().catch(() => null);
        report?.forEach((s) => {
          if (s.type !== "outbound-rtp" || s.kind !== "video") return;
          const codec = String(report.get(s.codecId)?.mimeType ?? "?").replace(/^video\//i, "");
          videoSend.push({ source, rid: s.rid || "-", codec, encoder: s.encoderImplementation, width: s.frameWidth ?? 0, height: s.frameHeight ?? 0, fps: s.framesPerSecond ?? 0, bytesSent: s.bytesSent ?? 0, limitation: s.qualityLimitationReason });
        });
      }
    }
    const videoRecv: VideoRecvStat[] = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.videoTrackPublications.values()) {
        const t = pub.track;
        if (!(t instanceof RemoteVideoTrack)) continue;
        const s = await t.getReceiverStats().catch(() => undefined);
        if (s) videoRecv.push({ identity: p.identity, source: pub.source === Track.Source.ScreenShare ? "screen" : "camera", width: s.frameWidth, height: s.frameHeight, framesDecoded: s.framesDecoded, bytesReceived: s.bytesReceived ?? 0, packetsLost: s.packetsLost });
      }
    }
    return { path, sender, receivers, videoSend, videoRecv };
  }

  /**
   * One raw reading of a received video (the viewer's statistics, `videoStats.ts`, shown by VideoStatsOverlay.tsx): the
   * receiver's own report, which has what LiveKit's `getReceiverStats()` leaves out. Null = no such track is received.
   */
  async videoReceiveSample(tileId: string): Promise<InboundVideoSample | null> {
    const track = this.state.tiles.find((tile) => tile.id === tileId)?.track;
    if (!(track instanceof RemoteVideoTrack) || !track.receiver) return null;
    const report = await track.receiver.getStats().catch(() => null);
    return report ? readInboundVideo(report, performance.now()) : null;
  }

  // ---------- A share's audio plays only for who chose to watch that share (user's requirement, 18 September 2026)
  /**
   * Nobody in the channel is made to hear a screen share's audio: it plays only while the user has that share selected in
   * the stage or popped out (`reason` = who asks: "stage", "popout"; several may hold it). While nobody listens the track
   * is also disabled at LiveKit, so it costs no bandwidth.
   */
  setScreenAudioListening(tileId: string, reason: string, on: boolean): void {
    const reasons = this.screenListening.get(tileId) ?? new Set<string>();
    if (on === reasons.has(reason)) return;
    if (on) reasons.add(reason); else reasons.delete(reason);
    if (reasons.size) this.screenListening.set(tileId, reasons); else this.screenListening.delete(tileId);
    this.applyScreenListening(tileId.slice(0, -":screen".length));
    this.patch({});
  }
  isScreenAudioListening(tileId: string): boolean { return this.screenListening.has(tileId); }
  private audioMuted(track: RemoteTrack, identity: string): boolean {
    return this.state.deafened || this.blocked.has(this.volumeKey(identity)) || (track.source === Track.Source.ScreenShareAudio && !this.screenListening.has(`${identity}:screen`));
  }
  private applyAudioMuted(): void {
    for (const [track, { element, identity }] of this.remoteAudio) element.muted = this.audioMuted(track, identity);
    this.applyShareAudio(); // a share on the separate device is silenced in its gain, not in its element
  }
  private applyScreenListening(identity: string): void {
    this.applyAudioMuted();
    const pub = this.room?.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.ScreenShareAudio);
    pub?.setEnabled(this.screenListening.has(`${identity}:screen`));
  }

  /** Move the existing audio element, preserving LiveKit volume/sink management and avoiding duplicate playback. */
  setVideoAudioHost(tileId: string, host: HTMLElement): () => void {
    this.videoAudioHosts.set(tileId, host);
    this.routeVideoAudio();
    return () => {
      if (this.videoAudioHosts.get(tileId) !== host) return;
      this.videoAudioHosts.delete(tileId);
      this.routeVideoAudio();
    };
  }

  private routeVideoAudio(): void {
    for (const [track, { element, identity }] of this.remoteAudio) {
      const kind = track.source === Track.Source.ScreenShareAudio ? "screen" : "camera";
      const host = this.videoAudioHosts.get(identity + ":" + kind) ?? this.audioHost;
      if (element.parentElement === host) continue;
      host.appendChild(element);
      element.muted = this.audioMuted(track, identity);
      void element.play().catch(() => this.patch({ canPlayback: false }));
    }
  }

  private attachRemote(track: RemoteTrack, identity: string) {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.muted = this.audioMuted(track, identity); // deafening and "not listening to this share" also apply to tracks that arrive later
    this.remoteAudio.set(track, { element: el, identity });
    if (track.source === Track.Source.ScreenShareAudio) this.applyScreenListening(identity);
    this.routeVideoAudio();
    if (track.source === Track.Source.ScreenShareAudio) this.applyShareAudio(track);
    if (track.source === Track.Source.Microphone) this.addMeter(identity, track.mediaStreamTrack);
    this.applyUserVolume(track, identity); // after the meter: volumes above 100 % use its source
    this.patch({ canPlayback: this.room?.canPlaybackAudio ?? true });
  }

  // ---- Local speaker detection: RMS per remote microphone track every 50 ms, gate with hangover (like our own VAD).
  // LiveKit's ActiveSpeakersChanged arrives smoothed from the server (~0.5-1 s later) and now only serves as a fallback.
  private addMeter(identity: string, mst: MediaStreamTrack) {
    this.dropMeter(identity);
    try {
      const ctx = this.ensureCtx();
      const source = ctx.createMediaStreamSource(new MediaStream([mst]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // not to destination: playback keeps running through the <audio> element
      this.meters.set(identity, { source, analyser, gate: new VoiceGate(REMOTE_SPEAK_THRESHOLD, REMOTE_SPEAK_HANGOVER_MS), samples: new Float32Array(analyser.fftSize), boost: null });
    } catch (err) {
      this.log(`pegelmesser fuer ${identity.slice(0, 8)} nicht moeglich: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  private dropMeter(identity: string) {
    const m = this.meters.get(identity);
    if (!m) return;
    m.source.disconnect(); m.analyser.disconnect(); m.boost?.disconnect();
    this.meters.delete(identity);
  }
  /** Cue for another participant, unless we have only just connected (then they were already there). */
  private peerCue(cue: "peerJoin" | "peerLeave"): void {
    if (this.peerCuesFrom === 0 || Date.now() < this.peerCuesFrom) return;
    this.playSound(cue);
  }

  private startMeters() {
    this.stopMeters();
    this.meterTimer = window.setInterval(() => {
      if (this.audioCtx?.state !== "running") return; // without a running context LiveKit's report applies (see refreshParticipants)
      const now = performance.now();
      let changed = false;
      for (const m of this.meters.values()) {
        m.analyser.getFloatTimeDomainData(m.samples);
        const before = m.gate.isOpen();
        if (m.gate.update(rmsLevel(m.samples), now) !== before) changed = true;
      }
      if (changed) this.refreshParticipants();
    }, 50);
  }
  private stopMeters() {
    if (this.meterTimer !== null) { clearInterval(this.meterTimer); this.meterTimer = null; }
    for (const id of [...this.meters.keys()]) this.dropMeter(id);
  }

  private refreshParticipants() {
    const room = this.room;
    if (!room) return;
    const all: LkParticipant[] = [room.localParticipant, ...room.remoteParticipants.values()];
    const participants = all.map((p) => ({
      identity: p.identity,
      name: p.name || p.identity,
      isLocal: p === room.localParticipant,
      speaking: p === room.localParticipant
        ? this.state.gateOpen && !this.state.micMuted
        : (this.audioCtx?.state === "running" && this.meters.get(p.identity)?.gate.isOpen()) ?? p.isSpeaking,
      micMuted: p === room.localParticipant ? this.state.micMuted : !p.isMicrophoneEnabled,
      deafened: p === room.localParticipant ? this.state.deafened : p.attributes?.deafened === "1",
      cameraOn: p.isCameraEnabled,
      screenOn: p.isScreenShareEnabled,
      quality: String(p.connectionQuality),
      watching: p === room.localParticipant ? this.watchedScreens() : parseWatchingAttribute(p.attributes?.watching),
    }));
    this.patch({ participants });
    this.publishWatching();
  }
}

/** Read the active candidate path from the WebRTC statistics: protocol and candidate types (host/srflx/prflx/relay). */
async function icePathOf(statsPromise: Promise<RTCStatsReport> | undefined): Promise<string | null> {
  const stats = await statsPromise?.catch(() => undefined);
  if (!stats) return null;
  type Pair = { type: string; state?: string; nominated?: boolean; selected?: boolean; localCandidateId?: string; remoteCandidateId?: string };
  type Cand = { type: string; candidateType?: string; protocol?: string; relayProtocol?: string };
  let pair: Pair | undefined;
  stats.forEach((s: Pair) => {
    if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) pair ??= s;
  });
  if (!pair) return null;
  const local = pair.localCandidateId ? (stats.get(pair.localCandidateId) as Cand | undefined) : undefined;
  const remote = pair.remoteCandidateId ? (stats.get(pair.remoteCandidateId) as Cand | undefined) : undefined;
  if (!local) return null;
  if (local.candidateType === "relay") return `relay (TURN via ${local.relayProtocol ?? local.protocol ?? "?"})`;
  return `${local.protocol ?? "?"} ${local.candidateType ?? "?"}->${remote?.candidateType ?? "?"}`;
}

/** Explain LiveKit's disconnect reason; unexpected = show it to the user as an error. */
function explainDisconnect(reason: DisconnectReason | undefined): { short: string; long: string; unexpected: boolean; removed?: boolean } {
  const name = reason === undefined ? t("voice.disc.unknown") : DisconnectReason[reason] ?? String(reason);
  const media = t("voice.iceHint");
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: return { short: name, long: "", unexpected: false };
    // The server took us out of the room (a moderator's removal or block, a vote kick): no error. The chat server's
    // `voice.moved` carries the reason and how long a block lasts; the plain sentence only stands when it never comes.
    case DisconnectReason.PARTICIPANT_REMOVED: return { short: name, long: "", unexpected: false, removed: true };
    case DisconnectReason.DUPLICATE_IDENTITY: return { short: name, long: t("voice.disc.duplicate"), unexpected: true };
    case DisconnectReason.SIGNAL_CLOSE: return { short: name, long: t("voice.disc.signalClose"), unexpected: true };
    case DisconnectReason.CONNECTION_TIMEOUT:
    case DisconnectReason.JOIN_FAILURE:
    case DisconnectReason.STATE_MISMATCH:
    case DisconnectReason.UNKNOWN_REASON:
    case undefined:
      return { short: name, long: t("voice.disc.generic", { name, media }), unexpected: true };
    default:
      return { short: name, long: t("voice.disc.server", { name }), unexpected: true };
  }
}

/** Turn a connection error into a sentence with the cause and the next step. */
function explainConnectError(message: string, url: string, pageIsHttps: boolean): string {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (host === "localhost" || host === "127.0.0.1") return t("voice.connErrLocalhost", { message, url });
  if (pageIsHttps && url.startsWith("ws://")) return t("voice.connErrWs", { message, url });
  return t("voice.connErrGeneric", { message, url, check: url.replace(/^ws/, "http") });
}

/** Message of an error; media errors without one (Chromium's OverconstrainedError) give their name instead of "[object …]". */
const errorText = (err: unknown) => {
  if (typeof err !== "object" || err === null) return String(err);
  const { message, name } = err as { message?: unknown; name?: unknown };
  return typeof message === "string" && message ? message : typeof name === "string" && name ? name : String(err);
};
/** The user cancelled the browser's screen picker (or refused the permission). */
const isUserCancel = (err: unknown) => err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
const isPermissionRefused = (err: unknown) => err instanceof DOMException && err.name === "NotAllowedError";

function mapState(s: ConnectionState): VoiceStatus {
  switch (s) {
    case ConnectionState.Connected: return "connected";
    case ConnectionState.Connecting: return "connecting";
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting: return "reconnecting";
    default: return "disconnected";
  }
}
