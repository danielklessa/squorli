/**
 * Who watches my screen share (user's wish, 27 September 2026): LiveKit does not tell a sender who subscribed to its
 * track, so every client says whose shares it watches in its participant attribute `watching` (identities, comma
 * separated, sorted), and the sharer's stage shows those who name it (VoiceStage.tsx `ShareViewers`). Everybody in the
 * room can read the attribute, as they can see the room itself. Pure, tested.
 */
const MAX = 50;

export function watchingAttribute(identities: readonly string[]): string {
  return [...new Set(identities.filter((id) => id && !id.includes(",")))].sort().slice(0, MAX).join(",");
}

export function parseWatchingAttribute(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, MAX);
}

/** The participants who watch `identity`'s screen share, in the order of the room. */
export function viewersOf<P extends { identity: string; isLocal: boolean; watching: readonly string[] }>(participants: readonly P[], identity: string): P[] {
  return participants.filter((p) => !p.isLocal && p.identity !== identity && p.watching.includes(identity));
}
