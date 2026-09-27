import { BrowserWindow, desktopCapturer, ipcMain, webContents, type DesktopCapturerSource, type IpcMainEvent, type Session } from "electron";
import { IPC, type ScreenPick, type ScreenSource } from "@squorli/web/platform/bridge";
import { hwndOfHandle, hwndOfSource, isDesktopWidget } from "./captureSource";
import type { GameLookup } from "./gameWatch";
import { PickOffer } from "./pickOffer";
import type { SystemWatch } from "./systemWatch";
import { helperPath, type ScreenAudioCapture } from "./windowAudio";

/**
 * Screen share: Electron has no picker of its own, so the client shows one (ScreenPicker.tsx). `getDisplayMedia()` in the page
 * lands here, the shell lists screens and windows, the page answers with the choice.
 *
 * The page is asked at once, before anything is listed, and the offer fills up afterwards (`PickOffer`, user's wish of
 * 28 September 2026: the dialog opens and the pictures load): the list with names and icons (thumbnail size 0, about 0.4 s),
 * then the thumbnails, screens and windows asked for side by side because the windows' take seconds. The thumbnails are made
 * only when the page asks for them (`IPC.screenPickPictures`): "Quick Share" answers from the list alone.
 *
 * Audio (Windows only; matrix in docs/features/voice-video.md): with the native helper (windowAudio.ts) a window carries what its application plays and a
 * screen what the system plays without this app; the helper's PCM goes to the client separately and Chromium gets no audio
 * to capture. Without the helper only a screen has audio: Chromium's "loopback" (everything, the app included). The app's
 * own windows never carry audio: it would be the voices of the others.
 *
 * What the system watch helper says about the windows (Windows) leaves desktop widgets out of the list (`isDesktopWidget`)
 * and marks a detected game's windows (`gameId`) and windows in full screen (`fullscreen`, the dialog lists them after the games): the client preselects H.264 for them and "Quick Share" picks one without
 * the dialog (docs/features/voice-video.md, 21 September 2026). The codec is the client's business; the shell ignores it.
 */
const PICK_TIMEOUT_MS = 120_000;
const THUMBNAIL = { width: 320, height: 180 };
const NO_THUMBNAIL = { width: 0, height: 0 };

export function handleDisplayMedia(ses: Session, isClientFrame: (event: IpcMainEvent) => boolean, capture: ScreenAudioCapture, watch: SystemWatch, games: GameLookup): void {
  let nextId = 1;
  const waiting = new Map<number, (pick: ScreenPick | null) => void>();
  ipcMain.on(IPC.screenPickAnswer, (event, requestId: unknown, pick: unknown) => {
    if (!isClientFrame(event) || typeof requestId !== "number") return;
    const p = pick as Partial<ScreenPick> | null;
    waiting.get(requestId)?.(p && typeof p.sourceId === "string" ? { sourceId: p.sourceId, audio: p.audio === true } : null);
  });
  // Requests whose thumbnails nobody asked for yet.
  const pictures = new Map<number, () => void>();
  ipcMain.on(IPC.screenPickPictures, (event, requestId: unknown) => {
    if (!isClientFrame(event) || typeof requestId !== "number") return;
    const make = pictures.get(requestId);
    pictures.delete(requestId);
    make?.();
  });

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const contents = request.frame ? webContents.fromFrame(request.frame) : undefined;
    // Refusing = an empty answer; the page sees the same error as after "cancel" in a browser's picker.
    const refuse = () => { try { callback({}); } catch { /* Electron throws on an empty answer in some versions; the request is refused either way */ } };
    if (!contents) { refuse(); return; }
    const offer = new PickOffer(nextId++);
    let answered = false;
    try {
      const windows = process.platform === "win32";
      const native = helperPath() !== null;
      const own = new Set(BrowserWindow.getAllWindows().map((w) => hwndOfHandle(w.getNativeWindowHandle())));
      const audioFor = (id: string): boolean => {
        if (!windows || !request.audioRequested) return false;
        const hwnd = hwndOfSource(id);
        return hwnd === null ? true : native && !own.has(hwnd);
      };
      const tell = (channel: string) => { if (!answered && !contents.isDestroyed()) contents.send(channel, offer.state()); };
      let found: DesktopCapturerSource[] = [];
      const list = async () => {
        try {
          const all = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: NO_THUMBNAIL, fetchWindowIcons: true });
          const infos = new Map((await watch.describeWindows(all.flatMap((s) => hwndOfSource(s.id) ?? []))).map((info) => [info.hwnd, info]));
          const infoOf = (id: string) => infos.get(hwndOfSource(id) ?? "");
          found = all.filter((s) => { const info = infoOf(s.id); return !info || !isDesktopWidget(info); });
          offer.list(found.map((s) => ({
            id: s.id, kind: s.id.startsWith("screen:") ? "screen" : "window", name: s.name,
            icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
            audio: audioFor(s.id), fullscreen: infoOf(s.id)?.fullscreen === true, gameId: games.gameOfProgram(infoOf(s.id)?.path ?? "")?.id ?? null,
          })));
        } catch { offer.list([]); /* nothing to offer: the dialog says so, the user closes it */ }
        tell(IPC.screenPickUpdate);
      };
      const picture = async (kind: ScreenSource["kind"]) => {
        const made = new Map<string, string>();
        try {
          for (const s of await desktopCapturer.getSources({ types: [kind], thumbnailSize: THUMBNAIL })) if (!s.thumbnail.isEmpty()) made.set(s.id, `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}`);
        } catch { /* the tiles keep their symbol */ }
        offer.made(kind, made);
        // Done before the list: the list carries them.
        if (offer.listed) tell(IPC.screenPickUpdate);
      };
      const pick = await new Promise<ScreenPick | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), PICK_TIMEOUT_MS);
        waiting.set(offer.requestId, (p) => { clearTimeout(timer); resolve(p); });
        pictures.set(offer.requestId, () => {
          if (answered) return;
          offer.making("screen"); offer.making("window");
          void picture("screen"); void picture("window");
          if (offer.listed) tell(IPC.screenPickUpdate);
        });
        tell(IPC.screenPickRequest);
        void list();
      });
      answered = true;
      const source = pick ? found.find((s) => s.id === pick.sourceId) : undefined;
      if (!pick || !source) { refuse(); return; }
      const withAudio = pick.audio && audioFor(source.id);
      if (withAudio && native) {
        // The helper's audio reaches the client on its own channel; a helper that does not start leaves the share without audio.
        const hwnd = hwndOfSource(source.id);
        void capture.start(hwnd !== null ? { kind: "window", hwnd } : { kind: "system" }, contents);
        callback({ video: source });
      } else callback({ video: source, ...(withAudio ? { audio: "loopback" as const } : {}) });
    } catch { refuse(); } finally { answered = true; waiting.delete(offer.requestId); pictures.delete(offer.requestId); }
  }, { useSystemPicker: false });
}
