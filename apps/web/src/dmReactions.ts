import { emojiKey, type DmControl, type ReactionChip } from "@squorli/protocol";

/**
 * Reactions in a direct message conversation (docs/features/reactions.md), pure and tested. A reaction is an encrypted
 * instruction (`DmControl` of kind `reaction`, dm.ts) like the removal of a preview: a message of its own that the
 * conversation shows as nothing (`visibleDms` in dmPreviews.ts drops it). What a message's chips are follows from folding
 * the loaded thread: the newest instruction per sender, message and emoji counts (`seq` orders them), only the two members
 * of the pair count (the directory relays nothing else, but the fold checks), and an instruction about a message that is
 * not loaded or was deleted changes nothing.
 */
export type DmReactionCarrier = { id: string; seq: number; from: string; control?: DmControl | undefined };
export type DmReactions = { chips: ReactionChip[]; /** Per emoji key: who reacted (their public keys, oldest first). */ who: Map<string, string[]> };

export function dmReactionsOf<T extends DmReactionCarrier>(list: readonly T[], myKey: string, peerKey: string): Map<string, DmReactions> {
  const known = new Set(list.filter((m) => !m.control).map((m) => m.id));
  // The newest word per (message, sender, emoji key), with the display form and the order of the first "on".
  const state = new Map<string, { on: boolean; emoji: string; firstAt: number }>();
  for (const m of [...list].sort((a, b) => a.seq - b.seq)) {
    const c = m.control;
    if (c?.type !== "reaction" || !known.has(c.id) || (m.from !== myKey && m.from !== peerKey)) continue;
    const k = `${c.id}\n${m.from}\n${emojiKey(c.emoji)}`;
    const prev = state.get(k);
    state.set(k, { on: c.on, emoji: prev?.emoji ?? c.emoji, firstAt: prev && prev.on ? prev.firstAt : m.seq });
  }
  const out = new Map<string, DmReactions>();
  const chipAt = new Map<string, { chip: ReactionChip; firstAt: number }>();
  for (const [k, s] of state) {
    if (!s.on) continue;
    const [id, from, key] = k.split("\n") as [string, string, string];
    const r = out.get(id) ?? out.set(id, { chips: [], who: new Map() }).get(id)!;
    const ck = `${id}\n${key}`;
    let entry = chipAt.get(ck);
    if (!entry) { entry = { chip: { emoji: s.emoji, count: 0, me: false }, firstAt: s.firstAt }; chipAt.set(ck, entry); r.chips.push(entry.chip); }
    entry.chip.count += 1;
    if (from === myKey) entry.chip.me = true;
    entry.firstAt = Math.min(entry.firstAt, s.firstAt);
    (r.who.get(key) ?? r.who.set(key, []).get(key)!).push(from);
  }
  for (const [id, r] of out) r.chips.sort((a, b) => chipAt.get(`${id}\n${emojiKey(a.emoji)}`)!.firstAt - chipAt.get(`${id}\n${emojiKey(b.emoji)}`)!.firstAt);
  return out;
}
