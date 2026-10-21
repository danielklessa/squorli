# Plan: a native client for iOS and Android

Part of the project description (entry point: root `AGENTS.md`, section 0; open work `docs/PLAN.md` 3.5). First written on 25 September 2026 ("was müsste man für einen nativen Client für Android (später auch iOS) machen?"). **Revised on 17 October 2026** after the user's request "Mache einen Plan für die App-Erstellung. Ich selbst habe ein iPhone, Android müsste ich über einen Emulator testen." Stage 1 begun on 20 October 2026 (below).

What the revision changes:

1. **The prerequisite is met:** reporting and blocking (`docs/PLAN-reports.md`, stages 1 to 4) are built and released (section 0). Stage 5 of that plan, the notice while offline, is the push of this plan (section 6.1).
2. **The test devices:** the user has an iPhone and no Android phone. Android can only be tried in the emulator, which cannot answer the questions that decide the architecture (section 3). This puts decision 5 of 25 September ("Android alone first") up for review (section 9).
3. **A new open point, the Mac:** iOS builds, signing and debugging the web view need macOS (section 4).
4. **Facts checked on 17 October 2026** (Capacitor version, store rules, fees; section 10) instead of knowledge alone.

The decisions of 25 September 2026 still stand unless section 9 says otherwise. Proposals in this file are Claude's until the user confirms them.

**Stage 1 begun on 20 October 2026** (user: "lass uns mit dem mobile plan beginnen"): the shell `apps/mobile` with both native projects, the app's `Platform`, Android's back button, the app page's policy, icons and start screens from the brand. Built and checked without a device; what is left of stage 1 is in section 5, what was built in `docs/features/mobile.md`.

---

## 0. Prerequisite: reporting and blocking (checked 17 October 2026)

| Part of `docs/PLAN-reports.md` | State |
|---|---|
| Stage 1: reports on a chat server, queue, `MANAGE_REPORTS` | built 26 September 2026, released with server 0.4.0 |
| Stage 2: delete on ban, moderation log | built 26 September 2026, released with server 0.4.0 |
| Stage 3: blocking members (sealed settings) | built 27 September 2026, released with server 0.5.0 / desktop app 0.8.0 |
| Stage 4: reports to the directory (direct messages, accounts, whole servers), refused servers in the client | built 26/27 September 2026, released with server 0.5.3; rules of use linked since 2 October 2026 |
| Stage 5: push while offline | **open, part of this plan** (section 6.1) |

So Apple's guideline 1.2 (report, block, act on reports) has its building blocks. Housekeeping: the head of `docs/features/reports.md` (line 9) still says stages 3 to 5 are open; stages 3 and 4 are built.

## 1. What exists already

- **One build, several shells** (`docs/features/desktop.md`, decision of 18 September 2026): the desktop app is an Electron shell around `apps/web/dist`, served from `app://squorli`; every difference goes through the `Platform` interface in `apps/web/src/platform/` (`types.ts`, `bridge.ts`, `desktop.ts`, `web.ts`, `mobile.ts`). A mobile shell becomes the third implementation (`platform/native.ts` or similar).
- **The client without a home server** (`docs/features/desktop.md`, P1): starts from the directory account and opens the server viewed last. The app needs exactly that.
- **Phones in the browser** (19 September 2026): `platform/mobile.ts`, the narrow layout in `App.tsx`, `MobileVoicePreview.tsx`, push-to-talk button, microphone boost limits for phones. Never checked on a real phone (test campaign T2).
- **Secrets in the browser are sealed** (5 October 2026, `apps/web/src/browserSecrets.ts`): seed, server accounts and session tokens as AES-GCM ciphertext in localStorage under a non-exportable key in IndexedDB. In a web view this works as in a browser; the Keychain/Keystore (6.3) replaces the key's home, not the scheme.
- **CORS of chat servers and the directory:** `origin: true` on both (`apps/server/src/index.ts`, `squorli-directory/apps/directory/src/index.ts`, checked 20 October 2026), and neither WebSocket checks the Origin header: an app origin needs nothing on either side. Only the device lists' "where from" (`signInOrigin`) does not know the app's origins yet (section 5, stage 1).
- **Reconnect** after a lost connection exists (`docs/features/offline.md`, `serverConnection.ts` with backoff). On a phone this becomes the normal case after every return to the front.
- **Notifications** exist for the desktop and opt-in in browsers, never on phones (`docs/features/notifications.md`). Native notifications go into the same `Platform` hook.

