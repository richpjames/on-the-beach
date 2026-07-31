# Artist Tracking & New-Release Alerts — Design

**Goal:** Track every artist the user has listened to, watch MusicBrainz for releases by
those artists that we haven't seen before, and surface them as alerts the user can accept
into the library.

**Status:** implemented. Phases 1–5 all landed together; see `server/artist-identity.ts`,
`server/artist-watch.ts`, `server/release-alerts.ts`, the `/api/release-alerts` and
`/api/artists` routes, `/feed/new-releases.rss`, and the `/new-releases` view.

Two details settled during the build, both noted inline below: the excluded secondary types
default to the full six-type list from [Noise filters](#noise-filters-defaults-all-overridable-in-settings)
rather than the four quoted in the settings table, and `release_alerts` carries a `reason`
column so a card can say *why* it fired without re-deriving it from the release date.

---

## Overview

The app already knows the artists: `artists` rows are created for every item, and
`music_items.listened_at` / `listen_status` say which ones have actually been listened to.
What's missing is (a) a stable MusicBrainz identity per *artist* rather than per *item*,
(b) a memory of which releases by that artist we already know about, and (c) a poller that
diffs the two.

The design deliberately mirrors the existing suggestion prefetch (`server/suggestions.ts`):
a throttled background sweep started from `src/hooks.server.ts`, writing pending rows into
a table, surfaced later in the UI with accept/dismiss. Same shape, different lifecycle —
so it should feel like the codebase it lands in.

Three moving parts:

1. **Artist identity** — promote the MusicBrainz artist ID from `music_items` onto
   `artists`, with a confidence marker, so an artist is the unit of tracking.
2. **Release snapshot** — per artist, the set of MusicBrainz *release groups* we've seen.
   The first poll is a silent baseline; every later poll diffs against it.
3. **Alerts** — new release groups become `release_alerts` rows, surfaced in-app and over
   RSS. Accepting one files an item into a New Releases stack; if the record isn't out
   yet, it's scheduled to arrive in To Listen on release day via the existing reminder
   cron.

---

## Why release *groups*, not releases

`server/musicbrainz.ts` currently browses `/artist/{mbid}?inc=releases`, which returns every
release: each pressing, each country, each reissue. For "is this new?" that's the wrong
grain — a 2026 Japanese repress of a 1974 album would fire an alert.

Release **groups** are the album-level entity: one per work, with `first-release-date` and
`primary-type` / `secondary-types`. Poll:

```
GET /ws/2/release-group?artist={mbid}&limit=100&offset=0&fmt=json
```

The existing suggestion code can stay on releases — it needs `media` track counts for its
length preference, which release groups don't carry. The two paths coexist; only the new
poller uses release groups.

---

## What counts as "new"

Two different events, and the user asked about the second:

| Event | Detect how |
|---|---|
| Artist puts out a new record | `first-release-date` is recent |
| A record is newly *added to MusicBrainz* | Release-group MBID we've never stored |

Snapshot-diffing on MBID catches both — a catalogue addition of a 1978 record is a genuine
"new to MusicBrainz" event, and for a user tracking obscure artists it's often the more
interesting one. But firing an alert for every archival edit is noisy, so the age of the
release is a **filter on presentation**, not on detection:

- Always record the new release group in `artist_releases`.
- Raise an alert when `first-release-date` is within the freshness window — the last 18
  months by default, **and any date in the future** (see [Announced
  releases](#announced-releases)) — **or** when the setting
  `alert_on_catalogue_additions` is on.

That way turning the setting on later surfaces history we already captured, rather than
needing a re-scan.

### Baseline

The first successful poll for an artist inserts every release group with
`is_baseline = 1` and raises **no** alerts. Without this, adding a well-documented artist
would immediately dump 40 alerts. Only rows first seen after the baseline can alert.

### Noise filters (defaults, all overridable in settings)

- Skip secondary types `compilation`, `live`, `remix`, `dj-mix`, `interview`, `audiobook`.
- Skip primary type `other`.
- Never track the Various Artists MBID (`89ad4ac3-39f7-470e-963a-56509c546377`).
- Cap alerts at 3 per artist per sweep; the rest stay recorded and surface next sweep.

---

## Announced releases

MusicBrainz routinely carries records with a `first-release-date` in the future —
announced-but-unreleased albums. These are the most valuable alerts in the system, and they
have somewhere obvious to go: the existing remind-to-listen machinery.

Accepting an alert for a future-dated release creates the item with `remind_at` set to the
release date. `processReminders()` (hourly, `server/reminders.ts`) then does the rest — on
release day it flips the item to `to-listen` and stamps `addedToListenAt`. Until then the
item sits in the Scheduled bucket, already excluded from the To Listen feeds by the
`isNull(musicItems.remindAt)` predicate in `server/routes/rss.ts`. No new scheduling code:
the alert just hands off to a cron that already runs.

**Partial dates.** MB dates are frequently incomplete, and the reminder column is a real
timestamp, so map them explicitly:

| `first-release-date` | `remind_at` |
|---|---|
| `2026-09-18` | that date |
| `2026-09` | 1st of that month |
| `2027` (future year) | 1st January of that year |
| `2026` (current year) | none — add as `to-listen` directly |

A year-only date in the current year can't be scheduled meaningfully — it may already have
passed — so the item goes straight into To Listen rather than being scheduled into the past.

**Date drift.** Announced dates slip; delayed albums are the norm, not the exception. On
each poll, compare the stored `first_release_date` against MB's current value, and when it
has moved, update the snapshot row. If that release group has an accepted item still
carrying an unfired reminder (join through `release_alerts.music_item_id`, `remind_at` not
null and `reminder_pending` false), move `remind_at` to match. A delayed record shouldn't
surface as "out now" three months early — and the user never touched that date manually, so
overwriting it is safe. Reminders the user set themselves are never touched; only ones this
system created, which is why the alert → item link matters.

When MusicBrainz drops the date **entirely** — the group still exists, but
`first-release-date` is gone — clear `remind_at` rather than leaving the old reminder
standing. A removed date means the release date is now unknown, and a reminder derived from
a value MusicBrainz has retracted is asserting something nobody stands behind any more.
Clearing it drops the item out of Scheduled and into To Listen, which does mean surfacing a
record that may not be out yet — that's the accepted cost. The alternative is holding the
item in Scheduled forever against a phantom date, which fails silently, and silent is
worse.

## Which artists get tracked

Derived, with an explicit override — no separate "follow" action to remember.

An artist is **tracked** when they have at least one item with `listen_status = 'listened'`.
On top of that, `artists.follow_state`:

| Value | Meaning |
|---|---|
| `auto` (default) | Tracked iff the derived rule says so |
| `always` | Tracked regardless (user asked for it explicitly) |
| `muted` | Never tracked, never alerted |

`muted` is the important one. Compilation credits, "Various Artists"-alikes, and one-off
features generate alerts nobody wants, and the only person who can tell is the user.

`to-listen`-only artists are **not** tracked. Having something queued isn't evidence you
want the artist's whole future output — a record sits in To Listen precisely because you
haven't formed that opinion yet. Listening is the signal. (The predicate lives in one
place, so widening it later is a one-line change.)

---

## Data model

### `artists` — new columns

| Column | Type | Notes |
|---|---|---|
| `musicbrainz_artist_id` | text, nullable | The artist's MBID |
| `mbid_confidence` | text, nullable | `confirmed` \| `probable` \| `unresolved` |
| `mbid_resolved_at` | timestamp, nullable | Last resolution attempt (hit or miss) |
| `follow_state` | text, not null, default `auto` | `auto` \| `always` \| `muted` |
| `last_polled_at` | timestamp, nullable | Last successful release-group poll |
| `next_poll_at` | timestamp, nullable | Due time; the sweep's work queue |
| `poll_failure_count` | integer, not null, default 0 | Drives exponential backoff |

Index on `next_poll_at` — the sweep's only hot query.

### `artist_releases` — the snapshot

```sql
CREATE TABLE artist_releases (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  artist_id integer NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  mb_release_group_id text NOT NULL,
  title text NOT NULL,
  normalized_title text NOT NULL,
  primary_type text,
  secondary_types text,            -- JSON array
  first_release_date text,         -- MB's partial date, verbatim: "1974", "1974-05"
  first_release_year integer,      -- parsed for sorting/filtering
  is_baseline integer NOT NULL DEFAULT 0,
  first_seen_at integer NOT NULL
);
CREATE UNIQUE INDEX artist_releases_artist_group ON artist_releases (artist_id, mb_release_group_id);
CREATE INDEX idx_artist_releases_artist_id ON artist_releases (artist_id);
```

Store MB's date string as given — partial dates (`1974`, `1974-05`) are normal and coercing
them to a full `Date` invents precision. Keep the parsed year alongside for filtering.

### `release_alerts` — the user-facing queue

```sql
CREATE TABLE release_alerts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  artist_id integer NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  artist_release_id integer NOT NULL REFERENCES artist_releases(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',   -- pending | seen | added | dismissed
  music_item_id integer REFERENCES music_items(id) ON DELETE SET NULL,
  created_at integer NOT NULL,
  resolved_at integer
);
CREATE UNIQUE INDEX release_alerts_release ON release_alerts (artist_release_id);
CREATE INDEX idx_release_alerts_status ON release_alerts (status);
```

The unique index on `artist_release_id` is the idempotency guarantee: a release can alert
once, ever, no matter how the sweep is retried or restarted.

**Not reusing `item_suggestions`.** It's keyed to a *source item* and answers "what else by
this artist have you not heard" — an editorial pick of one release, cleared when accepted.
Alerts are keyed to an artist, are an unbounded stream, and must never re-fire. Same
neighbourhood, different lifecycle; sharing the table would mean two meanings of `status`
in one column.

---

## Resolving artist MBIDs

This is the part most likely to produce wrong results, so it gets the most care. A bare
name search for "Nirvana", "Bad Company" or "Sun Ra Arkestra" returns several real artists,
and picking wrong means alerting on a stranger's discography forever.

Resolution ladder, best evidence first:

1. **From existing items.** `music_items.musicbrainz_artist_id` is already populated by the
   scan/manual-add enrichment path. Take the most frequent non-null value across the
   artist's items → `confirmed`. This backfills most of the library for free, no network.
2. **Via a known release.** For artists with no stored MBID, take one of their tracked
   releases and call the existing `lookupRelease(artist, title, year)` — the release search
   pins the artist through a record we know they made. Its `musicbrainzArtistId` →
   `confirmed`. This is far safer than a name search and reuses code that already exists.
3. **Name search fallback.** `/ws/2/artist?query=…`. Accept only when the top hit's score
   is ≥ 95 **and** it beats the second hit by ≥ 20 → `probable`. Otherwise `unresolved`.

Only `confirmed` and `probable` artists are polled. `unresolved` artists are listed in
settings with their candidate matches (name, disambiguation comment, country, life span) so
the user can pick — a small retro list dialog, in keeping with the existing chrome. Until
then they're simply not polled; no alerts is the correct failure mode, wrong alerts is not.

Re-resolution is attempted at most once per 30 days per unresolved artist.

---

## The poller

A new `server/artist-watch.ts`, started from `src/hooks.server.ts` alongside the existing
reminder and suggestion intervals, guarded by the same `globalThis` flag pattern and
no-opping under `OTB_DISABLE_EXTERNAL_LOOKUPS`.

**Cadence.** The sweep runs **daily**; each run drains artists where `next_poll_at <= now`,
oldest first, throttled at the existing 2.5 s (env-overridable, matching
`OTB_SUGGESTION_SWEEP_THROTTLE_MS`). MusicBrainz allows ~1 req/s; at 2.5 s that's ~1,400
artists an hour, so even a large library finishes its due set in minutes.

Daily is the right grain given the per-artist intervals below — an hourly wake would find
nothing to do 23 times out of 24. It also sets the alert latency floor: a record added to
MusicBrainz this morning surfaces within a day of its artist next coming due, which is well
inside the useful window for something that is, at best, news of the week.

Due-ness lives in the database (`next_poll_at`), not in the timer, so a restart never
double-polls and never skips: the sweep runs on startup and then every 24 h, and both paths
ask the same question. That matters for a deployment that restarts more than once a day.

Per artist, one request (100 release groups covers all but the most prolific; paginate only
when the response is full).

**Adaptive intervals** — most artists are dormant and don't deserve weekly polls:

| Artist's most recent release | Next poll in |
|---|---|
| Within 2 years | 7 days |
| 2–10 years ago | 21 days |
| Older than 10 years | 60 days |

Jitter each interval by ±20 % so an import batch doesn't resynchronise into a thundering
herd forever after.

**Failures.** On network error or 5xx: `poll_failure_count++`, `next_poll_at = now +
2^failures hours`, capped at 7 days; `last_polled_at` untouched so the artist keeps its
baseline. On 503 (MB's rate-limit response) additionally pause the whole sweep for the rest
of the run. Reset the counter on success. Errors are logged and never thrown out of the
sweep — one bad artist must not stop the queue.

**Sweep budget.** Stop after 200 artists per run so a cold start with a big library spreads
across several days instead of hammering MB in one sitting. With baselines raising no
alerts, that ramp is invisible to the user.

---

## Surfacing alerts

Three surfaces, in build order.

### 1. In-app: a "New Releases" view

The queue itself is not a `stacks` row — alerts aren't music items until accepted. A
dedicated view reached from the taskbar, showing pending alerts as cards: artwork (Cover Art
Archive by release-group MBID, already wired for suggestions), artist, title, type,
first-release date, and the reason it fired — "announced", "new release", or "added to
MusicBrainz".

Actions per card, matching `SuggestionPickerModal`'s vocabulary:

- **Add** → creates an item via `music-item-creator` with the MB metadata prefilled, files
  it in the **New Releases** stack, and sets `remind_at` when the release is still
  announced-only (see [Announced releases](#announced-releases)); alert → `added`,
  `music_item_id` set.
- **Dismiss** → alert → `dismissed`. Never re-fires (unique index on the release).
- **Mute artist** → `follow_state = 'muted'`, dismisses that artist's pending alerts.

**The New Releases stack** is a real stack, created on first accept. Reference it by id in
`app_settings` (`new_releases_stack_id`) rather than by name — `stacks.name` is unique and
user-editable, so name-matching would silently create a duplicate the moment the user
renames it. Recreate only if the stored id no longer resolves. Items land there *in
addition* to normal status handling, so the stack accumulates as a running record of what
the watcher has fed the library, and it nests like any other stack.

A count badge on the taskbar entry when any alert is `pending`. Marking the view as viewed
flips `pending` → `seen` so the badge clears without forcing a decision on each card.

### 2. RSS: `/feed/new-releases.rss`

Nearly free given `server/routes/rss.ts`, and it's the closest thing to a push notification
this app can offer without notification infrastructure — the user's existing reader does the
alerting. The renderer currently assumes `MusicItemFull`; this feed needs a small generic
item shape, which is a worthwhile tidy-up of that module anyway.

`guid` = `release-alert-{id}`, `pubDate` = alert `created_at` (not the release date — a
1978 record surfacing today should appear at the top of the reader, which is when the news
actually happened).

### 3. Out of scope: the notification UI

A dedicated notification surface — a proper notifications centre, and eventually push —
is wanted, but not in this work. It is deliberately *not* the New Releases view above:
that view is the alert queue, a place to go and triage. Notifications are delivery, they'll
carry more than release alerts (reminders firing, ingest results), and they deserve their
own design.

Two things here are built to receive it. `release_alerts` is already the queue a
notification layer would read — status transitions, timestamps and the artist join are all
there. And `native/` has a share extension and a widget but no push plumbing; a widget
listing pending alerts would be a far smaller job than APNs if an interim step is wanted.

Until that exists, RSS is the delivery mechanism: the user's reader does the alerting, at
zero infrastructure cost.

---

## Settings

New keys in `app_settings` (existing key/value pattern, single-user app):

| Key | Default | Effect |
|---|---|---|
| `artist_watch_enabled` | `true` | Master switch for the sweep |
| `alert_freshness_months` | `18` | Age window for "new release" alerts; future dates always qualify |
| `alert_on_catalogue_additions` | `false` | Also alert on newly-added older records |
| `alert_excluded_secondary_types` | `compilation,live,remix,dj-mix` | Noise filter |
| `new_releases_stack_id` | — | Stack accepted alerts are filed into; set on first accept |
| `schedule_announced_releases` | `true` | Set `remind_at` from a future release date on accept |

Exposed through the existing `GET`/`PUT /api/settings` handlers, plus an artist-management
panel listing tracked artists with their MBID confidence, last poll, and a mute toggle.

---

## API

| Route | Purpose |
|---|---|
| `GET /api/release-alerts?status=pending` | List alerts with artist + release joined |
| `POST /api/release-alerts/:id/add` | Create the item, mark `added`, return the item |
| `POST /api/release-alerts/:id/dismiss` | Mark `dismissed` |
| `POST /api/release-alerts/mark-seen` | Bulk `pending` → `seen`, clears the badge |
| `GET /api/artists/tracked` | Artists with follow state, MBID confidence, last poll |
| `PUT /api/artists/:id/follow` | Set `auto` \| `always` \| `muted` |
| `PUT /api/artists/:id/mbid` | Confirm an MBID from the disambiguation dialog |
| `POST /api/artists/:id/poll` | Force an immediate poll (debug / "check now") |
| `GET /feed/new-releases.rss` | RSS feed of alerts |

All mutating routes go through the existing CSRF handle in `src/hooks.server.ts`; no change
needed there.

---

## Implementation phases

Each phase is independently shippable and leaves the app working.

**Phase 1 — artist identity.** Migration for the new `artists` columns. Backfill MBIDs from
`music_items` (resolution step 1, no network). New `server/artist-identity.ts` with steps 2
and 3. Unit tests for the confidence rules, especially the ambiguous-name rejection.

**Phase 2 — snapshot + poller.** Migrations for `artist_releases` and `release_alerts`.
`server/musicbrainz.ts` grows `fetchArtistReleaseGroups(mbid)`. `server/artist-watch.ts`
holds the queue, the diff, the baseline rule and the filters. Wire the daily interval into
`src/hooks.server.ts`. Tests with a stubbed fetch: baseline silence, new group alerts,
repeat poll doesn't re-alert, secondary-type filtering, future-dated releases alerting
regardless of the freshness window, backoff on failure.

**Phase 3 — API + RSS.** `server/routes/release-alerts.ts`, mounted in `server/app.ts`.
Accept handling — the New Releases stack, and `remind_at` from partial dates — lands here;
the date-mapping table above is pure logic and wants direct unit tests. Generalise the RSS
renderer and add the feed. Route tests in the style of `tests/unit/release-route.test.ts`.

**Phase 4 — UI.** New Releases view, taskbar badge with count, artist-management panel in
settings. Retro chrome throughout (Encarta / Win97), and the alert cards need to hold up at
mobile width — a Playwright spec alongside the existing visual tests, per `AGENTS.md`.

**Phase 5 — polish.** Adaptive intervals and jitter, date-drift reconciliation for
scheduled announced releases, per-artist "check now", cover art on alert cards, and the
settings toggles.

Phases 1–2 alone make the system *correct but invisible* — alerts accumulate in the table.
That's a deliberate ordering: it lets the poller bake against real data for a week before
any UI depends on its output, and the baseline-vs-alert behaviour is exactly the thing you
want to observe before it starts pinging you.

---

## Risks

**Wrong artist match.** The big one. Mitigated by the confidence ladder, by preferring
release-derived MBIDs over name search, and by never polling `unresolved`. Worst realistic
case is a `probable` mismatch producing a stream of alerts for the wrong band — the mute
action and the artist panel make that recoverable in one click, and a mismatch is visible
immediately because the titles will look wrong.

**MusicBrainz rate limiting.** Existing code already got bitten by this (see the User-Agent
comment in `server/musicbrainz.ts`). Mitigated by the shared throttle, per-run budget,
adaptive intervals, and 503 handling. Worth considering a single shared MB request queue
across the suggestion sweep and this one, since they now compete for the same 1 req/s —
otherwise two concurrent sweeps quietly double the rate.

**Alert fatigue.** A 300-artist library with catalogue additions on could produce dozens of
alerts a week. Defaults are conservative (freshness window on, catalogue additions off,
per-artist cap) and the mute path is prominent.

**Baseline correctness.** If a poll partially fails mid-pagination and we still write the
baseline, the missing groups will alert as "new" on the next successful poll. Only mark the
baseline when every page fetched cleanly.

---

## Decisions

Settled during design review:

1. **Listened artists only.** `to-listen` is not evidence of wanting an artist's future
   output.
2. **Accepted alerts go to a New Releases stack**, referenced by id in settings.
3. **Poll daily.** Per-artist intervals stay at 7 / 21 / 60 days; the daily sweep just
   drains whatever is due.
4. **Announced releases are alerted on and scheduled**, handing off to the existing
   remind-to-listen cron via `remind_at`.
5. **A dedicated notification UI is wanted but out of scope.** RSS is the interim delivery
   mechanism; `release_alerts` is the queue that surface will read.
6. **A release whose date is removed from MusicBrainz is un-scheduled** — clear
   `remind_at` and let the item fall into To Listen, rather than holding it against a date
   that no longer exists.

No open questions outstanding.
