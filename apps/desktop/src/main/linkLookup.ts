import { createHeadParser, lookUpPage, lookUpYoutubeVideo } from "@squorli/link-preview";
import { IPC, type BridgeLinkLookup } from "@squorli/web/platform/bridge";
import { ipcMain, type IpcMainInvokeEvent } from "electron";

/**
 * Looks a link up for the preview of a direct message (docs/features/link-previews.md). Direct messages are end-to-end
 * encrypted, so the SENDER's client makes the preview, and a page cannot read a foreign site. The app can: the request goes
 * straight from this computer to the linked host, exactly what happens when the sender opens the link, and no server learns
 * which link was sent. The rules are the shared package's (public hosts only, caps, one deadline): a link a friend made the
 * user send must not reach the user's own network either. The page's head is read in a worker thread with a time budget
 * (`workerFile` = out/preview-worker.cjs next to the main bundle, previewWorker.ts; security audit of 5 October 2026, H-1),
 * so a page built to stall the parser cannot freeze the app's main process.
 */
const PER_MINUTE = 30;
const CONCURRENT = 4;

/** What the client may ask for: an http(s) address or a YouTube video id; anything else is no request. */
export function readLinkLookupRequest(value: unknown): { url: string } | { youtube: string } | null {
  if (!value || typeof value !== "object") return null;
  const { url, youtube } = value as { url?: unknown; youtube?: unknown };
  if (typeof youtube === "string" && /^[\w-]{11}$/.test(youtube) && url === undefined) return { youtube };
  if (typeof url === "string" && url.length <= 2100 && /^https?:\/\/[^/?#\s]/i.test(url) && youtube === undefined) return { url };
  return null;
}

export function handleLinkLookup(isClientFrame: (event: IpcMainInvokeEvent) => boolean, workerFile: string, log?: (text: string) => void): void {
  let running = 0;
  let recent: number[] = [];
  const parser = createHeadParser({ workerFile, warn: (msg, detail) => log?.(`${msg} ${JSON.stringify(detail)}`) });
  ipcMain.handle(IPC.linkLookup, async (event, raw: unknown): Promise<BridgeLinkLookup> => {
    const request = isClientFrame(event) ? readLinkLookupRequest(raw) : null;
    const now = Date.now();
    recent = recent.filter((t) => now - t < 60_000);
    if (!request || running >= CONCURRENT || recent.length >= PER_MINUTE) return { found: false };
    recent.push(now); running++;
    try {
      const found = "youtube" in request ? await lookUpYoutubeVideo(request.youtube, { parser }) : await lookUpPage(request.url, { parser });
      if (!found) return { found: false };
      return { found: true, kind: found.kind, siteName: found.siteName, title: found.title, description: found.description, image: found.image ? { mime: found.image.mime, data: new Uint8Array(found.image.bytes) } : null };
    } catch { return { found: false }; } finally { running--; }
  });
}
