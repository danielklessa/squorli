import { emojiKey, type Message, type MessageReactions, type ReactionChip, type ServerEvent } from "@squorli/protocol";

/**
 * Reactions in the channel cache (docs/features/reactions.md), pure and tested. A broadcast (`message.reactions`,
 * `message.update`) is one JSON for everybody and carries nobody's `me`; the client keeps its own flag across it and sets
 * it from `by`/`emoji`/`added` when the event is about its own doing. A REST answer and the history carry the real flag.
 */
type ReactionsEvent = Extract<ServerEvent, { type: "message.reactions" }>;

const sameKey = (a: string, b: string) => emojiKey(a) === emojiKey(b);

/** The chips after an event: the list replaced, my flag from the event when it was me, else kept from before. */
export function applyReactionEvent(list: readonly Message[], e: ReactionsEvent, myUserId: string | null): Message[] {
  return list.map((m) => {
    if (m.id !== e.messageId) return m;
    const prev = m.reactions ?? [];
    const reactions: ReactionChip[] = e.reactions.map((c) => ({
      ...c,
      me: e.by === myUserId && sameKey(c.emoji, e.emoji) ? e.added : (prev.find((p) => sameKey(p.emoji, c.emoji))?.me ?? false),
    }));
    return { ...m, reactions };
  });
}

/** A message that arrived whole (`message.update`): its chips with the flags I had before. */
export function keepMe(next: ReactionChip[] | undefined, prev: ReactionChip[] | undefined): ReactionChip[] | undefined {
  if (!next) return next;
  if (!prev?.length) return next;
  return next.map((c) => ({ ...c, me: prev.find((p) => sameKey(p.emoji, c.emoji))?.me ?? false }));
}

/** A REST answer (has my flag) replaces the message's chips. */
export function withReactions(list: readonly Message[], answer: MessageReactions): Message[] {
  return list.map((m) => (m.id === answer.messageId ? { ...m, reactions: answer.reactions } : m));
}
