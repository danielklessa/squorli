import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, contentTypeOf, resolveAppFile } from "./appFiles";
import { appearanceState, normalizeAppearance, supportedMaterials } from "./appearance";
import { attentionText, badgeFile, readAttentionCount } from "./attention";
import { AUTOSTART_ARG, entryStarts, linuxAutostartEntry, linuxAutostartFile, linuxExecutable, readAutostartBackground, startedBySystem, startsInBackground } from "./autostart";
import { hwndOfHandle, hwndOfSource, isDesktopWidget } from "./captureSource";
import { findControl } from "./controlArgs";
import { findDeepLink } from "./deepLinkArgs";
import { E0_FLAG, keysLine, scanCodeOf } from "./keyCodes";
import { isAllowedExternal, windowOpenDecision } from "./navigation";
import { appIdRegistration, inFullscreen, readNotification } from "./notifications";
import { SPLASH_SKIP_URL, mayInstallAtStart, splashHtml, splashScript, splashView } from "./splashPage";
import { updateMode } from "./updateMode";
import { desktopUserAgent } from "./userAgent";
import { restoreWindowState } from "./windowState";

const root = join(sep === "\\" ? "C:\\app" : "/app", "renderer");

describe("resolveAppFile", () => {
  it("serves files, and index.html for the client's routes", () => {
    expect(resolveAppFile(root, "/")).toBe(join(root, "index.html"));
    expect(resolveAppFile(root, "/invite/abcdef")).toBe(join(root, "index.html"));
    expect(resolveAppFile(root, "/assets/main-abc.js")).toBe(join(root, "assets", "main-abc.js"));
    expect(resolveAppFile(root, "/player-window.html")).toBe(join(root, "player-window.html"));
    expect(resolveAppFile(root, "/brand/squorli%2Dicon.svg")).toBe(join(root, "brand", "squorli-icon.svg"));
  });
  it("never leaves the root", () => {
    for (const path of ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/..%2f..%2fsecret.txt", "/assets\\..\\..\\x.txt", "/%00.js", "/%E0%A4%A"]) expect(resolveAppFile(root, path), path).toBeNull();
  });
});

describe("contentTypeOf", () => {
  it("knows what the client ships", () => {
    expect(contentTypeOf("index.html")).toContain("text/html");
    expect(contentTypeOf("a/main.JS")).toContain("text/javascript");
    expect(contentTypeOf("font.woff2")).toBe("font/woff2");
    expect(contentTypeOf("unknown.bin")).toBe("application/octet-stream");
  });
});

describe("CONTENT_SECURITY_POLICY", () => {
  it("keeps scripts to the app and the blur's WASM host, frames to the two players", () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src https://player.twitch.tv https://www.youtube-nocookie.com;");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
  });
});

describe("desktopUserAgent", () => {
  const electron = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Squorli/0.1.0 Chrome/140.0.0.0 Electron/44.4.2 Safari/537.36";
  it("replaces Electron's app token and keeps Chrome", () => {
    expect(desktopUserAgent(electron, "1.2.3")).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Squorli-Desktop/1.2.3 Chrome/140.0.0.0 Electron/44.4.2 Safari/537.36");
  });
  it("works without an app token and with an odd default", () => {
    expect(desktopUserAgent(electron.replace("Squorli/0.1.0 ", ""), "1.2.3")).toContain("(KHTML, like Gecko) Squorli-Desktop/1.2.3 Chrome/140");
    expect(desktopUserAgent("Something/1.0", "1.2.3")).toBe("Something/1.0 Squorli-Desktop/1.2.3");
  });
});

