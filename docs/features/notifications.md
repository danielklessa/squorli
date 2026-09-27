# Notifications of the operating system

Direct messages and mentions as notifications of the operating system, with a click that opens the conversation. Code: `apps/web/src/notifications.ts` (settings per device, text, tag), `apps/web/src/NotificationSettings.tsx` (Einstellungen > Töne), `store.ts` (`incoming`, `dmNote`, `mentionNote`), `App.tsx` (shows them, handles the click), `platform/types.ts` (`Platform.notifications`), `platform/web.ts` (Notification API), `platform/desktop.ts` + `platform/bridge.ts` (`notify`, `onNotificationClick`), `apps/desktop/src/main/notifications.ts` + `main/index.ts` (`showNotification`), `apps/desktop/src/preload/index.ts`.

## Built (27 September 2026)

From `docs/PLAN.md` 3.3 (user: "erledige alle Punkte aus 2"): "Desktop notifications (operating system notifications for mentions and direct messages; today only the taskbar mark and a sound), and browser notifications as an opt-in."

- **When:** exactly when the message sound plays (`attention.ts` `seesIncoming`): a direct message, or a live message that mentions the user, which the user does not see right now (window hidden, without the focus, or another conversation open). A blocked person's messages never get there (stage 3 of the reports). Channels that notify on every message do not notify here; that is the same rule as the sound.
- **What:** title = who (a direct message), or "who · #channel (server)" (a mention); body = the text as one plain line, mention tokens as @Name, Markdown's marks dropped, at most 180 characters (`notificationBody`), or "Neue Nachricht" when the preview is switched off. `tag` = `dm:<peer>` or `mention:<host>:<channelId>`: a browser replaces an older notification of the same conversation, and a click opens it (`parseNotificationTag`: the conversation in the home view, or the server and the channel).
- **Desktop app:** the client sends `{ title, body, tag }` over the bridge (`IPC.notify`); the main process checks it (`readNotification`: strings, cut to 120/300 characters) and shows an Electron `Notification`, silent (the client plays its own sound), with the app icon (Windows takes it from the AppUserModelID, Linux gets `build/icon.png`, now packaged). A click restores and focuses the window and sends the tag back (`IPC.notificationClick`). Notifications are kept referenced until clicked or closed (Windows loses the click handler of a collected one). Permission: "granted" at once; an app older than this client has no `notify` and shows none ("unsupported", the settings say an update brings them).
- **Browser:** the Notification API, only on a secure page and never on a phone (mobile browsers need a service worker for it). Off until switched on; the switch asks for the permission inside its click. "denied" explains the site settings.
- **Settings:** Einstellungen > Töne, section "Benachrichtigungen": on/off, "Nachrichtentext in der Benachrichtigung zeigen", "Test-Benachrichtigung". A choice per device (`chat.notifications.v1` in localStorage), not of the account.

### Decisions made by Claude, confirmed by the user on 27 September 2026

- Per device, not in the account's sealed settings: whether the system may show them is a property of the device and of the browser's permission, like the output device.
- On by default in the desktop app, off in a browser (the plan's "opt-in").
- The switch for the text in the notification (for a screen others see), on by default.
- Only what makes the sound: no notification for every message of a channel set to "all".
- The shell's notification is silent; the client's own message sound stays the one sound.

### Checked

- `notifications.test.ts` (3: the body text, title and tag, the tag read back), desktop `pure.test.ts` (`readNotification`).
- The unpackaged Electron app (44.4.2) driven over the DevTools protocol with a test page under `app://squorli`: platform "desktop", permission "granted", a notification sent over the bridge without an error in the main process; the settings block rendered (screenshot).

### Not checked

- The notification on screen and its click (headless run; Windows toast and Linux notification daemons), a real direct message or mention arriving while the window is in the background, Chrome and Firefox asking for the permission, the "denied" text.
