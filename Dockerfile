FROM oven/bun:1-alpine
WORKDIR /app

# `ts` (moreutils) stamps each log line with a timestamp; tzdata lets the
# TZ=Europe/Madrid setting below resolve so those stamps are Madrid local time.
RUN apk add --no-cache moreutils tzdata

# Install dependencies
COPY package.json bun.lock bun.lockb* ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source and build the SvelteKit app (client + server into build/)
COPY . .
RUN bun run build

ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOADS_DIR=/app/uploads
# Madrid local time for the app process and the log timestamps below (CET/CEST).
ENV TZ=Europe/Madrid
EXPOSE 3000

# The adapter-node output is self-contained; migrations in drizzle/ are applied
# on startup by the db layer (bun:sqlite).
#
# stdout/stderr are piped through `ts` so every line shown in Coolify carries an
# absolute Madrid-time timestamp, e.g. "[2026-07-26 18:04:11 CEST] [api] ...".
# pipefail preserves the server's exit status through the pipe.
CMD ["sh", "-c", "set -o pipefail; bun build/index.js 2>&1 | ts '[%Y-%m-%d %H:%M:%S %Z]'"]
