# Server accounts (`~name`) and no temporary users

Part of the project description (root `AGENTS.md` section 0). Read before changing sign-in, registration, the login views, the client's identities or anything that shows a handle; update in the same step.

## 25 September 2026: built

### The user's wishes

- A server must manage users of its own; without the directory it is an isolated instance.
- Users registered on a server (not at the directory) carry another prefix in front of their handle so they can be told apart: **`~name`** (user's choice), directory accounts keep `@name`.
- When a server is new, the owner **must** register unless they sign in with a directory handle.
- **No temporary users any more**, i.e. no user who cannot sign in on another client. Every account can.
- Signing in with a server account works **like the directory**: the key is encrypted in the client with the password, the server keeps only the ciphertext (user's choice among the offered ways).
- Server accounts are **a setting per server**: always allowed without a directory, off by default with one (user's choice).
- **Members from before** without a handle register at their next sign-in; key, messages and roles stay (user's choice).
- **No direct messages between server accounts for now.**
- **Server accounts can set their avatar too.**
- In the app, a directory account and server accounts must be usable **side by side**; a server without any directory can still be added to the app (then with a server account).
- With a directory, creating a directory account is the main way to create one; the server account sits in a tab. **Signing in has no tabs: the prefix decides** (`@` directory, `~` server account); the tab only concerns creating a new account.

### What is built

**Server** (`apps/server`):
- Table `local_accounts` (migration 0032): `user_id` (PK, cascade), `handle` (unique, the directory's handle rules), `backup_params`/`ciphertext` (the client's backup of the 32-byte seed, `packages/protocol/src/backup.ts`, unchanged), `auth_hash` (SHA-256 of the auth key), `avatar_mime`/`avatar_updated_at`. `server_settings.local_accounts` (default false).
- `hasAccount(u)` = a directory handle (`users.handle`, cached; the cached one counts during a directory outage) or a server account. `/api/auth/verify` refuses a key without either with 403 `registration_required` (body `localAccounts`), **the very first sign-in too** (the owner must register). A key the server never saw gets no lasting `users` row from such a refusal.
- A member from before without an account: `/verify` gives a session with `registrationRequired: true`; `requireMember` answers 403 `registration_required`, the WebSocket hello closes with **4013**, only `GET /api/me` (`Me.registrationRequired`) and `POST /api/local/claim` work.
- `src/auth/local.ts`: `GET /api/local/handles/:handle` (free?), `POST /api/local/register` (challenge + signature over `localRegisterMessage(domain, nonce, handle, ciphertext)`, handle free, server accounts allowed; creates user, account and membership, runs `admit()` = ban, invite, owner, session like `/verify`; a refused invite removes the account again so it holds no handle), `POST /api/local/claim`, `GET /api/local/backup/:handle/params` + `POST /api/local/backup/fetch` (401 `auth_invalid`; failures limited per IP and per handle, 10/min; registration 20/min per IP), `PUT /api/local/backup` (new password, needs the old auth key: a stolen session alone cannot lock the owner out), `DELETE /api/me` (server accounts only, auth key; the first owner refused as `founder`; uses `deleteUserAccount` of the directory's deletion), the avatar: `PUT`/`DELETE /api/me/avatar` (JSON, the directory's limits: `AVATAR_MAX_BYTES`, PNG/JPEG/WebP by `sniffAvatarMime`; a directory account gets 409 `use_directory`), `GET /api/avatars/:userId` (public, immutable, nosniff, closed CSP; file `DATA_DIR/avatars/<userId>`, a row whose file is gone is cleared at start).
- The avatar of a server account never goes into `users.avatar_url` (the directory's sync writes that column, and would set it to null for a key without a directory account): `avatarOf()` in `src/names.ts` builds the absolute address from `local_accounts.avatar_updated_at` for a member without a directory handle.
- `displayNameOf` falls back to `~handle`; every place that builds a name joins `local_accounts` (`nameColumns`/`localJoin` in `src/names.ts`).
- The setting: `PATCH /api/settings { localAccounts }` (MANAGE_SERVER); locked (`localAccountsLocked`, 409 `locked_by_config`) without a directory (always on) or when `LOCAL_ACCOUNTS=true|false` pins it. `/api/health.localAccounts` is the effective value. `REQUIRE_ACCOUNT` and `server_settings.require_account` are without effect now (warning at startup); `requireAccount`/`requireAccountLocked` are always true for clients from before.

**Protocol** (`packages/protocol/src/localAccounts.ts`, not copied to the directory): the schemas above, `handleLabel`, `parseLoginName`; `Member`/`Me`/`StatusMember.localHandle`, `Me`/`VerifyResponse.registrationRequired`, `ServerSettings.localAccounts`/`localAccountsLocked`. No `PROTOCOL_VERSION` bump (defaults and optional fields).

**Client** (`apps/web`):
- One key per server account (`identity.ts`, `chat.serverAccounts.v1`: host -> key, handle, session token), made fresh at the registration or fetched with name and password; `Store.identityFor(host)` signs with it, never with the main identity. The main identity (directory account or device key) keeps friends, direct messages and the synced settings. Switching it keeps the servers with a server account.
- Login (`LoginScreen.tsx`, `AccountForms.tsx`): one sign-in form, the prefix in front of the field (click to switch, or type `@`/`~`) decides; without a prefix the directory where the server has one. "Konto erstellen": with a directory the tabs "Squorli-Konto" (the link to the directory, first) and "Serverkonto" (where allowed), without one only the server account's form. A saved account continues with one click. The bare browser key is gone as a way in.
- Join view of a server added by address (`ServerStatus` in App.tsx, desktop app): "Als @handle beitreten" where the server knows our directory and the key has a handle, the `~` sign-in and "Konto erstellen" where the server allows server accounts.
- A member from before sees `ClaimAccount` (the same tabs; the directory tab registers a handle for the key they are signed in with, the server tab a server account for it, which the client from then on keeps as that server's server account).
- Einstellungen > Konto of a server account: password change and deletion (`LocalAccountSettings`); Profil: the avatar editor uploads to the server. Rail menu of such a server: "Vom Serverkonto abmelden" (forgets the key), "Konto auf diesem Server löschen" opens the settings (the password is needed). The desktop app with server accounts only offers "Mit Squorli-Konto anmelden" in Einstellungen > Konto (`Store.openAccountLogin`, the servers stay); its full sign-out forgets the server accounts' keys too.
- Friends and direct messages: not offered to a member with a server account (they have no directory account; the member menu says "Serverkonto"), and not on a server shown with one's own server account.

### My decisions (not confirmed by the user)

- A server account gets a **fresh key per server**; it never reuses the directory key (the isolated server does not learn it, and the accounts of different servers cannot be linked by their key). Consequence: `OWNER_PUBLIC_KEY` can only name a directory account's key.
  - **Rejected:** 25 September 2026, user: the owner must also be nameable as a server account (~name). Built on 27 September 2026 as a setup code (`OWNER_SETUP_CODE`, section below).
- A key with a directory handle cannot register a server account on the same server (409 `has_account`); a server account that later gets a directory handle shows `@`.
- Handles of server accounts follow the directory's rules (3-32, a-z 0-9 . _), their own namespace per server.
- The rate limits: registration 20/min per IP, wrong passwords 10/min per IP and per handle, parameter queries 30/min per IP.
- A password change needs the old password (not only the session).
- Deleting a server account needs the password; it deletes messages and attachments like the directory's deletion.
- Mentions find server accounts by their handle after `@` (typing `~` does not open the suggestions).
- The desktop app's "Abmelden" (full sign-out) also forgets the keys of the server accounts on this device (a shared computer keeps nothing); the password brings them back.
- The web client served by a server that holds a server account of this browser: "Abmelden" forgets that key as well.

### Not built

- A second factor or e-mail for server accounts; resetting a forgotten password (impossible by design: nobody but the user knows it).
- Friends and direct messages for server accounts.
- An admin view of the server accounts (list, delete someone's account other than kick/ban).
- A question in `deploy/install.sh` for `LOCAL_ACCOUNTS` (the admin panel decides; the install script explains the owner's registration).

### Checked

- `pnpm typecheck`, `pnpm test` (protocol 101, server 107, web 399, desktop 74, link-preview 8).
- Smoke test without a directory 204 checks, with the directory (`:3101` instance) 221 checks, all green; 18 of them the section "Server accounts" (registration_required also for the first sign-in, registration makes the owner, handle taken, has_account, `~handle` in /api/me and the members, the backup's parameters and blob, wrong password 401, password change, avatar upload/refusal/removal, deletion with the password, founder refused, rate limit, with a directory: switched off -> local_accounts_off, a directory account's avatar -> use_directory).
- A member from before (account row removed by hand): session with `registrationRequired`, REST 403, WS close 4013, claim, then everything works (Node script against the smoke server).
- Headless Chrome against a server without a directory: registering `~anna.test` makes the owner with a key of its own; a second browser profile signs in with `~anna.test` and the password as the same member. The claim view of a member from before, then in. Against a server with a directory: `@` preselected, typing `~` switches, the tabs "Squorli-Konto" (preselected) and "Serverkonto".
- The unpackaged desktop app over the DevTools protocol: "Nur mit Serverkonten", adding an isolated server by address, registering there, then "Mit Squorli-Konto anmelden" with a directory account: the directory account becomes the main identity (friends available), the isolated server stays connected with its server account; after a restart both come back.
- Not checked: a packaged app, Firefox/Safari, the mobile layout of the new forms, the install script end to end (`bash -n` only), a real migration of a production database (the claim path was checked with a hand-made member from before).

**Claim on a fresh key, backups bound to the server (25 September 2026, security review, group B):**
- *The claim moved the old key to the server.* A member from before (`registrationRequired`) claimed a server account by uploading a backup of the key it was signed in with: often the main identity, the directory account's key used on every server, then kept by this server encrypted only with the password (offline guessing). Since then the client makes a fresh key for this server (`newIdentity`) and the membership moves to it: `POST /api/local/claim` takes a challenge requested for the session's key, `newPublicKey`, `signature` (old key) and `newSignature` (new key), both over `localClaimMessage(domain, nonce, handle, newPublicKey, ciphertext)`; the server checks both, needs a membership, counts against the registration limit per IP (the claim had none), and in one transaction sets `users.public_key` to the new key and adds the server account. Messages, roles and the session stay; the old key no longer signs in here. The old form (no signatures) is a 400. `/api/health.localClaimRekey` tells clients; an older server gets no claim from a current client (`err.claimNeedsUpdate`), since it would keep the old key's membership with the new key's backup.
- *Bound backups.* A server account's backup was derived like the directory's (same HKDF infos), so for a user who reuses the password, a malicious chat server could serve the directory's parameters for the user's handle and receive the directory's auth key. Now `createBackup`/`deriveBackupKeys` take a `context`, the hostname the client reaches the server at (`ServerApi.bindHost`: never a value from the server, no port so browser, desktop app and a dev proxy agree), appended to both HKDF infos, and `params.bound` records it. The directory's own backups are unchanged. Old unbound backups stay readable; the first sign-in with the password on a device (`loginLocal`) encrypts the backup anew, bound, through the password change route with the same password. **Remaining risk:** as long as unbound backups are accepted, a malicious server can still present unbound parameters; the window closes for an account once it was bound. Dropping unbound backups altogether is an option once none are left (server accounts exist since 25 September 2026).
- *Checked:* typecheck and tests in both repos (protocol 103 with 2 new for bound backups, copies byte-identical); `pnpm smoke` with `SMOKE_DATABASE_URL` (new, optional block: a member from before made in the database, claims are refused without the new key's signature, with a foreign old signature and in the old form; the claim moves the membership, the session stays, the old key is refused, the stored backup is the new key's). Not checked: the claim and the rebinding in the running client.

**Password attempts and the first owner (25 September 2026, security review, group C):** wrong passwords now count before the check runs, per address (IPv6 by its /64), per handle and, for the password change and the deletion, per account over an hour (`docs/features/rate-limits.md`). The owner is claimed in `admit()` (`auth/routes.ts`) with one conditional update of `server_settings.owner_id` before the membership is written: of two first registrations at the same moment only one becomes owner, the others are handled as ordinary sign-ins (invite, open server); before, both got the owner flag and the Admin role. Checked: six parallel first registrations on a fresh invite-only instance gave one owner and five `invite_required`.

**Security review group D (25 September 2026):** a password change signs the account's other devices out of this server (the client calls `DELETE /api/me/sessions/others` after `localChangePassword`; not the server, because the same route rebinds an old backup with the same password at a sign-in). Profile name and avatar need a membership (`requireMember`): a kicked member keeps their session to come back with an invite, a banned one loses every session. The avatar upload counts against the upload limit. **Accepted:** handles of server accounts can be found out (`/api/local/handles/:handle` answers whether one is free, which registration needs; the parameters and fetch routes answer 404 for an unknown one); the routes are limited per address, and members see each other's handles anyway.

## 27 September 2026: the owner as a server account

From `docs/PLAN.md` 3.3 (user's decision of 25 September 2026: allow `~name` for the owner too, and a question in the installer; user: "erledige alle Punkte aus 2"). A server account gets its key only at its registration, so `OWNER_PUBLIC_KEY` cannot name it; a name alone would not do either, because on a fresh server anybody could register that name first. So the owner proves it with a **setup code**:

- `OWNER_SETUP_CODE` (config, 12-128 characters, trimmed): while no owner exists, `POST /api/local/register` with `ownerCode` equal to it (compared in constant time over SHA-256) makes that server account the owner (`isFirstEver`, `admit`), also where server accounts are switched off and without an invite. A wrong code, or any code once an owner exists, answers 403 `owner_code_invalid`. Set alone, no sign-in without the code becomes the owner (a directory sign-in no longer claims the server first); set with `OWNER_PUBLIC_KEY`, either way works.
- `/api/health.ownerSetup` = no owner yet and a code is set: the registration form shows "Einrichtungscode (nur für den Eigentümer)" with a hint, and the server account's registration is offered even where server accounts are off (login and the join view of another server).
- The installer asks "Wer wird Besitzer?": the Squorli account's key (only with a directory), a server account with a setup code the script makes (`openssl rand`, 24 hex characters, kept on a rerun) or whoever signs in first. It prints the code at the end with the address; the code also stays in `.env`. Portainer: `OWNER_SETUP_CODE` as a stack variable.
- The start log says which way the owner is expected.

**Decisions made by Claude, confirmed by the user on 27 September 2026:** a setup code instead of a name (the name could be taken first); the code opens the registration even where server accounts are off; the installer's default is the server account with a code, except when a key was set before (with a directory) or a reconfiguration had neither; the code stays in `.env` after use (it has no effect once there is an owner).

**Checked:** typecheck; the built server against a fresh database (dev Postgres) with `OWNER_SETUP_CODE`: health `ownerSetup` true, a registration without the code not the owner (`invite_required`), a wrong code 403 `owner_code_invalid`, the right code (with spaces around it) 200 and the owner in the database (`server_settings.owner_id`, `members.is_owner`), then `ownerSetup` false and the code refused; `bash -n deploy/install.sh`. **Not checked:** the installer's new question in a real run (dind recipe in `deploy/AGENTS.md`), the form in the browser, a server with a directory and server accounts off.
