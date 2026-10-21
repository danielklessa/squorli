# apps/mobile – Mobile app (`@squorli/mobile`)

Part of the project description. The entry point is the root [AGENTS.md](../../AGENTS.md) (commands, definition of done, cross-cutting conventions, the map of all documentation in its section 0). Whoever adds, removes or repurposes a file here, or changes a convention or pitfall, updates this file in the same step. Decisions, stages and what was checked: `docs/features/mobile.md`; the open work: `docs/PLAN-mobile.md`.

**The app has no renderer code**, like the desktop app. It is a Capacitor 8 shell around the web client for iOS and Android: `scripts/sync.mjs` copies the build of `apps/web` (`apps/web/dist`) into `www/`, and Capacitor copies that into both native projects. Everything a user sees is changed in `apps/web`; what differs goes through `apps/web/src/platform/` (`mobileApp.ts`, the third `Platform` next to the browser's and the desktop app's). The page reaches the system through Capacitor's plugins (`@capacitor/app` in the web client, loaded as a chunk of its own only inside the app), not through a bridge of its own.

## Structure

```
apps/mobile/
  package.json         version = the app's version (release tag `mobile-v<version>`, from stage 6 of docs/PLAN-mobile.md); every @capacitor package pinned to one exact version (native.test.mjs checks it, also against apps/web)
  capacitor.config.js  Capacitor's configuration, CommonJS on purpose (the CLI require()s a .js file; a .ts one needs TypeScript's JavaScript API, which TypeScript 7 no longer has): appId `com.squorli.app`, the origin (defaults spelled out), `appendUserAgent` `Squorli-Mobile/<version>`, the dark ground, SystemBars (edge to edge with env(safe-area-inset-*)), Keyboard (iOS resizes the web view)
  scripts/sync.mjs     `pnpm --filter @squorli/mobile sync [android|ios]`: apps/web/dist -> www/ (without `test/`), index.html prepared (appIndex.mjs), the version into the Xcode project (versions.mjs), then `cap sync`
  scripts/appIndex.mjs pure, tested: the app's Content-Security-Policy as a meta tag (the desktop app's without frame-ancestors; the test compares the two), `viewport-fit=cover`, no manifest link; stops when the page no longer has what it changes
  scripts/versions.mjs pure, tested: `buildNumber` (major * 1000000 + minor * 1000 + patch, Android's versionCode and iOS's CFBundleVersion), `withIosVersion` (MARKETING_VERSION, CURRENT_PROJECT_VERSION)
  scripts/native.test.mjs the native projects against node_modules: the paths Capacitor wrote exist, Package.swift names the installed Capacitor, one version everywhere, the Xcode project carries package.json's version
  www/                 the copied web client (ignored by git, made by sync)
  android/             the Gradle project (Capacitor's template, committed): AndroidManifest.xml (permissions for microphone and camera, no backup and no device transfer: data_extraction_rules.xml), build.gradle (version from package.json), res/ (icons and start picture from tools/mobile-icons.mjs, styles.xml with the dark ground and the start window, splash.xml); capacitor.settings.gradle and app/capacitor.build.gradle are WRITTEN BY `cap sync`
  ios/                 the Xcode project (Capacitor's template with the Swift Package Manager, committed): App/Info.plist (microphone and camera texts, English only so far), Assets.xcassets (icon and start picture from tools/mobile-icons.mjs), Base.lproj/LaunchScreen.storyboard (the dark ground); App/CapApp-SPM/Package.swift is WRITTEN BY `cap sync`
```

## Commands

From the repo root unless said otherwise:

| Command | Purpose |
|---|---|
| `pnpm build`, then `pnpm --filter @squorli/mobile sync` | the current client into both native projects (after every client change that should reach the app) |
| `pnpm --filter @squorli/mobile exec cap open android` | Android Studio with the project (needs Android Studio, docs/PLAN-mobile.md stage 0) |
| `pnpm --filter @squorli/mobile exec cap run android` | build, install and start on the emulator or a phone (Android SDK and an emulator image with Google Play services) |
| `pnpm --filter @squorli/mobile exec cap open ios` | Xcode with the project, **macOS only**; the iPhone attached by cable, Safari's Web Inspector for the web view |
| `pnpm --filter @squorli/mobile test` | the scripts' tests and the native projects' checks (also part of `pnpm test`) |
| `node tools/mobile-icons.mjs` | icons and start pictures from the brand package, only after a brand change (tools/AGENTS.md) |

**Live reload against the local stack (Android):** `pnpm --filter @squorli/web dev` (Vite on 5173), `adb reverse tcp:5173 tcp:5173` and the same for 3000 (chat server) and 3100 (directory), then `pnpm --filter @squorli/mobile exec cap run android --live-reload --host localhost --port 5173`. The page is `http://localhost:5173` then: localhost stays a secure context (getUserMedia), and the client takes the directory from `VITE_DIRECTORY_URL`, else `http://localhost:3100` (`mobileDirectoryUrl` in mobileApp.ts). A built app always uses `https://directory.squorli.com` and cannot reach an http server at all (mixed content from its https page), like the desktop app. Not tried yet; the built app (no live reload) ran on the emulator on 20 October 2026 (docs/features/mobile.md).

## Conventions

