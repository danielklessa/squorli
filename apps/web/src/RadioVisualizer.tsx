import { useEffect, useRef } from "react";
import { allDown, bandLevels, bandsOf, freshBars, particleAlpha, stepBars, stepParticles, type Band, type Particle } from "./radioVisual";
import type { RadioPlayer } from "./voice/radioPlayer";

/** How long the equalizer takes to fade in, or out once its bars have come down, in seconds. */
const FADE_S = 0.6;
/** Opacity of the bars, the glow along the base and the particles (user's corrections of 14 October 2026: faint). */
const BAR_ALPHA = 0.065, BASE_ALPHA = 0.2, PARTICLE_ALPHA = 0.22;

/**
 * The radio's equalizer behind the stage's tiles, rising from the button bar (user's wish of 14 October 2026,
 * docs/features/radio.md): faint bars in the brand's blue to mint with a glow along the base and a few particles,
 * drawn from the radio player's
 * analyser. `active` fades it in, and when it goes the bars fall down first and the equalizer fades out only once all of
 * them are down (user's wish of 14 October 2026); then `onFaded`, so the stage may unmount it: never before, it is never
 * cut off. Once inactive it reads no sound any more (the player may already have dropped it). The stage may live in a window of its
 * own, so frames and the observer come from the canvas's window. `calm` (reduced motion): slower bars, no particles.
 */
export function RadioVisualizer({ player, active, calm, front = false, onFaded }: { player: RadioPlayer; active: boolean; calm: boolean; front?: boolean; onFaded?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const wake = useRef<(() => void) | null>(null);
  activeRef.current = active;
  const fadedRef = useRef(onFaded);
  fadedRef.current = onFaded;
  useEffect(() => { wake.current?.(); }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const win = canvas?.ownerDocument.defaultView;
    const g = canvas?.getContext("2d");
    if (!canvas || !win || !g) return;
    const style = win.getComputedStyle(canvas);
    const color = (token: string, fallback: string, last: string) => style.getPropertyValue(token).trim() || style.getPropertyValue(fallback).trim() || last;
    const blue = color("--sq-squorli-blue", "--brand", "#6397FF"), mint = color("--sq-mint", "--ok", "#42D6AE"), cloud = color("--sq-cloud", "--text", "#F5F8FF");

    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      dpr = win.devicePixelRatio || 1;
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    };
    resize();
    const observer = new win.ResizeObserver(resize);
    observer.observe(canvas);

    let bars = freshBars();
    let particles: Particle[] = [];
    let bands: Band[] = [];
    let spectrum = new Uint8Array(0);
    let fade = 0, last = 0, frame = 0;

    const draw = (now: number) => {
      frame = 0;
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const on = activeRef.current;
      const analyser = on ? player.analyser() : null;
      if (analyser) {
        if (spectrum.length !== analyser.frequencyBinCount) {
          spectrum = new Uint8Array(analyser.frequencyBinCount);
          bands = bandsOf(analyser.frequencyBinCount, analyser.context.sampleRate, analyser.fftSize);
        }
        analyser.getByteFrequencyData(spectrum);
      }
      // Off: no levels, so the bars fall at their own pace and send no particles; the fade waits until all are down.
      bars = stepBars(bars, analyser ? bandLevels(spectrum, bands) : [], dt, calm);
      particles = calm ? [] : stepParticles(particles, bars.bars, dt, Math.random);
      if (on) fade = Math.min(1, fade + dt / FADE_S);
      else if (allDown(bars)) fade = Math.max(0, fade - dt / FADE_S);

      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (fade > 0 && w > 0 && h > 0) {
        const slot = w / bars.bars.length, bw = slot * 0.62, r = Math.min(bw / 2, 6);
        const grad = g.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, blue); grad.addColorStop(0.7, mint); grad.addColorStop(1, "transparent");
        // The glow along the base: a faint line over the whole width that brightens under the louder bars.
        g.filter = `blur(${Math.round(8 * dpr)}px)`;
        g.fillStyle = blue;
        g.globalAlpha = BASE_ALPHA * 0.35 * fade;
        g.fillRect(0, h - 8, w, 16);
        for (const [i, bar] of bars.bars.entries()) {
          const gh = 10 + bar * 34;
          g.globalAlpha = BASE_ALPHA * bar * fade;
          g.fillRect(i * slot + (slot - bw) / 2, h - gh / 2, bw, gh);
        }
        g.filter = "none";
        g.fillStyle = grad;
        g.globalAlpha = BAR_ALPHA * fade;
        for (const [i, bar] of bars.bars.entries()) {
          const bh = bar * h * 0.92;
          if (bh < 1) continue;
          g.beginPath();
          g.roundRect(i * slot + (slot - bw) / 2, h - bh, bw, bh + r, [r, r, 0, 0]);
          g.fill();
        }
        for (const p of particles) {
          g.globalAlpha = PARTICLE_ALPHA * fade * particleAlpha(p);
          g.fillStyle = p.size > 2 ? blue : cloud;
          g.beginPath();
          g.arc(p.x * w, h - p.y * h, p.size, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
      }
      // Faded out and nothing left to show: rest until `active` comes back.
      if (fade === 0 && !activeRef.current) { last = 0; fadedRef.current?.(); return; }
      frame = win.requestAnimationFrame(draw);
    };
    wake.current = () => { if (!frame) frame = win.requestAnimationFrame(draw); };
    wake.current();
    return () => { wake.current = null; if (frame) win.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [player, calm]);

  return <canvas ref={canvasRef} className={`radio-visual${front ? " front" : ""}`} aria-hidden="true" />;
}
