# Plan: a screen share that stays smooth by itself

Part of the project description (entry point: root `AGENTS.md`, section 0; open work `docs/PLAN.md` 3.4 and decision 6.2). Written on 22 September 2026 after the user's report: a member shares a game with H.265, the user watches and sees a lagging picture on every share of that member. The user's wish: a way for a viewer to see a share's statistics (built the same day, stage 0), and a plan for adapting the resolution by itself and automating other optimisations on demand.

Feature notes of what exists: `docs/features/voice-video.md` ("A game's share: smooth motion, and H.265 on the graphics unit", "The viewer's statistics of a share"). Standing rules: `apps/web/src/voice/AGENTS.md`.

## 1. What adapts today, and what does not

The share of moving pictures (`voice/screenShareOptions.ts`) is published without simulcast, with a bitrate ceiling (H.265 6 Mbit/s, H.264 8 Mbit/s, VP8 5 Mbit/s), `maxFramerate: 30`, hint "motion" and `degradationPreference: "maintain-framerate"`.

Adapts by itself, at the sender, without any code of ours:
- **Bitrate.** WebRTC's congestion control (transport-cc, GCC) lowers the target below the ceiling as soon as the upload to LiveKit is tighter than that. The ceiling is an upper limit, never a fixed rate.
- **Resolution under a bandwidth limit.** With "maintain-framerate" Chromium scales the picture down (1080p, 720p, 540p, ...) when the target bitrate cannot carry the full picture, and scales back up when it can. `qualityLimitationReason: "bandwidth"` in the sender's statistics says so.
- **Resolution under a CPU limit**, likewise, when the encoder falls behind (`"cpu"`). Whether a hardware encoder ever reports it is not measured.
- **Codec, in one direction.** LiveKit's backup codec: once a viewer cannot decode H.265 or H.264, the whole share regresses to VP8 for everyone (the regression policy is my unconfirmed choice; whether it returns was not checked).

Does not adapt:
- **Nothing reacts to what the viewer sees.** The sender only learns of packet loss and round trip through RTCP (and congestion control reacts to that); freezes, a full jitter buffer or a slow decoder on the viewer's side reach nobody.
- **The frame rate ceiling** stays at 30, the capture at 1080p; a capture that starves (the game saturates the GPU) delivers fewer frames and no statistic of ours says so.
- **The codec** never changes for a running share, except by the regression above.
- **A hardware encoder's rate control** is looser than OpenH264's or libvpx's: Media Foundation encoders overshoot the target on keyframes and scene changes. The ceiling is the only handle.

## 2. Where a lag can come from, and what the numbers say

The viewer's statistics (stage 0) show per second: codec and decoder (hardware or software), picture size, frames received and decoded, bitrate, packet loss, round trip, jitter buffer, decode time per frame, spread of the frame spacing, freezes, dropped frames, keyframes, and a first diagnosis (`videoStats.ts` `diagnose`, my thresholds, not yet measured against real cases):

| Numbers | Points at | The fitting adaptation |
|---|---|---|
| Loss of a percent and more, buffer 200 ms and more, freezes with retransmits | The path sender - LiveKit - viewer | Lower bitrate (the viewer's download or the sender's upload); a smaller picture only as the means to that |
| Decoding over 25 ms per frame, a tenth of the frames dropped, decoder "software" | The viewer's computer | Fewer pixels (720p), or a codec the viewer decodes in hardware |
| An H.264/H.265 share arrives with under 20 fps while the path is clean | The sender's capture or encoder | Frame cap in the game, lower capture resolution; a lower bitrate does not help |
| 30 fps, no loss, small buffer, and still "laggy" | Latency, not stutter: the sum of capture, encode, network, buffer, decode, render | Measure the round trip and the buffer; LiveKit's jitter buffer grows with jitter |

The report of 22 September 2026 was classified the same day with the statistics: the sender's capture starves (about 11 fps arrive over a clean path), so the path is not the cause; the next step is the sender's own rows (stage 1).

## 3. Stages

Each stage is worth doing on its own; the later ones need the earlier ones' data. Everything stays in the client (`apps/web`, so a new desktop app release each time, root `AGENTS.md` section 4); LiveKit and the server stay untouched until stage 3.

### Stage 0: the viewer's statistics (built 22 September 2026, documented in `docs/features/voice-video.md`)

### Stage 1: classify the real case, then tune the thresholds

