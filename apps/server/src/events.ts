import type { Message } from "@squorli/protocol";

/**
 * What happened on the server, said once more inside the process (docs/features/plugins.md, 15 November 2026). The routes keep
 * calling their broadcasts themselves; next to each they tell this emitter, and whoever wants to react (the plugins) listens
 * here. An event is told after the database has it, never before, and a listener that throws never fails the action that
 * caused it.
 */

/**
 * Who caused an event. A plugin's own doing carries its id and how deep in a chain of plugin reactions it stands: a plugin
 * never gets what it caused itself, and nothing deeper than `MAX_EVENT_DEPTH` is handed to plugins at all (two plugins
 * answering each other end there).
 */
export type Origin =
  | { kind: "user"; userId: string }
  | { kind: "reaction"; userId: string }
  | { kind: "plugin"; pluginId: string; depth: number }
  | { kind: "system" };

export const MAX_EVENT_DEPTH = 3;

export type ServerEvents = {
  /** A new membership (not a sign-in of somebody who was a member already). */
  "member.join": { userId: string };
  /** The membership ended: removed by a moderator, or the account was deleted. */
  "member.leave": { userId: string; reason: "kicked" | "banned" | "deleted" };
  /** A member's roles changed; only the difference, never the default role. */
  "member.roles": { userId: string; added: string[]; removed: string[] };
  /** A role was deleted (its members lost it without a `member.roles` each). */
  "role.delete": { roleId: string; name: string };
  "message.create": { message: Message };
  /** The text changed. Not told for a notice toggle, a preview that arrived or a reaction. */
  "message.update": { message: Message };
  "message.delete": { channelId: string; messageIds: string[] };
};

export type ServerEventName = keyof ServerEvents;
export type ServerEventOf<K extends ServerEventName> = { name: K; payload: ServerEvents[K]; origin: Origin; depth: number };
type Listener = (event: { [K in ServerEventName]: ServerEventOf<K> }[ServerEventName]) => void;

/** How deep an event stands: 0 for anything a person or the server itself did, one more than its cause for a plugin's doing. */
export function depthOf(origin: Origin): number {
  return origin.kind === "plugin" ? origin.depth + 1 : 0;
}

export class ServerEventBus {
  private readonly listeners = new Set<Listener>();
  /** Where a throwing listener is reported (index.ts sets the server's log). */
  onError: (err: unknown, name: ServerEventName) => void = () => {};

  /** Listen to every event; returns the function that stops it. */
  listen(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Synchronous and never throwing: the caller is a route that has done its work already. */
  emit<K extends ServerEventName>(name: K, payload: ServerEvents[K], origin: Origin): void {
    if (this.listeners.size === 0) return;
    const event = { name, payload, origin, depth: depthOf(origin) } as Parameters<Listener>[0];
    for (const fn of this.listeners) {
      try { fn(event); } catch (err) { this.onError(err, name); }
    }
  }
}

/** The one instance, like `visibility`: the routes import it instead of getting it handed through every register function. */
export const serverEvents = new ServerEventBus();
