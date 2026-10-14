import { VoiceGate, contextNeedsResume, rmsLevel } from "./gate";
import { OneSidedDetector, type SideVerdict } from "./oneSided";
import { AutoGain, DEFAULT_MIC_BOOST, DESKTOP_BOOST_LIMITS, MOBILE_BOOST_LIMITS, SOFT_CLIP_RANGE, clampBoost, clampManualGain, softClipCurve, type MicBoostLimits, type MicBoostSettings } from "./micBoost";

/**
 * Microphone pipeline: getUserMedia -> AudioContext -> [stereo only: one-sided input onto both channels, oneSided.ts] -> boost (gain + clipping guard, micBoost.ts) -> [analyser for the level]
 * + [gain as the gate] -> output track. Level meter, voice activation and the published track all sit behind the boost, so
 * the threshold means what the others hear. Stereo channels run without the browser's processing but WITH the boost (see start()).
 *
 * The gate (voice activation or push-to-talk) works locally through the gain; the published track stays
 * published and "unmuted" throughout. That way there is no signalling on every word and
 * switching back on is instant (apps/web/src/voice/AGENTS.md, speech gate). The mute button is separate from this (LiveKit mute).
 */
export type GateMode = "vad" | "ptt";

/** The chosen device does not exist (any more): unplugged, or the browser handed out new device ids. */
const isDeviceGone = (err: unknown) => {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === "OverconstrainedError" || name === "NotFoundError";
};

/**
 * Opens the microphone. The stored device is requested with `exact` so the browser does not quietly pick another one
 * while it exists; when it is gone, the default microphone takes over (`fellBack`) instead of the join failing
 * with "Constraints could not be satisfied". The stored choice stays, so the device is used again once it is back.
 */
export type OpenedMic = { stream: MediaStream; fellBack: boolean };
export async function openMic(
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>, deviceId: string | null, stereo: boolean,
): Promise<OpenedMic> {
  const audio = (id: string | null): MediaTrackConstraints => ({
    ...(id ? { deviceId: { exact: id } } : {}),
    // Use the browser's own processing (browser-native echo/noise suppression, the answer to the risk "audio quality" in docs/PLAN.md).
    // Stereo (music channels): processing off, because echo/noise suppression downmixes to mono.
    echoCancellation: !stereo,
    noiseSuppression: !stereo,
    autoGainControl: !stereo,
    channelCount: stereo ? 2 : 1,
  });
  try {
    return { stream: await getUserMedia({ audio: audio(deviceId) }), fellBack: false };
  } catch (err) {
    if (!deviceId || !isDeviceGone(err)) throw err;
    return { stream: await getUserMedia({ audio: audio(null) }), fellBack: true };
  }
}

/** The automatic boost's last gain per microphone, so a quiet microphone is not quiet again for the first seconds of every join. */
const BOOST_KEY = "chat.micBoost.v1";
function rememberedBoost(key: string): number {
  try { return clampBoost((JSON.parse(localStorage.getItem(BOOST_KEY) ?? "{}") as Record<string, unknown>)[key], MOBILE_BOOST_LIMITS.max); } catch { return 1; }
}
function rememberBoost(key: string, gain: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(BOOST_KEY) ?? "{}") as Record<string, number>;
    localStorage.setItem(BOOST_KEY, JSON.stringify({ ...all, [key]: Math.round(gain * 100) / 100 }));
  } catch { /* private mode or similar: then it learns again next time */ }
}

export class MicPipeline {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /**
   * Stereo capture only: what feeds the boost and the raw level. Normally the source itself; when only one channel carries
   * a signal (an iPhone's mono microphone in a two-channel stream, oneSided.ts), that channel on both sides.
   */
  private bus: GainNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private merger: ChannelMergerNode | null = null;
  private sideLeft: AnalyserNode | null = null;
  private sideRight: AnalyserNode | null = null;
  private sides: OneSidedDetector | null = null;
  private routed: SideVerdict = "stereo";
  private sideSamples = new Float32Array(1024);
  /** Which channel of a stereo capture carries the signal ("stereo" = both, or a mono channel); for the debug view. */
  inputSide: SideVerdict = "stereo";
  /** Level of the raw input, for the automatic boost (the `analyser` below sits behind the boost). */
  private inputAnalyser: AnalyserNode | null = null;
  private pre: GainNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private boost: MicBoostSettings = { ...DEFAULT_MIC_BOOST };
  private autoGain: AutoGain | null = null;
  private rememberedGain = 1;
  /** Under which name the learned gain is remembered: the microphone, plus "|stereo" for the capture without processing. */
  private boostKey = "default";
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  /** Second output for listening to yourself (microphone test): behind the boost, before the gate. Survives a restart of the capture. */
  private monitor: MediaStreamAudioDestinationNode | null = null;
  private samples = new Float32Array(1024);
  private timer: number | null = null;
  private gate: VoiceGate;
  private mode: GateMode = "vad";
  private pttHeld = false;
  private forcedOpen = false;
  /** Current level (0..1, behind the boost), the raw level in front of it, whether the gate is open, and the boost applied right now (1 = none); for the display. */
  readonly state = { level: 0, input: 0, open: false, boost: 1 };
  onState: ((s: { level: number; input: number; open: boolean; boost: number; side: SideVerdict }) => void) | null = null;
  /** The last start() used the default microphone because the chosen device was gone. */
  deviceFallback = false;