- ~~Read the statistics on the reported share~~ (done 22 September 2026, see section 2).
- Make the diagnosis thresholds match: they are my first guesses.
- Reproduce on purpose with two clients: Windows' `clumsy` (loss, lag, jitter on the viewer's side) or Linux `tc netem` in a container on the LiveKit side; a viewer started with `--disable-gpu` for software decoding; a sender with a game or the moving test picture of the Electron test recipe (`docs/features/voice-video.md`, 21 September 2026).
- Add the sender's side to the same overlay for the own share: `qualityLimitationReason`, encoder, target bitrate, fps, and the remote-inbound-rtp report's loss and round trip (what the viewers' RTCP says). Today only the debug view has part of it.

### Stage 2: the sender adapts by itself (a "share governor" in the voice core)

A small state machine in `voice/shareGovernor.ts` (pure, tested; driven by `VoiceClient` every 2 s from the sender's statistics), acting through `RTCRtpSender.setParameters()` on the running track, which changes nothing for the viewers except the picture: no republish, no interruption.

- **Ladder** (moving pictures): 1080p at the ceiling, 1080p at two thirds of it, 900p (scaleResolutionDownBy 1.2), 720p at half, 720p at a third, 540p. The standing VP8 share keeps "maintain-resolution" and is not governed (text has to stay readable; frames are the right thing to lose there).
- **Down** one rung when, for 5 s in a row: `qualityLimitationReason` is "cpu" or "bandwidth" with the resolution already scaled, or the encoded fps stay under 20, or the viewers' RTCP reports loss over 2 % or a round trip over 300 ms. **Up** one rung after 30 s without any of that, at most every 15 s, never above what the user picked.
- **Hysteresis** matters more than the thresholds: a ladder that oscillates is worse than a fixed 720p.
- What it cannot fix: a capture that starves at the game (stage 4 tells the user), a viewer's slow decoder (stage 3).
- Shown to the sender: a small line in the tile ("Übertragung angepasst: 720p, 3 Mbit/s") with a way to pin a rung by hand.

### Stage 3: viewers tell the sender how the picture arrives

The viewer's side is the one nobody sees today. Two ways, to be decided:

- **(a) Simulcast for moving pictures.** Two layers (1080p and 540p or 720p) of the H.264/H.265 share; LiveKit's `adaptiveStream` already switches every viewer to the layer that fits their bandwidth and tile, without any message of ours. Costs: a second encoder session on the sender's graphics unit (hardware encoders take it; OpenH264 doubles its CPU), and the coarse layer chosen for small tiles, which the standing share avoided on purpose for text (a game's share does not mind). Cheapest to build, worth measuring first.
- **(b) A quality report over LiveKit's data channel.** Every viewer of a share sends the sender, every 5 s and only while watching, the interval's freezes, buffer, decode time, fps and loss (`{ type: "share-quality", ... }`, reliable, to that participant only). The governor of stage 2 takes the worst viewer into account: decoder trouble there means fewer pixels, network trouble means fewer bits. Needs a small protocol (a zod schema in `packages/protocol`, the message never leaves the channel), and a rule for one bad viewer among many (do not drag everyone down for one; from two viewers on, the median).

### Stage 4: optimisations on demand, one click each

Before full automation, the human-in-the-loop version, which also covers what no governor can do:

- The viewer's tile gets a context menu entry "Übertragung ruckelt bei mir" that sends the sender the viewer's current statistics (the same message as 3b, once).
- The sender's client shows a notice with the diagnosis and one-click actions: 720p, ceiling 4 Mbit/s, switch to H.264 or VP8 (a republish, the viewers see a second of black), cap the game's frame rate (a hint only; the desktop app cannot do that). Each action is a rung the governor of stage 2 also knows.
- The same actions in the share dialog as defaults per game (`chat.games.v1`), so a game that lagged once starts at 720p the next time.

### Stage 5: an automatic codec switch (only if the data asks for it)

A codec change means a republish and a visible interruption for all viewers, so it is not a rung of the governor. Cases that would justify one, automatically, once each per share: the hardware encoder reports "cpu" at 720p (switch to the software H.264 or VP8); every viewer decodes in software (the codec is wrong for this audience). Decide after stage 1's data.

## 4. Open decisions for the user

1. ~~Stage 3 (a) simulcast or (b) quality reports, or (a) first and (b) only if needed~~ **decided by the user on 3 October 2026: (a) first, (b) only if the measurements ask for it** (skipped on 25 September 2026).
2. ~~Whether the governor may lower the picture below what the user picked in the dialog without asking~~ **decided by the user on 3 October 2026: yes, with the line in the tile and a way to pin** (skipped on 25 September 2026).
3. ~~Whether the standing VP8 share is ever governed~~ **decided by the user on 25 September 2026: no.**
4. The ladder's rungs and times (section 3, stage 2) once stage 1 has real numbers.

Priority (user, 25 September 2026): medium (`docs/PLAN.md` 3.4).

## 5. Order and effort

| Stage | Effort | Needs an app release |
|---|---|---|
| 1 | half a day of measuring, small code | yes, for the sender's rows |
| 2 | one day (state machine, tests, tile line) | yes |
| 3a | half a day plus measuring the encoder cost | yes |
| 3b | one day (protocol, sending, governor input) | yes |
| 4 | one day | yes |
| 5 | after stage 1 | yes |
