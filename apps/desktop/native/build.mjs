// Builds the desktop app's native helpers (Windows only) into native/bin/win32-x64/:
//   native/window-audio/main.cpp -> squorli-window-audio.exe (a screen share's audio)
//   native/system-watch/main.cpp -> squorli-system-watch.exe (controller input and "display required" for the AFK detection)
// with the MSVC compiler of an installed Visual Studio / Build Tools (found through vswhere). The output is not committed:
// the release workflow runs this before packaging, developers run `pnpm --filter @squorli/desktop native` once.
// Without the helpers the app still works; a screen share then only offers the whole system's audio and the AFK detection
// does not see controllers (apps/desktop/AGENTS.md).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
if (process.platform !== "win32") { console.log("[native] nothing to build on this platform (the helper is Windows only)"); process.exit(0); }

const vswhere = join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
if (!existsSync(vswhere)) { console.error("[native] vswhere.exe not found: install Visual Studio or the Build Tools with the C++ workload"); process.exit(1); }
const vs = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
const vcvars = join(vs, "VC/Auxiliary/Build/vcvars64.bat");
if (!vs || !existsSync(vcvars)) { console.error("[native] no Visual Studio installation with the x64 C++ tools found"); process.exit(1); }

const outDir = join(here, "bin/win32-x64");
const objDir = join(tmpdir(), "squorli-native-obj");
mkdirSync(outDir, { recursive: true }); mkdirSync(objDir, { recursive: true });
const targets = [
  { source: "window-audio/main.cpp", exe: "squorli-window-audio.exe", libs: "mmdevapi.lib ole32.lib user32.lib" },
  { source: "system-watch/main.cpp", exe: "squorli-system-watch.exe", libs: "user32.lib xinput.lib hid.lib powrprof.lib shell32.lib" },
];
// A batch file keeps the quoting out of cmd's hands. Static runtime (/MT): the helpers must start on a machine without the VC++ redistributable.
const batch = join(objDir, "build.cmd");
writeFileSync(batch, [
  "@echo off",
  `call "${vcvars}" >nul || exit /b 1`,
  ...targets.map((t) => `cl /nologo /std:c++17 /O2 /MT /EHsc /W3 /DUNICODE /D_UNICODE /Fo"${objDir}\\\\" /Fe"${join(outDir, t.exe)}" "${join(here, t.source)}" /link /SUBSYSTEM:CONSOLE ${t.libs} || exit /b 1`),
].join("\r\n"));
// A running app holds its helpers open, and Windows lets such a file be renamed but not overwritten: the old one steps aside
// (deleted at the next build; electron-builder packs *.exe only) and comes back if the build fails.
const aside = (t) => `${join(outDir, t.exe)}.old`;
for (const t of targets) {
  try { rmSync(aside(t), { force: true }); } catch { /* still running from an earlier build */ }
  try { if (existsSync(join(outDir, t.exe))) renameSync(join(outDir, t.exe), aside(t)); } catch { /* the linker will say what is wrong */ }
}
const result = spawnSync("cmd.exe", ["/d", "/c", batch], { stdio: "inherit" });
for (const t of targets) if (!existsSync(join(outDir, t.exe)) && existsSync(aside(t))) { try { renameSync(aside(t), join(outDir, t.exe)); } catch { /* nothing more to do */ } }
if (result.status !== 0 || targets.some((t) => !existsSync(join(outDir, t.exe)))) { console.error("[native] build failed"); process.exit(1); }
for (const t of targets) console.log(`[native] ${join(outDir, t.exe)}`);
