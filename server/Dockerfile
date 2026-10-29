# Build context is the repo root: docker build -f server/Dockerfile .
# One image: the server (Node runs its TypeScript directly) plus the built web app it serves and
# the headless device that answers its HTTP API (/api/v1).

# The web app is the same files on every platform: build it once, natively on the build machine
# ($BUILDPLATFORM), not again under QEMU for arm64, where npm ci + vite (esbuild) take minutes and
# can hang.
FROM --platform=$BUILDPLATFORM node:24 AS web
ENV IBM_TELEMETRY_DISABLED=true
WORKDIR /build
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci
COPY shared shared
COPY app app
RUN npm run build:web && npm run build:headless

FROM node:24-slim
WORKDIR /srv
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY server server
COPY shared shared
COPY --from=web /build/app/dist app/dist
COPY --from=web /build/server/headless server/headless
# Where the headless device keeps its database between starts (KUBUS_HEADLESS_DIR, set in docker-compose.yml;
# mount a volume here). Made in the image so a new named volume starts with it; writable by root (what the
# image runs as) and by `node` (for `--user node`).
RUN mkdir -p /data/headless && chown node:node /data/headless
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