describe("appearance", () => {
  it("offers mica on Windows 11 22H2 and later, a see-through window on Windows and Linux", () => {
    expect(supportedMaterials("win32", "10.0.26200")).toEqual(["mica", "clear"]);
    expect(supportedMaterials("win32", "10.0.22621")).toEqual(["mica", "clear"]);
    expect(supportedMaterials("win32", "10.0.19045")).toEqual(["clear"]);
    expect(supportedMaterials("linux", "6.8.0")).toEqual(["clear"]);
    expect(supportedMaterials("darwin", "24.0.0")).toEqual([]);
  });
  it("turns whatever was stored into a valid appearance", () => {
    const all = supportedMaterials("win32", "10.0.26200");
    expect(normalizeAppearance({ material: "clear", opacity: 0.75 }, all)).toEqual({ material: "clear", opacity: 0.75 });
    expect(normalizeAppearance({ material: "mica", opacity: 0.1 }, all)).toEqual({ material: "mica", opacity: 0.4 });
    expect(normalizeAppearance({ material: "mica", opacity: 7 }, ["clear"])).toEqual({ material: "none", opacity: 1 });
    expect(normalizeAppearance({ material: "acrylic", opacity: "x" }, all)).toEqual({ material: "none", opacity: 1 });
    for (const v of [null, undefined, 5, "clear", []]) expect(normalizeAppearance(v, all)).toEqual({ material: "none", opacity: 1 });
  });
  it("knows what the running window shows and when a restart is pending", () => {
    expect(appearanceState({ material: "mica", opacity: 0.8 }, false, "none")).toEqual({ appearance: { material: "mica", opacity: 0.8 }, effective: "mica", needsRestart: false });
    expect(appearanceState({ material: "clear", opacity: 0.8 }, false, "mica")).toEqual({ appearance: { material: "clear", opacity: 0.8 }, effective: "mica", needsRestart: true });
    expect(appearanceState({ material: "clear", opacity: 0.8 }, true, "clear")).toEqual({ appearance: { material: "clear", opacity: 0.8 }, effective: "clear", needsRestart: false });
    expect(appearanceState({ material: "none", opacity: 1 }, true, "clear")).toEqual({ appearance: { material: "none", opacity: 1 }, effective: "clear", needsRestart: true });
  });
});

describe("restoreWindowState", () => {
  const main = { x: 0, y: 0, width: 1920, height: 1040 }, left = { x: -2560, y: 0, width: 2560, height: 1400 };
  it("reopens where the window was, also on a display left of the main one", () => {
    expect(restoreWindowState({ bounds: { x: 100, y: 80, width: 1300, height: 800 }, maximized: false }, [main])).toEqual({ bounds: { x: 100, y: 80, width: 1300, height: 800 }, maximized: false });
    expect(restoreWindowState({ bounds: { x: -2000, y: 200, width: 1300, height: 800 }, maximized: true }, [main, left])).toEqual({ bounds: { x: -2000, y: 200, width: 1300, height: 800 }, maximized: true });
  });
  it("falls back to the default place when the display is gone or the title bar would be out of reach", () => {
    expect(restoreWindowState({ bounds: { x: -2000, y: 200, width: 1300, height: 800 } }, [main])).toBeNull();
    expect(restoreWindowState({ bounds: { x: 100, y: -400, width: 1300, height: 800 } }, [main])).toBeNull();
    expect(restoreWindowState({ bounds: { x: 1900, y: 100, width: 1300, height: 800 } }, [main])).toBeNull();
  });
  it("clamps the size to the display and survives rubbish", () => {
    expect(restoreWindowState({ bounds: { x: 0, y: 0, width: 5000, height: 100 } }, [main])).toEqual({ bounds: { x: 0, y: 0, width: 1920, height: 480 }, maximized: false });
    for (const v of [null, undefined, 3, "x", {}, { bounds: { x: "1", y: 0, width: 1, height: 1 } }, { bounds: { x: NaN, y: 0, width: 800, height: 600 } }]) expect(restoreWindowState(v, [main])).toBeNull();
  });
});

describe("updateMode", () => {
  it("updates itself on Windows and as an AppImage, by hand as a deb, never unpackaged", () => {
    expect(updateMode({ packaged: true, platform: "win32", appImage: false })).toBe("self");
    expect(updateMode({ packaged: true, platform: "linux", appImage: true })).toBe("self");
    expect(updateMode({ packaged: true, platform: "linux", appImage: false })).toBe("manual");
    expect(updateMode({ packaged: true, platform: "darwin", appImage: false })).toBe("none");
    expect(updateMode({ packaged: false, platform: "win32", appImage: false })).toBe("none");
  });
});