## 2. Which way (decided 25 September 2026: Capacitor)

**Capacitor 8** (the current major on 17 October 2026; minimum iOS 15, Android 7 / API 24, Xcode 26, Android Studio 2025.2.1) as shell around `apps/web/dist` in a new `apps/mobile`. A UI change reaches browser, desktop and phone at once.

The one technical unknown is **voice in the background**, above all on iOS (6.2). If WKWebView cannot carry it, voice on iOS moves into a native plugin on LiveKit's Swift SDK while the UI stays in the web view (the hybrid of 25 September). That hybrid is much more work than it sounds, because the voice core is web audio (`voiceClient.ts`, `micBoost.ts`, `levelMatch.ts`, the speech gate, per-person volume, the radio) and a native room's video tracks cannot be drawn in the web view. Section 9, decision N2, sets the scope of a first iOS version for that case.

## 3. Test devices: what each can prove

| Question | iPhone (real) | Android emulator | Real Android phone |
|---|---|---|---|
| Shell starts, sign-in, directory, text, layout, safe areas, keyboard | yes | yes | yes |
| Microphone and camera permission flow | yes | yes (host microphone must be switched on in the extended controls; off by default) | yes |
| Voice in the foreground, both ways | yes | roughly (host microphone, emulated audio path) | yes |
| **Voice with the screen off / app in background for 30 minutes** | **yes** | **no reliable answer** (no real battery saving, no vendor-specific app killing) | yes |
| Earpiece / speaker / Bluetooth headset, interruption by a phone call | yes | no | yes |
| Push (FCM / APNs) end to end | yes (needs the Apple account) | yes with a Google Play system image | yes |
| Real mobile network, change Wi-Fi to mobile data during a call | yes | no | yes |

Consequences (proposals):

- **The decisive measurement is possible only on iOS today.** The iPhone is the device that can answer the question that decides the architecture, and iOS is where the risk is largest (6.2).
- **The emulator is enough for building the Android shell** (stage 1), not for accepting it.
- **Before an Android store release a real phone is needed:** a used mid-range phone with a current Android is enough. Google Play's closed test (section 7) needs 12 testers anyway, so friends with Android phones can carry part of this.

## 4. The Mac question (open, decision N1)

Capacitor's iOS project is built, signed and run with Xcode, which exists only on macOS. Debugging the WKWebView (console, network, breakpoints) goes through Safari's Web Inspector on a Mac with the iPhone attached.

| Option | What it gives | What it costs |
|---|---|---|
| **A. An own Mac** (a used Apple Silicon Mac mini suffices) | Xcode, the iPhone attached by cable, Safari's Web Inspector, fast build-try loops; also the macOS desktop app (`docs/PLAN.md` 3.3) and its signing | the purchase (price not researched) |
| B. Cloud builds without a Mac: a macOS runner in GitHub Actions (or a Capacitor build service such as Capawesome or Capgo) builds, signs and uploads to TestFlight; the iPhone installs from TestFlight | no hardware | every try is a full build and upload (minutes per round), no web inspector: debugging only through the client's own debug view (`?debug`) and logs sent home; signing certificates and profiles have to be set up by hand in CI |

**Proposal: A.** The iOS prototype is a measuring job with many short rounds (start, background, screen off, listen, adjust, again); B makes each round slow and blind. B is still worth setting up later for releases, as the desktop app's release runs in CI.

## 5. Stages (revised order, proposal)

Times are rough guesses by Claude, not measured; they assume Claude writes most of the code and the user runs the device tests.

### Stage 0: accounts and tools (before any code that needs them)

- Apple Developer Program (needed for anything on the iPhone beyond a few days of free provisioning, and for push and TestFlight); Google Play developer account. **First decide who the publisher is** (N3): a person or the planned company.
- The Mac (N1), Xcode, Android Studio with an emulator image that has Google Play services (for FCM).

### Stage 1: the shell, for both platforms at once (about 1 to 2 weeks)

`apps/mobile` with Capacitor 8, iOS and Android projects in the repository, `apps/web/dist` copied in at build time.

