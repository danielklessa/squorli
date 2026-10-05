import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DialogHost } from "./dialogs";
import { CrashScreen, ErrorBoundary } from "./ErrorBoundary";
import "./emoji/font.css";
import "./styles.css";
import { applyLocaleToDocument, locale } from "./i18n";
import { platform } from "./platform";
import { openBrowserSecretStore } from "./browserSecrets";
import { indexedDbVault } from "./deviceKey";
import { SECRET_STORAGE_KEYS, setDeviceVault, setKeyVault, setSecretStore } from "./identity";
import { TitleBar } from "./TitleBar";

applyLocaleToDocument();
// The account keys' seeds out of the page's reach where the platform holds them (desktop app, security audit C1).
setKeyVault(platform.keyVault);
// Device keys (docs/features/devices.md): made by the browser so that they cannot be read out, kept in IndexedDB. The same in
// the desktop app, whose window is a browser of its own; where there is no IndexedDB the keys are ordinary ones.
setDeviceVault(indexedDbVault("squorli-keys"));
// The desktop shell draws a few things itself (the window's context menu, the tray's menu) and follows the client's language.
platform.setLanguage?.(locale);

/**
 * Where the secrets live, before anything reads them (App.tsx): encrypted by the system where the platform can (desktop
 * app), else sealed by the browser with a key it keeps in IndexedDB (browserSecrets.ts, security audit of 5 October 2026,
 * M-2; a plain entry from before is sealed at this start), else localStorage as before (no WebCrypto or IndexedDB).
 */
async function secretStore() {
  if (platform.secretStore) return platform.secretStore;
  try { return await openBrowserSecretStore(SECRET_STORAGE_KEYS); } catch (err) { console.warn("secrets: the browser's store could not be opened", err); return null; }
}

// The interface failed (ErrorBoundary.tsx): a notice with "Neu laden" instead of an empty window. The desktop app keeps its
// title bar, inside a boundary of its own that shows nothing: should the bar be what fails, the notice still stands.
const crashed = (error: unknown) => <>
  <ErrorBoundary fallback={() => null}><TitleBar title="Squorli" /></ErrorBoundary>
  <CrashScreen error={error} onReload={() => window.location.reload()} />
</>;

void secretStore().then((store) => {
  setSecretStore(store);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {/* `ready`: an error in the first moments must not stay hidden behind the desktop app's start window. */}
      <ErrorBoundary fallback={crashed} onError={() => platform.window.ready()}>
        <App />
        <DialogHost />
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
