# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — build the frontend (Vite -> /app/dist)
###############################################################################
FROM node:20-slim AS builder

WORKDIR /app

# The web build only needs the Vite toolchain. Skip Electron's ~100MB binary
# download (electron is a devDependency but unused by the web bundle).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false

# Install root deps against the committed lockfile first (better layer caching).
# Dev deps are required here: vite, @vitejs/plugin-react, terser.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the sources needed to build (see .dockerignore for exclusions).
COPY . .

# Root package.json has no "build" script; the web build is a plain `vite build`
# (vite.config.js sets base "./", outDir defaults to ./dist). Use the locally
# installed vite via npx so we don't touch package.json.
RUN npx --no-install vite build

###############################################################################
# Stage 2 — runtime (Node server + system media binaries)
###############################################################################
FROM node:20-slim AS runtime

# System binaries the backend shells out to:
#   ffmpeg / ffprobe  — media probing & muxing for downloads
#   chromium          — Phase-2 Playwright m3u8 extractor (see docs/WEB_PORT.md)
#   ca-certificates   — TLS trust store for outbound fetches
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        chromium \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    STREAMBERT_DATA=/data \
    # Reuse the system Chromium; don't let Puppeteer/Playwright fetch their own.
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Path to the downloader CLI (vid-dl). NOT bundled in this image — mount or
    # install it (see docs/DEPLOY.md). The server tolerates its absence until an
    # actual download is requested, so the build never fails without it.
    STREAMBERT_DOWNLOADER=/usr/local/bin/vid-dl

# Built frontend from stage 1.
COPY --from=builder /app/dist ./dist

# Backend source + production-only deps. server/ has no lockfile committed, so
# use `npm install --omit=dev` rather than `npm ci`.
COPY server ./server
RUN cd server && npm install --omit=dev && npm cache clean --force

# Data dir (downloads + secure key store); bind-mounted via docker-compose.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 8787

# Liveness: the static root returns 200 once the frontend is built and served.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