- The `Platform` implementation for the app (`platform/native.ts`): `mobile: true`, desktop-only functions reported as unavailable, as in the browser.
- Fixed origin (iOS `capacitor://localhost`, Android `https://localhost` by default, or a custom host); check that the directory accepts it (CORS, the sign-in's sign domain). The origin is final once a public version exists.
- Sign-in from the directory account, server rail, text, direct messages.
- The UI points of 6.4: safe areas (`viewport-fit=cover`), Android's back button, the keyboard over the input, long press for the context menus.
- Microphone and camera permissions (`NSMicrophoneUsageDescription`, `NSCameraUsageDescription`; Android's runtime permissions), voice **in the foreground**.

**Done when:** on the iPhone (stage 1 build through Xcode or TestFlight) and in the Android emulator: sign in, write, join a voice channel and talk in the foreground.

**State on 20 October 2026:** built: `apps/mobile` (Capacitor 8.5.3, iOS with the Swift Package Manager, both projects committed, `sync`), `platform/mobileApp.ts`, the fixed origin (Capacitor's defaults, final once public), the app page's CSP and `viewport-fit=cover`, safe areas through System Bars, the Keyboard plugin, Android's back button (`backStack.ts`), permissions and their texts, icons and start screens (`tools/mobile-icons.mjs`), the version in both projects, no Android backup; the device lists name the app ("Squorli App auf Android" "über die mobile App", `MOBILE_APP_ORIGIN`; both repositories, 20 October 2026, `docs/features/devices.md`). Checked in headless Chrome as an Android phone with a stand-in bridge (`docs/features/mobile.md`). **Left of stage 1:**
- the first build and run: **Android done on 20 October 2026** (Android Studio, the SDK and the emulator on the development machine, the app runs there; `docs/features/mobile.md`), Xcode on a Mac for the iPhone (N1) still open;
- the "Done when" above on both;
- long press for `VoiceMemberMenu` and the member menu (on iOS a long press fires no `contextmenu`; the stage's tiles and the sidebar's voice members have no other way to their menu);
- the app's own wording where the browser's says "Tab" or "Browser" (`login.createDirectoryHint` and others; the desktop app's `i18n/app.*.ts` speak of windows and Windows and are not taken);
- German texts for the iOS permission questions (`InfoPlist.strings`, added in Xcode);
- Renovate: one group for every `@capacitor/*` package in both `package.json` files, and the note in its merge requests that `pnpm --filter @squorli/mobile sync` has to run (`native.test.mjs` fails until then); its Gradle, Gradle wrapper and Swift managers kept out of `apps/mobile` (the template's versions, `Package.swift` is written by `cap sync`).

### Stage 2: the background measurement (2 to 3 days per platform)

Unchanged from 25 September in content, swapped in order: **iOS first on the iPhone**, Android in the emulator only as a smoke test, the real Android measurement once a phone is there.

- iOS: background mode `audio`, an `AVAudioSession` set by a small plugin (play-and-record, Bluetooth, speaker). Measure: app in the background, screen off, 30 minutes, sound both ways; a phone call in between; headset on and off. Known risk: reports from iOS 14.7 to 15.1 describe WKWebView muting `getUserMedia` in the background while native `AVAudioSession` capture keeps working, without a fix from Apple. Whether that still holds on current iOS is **not known**; the measurement says it.
- Android: a foreground service of type `microphone` (and `mediaPlayback`) with its standing notification; same measurement, with and without the service.

**Result decides N2.**

### Stage 3: voice on iOS according to N2

- If the web view holds: only the audio session plugin and the standing controls (mute, deafen, leave) from the lock screen if wanted.
- If it does not: the scope decided in N2 (a first version with voice in the foreground only, or a native audio plugin). The native plugin is a project of its own and gets its own plan file before it is built.

### Stage 4: push through the directory (about 1 to 2 weeks, two repositories)

As in 6.1: device tokens at the directory, the chat server's "news for account X" call, the relay to APNs and FCM, wake-up or count only (decision 2). Direct messages and mentions first. This also closes stage 5 of `docs/PLAN-reports.md` (a push to moderators for a new report).

### Stage 5: keys, links, polish

Keychain/Keystore (6.3), App Links and Universal Links with the two `/.well-known` files on squorli.com (6.4), badge count, the notification taps opening the conversation, the privacy statement and the store forms (section 7).

### Stage 6: test releases

- iOS: TestFlight, first to the user, then a small external group (external TestFlight needs Apple's beta review).
- Android: an internal test, then the **closed test with at least 12 testers for 14 days in a row** that a personal account created after 13 November 2023 needs before production.
- Test campaign T2 (`docs/PLAN.md` section 5) on both platforms with real phones.

### Stage 7: store releases, then later work

Store submissions (iOS and Android in the order the tests finish). Later: screen share (Android via MediaProjection, iOS via a Broadcast Upload Extension), UnifiedPush/F-Droid, live updates.

## 6. Work any way needs (kept from 25 September, updated)

### 6.1 Push notifications

- In the background the WebSockets die (iOS suspends within seconds, Android sooner or later). Without push nothing arrives while the app is closed.
- FCM and APNs need the app publisher's credentials, which a self-hosted server cannot have, so **the directory relays**: the chat server tells the directory "something new for account X on server Y" (a new server-to-directory call next to `DirectoryNotifyRequest`), the directory sends it through FCM/APNs to the account's devices.
- Content: only a wake-up or a count (decision 2). iOS shows a visible notification only with text or a Notification Service Extension; for the end-to-end encrypted direct messages such an extension can decrypt on the device (later).
- New in the directory: device tokens per account (platform, app version, last seen), registration and removal by a signed account action, rate limits per server, its own FCM service account and APNs key.
- New on the chat server: when to push (mentions, replies, channels set to "all messages"; mutes and read states of `docs/features/mentions-unread.md` apply), directory accounts only; server accounts (`~name`) get none (decision 3).
- Privacy: a new data flow (which server has news for which account; tokens at Google and Apple), into the privacy statement.

### 6.2 Voice in the background, audio session

- **iOS:** background mode `audio` (or `voip`), an own `AVAudioSession`. CallKit optional. See stage 2 for the known risk.
- **Android:** foreground service `microphone`/`mediaPlayback` with a standing notification; audio focus, earpiece/speaker/Bluetooth, phone calls. Whether Android's WebView keeps WebRTC running with the screen off while the service holds the process is not checked.
- **Back in front:** reconnect both WebSockets, fetch what was missed, rejoin LiveKit if the room dropped.

### 6.3 Keys and sign-in

- The non-exportable key of `browserSecrets.ts` moves to the Keychain (iOS) / Keystore (Android) through a secure storage plugin behind the `Platform` interface; the desktop app has the same point open (`safeStorage`), one interface for both.
- iOS can clear a web view's IndexedDB under storage pressure; with the key in the Keychain the sealed secrets stay openable. **Not checked** how often WKWebView in an app actually loses its storage.

### 6.4 Platform functions and UI

- Links: `squorli://`, App Links and Universal Links for `https://squorli.com/...` invites; `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` in the website's `public/`.
- Camera front/rear, badge count (`platform.window.attention`), notifications through the existing interface.
- Safe areas, Android's back button (close modal, then back to the channel list), on-screen keyboard, touch targets, long press for `VoiceMemberMenu` and the member menu.
- No screen share in the first version (decision 6).

### 6.5 Versions and releases

- Store updates take days: new apps must work with older servers and the other way round for longer than today; the `PROTOCOL_VERSION` rule and optional fields become more important.
- Tag scheme `mobile-v<semver>`, release notes like the desktop app's, a `mobile-release` skill.
- No live updates of the web bundle at first.

## 7. Stores and law

- **Apple 1.2 (user-generated content):** report, block and act on reports are built (section 0). A network of self-hosted servers the publisher does not moderate can still make the review harder; the directory's server refusal (`refusedServers.ts`) is the answer to "how do you act".
- **Account deletion in the app** (Apple 5.1.1(v)): exists (directory account page, server accounts in the settings); must be reachable in the app.
- Privacy forms in both stores, the privacy statement (6.1).
- Apple's export question (`ITSAppUsesNonExemptEncryption`): standard algorithms for the direct messages; to be declared.
- **Accounts:** Apple Developer Program 99 USD a year (the euro price is shown at enrolment). As a person the app is listed under the person's name, no D-U-N-S number; as an organisation it needs a legal entity, a D-U-N-S number, a business e-mail on the organisation's domain and a public website. Google Play: 25 USD once. **The 12-tester closed test applies to personal accounts**, per Google's help page.
- **Publisher and the company:** the earlier conversation about founding a company for hosting (Einzelunternehmen or UG) touches this: an app published by a person and moved to a UG later is extra work (not checked how much). Decision N3.
- License: the app is part of the Apache 2.0 repository; the plugins' licenses into `docs/features/licenses.md`.

## 8. Risks

| Risk | Handling |
|---|---|
| WKWebView mutes voice in the background | measured first (stage 2); N2 sets the fallback |
| Android behaviour unknown without a real phone | emulator for building only; a real phone before release (section 3) |
| iOS work without a Mac is slow and blind | N1 |
| Review rejection on 1.2 | reports and blocking built; prepare a short review note on how moderation and server refusal work |
| Store updates lag behind server releases | protocol compatibility rules (6.5) |
| One developer, three clients' shells | everything through `Platform`; no second UI |

## 9. Decisions

Of 25 September 2026, still standing: 1 (Capacitor), 2 (push content), 3 (no push for server accounts), 4 (reports first; done), 6 (no screen share in version 1).

**To decide now (proposals by Claude):**

- **5 (revised): order of the platforms.** Proposal: build the shell for both at once (stage 1), measure on iOS first (stage 2), release whichever is ready first. Reason: the iPhone is the only real device, and iOS carries the largest risk. Was: "Android alone first, iOS afterwards".
- **N1: Mac.** Proposal: buy a used Apple Silicon Mac mini (option A, section 4).
- **N2: iOS voice if the web view fails in the background.** Options: (a) version 1 with voice in the foreground only, clearly said in the app, text and push fully there; native audio plugin as version 1.1. (b) Native audio plugin before the first release. Proposal: (a), decided after stage 2.
- **N3: publisher in the stores.** Person or the planned company; decide before the first upload.
- **N4: an Android test phone.** Proposal: a used one before stage 6.

**Made by Claude in stage 1 and confirmed by the user on 20 October 2026 ("deine Entscheidungen sind akzeptiert"):** the app id `com.squorli.app` (bundle id and application id; final after the first upload); the origins `capacitor://localhost` and `https://localhost` (Capacitor's defaults; final once public); no backup and no device transfer of the app's data on Android (the device keys belong to one installation; iOS still backs up, 6.3); Android's back sends the app to the background instead of ending it; the version from `apps/mobile/package.json` with the build number major * 1000000 + minor * 1000 + patch; the English permission texts; the app page's CSP = the desktop app's; Capacitor pinned to exact versions.

## 10. Checked and not checked

**Checked on 17 October 2026 (web):** Capacitor 8 is the supported major with its minimum versions (capacitorjs.com support policy); Google Play's 12 testers / 14 days rule for personal accounts after 13 November 2023 (Google Play Console help); the Apple Developer Program's 99 USD and the person/organisation requirements (developer.apple.com enrolment help); Google Play's 25 USD (a vendor article, not Google); the emulator's host microphone is off by default (developer.android.com); reports of WKWebView muting the microphone in the background on iOS 14.7 to 15.1 (Apple developer forums).

**Checked in the repository (state of 14 October 2026, commit 692e0e5):** the reporting stages, `browserSecrets.ts`, CORS of the chat server, the platform files.

**Checked on 20 October 2026:** the directory's CORS (`origin: true`) and that no WebSocket checks the origin; Capacitor 8.5.3 is current (8.5.3 of 7 October, Capacitor 9 only as development builds); `cap add ios` and `cap sync ios` work on Windows (Swift Package Manager, no CocoaPods); Capacitor's Android bridge asks for RECORD_AUDIO/CAMERA when the page asks for the microphone or the camera and grants without looking at the origin, iOS's grants every capture request; both hand `window.open` and links with target _blank to the system (Capacitor's sources); System Bars: with `viewport-fit=cover` a WebView from 140 on gets the real `env(safe-area-inset-*)`, an older one is padded natively (Capacitor's source).

**Not checked:** anything run on a device; WKWebView's background audio on current iOS; Android WebView with a foreground service; the current store review wording beyond the points above; the euro price at Apple; the effort of moving an app to another publisher; the price of a Mac.