  private ownsCtx: boolean;

  /**
   * @param ctx shared AudioContext (created by the VoiceClient inside a user gesture); without it the pipeline creates its own.
   * @param limits how far the boost may go on this device (a phone needs more, micBoost.ts)
   */
  constructor(threshold: number, hangoverMs: number, ctx?: AudioContext, private readonly limits: MicBoostLimits = DESKTOP_BOOST_LIMITS) {
    this.gate = new VoiceGate(threshold, hangoverMs);
    this.ctx = ctx ?? null;
    this.ownsCtx = !ctx;
  }

  /** State of the AudioContext ("running" is required, otherwise the microphone stays silent). */
  contextState(): string { return this.ctx?.state ?? "none"; }

  /**
   * Starts the capture. Returns the track that is published to LiveKit.
   * @param preopened a microphone already asked for inside the user's gesture (`VoiceClient.prepareMic()`), opened with the same device and mode
   */
  async start(deviceId: string | null, stereo = false, preopened?: Promise<OpenedMic>): Promise<MediaStreamTrack> {
    await this.stopCapture();
    const opened = await (preopened ?? openMic((c) => navigator.mediaDevices.getUserMedia(c), deviceId, stereo));
    this.stream = opened.stream;
    this.deviceFallback = opened.fellBack;
    if (!this.ctx || this.ctx.state === "closed") { this.ctx = new AudioContext(); this.ownsCtx = true; }
    // resume() hangs forever in some browsers without a user gesture; do not wait for it, the click fallback in the
    // VoiceClient catches up on it. Until then the pipeline delivers silence (level 0).
    // Not only "suspended": iOS leaves the context "interrupted" after its microphone prompt and the start of the capture (gate.ts).
    // The capture is open at this point, and WebKit lets a capturing page start audio without another gesture.
    if (contextNeedsResume(this.ctx.state)) await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.dest = this.ctx.createMediaStreamDestination();
    this.dest.channelCount = stereo ? 2 : 1;
    this.dest.channelCountMode = "explicit";
    // The boost runs in stereo channels too, and matters most there: they capture without the browser's processing, so
    // without its gain control, and a microphone arrives at its raw level (user's report, 18 September 2026: level bar
    // low, threshold at the far left, everyone quiet, in a stereo channel). Gain and clipping guard keep both channels
    // as they are; the raw level differs a lot between the two capture modes, so the learned gain is kept per mode.
    this.inputAnalyser = this.ctx.createAnalyser();
    this.inputAnalyser.fftSize = 1024;
    this.pre = this.ctx.createGain();
    this.shaper = this.ctx.createWaveShaper();
    this.shaper.curve = softClipCurve();
    // Stereo: the raw level and the boost hang on a bus, so a one-sided input can be re-routed onto both channels while it
    // runs (tick()). Mono channels need none of it: one channel is spread to both sides by Web Audio itself.
    let input: AudioNode = this.source;
    if (stereo) {
      this.bus = this.ctx.createGain();
      this.bus.channelCount = 2;
      this.bus.channelCountMode = "explicit";
      this.splitter = this.ctx.createChannelSplitter(2);
      this.merger = this.ctx.createChannelMerger(2);
      this.sideLeft = this.ctx.createAnalyser();
      this.sideRight = this.ctx.createAnalyser();
      this.sideLeft.fftSize = this.sideRight.fftSize = 1024;
      this.source.connect(this.splitter);
      this.splitter.connect(this.sideLeft, 0);
      this.splitter.connect(this.sideRight, 1);
      this.merger.connect(this.bus);
      this.source.connect(this.bus);
      this.sides = new OneSidedDetector();
      input = this.bus;
    }
    this.routed = this.inputSide = "stereo";
    input.connect(this.inputAnalyser);
    input.connect(this.pre);
    this.pre.connect(this.shaper);
    this.shaper.connect(this.analyser);
    this.shaper.connect(this.gain);
    this.boostKey = `${this.activeDeviceId() ?? "default"}${stereo ? "|stereo" : ""}`;
    this.rememberedGain = rememberedBoost(this.boostKey);
    this.autoGain = new AutoGain(this.rememberedGain, this.limits);
    this.applyBoost(true);
    this.gain.connect(this.dest);
    if (this.monitor && this.monitor.context !== this.ctx) this.monitor = null;
    if (this.monitor) this.shaper.connect(this.monitor);

    this.gate.reset();
    this.timer = window.setInterval(() => this.tick(), 50);
    const track = this.dest.stream.getAudioTracks()[0];
    if (!track) throw new Error("kein Ausgangs-Track");
    return track;
  }

  /** Current capture device (deviceId), as the browser actually picked it. */
  activeDeviceId(): string | null {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId ?? null;
  }

