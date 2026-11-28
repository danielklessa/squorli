# Multi-stage: builds protocol, web client and server. Image: docker build --target app -t squorli/app:local .
# (compose.yml sets "target" itself.) The directory service has its own repo and image (squorli-directory).
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
# Node.js 26 ships no corepack: pnpm in the version package.json names (`packageManager`) comes from npm.
RUN npm install -g "$(node -p "require('./package.json').packageManager")"
COPY packages/protocol/package.json packages/protocol/
COPY packages/link-preview/package.json packages/link-preview/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/
# The desktop app (apps/desktop) is part of the workspace and the lockfile, but the image never starts it: no Electron binary.
# The mobile app (apps/mobile) is installed for the same reason and never built here (its native projects are not in the context).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @squorli/web build && pnpm --filter @squorli/server build \
 && pnpm --filter @squorli/server --prod deploy --legacy /out

# ---- Chat server (API, WebSocket, web client)
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/web/dist ./public
# License, notice and the third-party notices travel with the image (Apache License 2.0, section 4).
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
# The deploy files travel with the image too (5 October 2026, security audit L-10): the installer takes compose.yml, the
# Caddyfile, livekit.yaml, the proxy overlays and .env.example out of the signed and checked image (deploy/install.sh
# `download_files`), so they carry the release's signature and match the version that runs, instead of coming from
# raw.githubusercontent.com over TLS alone.
COPY deploy ./deploy
COPY .env.example ./deploy/.env.example
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
