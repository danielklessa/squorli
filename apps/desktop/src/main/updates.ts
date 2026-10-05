import { app, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { autoUpdater, type UpdateDownloadedEvent } from "electron-updater";
import { EventEmitter } from "node:events";
import { IPC, type UpdateState } from "@squorli/web/platform/bridge";
import { loadConfig, saveConfig } from "./config";
import type { Splash } from "./splash";
import { mayInstallAtStart } from "./splashPage";
import { updateMode } from "./updateMode";
import { fetchSignature, signatureUrlOf, verifyDetachedSignature } from "./updateSignature";

/**
 * App updates (docs/features/desktop.md, P4). The app asks only `https://squorli.com/updates/stable/` (the address is baked in
 * at packaging: `publish` in electron-builder.yml -> resources/app-update.yml); the manifests there point at the release files
 * on GitHub with absolute addresses, and every download is checked against the sha512 of the manifest. The builds are
 * unsigned, so that manifest, fetched over TLS from squorli.com, is what the trust rests on.
 *
 * Windows (NSIS) and the AppImage update themselves. **At the start** (`checkAtStart`, user's wish of 20 September 2026) the
 * start window shows the check, the download with its progress and the installation, and the app restarts into the new
 * version before the client was ever shown. While the app runs, as before: download in the background, install when the
 * user restarts from the client's notice or quits. A deb installation cannot replace itself: it only learns that a version
 * exists (`manual`) and the client links to the download page. An unpackaged app has no updates.
 */
const CHECK_AFTER_START_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The start waits this long for the feed's answer; a slow or missing network must not keep the user from the app. */
const START_CHECK_TIMEOUT_MS = 10_000;
/** "Installing" stays readable for a moment before the app closes for the installer. */
const INSTALL_NOTICE_MS = 1500;

export type Updates = {
  state: () => UpdateState;
  /** The check at the start, shown in the start window. "installing" = the installer takes over and the app closes; "continue" = open the client. Never rejects. */
  checkAtStart(splash: Splash): Promise<"continue" | "installing">;
  /** A start without a start window (by the system, in the background): the first check comes a little later, as it always did. */
  checkSoon(): void;
};

export function handleUpdates(getWindow: () => BrowserWindow | null, isClientFrame: (event: IpcMainEvent) => boolean, beforeInstall: () => void): Updates {
  const mode = updateMode({ packaged: app.isPackaged, platform: process.platform, appImage: !!process.env.APPIMAGE });
  let state: UpdateState = mode === "none" ? { status: "unsupported" } : { status: "idle", checkedAt: null };
  // Unpackaged only, to see the start window's update steps without a feed: nothing is downloaded or installed.
  const fake = !app.isPackaged && process.argv.includes("--fake-update");
  if (mode === "none") return { state: () => state, checkAtStart: (splash) => fake ? fakeUpdate(splash) : Promise.resolve("continue"), checkSoon: () => {} };

  const tell = (next: UpdateState) => { state = next; const win = getWindow(); if (win && !win.isDestroyed()) win.webContents.send(IPC.updateState, state); };
  // Linux (the AppImage): nothing is installed before the download's detached GPG signature was checked against the baked-in
  // release key (updateSignature.ts, security audit of 5 October 2026, L-3); so the install at quit is switched on only once a
  // download passed. On Windows electron-updater checks the installer's code signature itself (verifyUpdateCodeSignature).
  const checksSignature = process.platform === "linux";
  autoUpdater.autoDownload = mode === "self";
  autoUpdater.autoInstallOnAppQuit = mode === "self" && !checksSignature;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  /** `verdict` (info, ok): a download was checked; only a good one is "ready" and may be installed. */
  const verdicts = new EventEmitter();
  async function signatureOk(info: UpdateDownloadedEvent): Promise<boolean> {
    if (!checksSignature) return true;
    const file = info.files[0]?.url ?? "";
    const base = autoUpdater.getFeedURL() ?? "";
    let url: string;
    try { url = new URL(file, base || undefined).href; } catch { tell({ status: "error", message: `update ${info.version} refused: no address for its signature` }); return false; }
    const signature = await fetchSignature(signatureUrlOf(url));
    const check = signature ? await verifyDetachedSignature(info.downloadedFile, signature) : { ok: false as const, reason: "the signature could not be fetched" };
    if (check.ok) return true;
    tell({ status: "error", message: `update ${info.version} refused: ${check.reason}` });
    return false;
  }

  autoUpdater.on("checking-for-update", () => tell({ status: "checking" }));
  autoUpdater.on("update-not-available", () => tell({ status: "idle", checkedAt: Date.now() }));
  autoUpdater.on("update-available", (info) => tell(mode === "manual" ? { status: "available", version: info.version, manual: true } : { status: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (progress) => { if (state.status === "downloading") tell({ ...state, percent: Math.round(progress.percent) }); });
  autoUpdater.on("update-downloaded", (info) => {
    void signatureOk(info).then((ok) => {
      if (ok) { tell({ status: "ready", version: info.version }); if (checksSignature) autoUpdater.autoInstallOnAppQuit = true; }
      verdicts.emit("verdict", info, ok);
    });
  });
  autoUpdater.on("error", (error) => tell({ status: "error", message: error.message.split("\n")[0]!.slice(0, 300) }));

  const check = () => { if (state.status !== "checking" && state.status !== "downloading" && state.status !== "ready") void autoUpdater.checkForUpdates().catch(() => { /* reported through the error event */ }); };
  setInterval(check, CHECK_EVERY_MS);
  ipcMain.on(IPC.updateCheck, (event) => { if (isClientFrame(event)) check(); });
  ipcMain.on(IPC.updateInstall, (event) => {
    if (!isClientFrame(event) || state.status !== "ready") return;
    beforeInstall();
    autoUpdater.quitAndInstall(false, true);
  });

  const userData = app.getPath("userData");
  function checkAtStart(splash: Splash): Promise<"continue" | "installing"> {
    // A deb cannot install anything: look, and let the client say what it found.
    if (mode !== "self") { check(); return Promise.resolve("continue"); }
    return new Promise((resolve) => {
      let open = true;
      const listeners: [string, (...args: never[]) => void][] = [];
      const on = (event: string, fn: (...args: never[]) => void) => { listeners.push([event, fn]); autoUpdater.on(event as "error", fn as () => void); };
      const finish = (result: "continue" | "installing") => {
        if (!open) return;
        open = false;
        clearTimeout(timer);
        for (const [event, fn] of listeners) autoUpdater.removeListener(event as "error", fn as () => void);
        verdicts.removeListener("verdict", onVerdict);
        resolve(result);
      };
      // Guards the check alone; once a download runs, the user has the progress in front of them and "install later".
      const timer = setTimeout(() => finish("continue"), START_CHECK_TIMEOUT_MS);
      const mayInstall = (version: string) => mayInstallAtStart(loadConfig(userData).updateAttempt, version);
      splash.show({ step: "checking" });
      on("update-not-available", () => finish("continue"));
      on("error", () => finish("continue"));
      on("update-available", (info: { version: string }) => {
        if (!open) return;
        if (!mayInstall(info.version)) { finish("continue"); return; }
        clearTimeout(timer);
        splash.show({ step: "downloading", version: info.version, percent: 0 });
        splash.onSkip(() => finish("continue")); // the download goes on; the client offers the restart once it is there
      });
      on("download-progress", (progress: { percent: number }) => { if (open && state.status === "downloading") splash.show({ step: "downloading", version: state.version, percent: progress.percent }); });
      // After the download AND its check (the verdict, above): a refused download opens the client, which shows the error.
      const onVerdict = (info: { version: string }, ok: boolean) => {
        if (!open) return;
        if (!ok || !mayInstall(info.version)) { finish("continue"); return; }
        splash.show({ step: "installing", version: info.version });
        saveConfig(userData, { ...loadConfig(userData), updateAttempt: info.version });
        setTimeout(() => {
          if (!open) return;
          // Silent, and start the app again afterwards. If the installer cannot be started, the client opens as ever.
          try { beforeInstall(); autoUpdater.quitAndInstall(true, true); finish("installing"); } catch { finish("continue"); }
        }, INSTALL_NOTICE_MS);
      };
      verdicts.on("verdict", onVerdict);
      void autoUpdater.checkForUpdates().catch(() => finish("continue"));
    });
  }

  return { state: () => state, checkAtStart, checkSoon: () => { setTimeout(check, CHECK_AFTER_START_MS); } };
}

/** `--fake-update` (unpackaged): the steps of an update at the start, for looking at the start window. Ends in "continue". */
async function fakeUpdate(splash: Splash): Promise<"continue"> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let skipped = false;
  splash.show({ step: "checking" });
  await wait(1500);
  splash.onSkip(() => { skipped = true; });
  for (let percent = 0; percent <= 100 && !skipped; percent += 5) { splash.show({ step: "downloading", version: "9.9.9", percent }); await wait(250); }
  if (!skipped) { splash.show({ step: "installing", version: "9.9.9" }); await wait(2500); }
  return "continue";
}