  setMode(mode: GateMode) { this.mode = mode; this.gate.reset(); this.pttHeld = false; this.apply(); }
  setThreshold(t: number) { this.gate.threshold = t; }
  setHangover(ms: number) { this.gate.hangoverMs = ms; }
  setPttHeld(held: boolean) { this.pttHeld = held; this.apply(); }
  /** Keep the gate permanently open (e.g. a microphone test). */
  setForcedOpen(v: boolean) { this.forcedOpen = v; this.apply(); }

  /**
   * Microphone test: a stream of what the microphone delivers behind the boost, whatever the gate does; the published track
   * is not touched (the VoiceClient mutes it meanwhile). null = the capture is not running. `false` ends it.
   */
  setMonitor(on: boolean): MediaStream | null {
    if (!on) {
      if (this.monitor) { try { this.shaper?.disconnect(this.monitor); } catch { /* was not connected */ } }
      this.monitor = null;
      return null;
    }
    if (!this.ctx || !this.shaper) return null;
    if (!this.monitor) { this.monitor = this.ctx.createMediaStreamDestination(); this.shaper.connect(this.monitor); }
    return this.monitor.stream;
  }

  /** Boost settings (Einstellungen > Sprache und Audio); takes effect at once. */
  setBoost(b: MicBoostSettings) { this.boost = { auto: b.auto, gain: clampManualGain(b.gain) }; this.applyBoost(true); }

  /** Sets the boost's gain: learned (automatic) or by hand. The node gets gain / SOFT_CLIP_RANGE, see micBoost.ts. */
  private applyBoost(immediately = false) {
    if (!this.pre || !this.ctx) return;
    const g = this.boost.auto ? this.autoGain?.gain ?? 1 : this.boost.gain;
    this.state.boost = g;
    if (immediately) this.pre.gain.value = g / SOFT_CLIP_RANGE;
    else this.pre.gain.setTargetAtTime(g / SOFT_CLIP_RANGE, this.ctx.currentTime, 0.1);
  }

  /** Stereo capture: put a one-sided input on both channels, and take that back when the second channel comes alive. */
  private routeSides() {
    if (!this.sides || !this.sideLeft || !this.sideRight || !this.source || !this.bus || !this.splitter || !this.merger) return;
    this.sideLeft.getFloatTimeDomainData(this.sideSamples);
    const left = rmsLevel(this.sideSamples);
    this.sideRight.getFloatTimeDomainData(this.sideSamples);
    const verdict = this.sides.update(left, rmsLevel(this.sideSamples));
    if (verdict === this.routed) return;
    // Take the old route away, then set the new one: the source itself, or its live channel into both inputs of the merger.
    if (this.routed === "stereo") this.source.disconnect(this.bus);
    else { const was = this.routed === "left" ? 0 : 1; this.splitter.disconnect(this.merger, was, 0); this.splitter.disconnect(this.merger, was, 1); }
    if (verdict === "stereo") this.source.connect(this.bus);
    else { const live = verdict === "left" ? 0 : 1; this.splitter.connect(this.merger, live, 0); this.splitter.connect(this.merger, live, 1); }
    this.routed = this.inputSide = verdict;
  }

  private tick() {
    if (!this.analyser) return;
    this.routeSides();
    if (this.inputAnalyser) { this.inputAnalyser.getFloatTimeDomainData(this.samples); this.state.input = rmsLevel(this.samples); }
    if (this.inputAnalyser && this.autoGain && this.boost.auto) {
      const g = this.autoGain.update(this.state.input);
      if (g !== this.state.boost) this.applyBoost();
      if (Math.abs(g - this.rememberedGain) >= 0.1) { this.rememberedGain = g; rememberBoost(this.boostKey, g); }
    }
    this.analyser.getFloatTimeDomainData(this.samples);
    this.state.level = rmsLevel(this.samples);
    if (this.mode === "vad") this.gate.update(this.state.level, performance.now());
    this.apply();
  }

  private apply() {
    const open = this.forcedOpen || (this.mode === "ptt" ? this.pttHeld : this.gate.isOpen());
    if (this.gain) {
      // Short ramp instead of a hard cut: avoids clicks.
      const t = this.ctx!.currentTime;
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setTargetAtTime(open ? 1 : 0, t, 0.01);
    }
    if (open !== this.state.open) this.state.open = open;
    this.onState?.({ level: this.state.level, input: this.state.input, open, boost: this.state.boost, side: this.inputSide });
  }

  private async stopCapture() {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.source?.disconnect(); this.bus?.disconnect(); this.splitter?.disconnect(); this.merger?.disconnect(); this.sideLeft?.disconnect(); this.sideRight?.disconnect();
    this.bus = this.splitter = this.merger = this.sideLeft = this.sideRight = null;
    this.sides = null;
    this.inputAnalyser?.disconnect(); this.pre?.disconnect(); this.shaper?.disconnect(); this.analyser?.disconnect(); this.gain?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source = this.inputAnalyser = this.pre = this.shaper = this.analyser = this.gain = this.dest = null;
    this.autoGain = null;
    this.stream = null;
    this.state.level = 0; this.state.input = 0; this.state.open = false;
  }

  async stop() {
    await this.stopCapture();
    this.monitor = null;
    if (this.ownsCtx) await this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
