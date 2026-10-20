// Capacitor's configuration of the mobile app (apps/mobile/AGENTS.md). CommonJS on purpose: the CLI loads a .js
// configuration with require(), and a capacitor.config.ts would need TypeScript's JavaScript API, which TypeScript 7 no
// longer has. `pnpm --filter @squorli/mobile sync` copies it into both native projects; change it there never by hand.
const { version } = require("./package.json");

/** @type {import("@capacitor/cli").CapacitorConfig} */
module.exports = {
  appId: "com.squorli.app",
  appName: "Squorli",
  // The web client's build, copied and prepared by scripts/sync.mjs (never edited, ignored by git).
  webDir: "www",
  // The brand's dark ground behind the page until it paints, so the start never flashes white.
  backgroundColor: "#0C1424",
  // Names the app in the device lists, as the desktop app does with `Squorli-Desktop/<version>`
  // (packages/protocol/src/useragent.ts).
  appendUserAgent: `Squorli-Mobile/${version}`,
  // Capacitor's defaults, spelled out because they are the app's ORIGIN (capacitor://localhost on iOS,
  // https://localhost on Android): the page's storage (sessions, the sealed secrets, the device keys) belongs to it, so
  // it is final once a public version exists. `localhost` keeps the page a secure context on both (getUserMedia).
  server: { hostname: "localhost", androidScheme: "https", iosScheme: "capacitor" },
  ios: { contentInset: "never" },
  plugins: {
    // Edge to edge (Android 15 enforces it): with `viewport-fit=cover` in the page (scripts/appIndex.mjs) a WebView from
    // 140 on gets the real env(safe-area-inset-*) the client's CSS already uses; an older one is padded natively and
    // sees zeros. DARK = light icons on the dark ground.
    SystemBars: { insetsHandling: "native", initialViewportFitValueHint: "cover", style: "DARK" },
    // iOS: the keyboard makes the web view smaller, so the composer stays above it; the ground behind the keyboard's
    // animation is `backgroundColor`. Android does the same through the system bars' insets.
    Keyboard: { resize: "native", autoBackdropColor: "auto" },
  },
};
