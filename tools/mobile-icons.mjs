// Generates the mobile app's icons and start pictures (apps/mobile, iOS and Android) from the brand package (docs/brand/
// AGENTS.md): the launcher icons from the icon mark squorli-icon.svg (squorli-icon-small.svg where the mark would be drawn
// below 32 px, squorli-icon-white.svg for Android's themed icon), the start pictures from the default logo squorli-logo.svg
// (icon mark above the light wordmark; the icon mark where the logo would stay below its 160 px), always on the brand's
// dark ground #0C1424, which the target medium adds (the SVGs are transparent). Nothing is cropped, distorted or recoloured:
// every SVG is drawn whole, and only placed so that its drawn geometry (measured here, strokes included) sits in the
// middle with the clear space the brand asks for (1/8 of the icon mark's width). The result is committed; run this only
// after a brand change:
//   node tools/mobile-icons.mjs           (needs Google Chrome; another path: CHROME=<chrome executable>)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "apps/mobile/android/app/src/main/res");
const assets = join(root, "apps/mobile/ios/App/App/Assets.xcassets");
const chrome = process.env.CHROME ?? (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const GROUND = "#0C1424";
const SVG_FILES = { mark: "squorli-icon.svg", small: "squorli-icon-small.svg", white: "squorli-icon-white.svg", logo: "squorli-logo.svg" };
const svgs = Object.fromEntries(Object.entries(SVG_FILES).map(([k, f]) => [k, readFileSync(join(root, "docs/brand", f), "utf8").replace(/<\?xml[^>]*\?>/, "")]));
const work = mkdtempSync(join(tmpdir(), "squorli-mobile-icons-"));
const chromeArgs = ["--headless=new", "--disable-gpu", "--hide-scrollbars"];

/** The drawn geometry of each SVG in its view box's units (shapes' boxes through their transforms, half the stroke added). */
function measure() {
  const page = join(work, "measure.html");
  writeFileSync(page, `<!doctype html><body>${Object.entries(svgs).map(([k, s]) => `<div data-k="${k}">${s}</div>`).join("")}<pre id="out"></pre><script>
  const out = {};
  for (const div of document.querySelectorAll("[data-k]")) {
    const svg = div.querySelector("svg"), vb = svg.viewBox.baseVal, inv = svg.getScreenCTM().inverse();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of svg.querySelectorAll("path, rect, circle, ellipse, polygon, polyline, line")) {
      const b = el.getBBox(), m = inv.multiply(el.getScreenCTM()), st = getComputedStyle(el);
      const half = st.stroke && st.stroke !== "none" ? parseFloat(st.strokeWidth) / 2 : 0;
      for (const [px, py] of [[b.x - half, b.y - half], [b.x + b.width + half, b.y - half], [b.x - half, b.y + b.height + half], [b.x + b.width + half, b.y + b.height + half]]) {
        const p = new DOMPoint(px, py).matrixTransform(m);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    out[div.dataset.k] = { vw: vb.width, vh: vb.height, x0, y0, x1, y1 };
  }
  document.getElementById("out").textContent = JSON.stringify(out);
</script>`);
  const dom = execFileSync(chrome, [...chromeArgs, "--dump-dom", pathToFileURL(page).href], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(/<pre id="out">([^<]*)<\/pre>/.exec(dom)[1].replace(/&quot;/g, '"'));
}
const geo = measure();
const width = (k) => geo[k].x1 - geo[k].x0;
// In the logo the icon mark is drawn at the size of the icon mark's own file (squorli-logo.svg: translate, no scale).
const markInLogo = width("mark") / width("logo");

/**
 * The pictures. `w`, `h`: pixels. `tile`: how the dark ground is cut (null = transparent). `art`: what stands on it.
 * `size`: the width of the drawn geometry in percent of the shorter side. `shown`: how many pixels of the picture's width
 * the system shows in the end (the launcher shows a 108 dp layer's middle 72 dp as a 48 dp icon); the 32 px and 160 px
 * minimums apply to that.
 */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const ICONS = [
  ...Object.entries(DENSITIES).flatMap(([d, f]) => [
    // Android before 8 and launchers without adaptive icons: the rounded tile of the desktop app and the web client.
    { file: `${res}/mipmap-${d}/ic_launcher.png`, w: 48 * f, h: 48 * f, tile: "inset: 4%; border-radius: 22%;", art: "mark", size: 70 },
    { file: `${res}/mipmap-${d}/ic_launcher_round.png`, w: 48 * f, h: 48 * f, tile: "inset: 4%; border-radius: 50%;", art: "mark", size: 70 },
    // Adaptive icon (Android 8 and later), 108 dp: the launcher cuts its shape out of the middle, only a circle of 66 dp is
    // sure to show. The background layer is the colour @color/ic_launcher_background.
    { file: `${res}/mipmap-${d}/ic_launcher_foreground.png`, w: 108 * f, h: 108 * f, tile: null, art: "mark", size: 46, shown: 48 / 72 },
    // Android 13's themed icon: the launcher colours the white shape itself.
    { file: `${res}/mipmap-${d}/ic_launcher_monochrome.png`, w: 108 * f, h: 108 * f, tile: null, art: "white", size: 46, shown: 48 / 72 },
    // The start picture, 288 dp (styles.xml: Android 12 and later show it in the middle of the start window and keep only a
    // circle of 192 dp; drawable/splash.xml puts the same picture on the dark ground for older ones, unscaled).
    { file: `${res}/drawable-${d}/splash_icon.png`, w: 288 * f, h: 288 * f, tile: null, art: "logo", size: 42 },
  ]),
  // iOS: one icon of 1024 px, no transparency (an opaque picture comes out of Chrome without an alpha channel, which the
  // App Store asks for) and no corners of our own, iOS rounds it.
  { file: `${assets}/AppIcon.appiconset/AppIcon-512@2x.png`, w: 1024, h: 1024, tile: "inset: 0;", art: "mark", size: 72 },
  // The start picture fills the screen (LaunchScreen.storyboard, aspect fill: a phone shows about the middle 46 % of its
  // width), so the logo stays small in its middle: about a third of a phone's width, a fifth of an iPad's.
  ...["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"].map((f) => ({ file: `${assets}/Splash.imageset/${f}`, w: 2732, h: 2732, tile: "inset: 0;", art: "logo", size: 14.6 })),
];

for (const [i, icon] of ICONS.entries()) {
  let art = icon.art, drawn = (Math.min(icon.w, icon.h) * icon.size) / 100;
  const shown = drawn * (icon.shown ?? 1);
  // The brand's minimums: the logo at least 160 px wide, else the icon mark at the logo's mark size; the icon mark at least
  // 32 px, else its simplified variant without eyes.
  if (art === "logo" && shown < 160) { art = "mark"; drawn *= markInLogo; }
  if (art === "mark" && shown < 32) art = "small";
  const g = geo[art], scale = drawn / width(art);
  const left = icon.w / 2 - ((g.x0 + g.x1) / 2) * scale, top = icon.h / 2 - ((g.y0 + g.y1) / 2) * scale;
  const page = join(work, `${i}.html`);
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${icon.w}px; height: ${icon.h}px; background: transparent; overflow: hidden; }
  /* Everything hangs on this box, not on the viewport: headless Chrome's window has a minimum size above the small icons. */
  .canvas { position: absolute; left: 0; top: 0; width: ${icon.w}px; height: ${icon.h}px; overflow: hidden; }
  .tile { position: absolute; ${icon.tile ?? "display: none;"} background: ${GROUND}; }
  svg { position: absolute; left: ${left}px; top: ${top}px; width: ${g.vw * scale}px; height: ${g.vh * scale}px; display: block; }
</style><div class="canvas"><div class="tile"></div>${svgs[art]}</div>`);
  mkdirSync(dirname(icon.file), { recursive: true });
  execFileSync(chrome, [...chromeArgs, "--default-background-color=00000000", `--window-size=${icon.w},${icon.h}`, `--screenshot=${icon.file}`, pathToFileURL(page).href], { stdio: "ignore" });
  // Headless Chrome cannot make a window smaller than its minimum: a picture of another size would be wrong, so stop.
  const png = readFileSync(icon.file);
  const size = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
  if (size !== `${icon.w}x${icon.h}`) { console.error(`[mobile-icons] ${icon.file}: ${size} statt ${icon.w}x${icon.h}`); process.exit(1); }
  console.log(`[mobile-icons] ${icon.file.slice(root.length + 1)} ${size} ${SVG_FILES[art]} ${Math.round(drawn * (icon.shown ?? 1))} px`);
}
rmSync(work, { recursive: true, force: true });
