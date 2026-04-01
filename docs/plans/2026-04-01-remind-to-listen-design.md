# Remind To Listen Design

## Overview

Allow users to schedule a date on the release page after which an item is automatically returned to the "To Listen" list and an XState event is dispatched to the app machine (for future notification UI).

## User Flow

1. User opens a release page for a listened item
2. A date input is shown, prefilled with the Bandcamp release date if available
3. User confirms or edits the date and saves
4. On or after that date, a server cron job moves the item back to `to-listen` and flags it as pending
5. On next app load, the client dispatches a `REMINDERS_READY` XState event (no-op for now) and clears the pending flag

## Data Model

Two new fields on `musicItems`:

| Field | Type | Description |
|---|---|---|
| `remind_at` | timestamp, nullable | The scheduled reminder date set by the user |
| `reminder_pending` | boolean, default false | Set by cron when `remind_at` has passed; cleared by client after dispatching the XState event |

## Release Page UI

- A date input on the release page, prefilled with the Bandcamp release date from link metadata if available
- User can edit the prefilled date or enter one from scratch
- A "Clear reminder" option if a reminder is already set
- Submits to the reminder API on confirm

## API

### `PUT /api/music-items/:id/reminder`
Sets `remind_at` from the submitted date.

**Body:** `{ remindAt: string }` (ISO date)

### `DELETE /api/music-items/:id/reminder`
Clears `remind_at` and `reminder_pending`.

## Server Cron

Runs once daily (e.g. midnight). For each `musicItem` where `remind_at <= now` and `reminder_pending = false`:

1. Sets `listen_status = "to-listen"`
2. Sets `reminder_pending = true`

## Client (App Load)

1. Fetch items where `reminder_pending = true`
2. Dispatch `REMINDERS_READY` XState event to the app machine with the item IDs
3. Call `DELETE /api/music-items/:id/reminder` (or a bulk equivalent) to clear `reminder_pending`

The XState event handler is a no-op for now — the hook is in place for future notification UI.
