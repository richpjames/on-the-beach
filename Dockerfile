# Build stage. .git is deliberately IN the build context (.dockerignore): the
# Deploy workflow tags the commit it deploys (v1.0.N) because branch protection
# rules out the old bump-commit-to-main, and the tag is read back out here so
# the footer shows the deployed version. Only this stage sees .git — the final
# image below copies the built app without it.
FROM oven/bun:1-alpine AS build
WORKDIR /app

RUN apk add --no-cache git

# Install dependencies
COPY package.json bun.lock bun.lockb* ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source and build the SvelteKit app (client + server into build/)
COPY . .
# Highest v* tag on HEAD → .app-version, which vite.config.ts reads. An empty
# file means an untagged build and vite falls back to package.json's version.
# The numeric -k sort works on busybox (no GNU coreutils in this image).
RUN (git tag --points-at HEAD | grep '^v[0-9]' | sed 's/^v//' \
      | sort -t. -k1,1n -k2,2n -k3,3n | tail -1 > .app-version || true) \
 && bun run build \
 && rm -rf .git

FROM oven/bun:1-alpine
WORKDIR /app

# `ts` (moreutils) stamps each log line with a timestamp; tzdata lets the
# TZ=Europe/Madrid setting below resolve so those stamps are Madrid local time.
RUN apk add --no-cache moreutils tzdata

COPY --from=build /app ./

ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOADS_DIR=/app/uploads
# Madrid local time for the app process and the log timestamps below (CET/CEST).
ENV TZ=Europe/Madrid
# adapter-node rejects a body over this with a 413 before any route runs, and
# its 512KB default is smaller than a shared record sleeve: clients that can't
# compress first (iPhone Shortcuts, an app build predating the compression
# ladder) had their photo uploads bounced. 4M clears the server's own
# `MAX_IMAGE_BASE64_LENGTH` cap of 2,000,000 chars, which now does the
# rejecting — with a readable JSON error instead of an HTML error page.
ENV BODY_SIZE_LIMIT=4M
EXPOSE 3000

# The adapter-node output is self-contained; migrations in drizzle/ are applied
# on startup by the db layer (bun:sqlite).
#
# stdout/stderr are piped through `ts` so every line shown in Coolify carries an
# absolute Madrid-time timestamp, e.g. "[2026-07-26 18:04:11] [api] ...".
# pipefail preserves the server's exit status through the pipe.
CMD ["sh", "-c", "set -o pipefail; bun build/index.js 2>&1 | ts '[%Y-%m-%d %H:%M:%S]'"]
