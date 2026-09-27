# Plan: reporting, blocking, and deleting with evidence

Part of the project description (entry point: root `AGENTS.md`, section 0; open work `docs/PLAN.md` 3.1). Written on 25 September 2026. The question came from the mobile plan (`docs/PLAN-mobile.md`, open decision 4: the app stores require a way to report content and to block users), followed by the user's questions "wie muss das Löschen von Nachrichten funktionieren?" and "wie kann man melden (wenn es auf dem Server ist müsste ja der Servereigentümer benachrichtigt werden)"; the user asked for a plan of its own. **Stages 1 and 2 (section 8) were built on 26 September 2026: `docs/features/reports.md`; stage 4's direct messages later that day (the flag on a friend's message, the plain text inside the signed report, the directory's queue)** (server reports with snapshots, the queue in Verwaltung > Meldungen, the count on the rail, the notice to the reported person, delete on ban, the moderation log); sections 3 and 4 below describe what is built, with the choices Claude made listed in the feature note. **The rest of stage 4 (section 5.1: reports of accounts and chat servers, suspended accounts, refused servers, notices) was built on 27 September 2026.** Open here: stage 5 (push while offline) and the website (rules of use, guides). **All seven decisions of section 9 were made by the user on 25 September 2026, each as proposed** (plan cleanup; priority 1 of product work, `docs/PLAN.md` 3.1). Proposals elsewhere in the text that section 9 does not list are still Claude's.

This revises the former decision 3 of `docs/PLAN.md` (provisional since M2: "no audit log, no report function"); the user confirmed the revision on 25 September 2026. Reporting is worth having without an app too: every server operator in the EU who stores other people's content needs some way to receive notices (Digital Services Act; an assessment, not legal advice).

## 1. What exists

