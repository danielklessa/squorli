# Multi-stage: builds protocol, web client and server. Image: docker build --target app -t squorli/app:local .
# (compose.yml sets "target" itself.) The directory service has its own repo and image (squorli-directory).
FROM node:26-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/link-preview/package.json packages/link-preview/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# The desktop app (apps/desktop) is part of the workspace and the lockfile, but the image never starts it: no Electron binary.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @squorli/web build && pnpm --filter @squorli/server build \
 && pnpm --filter @squorli/server --prod deploy --legacy /out

# ---- Chat server (API, WebSocket, web client)
FROM node:26-alpine AS app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/dist ./dist
COPY --from=build /out/drizzle ./drizzle
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/web/dist ./public
# License, notice and the third-party notices travel with the image (Apache License 2.0, section 4).
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
