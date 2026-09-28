---
name: server-release
description: Prepare a release of Squorli Server (the container image with server and web client) - work out what changed since the last server tag, what operators must know before updating (migrations, new or removed environment variables, the desktop app version it needs), propose sensible version numbers, set the chosen version in apps/server/package.json and write the release notes for the GitHub release. Use when the user wants a new server version, server release notes or a server changelog.
---

# Server release: version and release notes

Run from the `squorli-server` repository. Read `deploy/AGENTS.md` (sections "Published image and the standard installation"
and the pitfalls about tags) first; it owns how the image is built and published, this skill only prepares a release.
Replies to the user are in German; everything written into the repository is English.

**This skill never tags, pushes, publishes or deploys.** It edits files and stops. Commit only if the user asks.

An optional argument is the version to set (`/server-release 0.2.0`); then skip the proposal in step 4 and only check it.

## What a server release is

- The image `ghcr.io/danielklessa/squorli-server` holds the app server **and the web client it serves**. Every push to the
  default branch already publishes `:latest` (`.github/workflows/ci.yml`, job `image`); a tag `v<version>` additionally
  publishes `:v<version>`, which operators can pin in `APP_IMAGE`. `.github/workflows/server-release.yml` puts
  `apps/server/release-notes/<version>.md` into a **draft** GitHub release titled "Squorli Server <version>" and refuses a
  tag that does not match `apps/server/package.json`.
- **The package for Windows** (`deploy/windows/`, installations without Docker) is built and tested by the same workflow
  on a Windows runner and attached to the release as `squorli-server-<version>-windows-x64.zip` with its `.sha256` file,
  about half an hour after the draft was written. `squorli update` on Windows reads the published releases and takes
  the newest one that carries the package, so these two names and the tag `v<version>` are fixed.
- The version in `apps/server/package.json` is what the login screen's footer and `/api/health` show, and what the
  package for Windows carries in its name and its `manifest.json`.
- Tags `desktop-v*` are the desktop app's (skill `desktop-release`); never mix the two.

## 1. Find the last release

- `git tag --list "v*" --sort=-v:refname | head -5` and the `version` in `apps/server/package.json`.
- The base is the newest `v*` tag. **No `v*` tag yet** (the case until the first server release): the base is the first
  commit, and the notes describe the state as a whole in a few lines instead of a list of changes since something; say so.
- If `package.json` names a version that has no tag yet, that version is being prepared: keep it unless the user wants
  another, and write or update its notes. If its tag exists already, a new number is needed; if that tag is pushed
  (`git ls-remote --tags origin "v<version>"`), its draft can be refreshed by running the workflow by hand for that tag only
  when the notes are committed on the tagged commit, otherwise the notes must be pasted into the release by hand.

## 2. Collect what changed for operators and their members

A change counts when it touches `apps/server/`, `apps/web/`, `packages/`, `deploy/`, `Dockerfile` or `.env.example`
(`apps/desktop/` only ships with the app).

- `git log <base>..HEAD --format="%h %ad %s" --date=short -- apps/server apps/web packages deploy Dockerfile .env.example`
  and the same with `git diff --stat`. Include uncommitted work (`git status --short`): it will be part of the release once
  committed.
- Commit subjects are terse. **The real source is `docs/MILESTONE-LOG.md`**: every row dated after the base (after the row
  of the last server version, once there is one), plus the entries of the same dates in `docs/features/*.md` for anything
  unclear. Read them; do not guess from file names.
- Drop refactoring, tests, docs, tooling, and what only the desktop app's shell does.

## 3. Collect what an operator must know before updating

This is the part the desktop notes do not have. Check each and write down what applies:

- **Database migrations:** `git diff --name-only <base>..HEAD -- apps/server/drizzle/` (new `*.sql`). They run at the
  start and cannot be undone; name what they add in plain words, and say "back up first" whenever there is one.
- **Environment variables:** `git diff <base>..HEAD -- .env.example apps/server/src/config.ts deploy/compose.yml
  deploy/portainer.yml deploy/windows/templates/env.example`: new ones (with their default), removed or deprecated
  ones, changed defaults. A variable that a Portainer stack must get by hand is worth a line.
- **Compose or proxy changes** an existing installation needs (`deploy/`): a new port, a changed Caddyfile or LiveKit config.
  The install script's `squorli update` pulls the image only, not new deploy files: say what to download again, if anything.