describe("captureSource", () => {
  it("reads the window handle of a source id and of Electron's handle buffer", () => {
    expect(hwndOfSource("window:1312345:0")).toBe("1312345");
    expect(hwndOfSource("screen:0:0")).toBeNull();
    for (const id of ["window:abc:0", "window:12", "window:1 --x:0", ""]) expect(hwndOfSource(id), id).toBeNull();
    expect(hwndOfHandle(Uint8Array.from([0x59, 0x06, 0x14, 0x00, 0, 0, 0, 0]))).toBe(String(0x140659));
    expect(hwndOfHandle(Uint8Array.from([0x39, 0x30, 0, 0]))).toBe("12345");
  });

  it("leaves desktop widgets out of the picker", () => {
    const rainmeter = "C:" + String.fromCharCode(92) + "Program Files" + String.fromCharCode(92) + "Rainmeter" + String.fromCharCode(92) + "Rainmeter.exe";
    expect(isDesktopWidget({ hwnd: "1", tool: true, className: "RainmeterMeterWindow", path: rainmeter, fullscreen: false })).toBe(true);
    expect(isDesktopWidget({ hwnd: "1", tool: false, className: "RainmeterMeterWindow", path: "", fullscreen: false })).toBe(true);
    expect(isDesktopWidget({ hwnd: "1", tool: false, className: "Other", path: rainmeter, fullscreen: false })).toBe(true);
    expect(isDesktopWidget({ hwnd: "1", tool: true, className: "SomeWidget", path: "", fullscreen: false })).toBe(true);
    expect(isDesktopWidget({ hwnd: "1", tool: false, className: "Chrome_WidgetWin_1", path: "C:/Apps/NotRainmeter.exe", fullscreen: false })).toBe(false);
    expect(isDesktopWidget({ hwnd: "1", tool: false, className: "UnrealWindow", path: "", fullscreen: false })).toBe(false);
  });
});

describe("findDeepLink", () => {
  it("finds the link among the arguments the system passes", () => {
    expect(findDeepLink(["C:/Users/someone/AppData/Local/Programs/Squorli/Squorli.exe", "--allow-file-access-from-files", "--","squorli://invite/chat.example.org/abcdef"])).toBe("squorli://invite/chat.example.org/abcdef");
    expect(findDeepLink(["squorli", "SQUORLI://server/Chat.Example.org"])).toBe("SQUORLI://server/Chat.Example.org");
  });
  it("ignores everything that is no valid link", () => {
    expect(findDeepLink(["Squorli.exe", "--dev-url=http://evil.example", "squorli://server/evil.example --inspect=0.0.0.0:9229", "squorli://open/x", "https://chat.example.org"])).toBeNull();
    expect(findDeepLink([])).toBeNull();
  });
});

