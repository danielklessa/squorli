import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db";
import { attachments, bans, serverSettings, users } from "../db/schema";
import type { Hub } from "../hub";
import type { LivekitAdmin } from "../livekit/admin";
import { SETTINGS_ID, broadcastStructure } from "../state";
import { visibility } from "../visibility";
import type { VoicePresence } from "../voice/presence";

/** WebSocket close code for "your account on this server was deleted" (the client goes to the login with a message, no reconnect). */
export const CLOSE_ACCOUNT_DELETED = 4012;

export type DeleteUserResult = "deleted" | "not_found" | "founder" | "not_pending" | "unavailable";

/**
 * Delete a user's account on this server, requested by the user through the directory. Order: refuse the first owner
 * (server_settings.owner_id, the server would lose its founder) before anything else, then `confirm` at the directory
 * (its 200 proves a pending, user-signed request for exactly this host and removes it there), then delete the `users` row,
 * and with it (cascade) sessions, membership, roles, bans, messages and attachment rows; attachment files are removed here.
 * A key the directory knows but we do not ("not_found") is confirmed anyway so the request does not stay pending.
 * Open connections are closed with 4012 and the member list is broadcast.
 */
export async function deleteUserAccount(
  app: FastifyInstance, db: Db, hub: Hub, presence: VoicePresence, publicKey: string,
  confirm: () => Promise<"confirmed" | "not_pending" | null>, lk: Pick<LivekitAdmin, "removeParticipant">,
): Promise<DeleteUserResult> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.publicKey, publicKey)).limit(1);
  if (u) {
    const [s] = await db.select({ ownerId: serverSettings.ownerId }).from(serverSettings).where(eq(serverSettings.id, SETTINGS_ID)).limit(1);
    if (s?.ownerId === u.id) return "founder";
  }
  const ok = await confirm();
  if (ok === null) return "unavailable";
  if (ok === "not_pending") return "not_pending";
  if (!u) return "not_found";
  const files = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.uploaderId, u.id));
  // A ban outlives the account (security audit, 2 October 2026, S5): it hung on the users row and went with its cascade, so a
  // banned directory account asked for its deletion and came back with the next invite. The row goes with everything of the
  // person's; a bare row with only the key (no name, no membership) carries the ban on, which is all the sign-in asks.
  await db.transaction(async (tx) => {
    const [ban] = await tx.select().from(bans).where(eq(bans.userId, u.id)).limit(1);
    await tx.delete(users).where(eq(users.id, u.id));
    if (ban) {
      const [bare] = await tx.insert(users).values({ publicKey }).returning({ id: users.id });
      await tx.insert(bans).values({ userId: bare!.id, bannedBy: ban.bannedBy, reason: ban.reason, createdAt: ban.createdAt });
    }
  });
  await app.removeAttachmentFiles(files.map((f) => f.id));
  // Voice is a connection of its own (LiveKit): the client hangs up when its socket goes, the server makes sure (security
  // audit, 2 October 2026, S4), as the suspension does.
  const channelId = presence.channelOfUser(u.id);
  presence.leaveUser(u.id);
  if (channelId) lk.removeParticipant(channelId, u.id).catch(() => {});
  visibility.dropUser(u.id);
  hub.closeUser(u.id, CLOSE_ACCOUNT_DELETED, "account_deleted");
  await broadcastStructure(db, hub, ["members"]);
  app.log.info({ userId: u.id, attachments: files.length }, "Konto auf Wunsch des Nutzers (ueber das Verzeichnis) geloescht");
  return "deleted";
}
