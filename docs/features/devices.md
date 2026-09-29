# Devices: signing a device out for good

Part of the project description (entry point: root `AGENTS.md`, section 0). The contract is `packages/protocol/src/directory.ts`, section "Devices" (copied to the directory), plus `localAccounts.ts` and `index.ts` for the chat server's part. The directory's side (its routes, the account page, the switch `DEVICE_ENFORCEMENT`): `../squorli-directory/docs/features/devices.md`.

## 29 September 2026: device keys, enforced sign-out

**The user's report:** "eine andere Sitzung abmelden ist im Moment sehr sinnlos, wir müssen einen Weg finden wie wir die Sitzung wirklich invalidieren können und ausloggen. Momentan muss ich nur auf weiter als @name klicken und bin wieder drin". Cause: signing a device out deleted that device's session row on one chat server (`DELETE /api/me/sessions/:id`, close 4011). The account's key stayed on the device (`chat.identity.v1`, for `~name` in `chat.serverAccounts.v1`), and every device of an account holds the same key. "Weiter als @name" signed the next challenge with it, `admit()` made a new session; for a foreign server `connectForeign` did that without a click.

**What is built:** every installation has a key of its own per account, the device key, next to the account's key. It is enrolled where the password is proven or the account is made, signs along with everything the account's key signs, and can be signed out. The directory decides for a directory account (`@name`), the chat server for a server account (`~name`). A device that was signed out loses the account's key and gets back in only with name, password and second factor.

### The user's decisions (29 September 2026)

| Topic | Decision |
|---|---|
| Strength | Enforced by the directory and the chat servers, not left to the client's good will; an app from before may stop working for an account after that account's first sign-out |
| Extent | A device that was signed out loses the whole account: the key is wiped there, all servers, friends and direct messages |
| Password | Signing other devices out and setting a new password need the current password (and a code while the authenticator is on) |
| The client's own "Abmelden" | Signs the device out and wipes the key from it |
| Unused devices | Signed out after 90 days; not for an account without a password |
| Limit | At most 10 devices per account |
| The eleventh device | After password and code the sign-in shows the ten devices, the user picks the one that is signed out |
| Keys that cannot be read out | Built right away: WebCrypto makes the device key and never hands it out; an ordinary key where the browser cannot |

The user accepted the plan's other decisions as a whole ("Die restlichen Entscheidungen sind gut"); the directory's note lists them. What came up while building and was not put to the user:

| Topic | Decision | Why |
|---|---|---|
| Server accounts are never enforced from birth | A server account is enforced from its first sign-out of another device, like an account from before (the plan had "new accounts from birth") | The chat server has no switch like the directory's; an app from before devices that registers a server account would lock itself out at its next sign-in |
| One proof for both | The device signs `deviceProofMessage(accountKey, message)` for the directory and for a chat sign-in alike (the plan had two formats) | One function, one test; the message inside names the host already |
| The tab "Sitzungen" is "Geräte" | With a directory or a server that knows devices, Einstellungen > Geräte shows the account's devices; the list of sessions per server stays for a server from before | Two lists that look alike confuse |
| "Identität verwerfen" is "Abmelden" | The button left the settings; the one on the login stays and does what signing out does (`forgetIdentity()` is `logout()`) | Both wipe the key now |
| Signing out an account without a password asks first | A confirmation that says the account is lost for good | The key exists nowhere else |
| The chat server's word alone wipes nothing | On a chat server's `device_refused` the client asks the directory first | A chat server the user does not run must not be able to wipe the account from a device |

The origin of a sign-in from the desktop app was decided by the user a day later: the entry of 30 September 2026 at the end.

### Protocol (no version bump)

Only optional fields, REST error codes and close reasons; no schema is strict, older sides drop the fields.