describe("navigation", () => {
  const origins = ["app://squorli"];
  it("opens only the client's own windows", () => {
    expect(windowOpenDecision("about:blank", origins)).toBe("allow");
    expect(windowOpenDecision("app://squorli/player-window.html?src=x", origins)).toBe("allow");
    expect(windowOpenDecision("app://squorli/other.html", origins)).toBe("deny");
    expect(windowOpenDecision("https://example.org/", origins)).toBe("external");
    expect(windowOpenDecision("mailto:someone@example.org", origins)).toBe("external");
    for (const url of ["file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "smb://host/share", "squorli://server/x.example", "app://evil/player-window.html", "not a url"]) expect(windowOpenDecision(url, origins), url).toBe("deny");
  });
  it("hands only web and mail addresses to the system", () => {
    expect(isAllowedExternal("https://squorli.com/de/download/")).toBe(true);
    expect(isAllowedExternal("http://localhost:3100/")).toBe(true);
    expect(isAllowedExternal("mailto:a@example.org")).toBe(true);
    for (const url of ["file:///etc/passwd", "ms-settings:privacy", "javascript:alert(1)", "", "C:\\Windows\\system32\\calc.exe"]) expect(isAllowedExternal(url), url).toBe(false);
  });
});

describe("link lookup for direct messages", () => {
  it("takes an http(s) address or a video id from the client and nothing else", async () => {
    const { readLinkLookupRequest } = await import("./linkLookup");
    expect(readLinkLookupRequest({ url: "https://example.org/a?b=1" })).toEqual({ url: "https://example.org/a?b=1" });
    expect(readLinkLookupRequest({ youtube: "aqz-KE-bpKQ" })).toEqual({ youtube: "aqz-KE-bpKQ" });
    for (const bad of [null, "https://example.org", {}, { url: "file:///C:/Windows/win.ini" }, { url: "javascript:alert(1)" }, { url: "https://" }, { url: `https://example.org/${"x".repeat(2100)}` },
      { youtube: "zu-kurz" }, { url: "https://example.org", youtube: "aqz-KE-bpKQ" }, { url: 5 }]) expect(readLinkLookupRequest(bad)).toBeNull();
  });
});

describe("player audio output", () => {
  it("knows the two player frames and nothing else", async () => {
    const { isPlayerFrameUrl } = await import("./playerAudioScript");
    expect(isPlayerFrameUrl("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?enablejsapi=1")).toBe(true);
    expect(isPlayerFrameUrl("https://player.twitch.tv/?channel=x&parent=squorli")).toBe(true);
    for (const url of ["https://www.youtube.com/embed/aqz-KE-bpKQ", "https://player.twitch.tv.evil.example/", "http://player.twitch.tv/", "app://squorli/", "about:blank", "", undefined]) expect(isPlayerFrameUrl(url)).toBe(false);
  });

  it("tells the chat's players from the radio's by the mark in the address", async () => {
    const { playerKindOf } = await import("./playerAudioScript");
    expect(playerKindOf("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?enablejsapi=1")).toBe("radio");
    expect(playerKindOf("https://player.twitch.tv/?channel=x&parent=squorli")).toBe("radio");
    expect(playerKindOf("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1&rel=0#squorli-chat")).toBe("chat");
    expect(playerKindOf("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ#anders")).toBe("radio");
    for (const url of ["https://www.youtube.com/embed/aqz-KE-bpKQ#squorli-chat", "app://squorli/#squorli-chat", "", undefined]) expect(playerKindOf(url)).toBeNull();
  });

  it("takes a label or nothing from the client, and carries the label into the script as data", async () => {
    const { playerAudioScript, readPlayerOutputLabel } = await import("./playerAudioScript");
    expect(readPlayerOutputLabel("Lautsprecher (Realtek)")).toBe("Lautsprecher (Realtek)");
    for (const bad of [null, undefined, "", 7, {}, "x".repeat(513)]) expect(readPlayerOutputLabel(bad)).toBeNull();
    const label = 'Speakers"); alert(1); ("';
    expect(playerAudioScript(label).endsWith(`)(${JSON.stringify(label)})`)).toBe(true);
    expect(playerAudioScript(null).endsWith(")(null)")).toBe(true);
    // The script parses, whatever the label.
    expect(() => new Function(`return ${playerAudioScript(label)}`)).not.toThrow();
  });
});

describe("attention mark", () => {
  it("takes only a sensible count from the client", () => {
    expect(readAttentionCount(3)).toBe(3);
    expect(readAttentionCount(2.9)).toBe(2);
    expect(readAttentionCount(1e9)).toBe(9999);
    for (const bad of [0, -1, Number.NaN, Infinity, "3", null, undefined, {}]) expect(readAttentionCount(bad), String(bad)).toBe(0);
  });
  it("names an image per count and says what waits", () => {
    expect(badgeFile(0)).toBeNull();
    expect(badgeFile(1)).toBe("badge-1.png");
    expect(badgeFile(9)).toBe("badge-9.png");
    expect(badgeFile(10)).toBe("badge-9plus.png");
    expect(attentionText(0, true)).toBe("Squorli");
    expect(attentionText(1, true)).toContain("1 neue Nachricht ");
    expect(attentionText(4, false)).toContain("4 new messages");
  });
});

describe("start with the system", () => {
  it("knows a start by the system from its argument", () => {
    expect(startedBySystem(["squorli.exe", AUTOSTART_ARG])).toBe(true);
    expect(startedBySystem(["squorli.exe", "squorli://server/x"])).toBe(false);
  });
  it("keeps such a start in the background unless the user wants the window opened", () => {
    for (const stored of [undefined, true, "no", null]) expect(readAutostartBackground(stored), String(stored)).toBe(true);
    expect(readAutostartBackground(false)).toBe(false);
    expect(startsInBackground(["squorli.exe", AUTOSTART_ARG], undefined)).toBe(true);
    expect(startsInBackground(["squorli.exe", AUTOSTART_ARG], false)).toBe(false);
    expect(startsInBackground(["squorli.exe"], true)).toBe(false); // started by the user: always opened
  });
  it("writes a desktop entry into the user's autostart folder on Linux", () => {
    expect(linuxAutostartFile({ XDG_CONFIG_HOME: "/cfg", HOME: "/home/a" })).toBe(join("/cfg", "autostart", "squorli.desktop"));
    expect(linuxAutostartFile({ HOME: "/home/a" })).toBe(join("/home/a", ".config", "autostart", "squorli.desktop"));
    expect(linuxAutostartFile({})).toBeNull();
    expect(linuxExecutable({ APPIMAGE: "/home/a/Apps/Squorli.AppImage" }, "/tmp/.mount_x/squorli")).toBe("/home/a/Apps/Squorli.AppImage");
    expect(linuxExecutable({}, "/opt/Squorli/squorli")).toBe("/opt/Squorli/squorli");
    const entry = linuxAutostartEntry("/home/a/My Apps/Squorli 100%.AppImage");
    expect(entry).toContain('Exec="/home/a/My Apps/Squorli 100%%.AppImage" --autostart\n');
    expect(entry.startsWith("[Desktop Entry]\nType=Application\n")).toBe(true);
    expect(linuxAutostartEntry('/x/a"b$c')).toContain('Exec="/x/a\\"b\\$c" --autostart');
    expect(entryStarts(entry, "/home/a/My Apps/Squorli 100%.AppImage")).toBe(true);
    expect(entryStarts(entry, "/home/a/Squorli-2.AppImage")).toBe(false);
  });
});

describe("start window", () => {
  it("says what happens at each step, and lets only the download be skipped", () => {
    expect(splashView({ step: "checking" }, true)).toEqual({ text: "Suche nach Updates …", percent: null, skip: null });
    expect(splashView({ step: "downloading", version: "1.2.3", percent: 41.6 }, true)).toEqual({ text: "Update 1.2.3 wird geladen …", percent: 42, skip: "Später installieren" });
    expect(splashView({ step: "downloading", version: "1.2.3", percent: 250 }, false).percent).toBe(100);
    expect(splashView({ step: "installing", version: "1.2.3" }, false)).toEqual({ text: "Installing update 1.2.3. Squorli restarts in a moment.", percent: 100, skip: null });
    expect(splashView({ step: "starting" }, false).text).toBe("Starting Squorli …");
    expect(splashView({ step: "devServer", url: "http://localhost:5173" }, true)).toEqual({ text: "Der Vite-Dev-Server unter http://localhost:5173 antwortet nicht. `pnpm dev` starten (der Web-Client läuft darin mit); Squorli lädt dann von selbst.", percent: null, skip: null });
  });
  it("is a page without a script, and the shell's writes cannot break out of their strings", () => {
    const html = splashHtml("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(html).not.toContain("<script");
    expect(html).toContain(`href="${SPLASH_SKIP_URL}"`);
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(splashHtml(null)).not.toContain("<img");
    const script = splashScript({ text: 'x"); alert(1); ("', percent: 10, skip: null });
    expect(script).toContain(JSON.stringify('x"); alert(1); ("'));
    expect(() => new Function(script)).not.toThrow();
  });
  it("hands a version to the installer at a start only once", () => {
    expect(mayInstallAtStart(undefined, "0.2.0")).toBe(true);
    expect(mayInstallAtStart("0.1.9", "0.2.0")).toBe(true);
    expect(mayInstallAtStart("0.2.0", "0.2.0")).toBe(false); // offered again although it was installed at the last start: it did not take
  });
});

describe("findControl", () => {
  it("takes the first control link or --control argument and ignores everything else", () => {
    expect(findControl(["Squorli.exe", "--control=mic-toggle"], "k1")).toBe("mic-toggle");
    expect(findControl(["Squorli.exe", "--allow-file-access", "squorli://control/deafen-on"], "k1")).toBe("deafen-on");
    expect(findControl(["Squorli.exe", "--CONTROL=Mic-Off"], "k1")).toBe("mic-off");
    expect(findControl(["Squorli.exe", "squorli://server/example.org", "--control=quit", "--control=mic-on"], "k1")).toBe("mic-on");
    expect(findControl(["Squorli.exe", "squorli://control/quit"], "k1")).toBeNull();
    expect(findControl(["Squorli.exe"], "k1")).toBeNull();
  });
  it("takes a link that could open the microphone only with the installation's key", () => {
    expect(findControl(["Squorli.exe", "squorli://control/mic-on?k=secret"], "secret")).toBe("mic-on");
    expect(findControl(["Squorli.exe", "squorli://control/mic-on"], "secret")).toBeNull();
    expect(findControl(["Squorli.exe", "squorli://control/mic-toggle?k=wrong"], "secret")).toBeNull();
    expect(findControl(["Squorli.exe", "squorli://control/deafen-off?k=secre"], "secret")).toBeNull();
    expect(findControl(["Squorli.exe", "squorli://control/mic-off"], "secret")).toBe("mic-off");
  });
});

describe("scanCodeOf", () => {
  it("knows the keys by their place, E0-prefixed ones marked", () => {
    expect(scanCodeOf("Space")).toBe(0x39);
    expect(scanCodeOf("KeyV")).toBe(0x2f);
    expect(scanCodeOf("F13")).toBe(0x64);
    expect(scanCodeOf("F24")).toBe(0x76);
    expect(scanCodeOf("ControlLeft")).toBe(0x1d);
    expect(scanCodeOf("ControlRight")).toBe(0x1d | E0_FLAG);
    expect(scanCodeOf("ArrowUp")).toBe(0x48 | E0_FLAG);
    expect(scanCodeOf("Numpad8")).toBe(0x48);
    expect(scanCodeOf("MetaLeft")).toBe(0x5b | E0_FLAG);
    expect(scanCodeOf("Pause")).toBeNull();
    expect(scanCodeOf("toString")).toBeNull();
    expect(scanCodeOf("")).toBeNull();
  });
  it("writes the helper's keys line", () => {
    expect(keysLine([])).toBe("keys");
    expect(keysLine([0x39, 0x1d | E0_FLAG])).toBe("keys	39	11d");
  });
});

describe("readNotification", () => {
  it("takes strings, cuts them and refuses anything else", () => {
    expect(readNotification({ title: "Anna", body: "Hi", tag: "dm:abc" })).toEqual({ title: "Anna", body: "Hi", tag: "dm:abc", inFullscreen: false });
    expect(readNotification({ title: "Anna", body: "Hi", tag: "dm:abc", inFullscreen: true })?.inFullscreen).toBe(true);
    const long = readNotification({ title: "t", body: "x".repeat(1000), tag: "dm:abc" });
    expect(long?.body).toHaveLength(300);
    expect(readNotification({ title: " ", body: "", tag: "dm:abc" })).toBeNull();
    expect(readNotification({ title: "t", body: "", tag: "" })).toBeNull();
    expect(readNotification({ title: "t", body: 1, tag: "x" })).toBeNull();
    expect(readNotification("dm:abc")).toBeNull();
  });
});

describe("inFullscreen", () => {
  it("counts Windows' full screen states and a window that covers its monitor", () => {
    expect(inFullscreen(5, false)).toBe(false);
    expect(inFullscreen(0, false)).toBe(false);
    expect(inFullscreen(6, false)).toBe(false);
    for (const state of [2, 3, 4, 7]) expect(inFullscreen(state, false)).toBe(true);
    expect(inFullscreen(5, true)).toBe(true);
  });
  it("registers name and icon under the app's id", () => {
    expect(appIdRegistration("com.squorli.desktop", "Squorli", "C:\\x\\icon.png")).toEqual([
      ["add", "HKCU\\Software\\Classes\\AppUserModelId\\com.squorli.desktop", "/v", "DisplayName", "/t", "REG_SZ", "/d", "Squorli", "/f"],
      ["add", "HKCU\\Software\\Classes\\AppUserModelId\\com.squorli.desktop", "/v", "IconUri", "/t", "REG_SZ", "/d", "C:\\x\\icon.png", "/f"],
    ]);
  });
});
