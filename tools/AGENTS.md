# tools – Dev start and generators

Part of the project description. The entry point is the root [AGENTS.md](../AGENTS.md) (commands, definition of done, cross-cutting conventions, the map of all documentation in its section 0). The commands that call these scripts are in the root file's section 3. `tools/` is deliberately not part of the Docker build context: everything generated here that the build needs is committed.

Notes on what the generators produce: `docs/features/emoji.md` (`emoji.mjs`), `docs/features/licenses.md` (`licenses.mjs`).

## Structure

```
tools/dev.mjs          Development start with cleanup (containers up, start apps, stop containers on exit); Node-only, no dependencies
tools/copy-web.mjs     copies apps/web/dist to apps/server/public (part of `pnpm build`)
tools/icons.mjs        collects all `<Icon name>` names in the web client, generates apps/web/src/icons/ from lucide-static (part of `pnpm build`, also `pnpm icons`); unknown name = build abort
tools/emoji.mjs        generates apps/web/src/emoji/: downloads the Noto Color Emoji COLRv1 slices, OFL.txt and font.json from Google Fonts into font/ and writes font.css (needs internet; `--no-font` skips it), shortcodes and picker data de/en from emojibase-data; `pnpm emoji`, output committed, not part of `pnpm build`
tools/licenses.mjs     generates apps/web/src/licenses/thirdParty.ts and THIRD-PARTY-NOTICES.md from the client's production dependencies, the latter with the programs of the package for Windows (deploy/windows/versions.json) (part of `pnpm build`, also `pnpm run licenses`; plain `pnpm licenses` is pnpm's own command); output committed
tools/desktop-icon.mjs generates apps/desktop/build/icon.png (1024 px) from docs/brand/squorli-icon.svg on the brand's dark tile and build/tray.png (64 px, the small mark, transparent) for the tray, rendered by headless Chrome (`CHROME=<path>` for another executable); run by hand after a brand change, output committed
tools/web-app-icons.mjs generates apps/web/public/app-icons/ (home screen icons of the web client: apple-touch-icon 180, icon-192/512 on the rounded tile, icon-maskable-512) from docs/brand/squorli-icon.svg on #0C1424 with headless Chrome (`CHROME=<path>`); run by hand after a brand change, then raise `?v=` in apps/web/index.html and `APP_ICON_VERSION` in apps/server/src/webManifest.ts (docs/features/home-screen.md)
tools/bots.mjs         Load test bots: `lk load-test` from the image livekit/livekit-cli, attaches to the network of the LiveKit dev container; `--video N` for camera bots (M3 bandwidth measurement)
```

## Known pitfalls

- **`EADDRINUSE :3000` right after `pnpm dev` (fixed 14 September 2026):** `tools/dev.mjs` used to load the entire `apps/server/.env` via `loadEnvFile` into its environment, which all apps inherit. The directory service thereby got `PORT=3000` and the chat `DATABASE_URL`. Now the wrapper reads only `LIVEKIT_DEV_NODE_IP` from the file and passes it exclusively to Compose. Rule: the wrapper never sets app variables; each app loads its own `.env`.
- **Wrapper test:** Ctrl+C cannot be triggered from scripts via `kill -INT` (MSYS does not reach native processes). Tested with `GenerateConsoleCtrlEvent` from PowerShell; alternatively terminate the apps via `taskkill`, the wrapper then stops the containers through the exit path.
- **`docker stats` does not measure the load test:** `pnpm bots` attaches itself to the network namespace of the LiveKit container; the media traffic runs over loopback and does not show up in NET I/O. Read the bandwidth from the `lk` table (subscriber) or from the debug view in the client.
