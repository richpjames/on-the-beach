# On The Beach

A full-stack music tracker for collecting links and keeping tabs on listening status. The app runs a Bun + Hono backend with a persistent server-side SQLite database and a Vite-powered TypeScript frontend.

## Features

- Add music links from Bandcamp, SoundCloud, Apple Music, Mixcloud, YouTube, and more
- Metadata auto-populated by scraping OG tags, JSON-LD, and oEmbed APIs
- Track listening status (To Listen, Listening, Listened, Revisit, Done)
- Rate releases and track purchase intent
- Organise items into named **Stacks** (collections) with hierarchical nesting to any depth
- Navigate nested stacks via breadcrumb trail and inline folder rows
- Multi-parent stack support (DAG — one list can live inside several others)
- Direct shareable URLs per stack (`/s/:id/:name`)
- Track physical media details (format, label, year, country, catalogue number)
- Scan release covers with Mistral AI (OCR or vision mode)
- Upload and store cover artwork
- Ingest music links automatically via HTTP webhook
- Filter the list by status, stack, or source
- Full-text search
- "You may also like" suggestions (via Cover Art Archive) when marking items as listened

## Tech Stack

- **Runtime**: Bun
- **Backend**: Hono (REST API)
- **Database**: SQLite via `better-sqlite3` + Drizzle ORM
- **Frontend**: Vite + TypeScript (SPA)
- **AI**: Mistral (cover scanning)

## Getting Started

```bash
bun install
bun run dev
```

Open http://localhost:3000.

## Environment Variables

| Variable             | Required | Default              | Description                                                                 |
| -------------------- | -------- | -------------------- | --------------------------------------------------------------------------- |
| `DATABASE_PATH`      | No       | `on_the_beach.db`    | Path to the SQLite database file                                            |
| `PORT`               | No       | `3000`               | HTTP server port                                                            |
| `UPLOADS_DIR`        | No       | `uploads`            | Directory for uploaded cover images                                         |
| `MISTRAL_API_KEY`    | No       | —                    | Enables AI cover scanning and unsupported music-link extraction             |
| `MISTRAL_LINK_MODEL` | No       | `mistral-small-latest` | Model for unsupported music-link extraction via chat completions.         |
| `MISTRAL_SCAN_MODEL` | No       | `mistral-ocr-latest` | Model for cover scanning. Non-OCR models use chat-completions mode.         |
| `INGEST_API_KEY`     | No       | —                    | Secret token for the HTTP email ingest webhook. Required to enable it.      |
| `INGEST_ENABLED`     | No       | `true`               | Set to `false` to disable the HTTP ingest endpoint without removing the key |

## Scripts

```bash
bun run dev             # Start dev server (Hono + Vite HMR) on port 3000
bun run build           # Build frontend for production
bun run typecheck       # Type-check without building
bun run test:unit       # Unit tests (Bun test)
bun run test:e2e        # Smoke E2E tests (Playwright)
bun run test:visual     # Visual regression tests (Playwright screenshot comparison)
bun run test:visual:update  # Re-generate baseline screenshots after intentional UI changes
bun run db:generate     # Generate Drizzle migrations
bun run db:migrate      # Apply migrations
bun run db:studio       # Open Drizzle Studio
bun run db:seed         # Seed the database
bun run lint            # Lint with oxlint
bun run format          # Format with oxfmt
```

## Visual Regression Tests

Visual regression tests use Playwright's built-in screenshot comparison. No external service or token is required.

### Running locally

```bash
bun run test:visual
```

Playwright compares the captured screenshots against the baselines committed in `tests/visual/`. A diff report is written to `playwright-report/` and opened automatically after the run.

### Updating baselines after intentional UI changes

```bash
bun run test:visual:update
```

This overwrites the baseline PNGs. Review the diff, then commit the updated files.

> **Important:** baselines must be generated on Linux to match the CI environment. Running `test:visual:update` on macOS or Windows will produce slightly different pixel output and cause false failures in CI. Use a Linux machine, WSL2, or the dev container to regenerate baselines.

### Reviewing diffs in pull requests

The `Visual Regression` GitHub Actions workflow runs automatically on every PR against `main`. When it completes, a sticky comment is posted with a link to the Playwright HTML report published to GitHub Pages at:

```
https://<owner>.github.io/<repo>/visual-reports/<pr-number>/
```

The workflow uses `continue-on-error: true` so the report is always published even when screenshots differ, giving reviewers a chance to inspect the diff before deciding whether it is intentional.

## Email Ingest

Set `INGEST_API_KEY` to a secret token, then point your email provider's webhook at:

```
POST /api/ingest/email
Authorization: Bearer <INGEST_API_KEY>
```

Append `?provider=sendgrid` for SendGrid payloads.

## Data Storage

Data is stored in a SQLite file on the server. In production, mount a persistent volume at the path set by `DATABASE_PATH`. Cover image uploads are stored under `UPLOADS_DIR` and also require a persistent volume.

For container deployments, prefer an absolute uploads path (for example `UPLOADS_DIR=/app/uploads`) and mount that path as a persistent volume.

## Deployment

Coolify deployment runbook: `docs/deployment/coolify-alpha.md`

The app ships as a single Docker container (Dockerfile builds the frontend and starts the Bun server). Use `Dockerfile` build pack, port `3000`, and mount persistent volumes for the database and uploads directories.

## Repo Documentation

Short repo guides now live under `docs/areas/`.

- `docs/areas/server/` for entrypoints and route groups
- `docs/areas/frontend/` for the app shell, state machines, and retro UI rules
- `docs/areas/data/` for schema and persistence
- `docs/areas/integrations/` for ingest, scraping, scanning, and enrichment
- `docs/areas/quality/` for tests and eval tooling

## License

This project is licensed under PolyForm Noncommercial License 1.0.0.
See `LICENSE` for details.
