import { useEffect, useRef, useState } from "react";
import type { RawLogEntry } from "./store";
import type { AudioStats, VoiceClient, VoiceState } from "./voice/voiceClient";
import { fmtTime, t } from "./i18n";
import { systemActivityDiagnostics } from "./systemActivity";

/**
 * Protocol inspector (docs/DEVELOPMENT.md): WebSocket events and LiveKit statistics, live.
 * Shown via the bug button or ?debug in the URL. M3: video bitrates per simulcast layer and per received track
 * (measurement basis for the bandwidth table in deploy/AGENTS.md).
 */
const POLL_MS = 2000;
const EMPTY: AudioStats = { path: { publisher: null, subscriber: null }, sender: null, receivers: [], videoSend: [], videoRecv: [] };

type Rates = Record<string, { kbps: number; fps: number }>;

export function DebugPanel({ log, client, voice }: { log: RawLogEntry[]; client: VoiceClient; voice: VoiceState }) {
  const [stats, setStats] = useState<AudioStats>(EMPTY);
  const [rates, setRates] = useState<Rates>({});
  const prev = useRef<{ at: number; bytes: Record<string, number>; frames: Record<string, number> }>({ at: 0, bytes: {}, frames: {} });

  useEffect(() => {
    if (voice.status === "disconnected") { setStats(EMPTY); setRates({}); prev.current = { at: 0, bytes: {}, frames: {} }; return; }
    const id = setInterval(() => {
      void client.stats().then((s) => {
        setStats(s);
        // Bitrate from the difference in cumulative bytes since the last measurement.
        const now = performance.now();
        const bytes: Record<string, number> = {}; const frames: Record<string, number> = {};
        for (const v of s.videoSend) { bytes[`s:${v.source}:${v.rid}:${v.codec}`] = v.bytesSent; }
        for (const v of s.videoRecv) { bytes[`r:${v.identity}:${v.source}`] = v.bytesReceived; frames[`r:${v.identity}:${v.source}`] = v.framesDecoded; }
        if (s.sender?.bytesSent !== undefined) bytes["s:audio"] = s.sender.bytesSent;
        for (const r of s.receivers) if (r.bytesReceived !== undefined) bytes[`r:${r.identity}:audio`] = r.bytesReceived;
        const dt = (now - prev.current.at) / 1000;
        if (prev.current.at > 0 && dt > 0) {
          const next: Rates = {};
          for (const [k, b] of Object.entries(bytes)) {
            const pb = prev.current.bytes[k];
            const pf = prev.current.frames[k];
            next[k] = { kbps: pb === undefined ? 0 : Math.round(((b - pb) * 8) / dt / 1000), fps: pf === undefined || frames[k] === undefined ? 0 : Math.round((frames[k] - pf) / dt) };
          }
          setRates(next);
        }
        prev.current = { at: now, bytes, frames };
      }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [client, voice.status]);

  // AFK signals of the desktop app's shell: controller input counted as activity, and the "display required" state.
  const [system, setSystem] = useState(systemActivityDiagnostics);
  useEffect(() => { const id = setInterval(() => setSystem(systemActivityDiagnostics()), 1000); return () => clearInterval(id); }, []);

  const totalDown = Object.entries(rates).filter(([k]) => k.startsWith("r:")).reduce((a, [, v]) => a + v.kbps, 0);
  const totalUp = Object.entries(rates).filter(([k]) => k.startsWith("s:")).reduce((a, [, v]) => a + v.kbps, 0);

  return (
    <section className="debug">
      <h3>{t("debug.heading")}</h3>
      <table>
        <tbody>
          <tr><td>{t("debug.status")}</td><td>{voice.status}</td></tr>
          <tr><td>{t("debug.channel")}</td><td>{voice.channelId ?? "–"}</td></tr>
          <tr><td>LiveKit-URL</td><td>{voice.rtcUrl ?? "–"}</td></tr>
          <tr><td>{t("debug.audio")}</td><td title={t("debug.audioHint")}>{t("debug.audioRow", { ctx: voice.audioContext, playback: voice.canPlayback ? t("debug.free") : t("debug.blocked") })}</td></tr>
          <tr><td>{t("debug.icePath")}</td><td title={t("debug.iceHint")}>{t("debug.iceRow", { pub: stats.path.publisher ?? "–", sub: stats.path.subscriber ?? "–" })}</td></tr>
          <tr><td>{t("debug.levelGate")}</td><td>{voice.level.toFixed(3)} / {voice.gateOpen ? t("debug.open") : t("debug.closed")} · x{voice.micBoost.toFixed(2)} · {t("debug.micInput", { level: voice.micInput.toFixed(4) })}{voice.micSide !== "stereo" ? ` · ${t("debug.micOneSided", { side: voice.micSide === "left" ? "L" : "R" })}` : ""}</td></tr>
          <tr><td>{t("debug.microphone")}</td><td>{voice.inputDeviceId ?? "–"}</td></tr>
          <tr><td>{t("debug.screenOut")}</td><td>{voice.screenSink.deviceId ? t("debug.device", { id: voice.screenSink.deviceId.slice(0, 12) }) : t("debug.sameAsVoice")} · {t("debug.tracks", { n: voice.screenSink.tracks })} · {t(voice.screenSink.via === "webaudio" ? "debug.screenViaWebAudio" : "debug.screenViaElement")}{voice.screenSink.error ? ` · ${t("debug.error", { err: voice.screenSink.error })}` : ""}</td></tr>
          <tr><td>{t("debug.camScreen")}</td><td>{voice.cameraOn ? t("debug.on") : t("debug.off")} / {voice.screenOn ? (voice.screenAudio ? t("debug.onWithAudio") : t("debug.onNoAudio")) : t("debug.off")}</td></tr>
          <tr><td>{t("debug.controllerInput")}</td><td title={t("debug.controllerInputHint")}>{!system.available ? t("debug.systemWatchMissing") : `${t("debug.controllerInputRow", { n: system.inputs })}${system.lastInput ? ` · ${t("debug.controllerInputLast", { time: new Date(system.lastInput).toLocaleTimeString() })}` : ""}`}</td></tr>
          <tr><td>{t("debug.displayRequired")}</td><td title={t("debug.displayRequiredHint")}>{!system.available ? t("debug.systemWatchMissing") : system.display === null ? "–" : !system.display ? t("debug.no") : system.ownVideo ? t("debug.displayOwnVideo") : t("debug.yes")}</td></tr>
          <tr><td>{t("debug.total")}</td><td>{t("debug.totalRow", { up: fmtKbps(totalUp), down: fmtKbps(totalDown), s: POLL_MS / 1000 })}</td></tr>
          <tr><td>{t("debug.audioSend")}</td><td>{stats.sender ? t("debug.audioSendRow", { rate: fmtKbps(rates["s:audio"]?.kbps), sent: stats.sender.packetsSent ?? "?", lost: stats.sender.packetsLost ?? 0, jitter: fmtMs(stats.sender.jitter), rtt: fmtMs(stats.sender.roundTripTime) }) : "–"}</td></tr>
          {stats.videoSend.map((v) => (
            <tr key={`${v.source}${v.rid}${v.codec}`}><td>{v.source === "screen" ? t("debug.screen") : t("debug.camera")} {t("debug.send")} {v.rid}</td>
              <td>{fmtKbps(rates[`s:${v.source}:${v.rid}:${v.codec}`]?.kbps)}, {v.codec}{v.encoder ? ` (${v.encoder})` : ""}, {v.width}×{v.height} @ {Math.round(v.fps)} fps{v.limitation && v.limitation !== "none" ? t("debug.limitedBy", { what: v.limitation }) : ""}</td></tr>
          ))}
          {stats.receivers.map((r) => (
            <tr key={r.identity}><td>{t("debug.audioFrom", { id: r.identity.slice(0, 8) })}</td><td>{t("debug.audioRecvRow", { rate: fmtKbps(rates[`r:${r.identity}:audio`]?.kbps), recv: r.packetsReceived ?? "?", lost: r.packetsLost ?? 0, jitter: fmtMs(r.jitter) })}{client.isLevelMatching() && client.levelGain(r.identity) !== null ? ` · x${client.levelGain(r.identity)!.toFixed(2)}` : ""}</td></tr>
          ))}
          {stats.videoRecv.map((v) => (
            <tr key={`${v.identity}${v.source}`}><td>{v.source === "screen" ? t("debug.screen") : t("debug.camera")} {t("debug.from")} {v.identity.slice(0, 8)}</td>
              <td>{t("debug.videoRecvRow", { rate: fmtKbps(rates[`r:${v.identity}:${v.source}`]?.kbps), w: v.width ?? "?", h: v.height ?? "?", fps: rates[`r:${v.identity}:${v.source}`]?.fps ?? "?", lost: v.packetsLost ?? 0 })}</td></tr>
          ))}
          {voice.participants.map((p) => (
            <tr key={p.identity}><td>{p.isLocal ? t("debug.me") : p.name}</td><td>{p.identity.slice(0, 8)} · {p.speaking ? t("debug.speaking") : t("debug.silent")} · {p.micMuted ? t("debug.muted") : t("debug.unmuted")}{p.cameraOn ? ` · ${t("debug.camera")}` : ""}{p.screenOn ? ` · ${t("debug.screen")}` : ""} · {p.quality}</td></tr>
          ))}
        </tbody>
      </table>
      <h3>{t("debug.voiceEvents", { n: voice.events.length })}</h3>
      <pre className="wslog">{voice.events.join("\n")}</pre>
      <h3>{t("debug.wsEvents", { n: log.length })}</h3>
      <pre className="wslog">
        {log.map((e) => `${fmtTime(new Date(e.at).toISOString())} ${e.dir === "in" ? "<-" : "->"} ${e.text}`).join("\n")}
      </pre>
    </section>
  );
}

const fmtMs = (s: number | undefined) => (s === undefined ? "?" : `${Math.round(s * 1000)} ms`);
const fmtKbps = (k: number | undefined) => (k === undefined ? "? kbit/s" : k >= 1000 ? `${(k / 1000).toFixed(2)} Mbit/s` : `${k} kbit/s`);
