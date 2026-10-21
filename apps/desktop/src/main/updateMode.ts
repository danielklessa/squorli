/**
 * How this installation can update: by itself (Windows installer, AppImage), by hand (a deb cannot replace itself, and the
 * unsigned macOS app may not: Squirrel.Mac installs only signed apps; the client links to the download page), or not at all
 * (unpackaged, other platforms). Pure (tested), no Electron import. macOS becomes "self" once the app is signed and notarized
 * (docs/features/desktop.md "macOS build", 21 October 2026).
 */
export function updateMode(o: { packaged: boolean; platform: string; appImage: boolean }): "self" | "manual" | "none" {
  if (!o.packaged) return "none";
  if (o.platform === "win32") return "self";
  if (o.platform === "linux") return o.appImage ? "self" : "manual";
  if (o.platform === "darwin") return "manual";
  return "none";
}
