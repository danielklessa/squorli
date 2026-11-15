import { ApiError } from "./api";
import { t } from "./i18n";

/**
 * A server refusal as a sentence for the user. An ApiError's message is its request line ("POST /api/rtc-token -> 403
 * (forbidden)"), fine for a log and useless in a dialog (user's report, 23 September 2026). The codes are the ones the
 * routes send (apps/server/src/livekit/routes.ts, routes/members.ts); anything else keeps the bare message.
 */
type Key = Parameters<typeof t>[0];
const shared: Record<string, Key> = {
  confined: "voice.stickyBlocked",
  channel_full: "voice.joinErr.full",
  voice_seats_full: "voice.joinErr.seatsFull",
  unknown_channel: "voice.joinErr.gone",
};

/** POST /api/rtc-token before the voice client had a say. */
export function joinErrorText(err: unknown): string {
  // A channel block (docs/features/channel-blocks.md) says how long it still lasts; `until` null = permanent.
  if (err instanceof ApiError && err.code === "channel_blocked") {
    const until = typeof err.body.until === "string" ? err.body.until : null;
    if (until) return t("voice.joinErr.channelBlockedMinutes", { minutes: Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000)) });
    return t(err.body.until === null ? "voice.joinErr.channelBlockedForever" : "voice.joinErr.channelBlocked");
  }
  return explain(err, { ...shared, forbidden: "voice.joinErr.forbidden", votekicked: "voice.joinErr.votekicked" }, "voice.joinErr.generic");
}

/** POST /api/members/:id/move (a drag in the sidebar, the member list's menu). */
export function moveErrorText(err: unknown): string {
  return explain(err, { ...shared, confined: "members.moveErr.confined", forbidden: "members.moveErr.forbidden", not_found: "members.moveErr.gone", target_above_you: "members.moveErr.aboveYou", not_in_voice: "members.moveErr.notInVoice" }, "members.moveErr.generic");
}

/** PUT and DELETE /api/channels/:id/blocks (the member list's menu, the channel dialog). */
export function blockErrorText(err: unknown): string {
  return explain(err, { ...shared, forbidden: "members.blockErr.forbidden", target_above_you: "members.blockErr.aboveYou", not_found: "members.blockErr.gone" }, "members.blockErr.generic");
}

/** POST /api/channels/:id/votekick (the menu entry) and .../vote (the modal). */
export function voteKickErrorText(err: unknown): string {
  return explain(err, {
    votekick_disabled: "votekick.err.disabled", moderator_present: "votekick.err.moderator", too_few_members: "votekick.err.tooFew",
    not_in_channel: "votekick.err.notInChannel", target_not_in_channel: "votekick.err.targetGone", vote_running: "votekick.err.running",
    cooldown: "votekick.err.cooldown", no_vote: "votekick.err.noVote", not_eligible: "votekick.err.notEligible", already_voted: "votekick.err.alreadyVoted",
    unknown_channel: "voice.joinErr.gone",
  }, "votekick.err.generic");
}

/** PUT /api/messages/:id/reactions (a chip, the picker). */
export function reactionErrorText(err: unknown): string {
  return explain(err, { forbidden: "chat.reactForbidden", too_many_reactions: "chat.reactionsFull", reaction_roles_only: "chat.reactionRolesOnly", not_found: "chat.reactionGone", rate_limited: "chat.reactionRateLimited" }, "chat.reactionErr");
}

/** PUT /api/messages/:id/reaction-roles and DELETE /api/reaction-roles/:id (the rules dialog, Verwaltung > Reaktionsrollen). */
export function reactionRuleErrorText(err: unknown): string {
  return explain(err, { forbidden: "rr.err.forbidden", cannot_grant: "rr.err.cannot_grant", role_above_you: "rr.err.role_above_you", default_role: "rr.err.default_role", unknown_role: "rr.err.unknown_role", too_many_reactions: "chat.reactionsFull", not_found: "chat.reactionGone" }, "rr.err.generic");
}

/**
 * A refusal of the plugin routes (apps/server/src/routes/plugins.ts; docs/features/plugins.md): Verwaltung > Plugins, a
 * member action, a slash command. `detail` is the server's own `message` where it sends one (English and technical: the
 * parser's line for code that does not compile, the manifest's fault); it is shown below the sentence, never instead of it.
 */
const pluginKeys: Record<string, Key> = {
  plugins_operator_only: "plugin.err.plugins_operator_only", plugin_no_manifest: "plugin.err.plugin_no_manifest", plugin_bad_manifest: "plugin.err.plugin_bad_manifest",
  plugin_bad_code: "plugin.err.plugin_bad_code", plugin_bad_file_name: "plugin.err.plugin_bad_file_name", plugin_too_large: "plugin.err.plugin_too_large",
  plugin_api_too_new: "plugin.err.plugin_api_too_new", plugin_api_too_old: "plugin.err.plugin_api_too_old", too_many_plugins: "plugin.err.too_many_plugins",
  capabilities_changed: "plugin.err.capabilities_changed", plugin_incompatible: "plugin.err.plugin_incompatible", plugin_unavailable: "plugin.err.plugin_unavailable",
  plugin_failed: "plugin.err.plugin_failed", plugin_timeout: "plugin.err.plugin_timeout", unknown_plugin: "plugin.err.unknown_plugin", unknown_action: "plugin.err.unknown_action",
  unknown_command: "plugin.err.unknown_command", unknown_view: "plugin.err.unknown_view", invalid_values: "plugin.err.invalid_values", owner_only: "plugin.err.owner_only",
  forbidden: "plugin.err.forbidden", target_above_you: "plugin.err.target_above_you", self: "plugin.err.self", not_found: "plugin.err.not_found",
  unknown_channel: "voice.joinErr.gone", rate_limited: "err.rateLimited", bad_request: "plugin.err.bad_request",
};
export type PluginProblem = { text: string; detail: string | null };
export function pluginProblem(err: unknown): PluginProblem {
  if (!(err instanceof ApiError)) return { text: explain(err, pluginKeys, "plugin.err.generic"), detail: null };
  const detail = typeof err.body.message === "string" && err.body.message.trim() ? err.body.message.trim().slice(0, 600) : null;
  // The name of the command that is taken comes with the refusal.
  if (err.code === "command_taken") return { text: t("plugin.err.command_taken", { command: typeof err.body.command === "string" ? err.body.command : "?" }), detail };
  return { text: explain(err, pluginKeys, "plugin.err.generic"), detail };
}
export const pluginErrorText = (err: unknown): string => pluginProblem(err).text;

function explain(err: unknown, keys: Record<string, Key>, generic: Key): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  const key = err.code ? keys[err.code] : undefined;
  if (key) return t(key);
  if (err.status === 401) return t("voice.joinErr.session");
  return t(generic, { message: err.message });
}