- **The origin is final once a public version exists:** iOS `capacitor://localhost`, Android `https://localhost`. The page's storage (sessions, the sealed secrets and their key in IndexedDB, the device keys) belongs to it; changing scheme or host loses them for every user. Keep `localhost` as the host: Capacitor's documentation names it as what keeps the page a secure context on both systems. The protocol's `signInOrigin` recognises exactly these two origins as the app (`MOBILE_APP_PAGE_ORIGINS` -> `MOBILE_APP_ORIGIN`, `docs/features/devices.md`); any other origin would show as a host in the device lists. The user agent's `Squorli-Mobile/<version>` (`appendUserAgent`) makes the label "Squorli App auf Android/iOS" (`labelFromUserAgent`).
- **`com.squorli.app` is the app's identity in both stores** (bundle id, application id, the Java package of MainActivity). Changing it after the first upload makes a different app.
- **After every update of a @capacitor package run `sync` and commit what it changed** in `android/` and `ios/`: Capacitor writes pnpm's real paths with the version in them (`node_modules/.pnpm/@capacitor+android@8.5.3_.../`) and the exact Capacitor version into Package.swift. `native.test.mjs` fails until that is done, also in CI. Update all @capacitor packages together, in `apps/mobile` and `apps/web` (the web client's @capacitor/core and @capacitor/app must match the shell's native parts).
- **No backup of the app's data** (AndroidManifest.xml `allowBackup="false"`, `data_extraction_rules.xml` for Android 12 and later): the web view's storage holds the device keys, which belong to one installation (docs/features/devices.md); a copy on a new phone would be the same device twice. A new phone signs in with name and password. iOS backs the web view's data up into iCloud backups; excluding it needs native code (docs/PLAN-mobile.md 6.3).
- **Icons and start pictures only from `tools/mobile-icons.mjs`**, never edited by hand (docs/brand/AGENTS.md: the icon mark for icons, the default logo with the wordmark for the start screens, the small mark below 32 px, the logo not below 160 px, the dark ground #0C1424). A brand change runs the tool again.
- **The app's page has a Content-Security-Policy of its own** (scripts/appIndex.mjs): Capacitor sends no headers, so the policy travels as a meta tag. A change of the desktop app's or the server's policy is made here too (the test compares with the desktop app's).
- **A plugin is a proxy that answers every property, `then` included:** never resolve a promise WITH a plugin (`import("@capacitor/app").then((m) => m.App)` makes the promise call `App.then()`, which throws "not implemented"); use it inside the `then` (mobileApp.ts).

## Known pitfalls

- **Capacitor's CLI cannot load `capacitor.config.ts` here** (TypeScript 7 has no JavaScript API); the configuration is `capacitor.config.js` in CommonJS, which is why this package has no `"type": "module"` (the scripts are `.mjs`).
- **iOS on Windows:** `cap add ios` and `cap sync ios` work (the Swift Package Manager needs no CocoaPods), building, signing and running need Xcode on macOS (docs/PLAN-mobile.md section 4).
- **German texts of the iOS permission questions** need an `InfoPlist.strings` per language that is a member of the Xcode project; adding it by hand to `project.pbxproj` on Windows is error-prone, so it waits for the Mac.
- **The Gradle wrapper** is the one of Capacitor 8.5.3's template: Gradle 8.14.3 with the Android Gradle plugin 8.13.0 (Capacitor's 8.0 upgrade guide names these). On 20 October 2026 an IDE extension (it also created `android/.gradle/`) rewrote `gradle-wrapper.properties` to Gradle 9.7.1 the moment the project appeared; it was set back to the template's before the first commit. Raise Gradle only together with what Capacitor's next template or upgrade guide names, and check the build. `gradlew.bat` needs CRLF (`.gitattributes` `*.bat`).
- **The Android SDK the project needs:** `platforms;android-36` (compileSdk; Android Studio's first-run wizard installs only the newest platform, 37.0 on 20 October 2026, and its Google Play x86_64 image with an AVD), build-tools 36.0.0, platform-tools, the emulator; `ANDROID_HOME` for `cap run`'s `native-run`, `android/local.properties` with `sdk.dir` for Gradle (Android Studio writes it when it opens the project; ignored by git). An app with targetSdk 36 runs on the API 37 image. The emulator's microphone is off until switched on in its extended controls (Microphone, "Virtual microphone uses host audio input"); without it there is no voice test.
- **`cap run android` fails with "Der Befehl gradlew ist entweder falsch geschrieben" in a shell that has `NoDefaultCurrentDirectoryInExePath=1`** (Claude Code's tool shells set it): the CLI starts `./gradlew` through cmd.exe, which then no longer looks in the project directory for `gradlew.bat`. Empty the variable for the call (`$env:NoDefaultCurrentDirectoryInExePath = $null`) or build with `android\gradlew.bat -p android assembleDebug` and install with `adb install -r`. A normal terminal is not affected.
- **Testing the page without a phone:** serve `www/` locally and open it in headless Chrome as a phone (`Emulation.setDeviceMetricsOverride` with `mobile: true`, touch, a user agent with `Squorli-Mobile/`), with a stand-in for Capacitor's native bridge added by `Page.addScriptToEvaluateOnNewDocument`: `window.androidBridge = {}` and `window.Capacitor = { isNativePlatform, getPlatform, PluginHeaders: [{ name: "App", methods: [{ name, rtype }] }], nativePromise, nativeCallback }`; `nativeCallback` keeps the `backButton` listener, calling it presses back (docs/features/mobile.md, 20 October 2026).
