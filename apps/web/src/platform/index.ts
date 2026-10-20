import type { DesktopBridge } from "./bridge";
import { desktopPlatform } from "./desktop";
import { inMobileApp, mobileAppPlatform, type CapacitorGlobal } from "./mobileApp";
import type { Platform } from "./types";
import { webPlatform } from "./web";

export type * from "./types";

declare global {
  interface Window { squorliDesktop?: DesktopBridge; Capacitor?: CapacitorGlobal }
}

/** The platform of this page: the desktop app when its preload script left a bridge, the mobile app when Capacitor's native bridge did, the browser otherwise. */
export const platform: Platform = window.squorliDesktop ? desktopPlatform(window.squorliDesktop)
  : inMobileApp(window.Capacitor) ? mobileAppPlatform(window.Capacitor)
  : webPlatform();