- **Installations on Windows** (`git diff <base>..HEAD -- deploy/windows`): `squorli update` there runs the setup of the
  new package, so programs, templates and service files come by themselves. Worth a line: a new port to open in the
  firewall or to forward, a changed proxy template (`deploy/proxies/`, IIS included), a new version of PostgreSQL,
  LiveKit or Caddy inside the package (`deploy/windows/versions.json`), and the first release that carries a package.
- **Clients:** a change of `PROTOCOL_VERSION` (`packages/protocol/src/index.ts`), or behaviour older desktop apps cannot
  handle (the milestone log's rows say "Needs a desktop app release"): name the desktop app version that is needed, or say
  that a new one follows (skill `desktop-release`). The server goes out **before** the app.
- **The directory:** a change that needs a newer Squorli Directory, or new directory features, is worth a line.
- **Anything that changes access** for existing members (sign-in rules, permissions, what a role may do): say what members
  will see after the update.

**Does anything of this ask an operator to do something by hand before or for the update** (a deploy file to fetch
again, a variable that must be set, a file of their own to change)? Then this release gets the mark in step 5:
installations with automatic updates (`squorli autoupdate`, `docs/features/auto-update.md`) must not take it by
themselves. A backup alone is no such work (every update makes one), and neither is something only a part of the
operators may want to do later.

## 4. Propose version numbers

Semantic versioning, below 1.0 while the project is in preview. Offer the realistic candidates with one line of reasoning
each and recommend one:

- **Patch** (`0.2.3` -> `0.2.4`): only fixes and small improvements, no migration, no new variable, nothing an operator
  must do.
- **Minor** (`0.2.3` -> `0.3.0`): new features, a migration, a new or removed environment variable, a change members notice
  in access or permissions, or a change that needs a new desktop app.
- **First release** (no `v*` tag yet, `package.json` at `0.0.1`): propose `0.1.0`.
- **Major** (`1.0.0`): never on its own; only if the user says the server leaves its preview state.

Check before proposing: the number is greater than every existing `v*` tag, and its tag does not exist yet. Ask with
AskUserQuestion (recommended option first) unless a version was passed as the argument.

## 5. Set the version

- `apps/server/package.json`: `"version"`. Nothing else needs it (the root `package.json` stays as it is; the lock file does
  not carry it).
- `apps/server/package.json`: `"squorli": { "autoUpdateFrom" }`, the version from which on an installation may update to
  this release by itself. Set it to the new version when the release asks for work by hand (step 3), else leave it as
  it is; never lower it. Tell the user which of the two it is and why.
- `docs/MILESTONE-LOG.md`: one new row at the top of the table: "Server version <version>" with what it carries, the
  migrations and variables, which desktop app version it needs, and "Not tagged yet.".

## 6. Write the release notes

File: `apps/server/release-notes/<version>.md`. The workflow adds a standing text with the image name and how to update,
so do not repeat that and add no title.

Written for the people who run a server (and, in "New", for what their members get), not for developers:

- English, plain words. No file names, function names, table names or internal reasons; a variable name is fine where an
  operator sets it.
- Sections in this order, leaving out empty ones:
  - `## Before you update`: whether installations with automatic updates take this version by themselves (the mark of
    step 5), backups because of migrations, new or removed variables, deploy files to fetch again, the
    desktop app version needed, changes in who can sign in. Only what applies; this section comes first because it matters
    before anything else.
  - `## New`: a short bold name, then one or two sentences, with where it lives (Administration > …, Settings > …).
  - `## Improved`
  - `## Fixed`
- One bullet per change, the most noticeable first. Say when something needs a directory, or only works with the desktop app.
- Only what is in the milestone log and the code. Nothing planned, nothing unverified presented as working: if a feature
  note lists something under "not checked", do not promise it.
- Short. A release with ten changes fits on one screen.

## 7. Check and hand over

- Run `git status --short` and show which files changed.
- Show the user the notes in the reply (in German: a short summary plus the English text as written).
- End with what remains for them, in order: commit (squorli-server), push the default branch (CI publishes `:latest`),
  tag `v<version>` on that commit and push the tag (CI publishes `:v<version>`, the release workflow writes the draft and
  attaches the package for Windows once it is built and tested), wait for that workflow to end, check the draft (the ZIP
  and its `.sha256` file are attached) and publish it on GitHub, update the servers (`squorli backup`, `squorli update`;
  on Windows `squorli update` alone, it backs up first). If a desktop app release is
  needed, it follows after the server (skill `desktop-release`). Website texts that describe the change go out with a push
  of `squorli-website` after the server is pushed.
