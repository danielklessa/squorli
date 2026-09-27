# Feature notes: reports on a chat server, the moderation log, deleting on ban

Part of the project description (entry point: root `AGENTS.md`, section 0). Dated entries: what was built, the user's wishes and decisions, consequences, and what was and was not checked. Standing rules live in the `AGENTS.md` of the area. Whoever changes the feature adds or updates its entry here in the same step. The plan with the seven decisions and the later stages: `docs/PLAN-reports.md`.

Code: protocol `packages/protocol/src/reports.ts` (`ReportReason`, `CreateReportRequest`, `Report`, `ReportSnapshot`, `CloseReportRequest`, `DeleteRecentHours`, `ModLogEntry`, retention constants), `permissions.ts` (`MANAGE_REPORTS`), `index.ts` (`BanRequest.deleteMessagesHours`, `ServerState.openReports`, events `reports.count`, `message.bulkDelete`, `moderation.notice`); server `src/reports.ts` (`ReportsService`: snapshots, queue, close, files, retention), `src/modLog.ts` (`recordModLog`, `listModLog`, `sweepModLog`, `userNameOf`), `src/moderation.ts` (`deleteRecentMessagesOf`), `src/routes/reports.ts`, the log calls in `routes/messages.ts`, `routes/members.ts` (ban with the delete choice), `routes/channelBlocks.ts`, `state.ts` (`openReports`), tables `reports` and `mod_log` (migration 0035), migration 0036 (the permission backfill), `rateLimits.ts` (`tokenReports`); client `ReportDialog.tsx`, `ReportsTab.tsx` (Verwaltung > Meldungen and the log; `askDeleteRecentHours`), `askSelect` in `dialogs.tsx`, the flag in `ChatView.tsx`'s message actions and in `MemberList.tsx`'s server section, the `reports` badge of `ServerRail.tsx`, the three events in `serverConnection.ts`, the `report.*` texts.

## Built (26 September 2026): stages 1 and 2 of `docs/PLAN-reports.md`

The user made all seven decisions on 25 September 2026 (plan section 9) and asked on 26 September 2026 to tackle the feature. Built are stage 1 (server reports) and stage 2 (delete on ban, the moderation log). Stages 3 (blocking members in the sealed settings), 4 (reports to the directory: direct messages, accounts, whole servers, passed-on reports) and 5 (push while offline) are open; the plan keeps them.

### Reporting

