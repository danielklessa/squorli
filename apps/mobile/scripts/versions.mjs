// The app's version in the native projects (pure, tested in versions.test.mjs). The source is apps/mobile/package.json:
// Android's build.gradle reads it itself, the Xcode project gets it written by scripts/sync.mjs.

/** The store's build number of a version, growing with it: 0.1.0 = 1000, 1.2.3 = 1002003 (Android's versionCode, iOS's CFBundleVersion). */
export function buildNumber(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!m) throw new Error(`not a version: ${version}`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 999 || patch > 999) throw new Error(`version ${version}: minor and patch must stay below 1000`);
  return major * 1_000_000 + minor * 1_000 + patch;
}

/** The Xcode project with `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` of every build configuration set to `version`. */
export function withIosVersion(pbxproj, version) {
  const marketing = version.replace(/[-+].*$/, "");
  if (!/MARKETING_VERSION = [^;]+;/.test(pbxproj) || !/CURRENT_PROJECT_VERSION = [^;]+;/.test(pbxproj)) throw new Error("project.pbxproj: no version settings found");
  return pbxproj
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketing};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber(version)};`);
}
