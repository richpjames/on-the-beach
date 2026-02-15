# Sync API Contract

This document defines the first-pass sync contract for:
- `POST /v1/sync/push`
- `GET /v1/sync/pull`

Canonical JSON Schemas:
- `docs/api/schemas/sync-push-request.schema.json`
- `docs/api/schemas/sync-push-response.schema.json`
- `docs/api/schemas/sync-pull-query.schema.json`
- `docs/api/schemas/sync-pull-response.schema.json`

## POST /v1/sync/push

Auth:
- Bearer access token

Request body:
- `deviceId`: stable client installation id
- `ops[]`: up to 500 operations with `opId` idempotency keys

Response body:
- `appliedOpIds[]`: operations accepted and applied
- `conflicts[]`: operations rejected with conflict reason
- `serverVersion`: latest change_log version after push

## GET /v1/sync/pull

Auth:
- Bearer access token

Query params:
- `since`: last server version seen by client
- `limit`: max records to return (1..500)

Response body:
- `changes[]`: ordered change events
- `nextVersion`: new cursor to persist client-side
- `hasMore`: whether more pages are available

## Notes

- Operations are idempotent by `opId`.
- Ordering is defined by monotonic `version` in `changes[]`.
- Deletes must be represented via `action = "delete"` with tombstoned payload.
