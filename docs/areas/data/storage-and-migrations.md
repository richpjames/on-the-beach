# Storage And Migrations

## Persistence

- SQLite is the system of record.
- `server/db/index.ts` opens the database connection used across the server.
- `DATABASE_PATH` controls where the database file lives.
- `UPLOADS_DIR` controls where release artwork is written and served from.

## Schema evolution

- Drizzle migrations live in `drizzle/`.
- Snapshot metadata lives in `drizzle/meta/`.
- `drizzle.config.ts` configures migration generation and application.

## Seed data

`server/db/seed.ts` seeds the `sources` table with the known platform list. Run it when setting up a new database so source URLs can be classified consistently.

## Operational note

Container or hosted deployments need persistent volumes for both the SQLite file and the uploads directory. Without both, item metadata and cover art will be lost across restarts.