- **Deleting a channel message** (`apps/server/src/routes/messages.ts`, `DELETE /api/messages/:id`): the author, or whoever has `MANAGE_MESSAGES` in the channel ("Fremde Nachrichten löschen"). The row goes for good, attachment rows by cascade, attachment files by `removeAttachmentFiles`; every client gets `message.delete`. No trace of who deleted what.
- **Deleting a member's account on a server** (`apps/server/src/users/deleteUser.ts`) takes their messages and attachments along.
- **Direct messages** (`packages/protocol/src/friends.ts`, user's decision of 14 September 2026): the sender deletes for both sides within `DM_DELETE_BOTH_MS` (5 minutes), after that and the recipient always only for themselves. End-to-end encrypted: the directory never sees the content.
- **Blocking** exists only between friends (`friends.block`). On a server nobody can hide another member.
- **Moderation actions:** kick, ban with reason (`/api/bans`), channel blocks (`docs/features/channel-blocks.md`), vote kick. No report, no audit log.

## 2. Three kinds of report, three places

| What is reported | Goes to | Why |
|---|---|---|
| A message or a member on a chat server | **That server's moderators** (new permission, section 3); the owner always | The server belongs to its operator; only they can delete, kick, ban. Squorli as publisher has no access to a self-hosted server. |
| A direct message or a directory account (name, avatar) | **The directory's operator** | Direct messages and accounts live at the directory; no server moderator is in charge. |
| A whole chat server (its owner is the problem, or it exists for illegal content) | **The directory's operator** | The directory can drop the server from the server directory and refuse its registration; the app can refuse to open it. The stores expect the publisher of an app to be able to act. |

A report on a server can also be passed on to the directory's operator by the reporter ("the moderators do nothing"), which makes it the third kind.

The directory's side of kinds two and three is planned in the directory's own repository, which is not public; this plan only fixes what the client and the protocol need from it (section 5).

## 3. Reports on a chat server

**Permission:** `MANAGE_REPORTS` ("Meldungen bearbeiten"), server-wide only (not overridable per channel: a report's queue is one list). The owner and roles with Administrator have it. Proposal: the migration grants it to every role that has `MANAGE_MESSAGES` today. (Protocol rule: a new permission bit is no incompatible change.)

**Who may report:** every member who can see the message (so also guests in a channel they may read). Rate limit per member (proposal: 10 per hour), one open report per member and message.

**What a report holds** (table `reports`):
- kind (`message` | `member`), reason (fixed list: spam, harassment, hate, sexual content, violence, illegal content, other; plus a free text up to 1000 characters),
- reporter, reported member, channel, time,
- **a snapshot**: the message's text, author, time, and copies of its attachments and link preview; for a member their name and avatar at that moment. With the snapshot a report stays reviewable after the author deleted the message or left the server. Attachment copies are stored apart from ordinary attachments and are not reachable through the ordinary attachment route.
- status (`open`, `actioned`, `dismissed`), who closed it, when, what was done (deleted, channel block, kick, ban, nothing), an optional note.

**Retention (proposal):** the snapshot goes when the report is closed plus 30 days, an open report's after 90 days at the latest; the report row itself stays without content (for counting repeats). A member's account deletion removes their reports as reporter; as the reported person the snapshot stays until the deadline (it is evidence about them).

**The reported person never learns who reported.** Whether they learn that something was removed because of a report (the DSA asks hosting services to give reasons to the person affected; proposal: a short system notice "a moderator removed your message in #channel", without the reporter): decided yes, section 9.

**Notifying the moderators:**
- live: a server event `reports.count` to every connection with `MANAGE_REPORTS` (a count only, no content); the rail and the admin panel show a mark (`docs/features/mentions-unread.md` has the rail marks),
- offline: nothing until push exists (`docs/PLAN-mobile.md` 3.1); later a push to the owner and the moderators. An e-mail to the owner is not possible from the server today (the chat server sends no mail; the directory knows the owner's address only if the owner is a directory account) — open decision 5.
- nobody has `MANAGE_REPORTS` online for a long time: shown to the owner at the next sign-in.

**The queue:** Verwaltung > Meldungen: open reports newest first, grouped per message; the snapshot next to the live message (or "deleted"); actions right there: delete the message, delete the member's messages of the last hour/day/7 days, channel block, kick, ban, dismiss. Each action closes the report with its result.

## 4. Deleting, afterwards

- **Delete on ban:** the ban dialog gets "delete messages of the last: none / 1 hour / 24 hours / 7 days" (Discord's choice). Attachments with them. One `message.bulkDelete` event per channel instead of hundreds of single ones (a new event older clients must understand only if they should see it at once; they catch up on reload: no version bump needed, to be checked against the rule in `packages/protocol/AGENTS.md`).
- **A minimal moderation log** (table `mod_log`): who did what to whom, when, in which channel (delete of another's message, kick, ban, channel block, report closed), **without message contents**. Readable with `MANAGE_REPORTS`. Kept 180 days (decided, section 9). This is the audit log the former decision 3 of `docs/PLAN.md` left out.
- **Own messages** stay deletable at any time, for good. A report's snapshot is the only copy that outlives it, and only until the deadline in section 3.
- **Direct messages** keep their rules; reporting one does not delete it (the reporter can delete it for themselves afterwards).

## 5. Direct messages and servers reported to the directory

- **A direct message:** the directory cannot read it. The reporter's client sends the reported message and, if the reporter agrees (checkbox, on by default?), the preceding messages of that conversation (proposal: up to 20) in plain text with the report; only what the reporter can read anyway. Signal and WhatsApp work this way. The report goes over the directory socket as a signed action.
- **A directory account** (name, avatar): same way, without messages.
- **A chat server:** reason, free text, and optionally the channel or message that shows it (the reporter's client sends a snapshot as in section 3).
- **A server report passed on:** the report of section 3 with its snapshot, sent by the reporter's client.
- Protocol: a new part in `packages/protocol` (copied to the directory, `AGENTS.md` section 2a), a directory feature flag so that clients show the entries only where the directory knows them.
- After the report the client offers to block (section 6).

### 5.1 What the client and the chat server still need (decisions of 27 September 2026)

The directory's operator can act on a report since 27 September 2026: warn an account, remove its picture or display name, suspend it for a time, delete it; take a chat server out of the server directory or refuse it. What that means for this repository, **all of it built on 27 September 2026** (`docs/features/reports.md`, the last section, with what differs from the plan below: the session on a chat server is refused while the suspension lasts instead of being ended):

- **The receiver's choice in the report dialog** (decision 8 below): a report of a message on a chat server goes to "die Moderatoren von <Server>" or to the directory's operator, with the hint to take the second when the moderators do nothing or are the problem. The second is a report of the server with the message as evidence (text, author, channel, time, built by the reporter's client from what it shows). No third kind of report and no list of "my reports".
- **Reporting a directory account** (name, avatar): an entry on a friend and on a member who has a handle. **Reporting a chat server:** an entry in the server rail's menu and in the server browser.
- **Protocol:** one request shape for both kinds with the payload in a fixed order, as `directoryDmReportPayload` has it; `DirectoryHealth.features.reportKinds` tells the client which entries to show (a directory that only says `reports: true` takes direct messages only).
- **A suspended account:** the directory refuses its socket (friends, direct messages, presence), profile changes, friend actions and reports with `account_suspended` and the date; the key backup, the account status and the deletion stay open. The client shows the notice and the suspended state instead of reconnecting. `DirectoryAccount.suspendedUntil` (nullable, default null, only in answers to a server's token) tells chat servers.
- **Chat servers and suspended accounts** (decision 9 below): a server setting, on by default, that the operator of a server can switch off. While it is on, a directory account that is suspended cannot sign in until the suspension ends (403 `account_suspended` with the date), and its running sessions end at the next reconciliation with the directory (the push `/api/directory/notify` or the five-minute pass). Server accounts (`~name`) are not concerned.
- **A refused chat server** (decision 10 below): the directory publishes the SHA-256 of every refused host. The client fetches the list with the directory's health, keeps it for an hour and checks every host before it connects, so the directory does not learn which servers a client opens. A match is refused with a page of its own. The list missing (the directory cannot be reached) refuses nothing; an older list stays in force. The home server of a web client is not checked: the refused operator serves that page anyway.
- **A refused registration:** the directory answers a refused server's registration with 403 `server_blocked`; the server's log and `squorli doctor` need a text for it (today the hint about the proof URL is printed, which misleads).
- **Notices:** the account's status carries the notices about measures (fixed wording in both languages, the reason from the reports' list, never who reported); the client shows them and marks them as read (`notice-read`).

Order of the rollout: the directory first, then the server, then the desktop app, then the website (a page with the rules of use, the privacy policy's lines, the guides; open).

## 6. Blocking members on servers (built 27 September 2026, `docs/features/reports.md`)

- A list of blocked accounts per user, in the account's sealed settings (`SealedSettingsContent`, user's rule of 22 September 2026: new account-level settings are encrypted), so it follows the user across devices and servers and no server learns it. Server accounts (`~name`) keep theirs per device in their key's storage.
- Effect in the client: messages of a blocked member are folded ("blocked message, show"), their voice is muted at volume 0 for this user, their mentions do not count, friend requests from them are refused (that exists). The server does not enforce anything: blocking is a view, moderation is the server's.
- Blocked by a directory account's public key, so it applies on every server where that person is.

## 7. Client

- Message context menu: "Melden" (not on own messages); member menu and profile: "Melden", "Blockieren".
- The report dialog (a modal of our own, no browser dialog, `apps/web/AGENTS.md`): reason, free text, whom it goes to ("an die Moderatoren von <Server>" / "an Squorli"), for a direct message the checkbox of section 5.
- Verwaltung > Meldungen (section 3), the rail mark, the log view (section 4).
- Settings > Blockiert: the list, unblock.
- Needs a desktop app release; the server first (`docs/features/desktop.md`, versions).

## 8. Stages

1. **Server reports:** permission, table, snapshot, queue, event, client menus and dialog, retention job. **Built 26 September 2026** (`docs/features/reports.md`).
2. **Delete on ban** and the moderation log. **Built 26 September 2026.**
3. **Blocking** in the sealed settings. **Built 27 September 2026** (`docs/features/reports.md`).
4. **Reports to the directory** (direct messages, accounts, servers, passed-on reports), together with the directory's side. **Direct messages built 26 September 2026, the rest with section 5.1 on 27 September 2026** (`docs/features/reports.md`).
5. Offline notification with the push of `docs/PLAN-mobile.md`.

The mobile app's store submission needs stages 1, 3 and 4 at least.

## 9. Decisions (made by the user on 25 September 2026)

1. Reporting is built; the old "no report function, no audit log" is revised.
2. A moderation log without contents, kept 180 days.
3. A report's snapshot: closed + 30 days, 90 days at the latest.
4. The reported person gets a notice when something of theirs is removed after a report, without the reporter's name.
5. While offline before push exists: no mail; the count shows at the next sign-in (rail mark, Verwaltung).
6. Direct message reports carry up to 20 preceding messages, checkbox on by default (opt-out).
7. The migration grants `MANAGE_REPORTS` to every role with `MANAGE_MESSAGES`; owner and administrators always have it.

Decisions of 27 September 2026 (the user, for section 5.1):

8. A report passed on from a chat server is a choice of the receiver in the report dialog, not a kind of its own.
9. Chat servers are told about a suspension and refuse suspended directory accounts by default; the operator of a server can switch that off.
10. A chat server the directory refused is refused by the clients too, also when it is opened by its address; the check is local, against a list of hashed hosts.
11. The notice to the person concerned has a fixed wording in both languages and never names the reporter; mails about measures are English.

## 10. Not checked

What was run per stage is in `docs/features/reports.md` and `docs/VERIFIED-STATE.md`. The DSA's duties for a small self-hosted server and for the directory's operator are an assessment, not legal advice; they belong with the imprint/privacy task (`LEGAL_DATENVERARBEITUNG.md` in the workspace root).