- `directory.ts` (copied): `DEVICE_MAX` 10, `DEVICE_PAGE_MAX` 5, `DEVICE_IDLE_MS` 90 days, `deviceProofMessage`, `deviceEnrolMessage`, `DeviceProofFields` (`deviceKey`, `deviceSignature`) on every signed request, `DeviceInfo`, `TooManyDevicesResponse` (devices and a ticket), `DEVICE_REFUSALS`/`isDeviceRefusal`, `DirectoryAccount.devicesEnforced`/`deviceKeys`, the action `device-revoke` with `DeviceRevokeRequest`/`Response`, `AccountStatus.devices`, `features.devices`/`deviceRevoke`, `BackupUploadRequest.oldAuthKey`, `BackupFetchRequest.ticket`/`replaceDevice`.
- `friends.ts` (copied): the proof on the socket's `auth`, close code 4015 (`DIRECTORY_WS_CLOSE_DEVICE`), the error codes `device_revoked`, `device_unknown`, `device_required`.
- `localAccounts.ts`: the proof on `LocalRegisterRequest`, `LocalClaimRequest`, `LocalBackupFetchRequest` (with `replaceDevice`), `LocalDeviceRevokeRequest` (`authKey`), `DevicesResponse`, the error codes `device_refused`, `too_many_devices`.
- `index.ts`: the proof on `VerifyRequest`, `DEVICE_REFUSED`, `WS_CLOSE_SESSION_ENDED` (4011), `SESSION_END_REASONS` (`session_expired`, `session_revoked`, `device_revoked`), `sessionEndReasonOf`.

### Chat server

