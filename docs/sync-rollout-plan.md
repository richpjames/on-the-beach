# Sync Rollout Plan

## Phase 1: Contract and Local Scaffolding

1. Freeze sync endpoint contracts with JSON Schema.
2. Add client-side `AuthService` and `SyncService` scaffolding.
3. Add local sync tables (`sync_outbox`, `sync_state`, `sync_inbox`).

## Phase 2: Local Backend Infra (Docker Compose)

1. Create `docker-compose.yml` with Postgres for backend development.
2. Add optional Adminer for DB inspection.
3. Add SQL init scripts under `ops/postgres/init` as backend migrations are defined.

## Phase 3: Backend Auth + Sync Endpoints

1. Implement OAuth PKCE login and rotating refresh token flow.
2. Implement `POST /v1/sync/push` with idempotency by `opId`.
3. Implement `GET /v1/sync/pull` backed by monotonic `change_log.version`.

## Phase 4: Data Model Convergence

1. Add UUID primary identifiers to synced entities.
2. Add tombstones (`deleted_at`) where required.
3. Build deterministic conflict handling (server-version last-write-wins initially).

## Phase 5: Safari Extension Ingest

1. Ship deep-link ingest first.
2. Add scoped extension token flow.
3. Point extension to `POST /v1/links`, then rely on pull sync for app delivery.
