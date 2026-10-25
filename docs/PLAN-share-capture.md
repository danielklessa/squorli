# Plan: a game's share when the graphics unit is saturated

Part of the project description (entry point: root `AGENTS.md`, section 0; open work `docs/PLAN.md` 4). Written on 25 October 2026 after the diagnosis of 21 to 23 October 2026 (the user's reports: a viewer saw 5 fps of a Call of Duty share, the own preview stuttered) and the user's decision of 25 October 2026: live with the limitation for now, keep this plan for later.

Feature notes of what exists: `docs/features/voice-video.md` ("A game's share: smooth motion, and H.265 on the graphics unit", "A game's share when the graphics unit is saturated"). What adapts by itself and what the planned governor cannot fix: `docs/PLAN-share-adaptation.md`. Standing rules: `apps/web/src/voice/AGENTS.md`.

## 1. What was measured (23 October 2026)

- **The capture itself starves.** The graphics unit's load (nvidia-smi, per second) next to the app's capture rate (the `media-source` statistics of the share track, read per second over the DevTools protocol from the packaged app started with `--remote-debugging-port`): 85 to 91 % gave 28 to 30 fps, 97 to 99 % gave 14 to 23 fps, 100 % gave 6 to 13 fps, changing within the same second. In the game's menus (its 120-fps cap) every capture ran at 30 fps. The game: borderless fullscreen 2560x1440 at 165 Hz, frame rate uncapped, on an RTX 4080.
- **Everything after the capture is innocent.** The preview is the raw capture track (`track.attach()`, no dropped frames) and the encoder encodes exactly what it gets (`qualityLimitationReason: none`), so the sender's preview and every viewer show the same rate. Ruled out: the encoder, the LiveKit path, the viewer, window versus screen source, VRAM, hardware-accelerated GPU scheduling, HDR, Game Mode, other capture software on the machine.
- **The mechanism, as far as it is known.** Chromium's Windows capturers (Windows Graphics Capture for windows and screens) receive a frame only when the Desktop Window Manager composes one, and the capture of any monitor (also one without the game) followed the game's load second by second. Open since 25 October 2026: WebRTC's WGC session copies every frame on the graphics unit and then maps it with a blocking call in Chromium's own Direct3D context, which runs at the normal scheduling priority (`modules/desktop_capture/win/wgc_capture_session.cc`: `CopySubresourceRegion`, then `Map` with `D3D11_MAP_READ`), so the low rate may be that readback waiting behind the game's queue rather than DWM alone. A GDI readback of the game's monitor still saw more than 79 changes per second at 100 %, which fits the readback explanation better. Stage 2's test decides it.
- **What helps today, on the sender's side:** a frame cap in the game that keeps the graphics unit below saturation (140 to 150 on a 165 Hz monitor) or lower graphics settings. The readout is the debug panel's video row of the share (`DebugPanel.tsx`: the sender's fps and limitation reason; the fps equal the capture rate when nothing else limits).

## 2. Assessed and set aside (25 October 2026, the user's questions)

- **Hiding the own preview while a game runs.** The own tile is always on the stage while sharing (`voiceClient.ts` `refreshTiles`: the local participant counts as watching), and the main window never reports itself hidden (`backgroundThrottling: false` in `apps/desktop/src/main/index.ts`; Electron then draws and swaps frames for the whole window, also covered or minimized), so the preview is drawn while playing. It costs one 1080p texture draw per captured frame and never touches the capture chain: it attaches to the captured track, there is no second capture. It cannot raise the capture rate; at most it would save a little of Squorli's own GPU work, measurable with the per-process GPU engine counters (`\GPU Engine(*)\Utilization Percentage`, instances `pid_<pid>_..._engtype_3D`). Not planned.
- **A higher CPU priority for Squorli's processes** (`os.setPriority` from the main process on every process of `app.getAppMetrics()`; HIGH works without administrator rights, REALTIME does not). The wrong bottleneck: the limitation reason stayed "none" while the graphics unit was saturated. It would only help with a game that saturates every core. Not planned; the priority that matches the problem is the graphics unit's (stage 2).

## 3. Stages for later

Each stage stands on its own. Stages 1 and 3 are client work (`apps/web`, so a desktop app release each, root `AGENTS.md` section 4); stage 2 adds a native helper to the desktop app; stage 4 is a different product.

### Stage 1: make it visible (small)

- The capture rate (`media-source` `framesPerSecond`) next to the encoder's fps and limitation reason in the debug panel and in the own tile's statistics overlay (the sender's rows of `docs/PLAN-share-adaptation.md`, stage 1).
- A hint to the sender, once per share, when the capture stays well under 30 fps for about ten seconds with limitation "none": the graphics unit is saturated by the game, set a frame cap in the game (German and English, `apps/web/src/i18n`). Stage 4 of the adaptation plan ("cap the game's frame rate, a hint only") is the same hint.
- The website's user guide gets a troubleshooting sentence in both languages (`../squorli-website/docs/PLAN.md`).

### Stage 2: the GPU scheduling priority (test first)

The lever OBS gets when it is run as administrator: `D3DKMTSetProcessSchedulingPriorityClass(process, D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH)` for the processes that copy the capture and encode it (Chromium's GPU process and the video capture process; simplest: every Squorli process). HIGH and REALTIME need the privilege `SeIncreaseBasePriorityPrivilege`, which administrators have by default and a normal user does not; REALTIME hangs NVIDIA's driver in known cases (Sunshine and Apollo use HIGH).

- **The test (a quarter of an hour with the user at a match):** an elevated PowerShell script with a P/Invoke of `gdi32.dll` `D3DKMTSetProcessSchedulingPriorityClass` sets HIGH on every Squorli process while a share runs; compare the debug panel's fps before and after at 100 % GPU. The same with a separate Chrome capturing the screen (`--auto-select-desktop-capture-source`) to see the capturer alone.
- **If it works:** an opt-in in the desktop app's share settings ("die Übertragung bevorzugen", off by default) with one elevated step. Options to decide then: (a) a UAC prompt every time a share starts (simple, annoying); (b) a scheduled task registered once with highest privileges at the opt-in (one UAC prompt, afterwards the app starts the helper without one; antivirus heuristics dislike the pattern); (c) a Windows service (needs a per-machine installation, the app installs per user today). The helper (a third program next to `squorli-window-audio.exe` and `squorli-system-watch.exe`, `apps/desktop/native/`) takes the process IDs as arguments, sets the class and exits; it is signed like the app (`docs/features/release-signing.md`). Risks: the game's own frames come later while Squorli is preferred (a frame cap in the game stays the better advice), and a helper that raises priorities is what cheat detection looks at, so it never touches a foreign process.
- **If it does not work:** the Desktop Window Manager is the limit, not the readback; only the game's cap, the hint of stage 1 and stage 4 remain.

### Stage 3: a capture at 60 Hz with the encoder capped at 30

A game capped at 30 fps (or out of focus) yields about 22 encoded frames today, because the capture's 30 Hz and the game's 30 Hz do not line up. Capturing at 60 and leaving `maxFramerate: 30` to the encoder gives it 30 frames out of 60. Costs a readback per capture frame at 60 Hz, which is the very thing that starves; so only with GPU headroom and measured first. The H.265 ceiling that makes the quality scaler oscillate between 1080p and 720p on high-motion games is handled by the governor's hysteresis (`docs/PLAN-share-adaptation.md`, stage 2), not here.

### Stage 4: a game-hook capture (large, deferred)

What OBS "Game Capture" and Discord's overlay do: a DLL in the game's process hooks the call that presents a finished frame (Direct3D `IDXGISwapChain::Present`, OpenGL `SwapBuffers`, Vulkan `vkQueuePresentKHR` through a layer registered in the registry), copies the back buffer into a shared GPU texture inside the game's own command queue, and the capturing app opens that texture in its process. The copy cannot wait behind the game because it is part of the game; DWM and WGC are out of the path; every rendered frame arrives, also from an exclusive fullscreen.

What it would cost here:
- The hook DLL in C++ for Direct3D 9 to 12, OpenGL and Vulkan, 64 and 32 bit, plus an injector (elevated for elevated games), the shared texture handover with a keyed mutex, and the maintenance for new engines, drivers and Windows versions. A bug in the DLL crashes the user's game, not Squorli. OBS's `graphics-hook` is GPL-2.0 and may only serve as reference, never as code (`docs/PLAN.md` 1.1).
- The second problem is ours alone: Electron has no way to take a foreign GPU texture as a WebRTC video source. Discord solves it with its own Electron fork. The path over shared memory and a canvas costs about 500 MB/s of CPU copies at 1080p60 and would be worse than today. Realistically a Chromium patch and an own build of Electron.
- Anti-cheat: a new DLL in the game's process is unknown to EAC, BattlEye, Ricochet and Vanguard; the outcome ranges from a black capture to a refused start or a ban, and a whitelisting is separate work with every vendor. OBS's hook is signed and whitelisted after years.

Months of work with an uncertain outcome; out of proportion for the product today. Deferred by the user on 25 October 2026.

## 4. Open decisions for the user

1. Whether stage 2's test is run (needs the user at a match) and, if it works, which elevated step (a, b or c).
2. Whether stage 1's hint goes into the next client release on its own (small, no server change).

## 5. Order and effort

| Stage | Effort | Needs |
|---|---|---|
| 1 | half a day | an app release |
| 2, the test | a quarter of an hour with the user | nothing shipped |
| 2, the product path | two to three days (helper, elevation step, signing, settings) | an app release |
| 3 | half a day of measuring, small code | an app release, only with GPU headroom |
| 4 | months | a Chromium or Electron fork, anti-cheat whitelisting |