- **Who and what:** every member may report a message they can see (not their own; an invisible channel's message is a 404 as everywhere) or a member. Reason from the fixed list (`spam`, `harassment`, `hate`, `sexual`, `violence`, `illegal`, `other`) plus a free text up to 1000 characters. One open report per member and message (409 `already_reported`), 10 reports per member and hour (`tokenReports`). `POST /api/reports`.
- **The snapshot:** the message's text, its author (name, handle, avatar address at that moment), time, the previews' texts, and **copies of the attachment files** under `DATA_DIR/reports/<reportId>/<n>`, apart from ordinary attachments and reachable only through the report's own signed links (`/api/reports/:id/files/:n/:name?e&s`, the same HMAC as attachment links with the id `report/<id>/<n>`, the same inline rule and sandbox). A member report keeps name, handle and avatar address. So the report stays reviewable after the message is gone or the person left.
- **The queue (Verwaltung > Meldungen, `MANAGE_REPORTS`):** open reports newest first with the snapshot, whether the message still exists, the reporter, and how many earlier reports exist about the same person; the closed ones on request (the last 200). Actions close a report with their result: delete the message (the server does it, `MANAGE_REPORTS` suffices for a reported message; every other open report about that message closes with it), delete the person's messages of the last hour, day or week, kick, ban (both through their own routes with their own rights and rank rules, then recorded), dismiss. `POST /api/reports/:id/close`.
- **The count:** `ServerState.openReports` (the number for a member with `MANAGE_REPORTS`, 0 for everybody else; the field's presence is the feature flag for "Melden") and the event `reports.count` on every change to every online moderator. The rail shows an amber badge with the number (on the current server too), the admin panel's tab a badge. Nothing while offline (decision 5): the count comes with the next welcome.
- **The reported person** never learns who reported. When a moderator deletes their message through the queue, or their recent messages, they get `moderation.notice` (decision 4): the reason and the channel, no name; the client shows it as a notice dialog. Only while online: the server keeps no notices (a limitation of stage 1, noted in the plan).
- **Retention (decision 3):** an hourly sweep sets the snapshot to null and removes the files 30 days after closing, 90 days after the report at the latest; the row stays, so repeats about the same person keep counting. The reporter's account deletion takes their reports along (FK cascade); the reported person's deletion leaves the snapshot with the user reference null (it is evidence about them).
- **Permission:** `MANAGE_REPORTS` (bit 18, "Meldungen bearbeiten"), server-wide, in the role editor's group "Mitglieder" after kick and ban; migration 0036 grants it to every role with `MANAGE_MESSAGES` (decision 7); owners and administrators have it anyway.

### Deleting on ban and the moderation log (stage 2)

- **Ban:** `BanRequest.deleteMessagesHours` (1, 24 or 168) deletes the member's messages of that window in every channel with their attachment files, one `message.bulkDelete` per channel instead of single events (older clients drop the event and catch up on reload; no version bump, `packages/protocol/AGENTS.md`). The member menu asks for it after the reason (`askSelect`), the report queue's ban too.
- **The log (`mod_log`, decision 2):** who did what to whom, when, where, without message contents: deleting somebody else's message (own deletions are nobody's business), kick, ban (with reason and the delete choice), unban, a moderator's channel block and its lifting (the vote kick's block is the members' own doing and not logged), and every closed report with its result. Names are kept as text so a line stays readable after an account is gone. `GET /api/mod-log?before=<iso>` with `MANAGE_REPORTS`, 100 per page, newest first; shown below the queue. Rows older than 180 days go (a sweep every 6 hours).

### Protocol

No `PROTOCOL_VERSION` bump: the new events reach only moderators (`reports.count`) or are safe to miss (`message.bulkDelete`, `moderation.notice`); `openReports` is optional; the new permission bit is no incompatible change; `BanRequest`'s new field is optional. New error codes went on REST answers only (`own_message`, `already_reported`, `already_closed`, `no_message`, `no_member`).

### Decisions made by Claude, not confirmed by the user

- The snapshot copies attachment files but only the texts of link previews (title, description, site name, address), not the preview pictures: the picture is a copy of a public page's image, the address stays in the snapshot.
- Channel blocks are not offered as an action in the queue (they concern voice channels; a reported message is in a text channel); kick and ban are.
- Deleting a reported message through the queue needs `MANAGE_REPORTS` only, not `MANAGE_MESSAGES` in that channel (the migration gives moderators both anyway).
- The notice to the reported person is a dialog shown only while they are online; the server keeps no notices.
- The report queue lists reports about channels the moderator cannot see themselves (one server-wide list, as the plan says); the snapshot is what they judge by.
- The rail badge for open reports is amber and shows on the current server too (a moderator should notice it), the mention badge's rules stay.
- Sizes: 200 reports per list, 100 log lines per page, one hourly and one six-hourly sweep.

## Not checked

- The dialog, the queue, the badges and the notice on screen (typecheck, unit tests and the smoke test only; no screenshot yet).
- Two real clients: the notice arriving at the reported person, the bulk delete disappearing from an open channel, the badge updating live.
- The retention sweep with real dates (the SQL only), the log sweep.
- The website's guides describe the queue and "Melden" since 26 September 2026 (`../squorli-website`, `/docs/admin/#reports`, `/docs/use/#report`); they go live with the release that carries the feature.

## Built (26 September 2026, later that day): reporting a direct message (stage 4, first part)

The user asked whether reports cover direct messages as well and, as they did not, to build them. Decision 6 of the plan applies (up to 20 preceding messages, checkbox on by default). What the directory does with a report is described in its own repository (`../squorli-directory/docs/features/reports.md`), not here.

- **Why the reporter sends plain text:** a direct message is end-to-end encrypted, the directory holds only ciphertext (`dm.ts`) and cannot read what is reported. So the reporter's client sends the reported message and, unless the reporter unticks the checkbox, the messages before it in plain text, both sides, oldest first (`dmReports.ts` `dmReportContent`: only messages this client could read, no instructions such as a removed preview). Signal and WhatsApp report the same way. The dialog says so ("schickt dein Client die gemeldete Nachricht im Klartext mit").
- **The flag** on a friend's message in `DmView.tsx` (not on one's own, not on an undecryptable one) opens the same `ReportDialog` addressed to the directory's operator (`report.goesToDirectory` with the directory's host); after the report the dialog offers "Blockieren" (`askBlockFriend`). Only with `features.reports` from the directory's health (`State.dmReports`, set when the socket is opened); a directory without the key that seals the copies takes none, and the flag stays away.
- **The request:** `api.directoryReportDm` -> signed action `report`, `POST /api/reports`; the payload of the signature is the whole content in a fixed order (`directoryDmReportPayload` in `directory.ts`: kind, reason, text, peer, message, context, each message as id/from/sentAt/text), so nothing can be swapped under the signature. Errors the dialog names: `already_reported` (one open report per reporter and message) and `rate_limited` (10 per hour); everything else as the error's text. `DM_REPORT_CONTEXT_MAX` = 20, `DM_REPORT_MESSAGE_TEXT_MAX` = 16,000 per message.
- **Protocol:** `REPORT_REASONS`/`ReportReason`/`REPORT_TEXT_MAX` moved from `reports.ts` to `primitives.ts` (one of the six copied files) so the directory's copy knows them; `reports.ts` imports them, `index.ts` re-exports them. `DirectoryAction` gained `report`, `DirectoryHealth.features.reports` (default false). No version bump: a signed REST action and a feature flag.
- **Store:** `reportDm(peer, messageId, withContext, reason, text)` builds the content from the loaded thread (`state.dms[peer]`); only loaded messages count as context (the thread's older pages are not fetched for a report).

### Decisions made by Claude, not confirmed by the user

- The context is taken from the messages the client has loaded, at most 20 before the reported one, from both sides; nothing older is fetched for the report.
- A message that could not be decrypted, and an instruction message, cannot be reported and are left out of the context.
- The dialog offers blocking the friend after the report (plan section 5, "the client offers to block"); it does not block by itself.
- The flag shows only with `features.reports`; there is no "the directory takes no reports" notice in the conversation.

### Not checked

- The flag and the dialog on screen (typecheck, unit tests `dmReports.test.ts` (3) and the protocol's payload tests only).
- A real report reaching the directory from the client (the directory's smoke test signs the same payload the client builds).

## Built (27 September 2026): blocking members (stage 3)

The user asked for stage 3 next ("dann mach erstmal reports stufe 3"). Plan section 6 applies: a list of blocked people per user, in the account's sealed settings, a view of this user's client alone. Code: `apps/web/src/blocked.ts` (the lists per identity, `chat.blocked.v1`, the names seen at the time in `chat.blockedNames.v1`, `BlockControls`), `store.ts` (`blockedFor`, `setBlocked`, the sealed sync), `serverConnection.ts` (`hooks.isBlocked`, `refreshMarks`), `readState.ts` (`catchUp` with `ignoreAuthors`), `ChatView.tsx` (the fold), `MemberList.tsx`/`MemberProfile.tsx` (the entries), `ReportDialog.tsx` (the offer after a report), `VoiceMemberMenu.tsx`, `voice/voiceClient.ts` (`setBlocked`), `SettingsDialog.tsx` ("Blockiert"), `friendActions.ts` (`askBlockPerson`); protocol `directory.ts` (`SealedSettingsContent.blockedUsers`, `BLOCKED_USERS_MAX` = 200; copied to the directory repo).

- **Whom and where:** blocked by public key, so a block holds on every server where that person is. The directory account's list travels inside the sealed blob (`blockedUsers`) and so follows the user to every device; a server account (`~name`) keeps its list on this device under its own key (`chat.blocked.v1` is keyed by the identity's public key) and loses it with the account. No server and not the directory learns whom somebody blocks.
- **Effect:** the person's messages are folded to one line ("Blockierte Nachricht von X", "Anzeigen" opens one for this view, the eye in the actions folds it again); they do not mark a channel unread and their mentions do not count (live and in the catch-up; a server with server-side read states still counts them until the channel is opened, it cannot know); they are not listed as typing; in a voice channel their voice and screen sound are silent for this user whatever the volume slider says (the member menu says "Blockiert: für dich stumm" instead of the slider), their tiles stay; with a directory account the directory is told as well (`friends.block`: their requests are refused, a friendship ends; `friends.unblock` when the block is lifted and the directory shows them as blocked). The person notices nothing.
- **Where:** the member menu and the small profile ("Blockieren" / "Blockierung aufheben", never on oneself), the report dialog after a report of a message or a member ("Blockieren"), the friends' "Blockieren" (home view, conversation head, a direct message's report) which now goes the same way, a ban mark in the member row, and Einstellungen > Blockiert: the list of the identity used on the server shown (names from any open server, the friends, else the name remembered when blocking, else the key), where it is kept, "Blockierung aufheben". The confirmation says what follows and where the block holds (`block.textAccount` / `block.textDevice`).
- **Sync:** like the hide list and the server rail's order: the account's list wins when the status is read, a device that blocked somebody just now (a pending push) merges the account's into its own first, and every push writes the list, an empty one too, so "nobody" wins over a device's stale list after an unblock elsewhere (a blob from before the feature says nothing and the device's list stays and is pushed).

### Decisions made by Claude, not confirmed by the user

- A blocked person's messages mark nothing, not only no mentions (the plan named mentions): a folded message should not ping anybody.
- Blocking somebody with a directory account also blocks them at the directory (their requests refused, a friendship ended), as the plan's "friend requests from them are refused (that exists)" implies; a server account is blocked on this client only.
- The empty list is written into the blob; the schema keeps the field optional for older blobs.
- At most 200 blocked people per account (with the hide list at its maximum the blob would not fit the request otherwise).
- The name is remembered on the device only, never in the blob.
- The home view's "Blockiert" section (the directory's blocked friends) stays next to Einstellungen > Blockiert; both go through the same store functions.

### Not checked

- On screen: the fold, the menu entries, the tab and the confirmation texts (typecheck, unit tests and the store harness only; no screenshot yet).
- Two real clients: the silence in a voice channel, a block from one device arriving at another while both are open (the second device takes it over at its next status read).
- A server account's list on a real server, the mention counter on a server with server-side read states.
- **Needs a desktop app release** (web client only; the server and the directory are unchanged apart from the protocol copy).

