# ── React Router (SPA) — built from the monorepo root ──
# build context in docker-compose = repository root (.)
FROM oven/bun:1.4.0-alpine AS base
WORKDIR /app

# 1) Install dependencies from manifests (cacheable layer). All workspace
# manifests are copied — `bun install --frozen-lockfile` validates the whole
# workspace against bun.lock, so a missing member (e.g. api) fails the install.
FROM base AS install
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY apps/bot/package.json ./apps/bot/
COPY packages/db/package.json ./packages/db/
COPY packages/auth/package.json ./packages/auth/
COPY packages/agent-tools/package.json ./packages/agent-tools/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/mailer/package.json ./packages/mailer/
COPY packages/runner/package.json ./packages/runner/
COPY packages/storage/package.json ./packages/storage/
COPY packages/eslint-config/package.json ./packages/eslint-config/
RUN bun install --frozen-lockfile

# 2) The runtime dependency tree, without the build-time ones (Vite, the React
# Router compiler, TypeScript). This is what the final image runs on: the tiny
# Express server needs express, compression and better-auth's cookie helper.
FROM install AS prod-deps
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --production

# 3) Build the client bundle. bun keeps some workspace deps in per-package
# node_modules rather than hoisting them to the root, so copy the whole install
# tree (manifests + every node_modules), then overlay the source. .dockerignore
# excludes node_modules, so `COPY . .` does not clobber the copied dependencies.
FROM base AS build
COPY --from=install /app ./
COPY . .
# No per-instance value is baked in: the origins are read from the environment at
# request time and published to the browser through /__env.js
# (apps/web/server/middleware.mjs), so one image serves any instance.
RUN cd apps/web && bun run build

# 4) Minimal final image. Node, not Bun: the server is a plain Node/Express
# process, and Alpine keeps the musl build of any traced native module valid.
FROM node:24-alpine AS release
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

# The workspace layout is kept so module resolution finds the hoisted root
# node_modules exactly as it did during the build.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/build ./apps/web/build
COPY --from=build /app/apps/web/server ./apps/web/server
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/package.json ./package.json

EXPOSE 3001
CMD ["node", "apps/web/server/index.mjs"]
