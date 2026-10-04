// Windows code signing of the desktop app (docs/features/desktop.md "Code signing", apps/desktop/AGENTS.md).
//
// electron-builder calls `sign` for every executable it packs (Squorli.exe, the uninstaller, the installer; electron-builder.yml
// `win.signtoolOptions.sign`), afterPack.cjs calls `signFile` for the native helpers. Every file goes to `ssign`, the
// command-line client for Certum SimplySign: the certificate's private key lives in Certum's cloud HSM, ssign hashes the file
// here, has the hash signed there and adds an RFC 3161 timestamp. The SimplySign login comes from the environment:
//   CERTUM_EMAIL   the SimplySign account
//   CERTUM_OTP     its TOTP seed (the pipeline's secret), or CERTUM_TOKEN = one current 6-digit code for a build by hand
// Without them nothing is signed and the build goes on (a developer's `dist`), unless SQUORLI_SIGN_REQUIRED=1: the release
// workflow sets it for a tag, so a release can never be built unsigned by accident. SSIGN names the executable (default: `ssign`
// on PATH).
const { execFileSync } = require("node:child_process");
const { basename } = require("node:path");

function credentials() {
  const email = process.env.CERTUM_EMAIL;
  const secret = process.env.CERTUM_OTP || process.env.CERTUM_TOKEN;
  if (email && secret) return true;
  if (process.env.SQUORLI_SIGN_REQUIRED === "1") {
    throw new Error("SQUORLI_SIGN_REQUIRED=1 but CERTUM_EMAIL and CERTUM_OTP (or CERTUM_TOKEN) are not set: refusing to build an unsigned release");
  }
  return false;
}

/** Signs one file in place. Returns false when the file was left unsigned on purpose (no credentials, not required). */
function signFile(file) {
  if (!credentials()) {
    console.log(`  • not signed (no Certum credentials in the environment)  file=${basename(file)}`);
    return false;
  }
  console.log(`  • signing through Certum SimplySign  file=${basename(file)}`);
  execFileSync(process.env.SSIGN || "ssign", [file], { stdio: "inherit", windowsHide: true });
  return true;
}

/** electron-builder's hook: once per file and hash algorithm (electron-builder.yml asks for sha256 only; a second pass would be a dual signature, which ssign does not do). */
async function sign(configuration) {
  if (configuration.hash !== "sha256") return;
  signFile(configuration.path);
}

module.exports = { sign, signFile };
