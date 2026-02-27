FROM oven/bun:1-alpine
WORKDIR /app

# Install dependencies
COPY package.json bun.lock bun.lockb* ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source and build frontend
COPY . .
RUN bun run build

ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOADS_DIR=/app/uploads
EXPOSE 3000

CMD ["bun", "server/index.ts"]