- **Schema (migration 0038):** `sessions.device_key`; `users.devices_enforced` and `users.device_keys` (what the directory said, cached like the handle); `local_devices` (a server account's devices; a row that was signed out stays for a year so that the device hears "signed out"); `local_accounts.devices_enforced_at`.
- **The verdict** is `deviceAllowed` in `src/users/devices.ts` (pure, tested). A server account: refused when its device's row is signed out, and once the account is enforced when it names no enrolled device. A directory account: refused when the directory says the account is enforced and the device is not among its keys. A `users` row with both a handle and a server account counts as the server's. Everything else passes, a sign-in without a device included.
- **Every way in asks it:** `lookUpSession` in `src/auth/session.ts` (REST through `requireSession`, which answers 401 `device_refused`, and the WebSocket's hello, which sends `unauthorized` and closes with 4011 and the reason `device_revoked`). A refused session's row is deleted there, so the race between a sign-out and a sign-in under way is closed. `/api/auth/verify` checks the proof (`checkDeviceProof`, 401 `device_signature_invalid`) and the verdict (403 `device_refused`) before `admit()`, which stores the device's key with the session.
- **What the directory tells:** `src/directory.ts` takes `devicesEnforced` and `deviceKeys` only from answers to the server's token (a public lookup never clears them), sends the sign-in's proof with the device's proof next to it (`dkey`, `dsig`, also with `member=0`), and calls `onDevices` when they changed; `Devices.endRefused` then ends the sessions of devices that are not let in, their sockets and their voice seat at LiveKit. The directory's push after a sign-out arrives at `POST /api/directory/notify` as before.
- **Server accounts:** the device is enrolled at `POST /api/local/register`, `POST /api/local/claim` and `POST /api/local/backup/fetch` (the proof is `deviceEnrolMessage(PUBLIC_DOMAIN, handle, deviceKey)`; at the limit 409 `too_many_devices` with the list and no key, the repeat names `replaceDevice`; no ticket, the auth key is sent again), and silently at a sign-in while the account is not enforced. `GET /api/me/devices`, `DELETE /api/me/devices/:id` and `/others` (body `authKey` = the password's auth key, from a session with an enrolled device, else 400 `no_device`; wrong passwords count against the limit of the password routes), `DELETE /api/me/devices/current` (no password). For a directory account these answer 409 `use_directory`. The first sign-out of another device sets `devices_enforced_at` and ends the account's sessions without an enrolled device.
- **The sweep** (hourly and at start): server account devices unused for 90 days are signed out, rows signed out a year ago go. A device counts as used with its session (`touchLocal`, at most hourly).
- `/api/health` has `devices: true`, the client's feature flag. The routes `/api/me/sessions*` stay for clients from before.

### Client

- **The key:** `apps/web/src/deviceKey.ts` (the same file as the directory's `apps/directory/web/deviceKey.ts`, change both together). WebCrypto Ed25519 with `extractable: false`, the key pair in IndexedDB (`squorli-keys`, object store `devices`, keyed by the public key); where WebCrypto has no Ed25519 or IndexedDB cannot be used, an ordinary key whose private half lies where the account's key lies (`store: "plain"`). `main.tsx` hands the vault in (`setDeviceVault`); tests and Node harnesses use `memoryVault()`.
- **Where it is named:** `Identity.device` and `ServerAccount.device` (`identity.ts`: `newDevice`, `loadDeviceOf`, `deviceSignerOf`, `dropDevice`, `signBoth` = the account's signature with the device's proof, `enrolFields`). A device is made only at an enrolment (account made, key fetched with the password, first sign-in of an identity from before), never on the side: two tabs would make two.
- **Requests:** `api.ts` signs every directory action through `directorySigned`/`directoryAction` (twelve hand-built copies until then); `login`, `localRegister`, `localClaim`, `localRestore` and the directory socket's `auth` carry the proof.
- **A refusal:** `deviceRefusal.ts` (pure, tested) decides between nothing, signing in again and wiping. The directory's `device_revoked`/`device_unknown` wipes (`Store.wipeAccount`: the identity with its device, the sessions, the connections of the main identity, the directory link, the keys for direct messages and settings, friends and conversations, the blocked list; server accounts stay). A chat server's `device_refused` or close reason `device_revoked` makes the client ask the directory: refused there = wipe; fine there = sign in again at that server, once per minute at most (this is what the device that signed another one out meets at the first enforcement, because its session from before names no device); no answer = a message, nothing is wiped. For a server account the server's word counts: `dropServerAccount(host)`. Nothing is wiped unless the stored device is still the one that was refused; a second tab follows through the `storage` event.
- **The login after it** says "Dieses Gerät wurde abgemeldet. Melde dich mit Benutzername und Passwort neu an." and offers no saved account.
- **The user's own sign-out** (`Store.logout`): sockets close first, then the device signs itself out at the directory and at the server of each server account (3 s each at most), the server accounts and the account are wiped. While that runs the flag `leaving` keeps the servers' answers from being read as a foreign sign-out.
- **Einstellungen > Geräte** (`DevicesTab.tsx`): the account's devices, this one marked, "Abmelden" per device and "Alle anderen Geräte abmelden", both with the password (and the code while the authenticator is on) in a form inside the tab. With a server account shown, the list is that server's.
- **The eleventh device** (`DevicePicker.tsx`, in `SignInForm` and `DesktopLogin.tsx`): the list of the ten, one to pick, then the sign-in runs again with the ticket. The device key made for the first try is kept for the second (`Store.limitDevice`): the directory binds the ticket to it.

### Rollout

Directory with the switch off, chat server, desktop app, then the switch on, then the website. Needs a new server version and a new desktop app version.

| Combination | Behaviour |
|---|---|
| App from before, account not enforced | As before |
| App from before, account enforced | Refused, nothing is wiped; the app has to be updated |
| Client that knows devices, directory or chat server from before | The fields are dropped, the tab shows the sessions as before |
| Chat server that knows devices, directory from before | Directory accounts are never enforced there |

### What stays

- A chat server that was not updated lets everybody in who holds the account's key. This belongs in the release notes.
- Whoever copied the account's key can still open direct messages they get hold of (no forward secrecy); the directory hands them none any more. Only a change of the account's key ends that, which is not built.
- A key that cannot be read out keeps scripts and extensions from copying it, not somebody who copies the browser's whole profile from the disk. In the fallback the device key lies readable next to the account's key.
- The account's key itself stays readable: the client derives the keys for direct messages and the sealed settings from it.
- A forgotten password cannot be replaced from a signed-in device any more.

### Found on the way

- **Sign-in with a server account on a second device never worked** (released on 25 September 2026): `GET /api/local/backup/:handle/params` left `bound` out, the client derived the keys of a host-bound backup as unbound, and the right password read as "Benutzername oder Passwort falsch". Fixed in `auth/local.ts`, held by `smoke-devices.mjs`. Found by the run with two browsers; the smoke test had derived the keys from the full parameters it made itself.
- The user's own sign-out showed "Dieses Gerät wurde abgemeldet" (the servers' answer to the sign-out ran into the refusal path): the flag `leaving`.
- The pick at the eleventh device answered "Die Auswahl ist abgelaufen": the second try made a new device key, the ticket named the first. Found in the browser; the smoke test had used one key for both tries.
- The radio buttons of the pick took the login's field size (`.auth-login input`); `.device-choice` in `styles.css`.

### Checked

- `pnpm typecheck`, `pnpm test` (protocol 134, server 169, web 493, desktop 82; new: `devices.test.ts` in the protocol and the server, `deviceKey.test.ts`, `deviceRefusal.test.ts`, the device part of `identitySecrets.test.ts`), `pnpm build`, `docker build --target app`.
- `pnpm smoke:devices` (new, `apps/server/scripts/smoke-devices.mjs`, 30 checks): the script plays the directory on 127.0.0.1:3196. Directory accounts: the proof at the sign-in and towards the directory, a proof over another message, an account that is not enforced with and without a device, the account that becomes enforced (the session without a device ends, socket 4011 `device_revoked`), a sign-in without a device or with one that is not enrolled, a device that is signed out with its sockets and sessions, a sign-out right after a sign-in, what the directory told last while it does not answer. Server accounts: enrolment at registration, key fetch and the first sign-in, `bound` in the backup's parameters, a sign-out without the password, with a wrong one and from a session without a device, the first sign-out that enforces, the password that brings a device back, the device's own sign-out, all others, the limit with `replaceDevice`. One run per database (the script says so when the database has an owner already).
- `pnpm smoke` (230) and `pnpm smoke:suspended` (24), both of which know no devices: all ok.
- The built client in two headless Chrome profiles against a real chat server and a real directory with `DEVICE_ENFORCEMENT=true`, 30 checks: both sign in, the key pair lies in IndexedDB and `exportKey` refuses it, the list shows three devices, a copied account key without a device is refused by server and directory, device A signs device B out (a wrong password signs nothing out), B falls to the login with the notice and without "Weiter als", its keys are gone, a reload stays out, B comes back with the password as a new device, the layout at 400 px, A's own sign-out, and the same with a server account. Screenshots looked at.
- The eleventh device in headless Chrome, 6 checks: the list of ten, the button waits for a pick, 400 px, the pick signs in, the device that made way is refused by the directory.
- The unpackaged desktop app (Electron, `--directory-url`, a user data folder of its own), 17 checks: sign-in, the account's key is in the shell's secret store and not in localStorage, the device key in IndexedDB cannot be read out, the list, signed out from another device the app falls to its login with the notice, stays there after a restart, comes back with the password as a new device, a restart enrols no further device, the app's own sign-out.
- The fallback in headless Chrome, 12 checks: with WebCrypto refusing Ed25519 and with IndexedDB refusing to open, the sign-in works, the device key is an ordinary one, a reload enrols nothing new, a sign-out from elsewhere takes both keys.
- `deviceKey.ts` in Firefox 159 (nightly, headless), 9 checks: the key is made by WebCrypto, signs, cannot be exported as `pkcs8` or `jwk`, comes back from IndexedDB after a reload, is gone once forgotten.

**Not checked:** two real machines; Safari; a private window of a real browser; the second factor at a sign-out and the ticket after an authenticator code in the client (the test directory ran without `DIRECTORY_SECRET_KEY`); the 90 days with real dates; a packaged app; the app on Linux; the English texts by eye; a chat server from before devices against the new client.

**Recipes** (the scripts were deleted after the runs): a harness under `apps/server/scripts/` (so that `@squorli/protocol` and `@noble/ed25519` resolve), run with `npx tsx`; it spawns Chrome with `--headless=new --remote-debugging-port` and a profile folder of its own per device, or `apps/desktop/node_modules/electron/dist/electron.exe apps/desktop --directory-url=... --user-data-dir=... --remote-debugging-port=...` with `ELECTRON_RUN_AS_NODE` removed (the page to drive is the target whose address starts with `app://`; end with `Browser.close`), talks to the DevTools protocol with Node's `WebSocket`, fills React's fields through the value setter of `HTMLInputElement.prototype` plus an `input` event, and plays further devices over the API. The chat server serves the built client with `STATIC_DIR=apps/server/public`. **Start fresh instances per run:** the directory counts key fetches and parameter requests per address (`BACKUP_RATE_LIMIT`), and a run that follows another on the same instance fails with 429 in places that look like bugs. A browser without Ed25519 is played with `Page.addScriptToEvaluateOnNewDocument` (a `generateKey` that rejects). Firefox without an installation: the nightly zip, a page bundled with esbuild that posts its findings to a small node server.

## 30 September 2026: every sign-in says where it came from

**The user's question and decision:** "warum ist die Herkunft der Anmeldung weg? Ich finde es eigentlich praktisch zu sehen was für eine Anmeldung das ist". Claude had left the origin out for the desktop app the day before, because the app's entry read "Squorli Desktop auf Windows über squorli" (the host of the app's internal address `app://squorli`); browsers kept theirs. Of three ways (leave it, as before, a readable word for the app) the user chose the third: "setze den dritten Vorschlag um".

- **Protocol** (`directory.ts`, copied): `DESKTOP_APP_ORIGIN` = `app://squorli`, the whole origin with its scheme, so that no host can be taken for it (a site reached as plain `squorli` stays the host `squorli`); `signInOrigin(header)` = what to keep of a request's Origin header: a site's host for `http:`/`https:`, the constant for the app, null for anything else. Tested.
- **Server and directory:** `originOf` is `signInOrigin(req.headers.origin)` in both; the directory's socket, which had a copy of its own that kept any host, uses it too.
- **Shown** as "über die Desktop-App" / "via the desktop app": `deviceOrigin`/`deviceLabel` in `DevicesTab.tsx` (Einstellungen > Geräte and the choice at the eleventh device; `devices.viaApp`), on the account page in the devices and in the list of key retrievals (`m.fetch.viaApp`), and in the mail about a key retrieval ("die Squorli-Desktop-App"). A client or an account page from before shows "über app://squorli".
- **Rows from before** (the directory's key retrievals of the app, kept as `squorli`): the directory's migration 0024 turns them into the constant.
- **Checked:** typecheck and tests in both repos (protocol 135 and 73 with the new test of `signInOrigin`, web 496 with `DevicesTab.test.ts`); `pnpm smoke:devices` 30 here, 41 at the directory with the switch on, the directory's `pnpm smoke` 219 with it off; the unpackaged desktop app, a headless Chrome on the chat server's web client and one on the account page with one account, 10 checks: the app's entry reads "Squorli Desktop auf Windows über die Desktop-App" in the app, in the browser and on the account page, the browsers' entries name `localhost:3001` and `localhost:3101`, the list of key retrievals says the same, the directory keeps `app://squorli`, the mail names the app; screenshots of the app and the page looked at; the migration against a database with a row from before (`squorli` became the constant, `squorli.example.org` stayed). **Not checked:** the packaged app, the English texts on screen, a real mail.
