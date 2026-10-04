import { moveInOrder } from "./serverOrder";

/**
 * The user's own order of a voice channel's tiles (4 October 2026, user's wish): drag a tile where you want it, for this stay
 * in the channel only (the voice client keeps the order in `VoiceState.tileOrder` until the room is left; nothing is stored).
 * The own tile stays first and is never moved; what the user placed comes in that order; everything else, newcomers
 * included, follows in the order it arrived. Keys of tiles that are gone are simply skipped.
 */
export function orderTiles<T extends { key: string }>(items: readonly T[], order: readonly string[], fixed: (item: T) => boolean): T[] {
  const first = items.filter(fixed);
  const movable = items.filter((i) => !fixed(i));
  const rank = new Map(order.map((k, i) => [k, i] as const));
  const placed = movable.filter((i) => rank.has(i.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const rest = movable.filter((i) => !rank.has(i.key));
  return [...first, ...placed, ...rest];
}

/**
 * The order after moving the movable tile at `from` in front of the one at `to` (`to` = count: last); indices count the
 * movable tiles only, in their shown order. The result names every movable tile, so later newcomers follow at the end.
 */
export function moveTile(movableKeys: readonly string[], from: number, to: number): string[] {
  return moveInOrder(movableKeys, from, to);
}
