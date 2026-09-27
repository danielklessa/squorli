import type { ScreenPickRequest, ScreenPickUpdate } from "./bridge";
import type { ScreenOffer, ScreenOfferState } from "./types";

/**
 * One question of the desktop shell which screen or window to share, as the client holds it; pure, tested. The shell asks at
 * once and fills the offer afterwards (user's wish, 28 September 2026: the dialog opens and the pictures load, instead of the
 * wait for them): `update` takes what it sends. `askPictures` reaches the shell once, however often the offer is asked.
 */
export function createScreenOffer(request: ScreenPickRequest, askPictures: (() => void) | null): { offer: ScreenOffer; update(next: ScreenPickUpdate): void } {
  let state: ScreenOfferState = { sources: request.sources, listing: request.listing === true };
  const listeners = new Set<() => void>();
  let asked = false;
  return {
    offer: {
      current: () => state,
      subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      loadPictures: () => { if (asked || !askPictures) return; asked = true; askPictures(); },
    },
    update: (next) => {
      if (next.requestId !== request.requestId) return;
      state = { sources: next.sources, listing: next.listing === true };
      for (const fn of [...listeners]) fn();
    },
  };
}
