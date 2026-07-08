#!/bin/sh
# Container entrypoint. On a single-service deploy the stream extractor runs as
# a co-process next to the app so VidSrc Direct works without a separate
# service. Multi-service deploys (e.g. Vision) point STREAMBERT_EXTRACTOR_URL at
# a dedicated extractor container and must NOT run a redundant co-process.
#
# The local extractor listens on a fixed internal port (8788); the app reaches
# it via STREAMBERT_EXTRACTOR_URL=http://127.0.0.1:8788 (the Dockerfile default,
# overridden by an explicit external URL at deploy time). It is restarted if it
# dies so a Chromium OOM under tight memory just briefly drops VidSrc Direct
# (the app falls back to an embed) instead of disabling it for the container's
# lifetime.
case "${STREAMBERT_EXTRACTOR_URL:-}" in
  ""|*127.0.0.1*|*localhost*)
    (
      while true; do
        PORT=8788 node extractor/server.js || true
        echo "[start] extractor exited; restarting in 2s"
        sleep 2
      done
    ) &
    ;;
  *)
    echo "[start] external STREAMBERT_EXTRACTOR_URL=$STREAMBERT_EXTRACTOR_URL; not starting local extractor"
    ;;
esac

# The app is the primary/foreground process so the platform tracks its health
# and lifecycle (it binds the platform-provided $PORT).
exec node server/index.js
