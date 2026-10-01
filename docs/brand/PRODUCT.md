# Squorli product identity

Last updated: 15 September 2026. Keep this file byte-identical in the brand packages of all three Squorli projects.

## Names and domains

| Name | Meaning | Official destination |
| --- | --- | --- |
| Squorli | The overall brand: a home for community conversations, voice and video | https://squorli.com |
| Squorli Server | The self-hosted, open-source community server and its web client | https://github.com/danielklessa/squorli |
| Squorli Directory | The separately operated identity, discovery and friends service; not open source | https://directory.squorli.com |

The website is being prepared for squorli.com; this statement is not a deployment status claim. The Directory destination was supplied by the project owner. Do not advertise a public source repository for the Directory. Generic deployment examples may use chat.example.org for a community's own server.

## Product description

The official published server container is `ghcr.io/danielklessa/squorli-server:latest`. Its package page is https://github.com/danielklessa/squorli/pkgs/container/squorli-server. This image includes the server and web client, not the separately operated Directory. Use the package page for available tags/digests; do not invent versions or architecture support. `latest` is mutable. Compose installation uses `APP_IMAGE`, the matching profile, `pull`, and `up -d --no-build`; a source build remains an alternative.

Always link the open-source Squorli Server to https://github.com/danielklessa/squorli in public copy, documentation and installation examples. Clone using the same URL with `.git`; link individual files using GitHub's `/blob/main/` path. Development remotes and container registries are separate configuration and do not determine the public source address.

Squorli gives gaming, creator and other communities a place for text, voice, video and screen sharing on a server they operate themselves. Roles, invitations and moderation belong to each server. The browser client is implemented; a desktop app for Windows and Linux (the same client in its own window) is available as an early version from https://squorli.com, macOS is planned.

Connecting Squorli Directory adds global handles, password-encrypted key backup, authenticator support, public server discovery, friends and end-to-end encrypted direct messages between friends. The Directory is optional for basic server operation. Do not describe it as self-hosted open-source software or imply that an optional connection makes its dependent features available offline.

Only direct messages between friends are described as end-to-end encrypted. Do not extend that claim to server channels, attachments, voice or video. Do not claim anonymous operation, zero metadata, audited cryptography, measured scalability or production readiness without supporting evidence.

## Release and licensing wording

The owner identifies Squorli Server as the open-source project and Squorli Directory as not open source. Squorli Server is licensed under the Apache License, Version 2.0 (file `LICENSE` in the server repository, copyright Daniel Klessa). Name that license exactly in public copy; do not describe it as MIT or as pending.

Video and screen sharing are implemented and have been tested successfully with real webcams and screen shares (15 September 2026); restrictive-network/TURN testing remains pending. Screen audio depends on a supported Chromium browser. Do not present roadmap targets as measured capabilities.

## Language and visual rules

- Internal project documentation and agent instructions are maintained in English.
- The public website's marketing text, navigation and technical articles are available in German and English. Update both translations in the same work step and share executable examples to prevent drift.
- Use the spelling **Squorli**, **Squorli Server**, and **Squorli Directory** consistently in current descriptions. Historical technical identifiers need not be renamed.
- Use the approved version 2 SVGs, palette and UI font from this package. Website headlines may scale responsively beyond the UI heading sizes, without changing the logo geometry or wordmark.
- Illustrations may show fictional communities but must be labeled as examples. They must not imply a live app session or modify the brand mark.

## Synchronization

The canonical package is squorli-server/docs/brand. Mirror the complete package into squorli-directory/docs/brand and squorli-website/docs/brand. Mirror the selected runtime SVGs and CSS tokens into each application's brand asset folder. Product-positioning changes must also update affected READMEs, plans and public website copy in the same work step.

From squorli-website run `pnpm brand:sync` after editing the canonical package, then `pnpm brand:check`. The scripts compare bytes and never delete unexpected files. Missing sibling checkouts or unexpected extra files require manual review; do not silently create a divergent brand package.

## Standard container installation

The default user installation requires no Git clone, Node.js or application build. Download only .env.example, deploy/compose.yml, Caddyfile, livekit.yaml and the optional nginx port overlay into a fresh squorli directory. Configure .env with APP_IMAGE and the matching proxy mode, then run Compose pull and up --no-build from squorli/deploy. Updates pull the image without git pull; never overwrite existing secrets by repeating the initial download. Source cloning and --build belong only to a separate optional developer workflow at the end of both public guides. Both languages must stay equivalent.
