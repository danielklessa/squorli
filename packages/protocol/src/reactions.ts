import { z } from "zod";
import { Iso, ReactionEmoji, Uuid } from "./primitives";

/**
 * Emoji reactions on channel messages and reaction roles (6 October 2026, docs/features/reactions.md). The emoji rule itself
 * (`EMOJI_SOURCE`, `isSingleEmoji`, `emojiKey`, `ReactionEmoji`) lives in primitives.ts, which the directory's copy of the
 * protocol has too (direct messages carry reactions as a control, dm.ts). Not copied: this file is the chat server's part.
 *
 * No PROTOCOL_VERSION bump: `Message.reactions` and `ServerState.reactions` are optional (the feature flag), the event
 * `message.reactions` is one a client from before drops without harm (it sees the reactions on the next history load), and
 * everything a client does goes over REST. Emoji travel in a body or a query string, never in a path (a percent-encoded ZWJ
 * family is longer than Fastify's default parameter length).
 */

/** Distinct emoji a message may carry, the configured reaction roles included (so a rule never pushes a message past the cap). */
export const REACTIONS_PER_MESSAGE_MAX = 20;
/** How many of the people who reacted with one emoji a client asks for at once. */
export const REACTION_USERS_PAGE = 50;

/** One chip under a message. `roleId` = a reaction role is configured for this emoji (then the chip exists with count 0 too). */
export const ReactionChip = z.object({
  emoji: z.string().min(1),
  count: z.number().int().nonnegative(),
  /** The viewer reacted with it. Default false: a broadcast carries no viewer, the client keeps its own flag (apps/web/src/reactions.ts). */
  me: z.boolean().default(false),
  roleId: Uuid.optional(),
});
export type ReactionChip = z.infer<typeof ReactionChip>;
/** What the add and remove routes answer: the whole list of one message, `me` for the caller. */
export const MessageReactions = z.object({ messageId: Uuid, channelId: Uuid, reactions: z.array(ReactionChip) });
export type MessageReactions = z.infer<typeof MessageReactions>;
/** PUT /api/messages/:id/reactions and POST /api/messages/:id/reactions/remove. */
export const ReactRequest = z.object({ emoji: ReactionEmoji });
/** GET /api/messages/:id/reactions/users?emoji=: who reacted, oldest first; the client takes the names from the member list. */
export const ReactionUsersResponse = z.object({ userIds: z.array(Uuid), total: z.number().int().nonnegative() });
export type ReactionUsersResponse = z.infer<typeof ReactionUsersResponse>;

/** A rule "this emoji on this message gives that role". */
export const ReactionRole = z.object({
  id: Uuid,
  messageId: Uuid,
  channelId: Uuid,
  emoji: z.string().min(1),
  roleId: Uuid,
  /** Take the role away again when the member removes the reaction. Default off: "accept the rules" keeps the role (the user's decision). */
  removeOnUnreact: z.boolean(),
  createdAt: Iso,
});
export type ReactionRole = z.infer<typeof ReactionRole>;
/** PUT /api/messages/:id/reaction-roles: adds or changes the rule of that emoji on that message. */
export const SetReactionRoleRequest = z.object({ emoji: ReactionEmoji, roleId: Uuid, removeOnUnreact: z.boolean().default(false) });
export type SetReactionRoleRequest = z.infer<typeof SetReactionRoleRequest>;
export const ReactionRolesResponse = z.object({ rules: z.array(ReactionRole) });
export type ReactionRolesResponse = z.infer<typeof ReactionRolesResponse>;
/** Verwaltung > Reaktionsrollen (GET /api/reaction-roles): every rule with where it hangs; `excerpt` = the message's first characters. */
export const ReactionRoleOverviewEntry = ReactionRole.extend({ channelName: z.string(), excerpt: z.string(), authorId: Uuid });
export type ReactionRoleOverviewEntry = z.infer<typeof ReactionRoleOverviewEntry>;
export const ReactionRoleOverviewResponse = z.object({ rules: z.array(ReactionRoleOverviewEntry) });
export type ReactionRoleOverviewResponse = z.infer<typeof ReactionRoleOverviewResponse>;
export const REACTION_ROLE_EXCERPT_MAX = 120;
