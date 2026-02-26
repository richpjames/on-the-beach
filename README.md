# On The Beach

A full-stack music tracker for collecting links and keeping tabs on listening status. The app runs a Bun + Hono backend with a persistent server-side SQLite database and a Vite-powered TypeScript frontend.

## Features

- Add music links from Bandcamp, SoundCloud, Apple Music, Mixcloud, YouTube, and more
- Metadata auto-populated by scraping OG tags, JSON-LD, and oEmbed APIs
- Track listening status (To Listen, Listening, Listened, Revisit, Done)
- Rate releases and track purchase intent
- Organise items into named **Stacks** (collections)
- Track physical media details (format, label, year, country, catalogue number)
- Scan release covers with Mistral AI (OCR or vision mode)
- Upload and store cover artwork
- Ingest music links automatically from emails via embedded SMTP server or HTTP webhook
- Filter the list by status, stack, or source
- Full-text search

## Tech Stack

- **Runtime**: Bun
- **Backend**: Hono (REST API)
- **Database**: SQLite via `better-sqlite3` + Drizzle ORM
- **Frontend**: Vite + TypeScript (SPA)
- **AI**: Mistral (cover scanning)
- **Email**: smtp-server + mailparser (SMTP ingest)

## Getting Started

```bash
bun install
bun run dev
```

Open http://localhost:3000.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_PATH` | No | `on_the_beach.db` | Path to the SQLite database file |
| `PORT` | No | `3000` | HTTP server port |
| `UPLOADS_DIR` | No | `uploads` | Directory for uploaded cover images |
| `MISTRAL_API_KEY` | No | — | Enables AI cover scanning |
| `MISTRAL_SCAN_MODEL` | No | `mistral-ocr-latest` | Model for cover scanning. Non-OCR models use chat-completions mode. |
| `SMTP_ENABLED` | No | `false` | Set to `true` to start the embedded SMTP server |
| `SMTP_PORT` | No | `2525` | Port for the embedded SMTP server |
| `SMTP_ALLOWED_FROM` | No | (all) | Comma-separated sender addresses to accept |
| `INGEST_API_KEY` | No | — | Secret token for the HTTP email ingest webhook. Required to enable it. |
| `INGEST_ENABLED` | No | `true` | Set to `false` to disable the HTTP ingest endpoint without removing the key |

## Scripts

```bash
bun run dev             # Start dev server (Hono + Vite HMR) on port 3000
bun run build           # Build frontend for production
bun run typecheck       # Type-check without building
bun run test:unit       # Unit tests (Bun test)
bun run test:e2e        # Smoke E2E tests (Playwright)
bun run test:e2e:full   # Full E2E suite (Playwright)
bun run db:generate     # Generate Drizzle migrations
bun run db:migrate      # Apply migrations
bun run db:studio       # Open Drizzle Studio
bun run db:seed         # Seed the database
bun run lint            # Lint with oxlint
bun run format          # Format with oxfmt
```

## Email Ingest

Music links can be ingested automatically from emails in two ways.

### Embedded SMTP server

Set `SMTP_ENABLED=true`. The server listens on `SMTP_PORT` (default 2525) and extracts music URLs from incoming email bodies to create items automatically.

### HTTP webhook

Set `INGEST_API_KEY` to a secret token, then point your email provider's webhook at:

```
POST /api/ingest/email
Authorization: Bearer <INGEST_API_KEY>
```

Append `?provider=sendgrid` for SendGrid payloads.

## Data Storage

Data is stored in a SQLite file on the server. In production, mount a persistent volume at the path set by `DATABASE_PATH`. Cover image uploads are stored under `UPLOADS_DIR` and also require a persistent volume.

## Deployment

Coolify deployment runbook: `docs/deployment/coolify-alpha.md`

The app ships as a single Docker container (Dockerfile builds the frontend and starts the Bun server). Use `Dockerfile` build pack, port `3000`, and mount persistent volumes for the database and uploads directories.

## License

This project is licensed under PolyForm Noncommercial License 1.0.0.
See `LICENSE` for details.
