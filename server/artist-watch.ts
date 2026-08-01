import { and, asc, eq, inArray, isNull, isNotNull, or, lte, sql } from "drizzle-orm";
import { db } from "./db/index";
import { artistReleases, artists, musicItems, releaseAlerts } from "./db/schema";
import { fetchArtistReleaseGroups, MusicBrainzHttpError, type MbReleaseGroup } from "./musicbrainz";
import {
  artistsDueForResolution,
  backfillArtistMbidsFromItems,
  resolveArtistMbid,
  VARIOUS_ARTISTS_MBID,
} from "./artist-identity";
import { getArtistWatchSettings, type ArtistWatchSettings } from "./settings";
import { normalize } from "./utils";

// ---------------------------------------------------------------------------
// Artist release watch
//
// A daily sweep drains the artists whose `next_poll_at` has come round, asks
// MusicBrainz for their release groups, and diffs that against the snapshot in
// `artist_releases`. Groups we've never seen become `release_alerts` rows.
//
// The shape deliberately mirrors the suggestion prefetch (./suggestions.ts): a
// throttled background sweep started from src/hooks.server.ts, writing pending
// rows surfaced later with accept/dismiss. Different lifecycle, same feel.
//
// Two rules carry most of the weight:
//   * The first successful poll for an artist is a silent **baseline** — every
//     group is recorded, none alerts. Without it, adding a well-documented
//     artist would immediately dump forty alerts.
//   * Due-ness lives in the database, not in the timer, so a restart neither
//     skips nor double-polls.
// ---------------------------------------------------------------------------

/** Cap per artist per sweep; the rest stay recorded and surface next sweep. */
const MAX_ALERTS_PER_ARTIST_PER_SWEEP = 3;
/** Cold start with a big library spreads over days instead of hammering MB. */
const MAX_ARTISTS_PER_SWEEP = 200;
/** Primary types that are never worth an alert. */
const EXCLUDED_PRIMARY_TYPES = new Set(["other"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 7 * DAY_MS;

export const SWEEP_INTERVAL_MS = DAY_MS;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** MusicBrainz allows ~1 request/second; one artist is one request. */
function sweepThrottleMs(): number {
  for (const key of ["OTB_ARTIST_WATCH_THROTTLE_MS", "OTB_SUGGESTION_SWEEP_THROTTLE_MS"]) {
    const fromEnv = Number(process.env[key]);
    if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  }
  return 2_500;
}

// ---------------------------------------------------------------------------
// Dates
//
// MusicBrainz dates are frequently incomplete — "1974" and "1974-05" are as
// normal as "1974-05-01" — so partial dates are first-class here rather than
// being coerced into a full timestamp that invents precision.
// ---------------------------------------------------------------------------

/** The year of an MB partial date, or null when there isn't one. */
export function parseReleaseYear(date: string | null): number | null {
  if (!date || date.length < 4) return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/** The earliest instant an MB partial date could refer to. */
export function earliestInstant(date: string | null): Date | null {
  const year = parseReleaseYear(date);
  if (year === null || !date) return null;

  const month = date.length >= 7 ? Number.parseInt(date.slice(5, 7), 10) : 1;
  const day = date.length >= 10 ? Number.parseInt(date.slice(8, 10), 10) : 1;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;

  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The reminder date for an announced release, per the design's mapping:
 *
 * | `first-release-date` | `remind_at`             |
 * |----------------------|-------------------------|
 * | `2026-09-18`         | that date               |
 * | `2026-09`            | 1st of that month       |
 * | `2027` (future year) | 1st January of that year|
 * | `2026` (current year)| none                    |
 *
 * A year-only date in the current year can't be scheduled meaningfully — it
 * may already have passed — so the item goes straight into To Listen rather
 * than being scheduled into the past. Anything already elapsed maps to null
 * for the same reason.
 */
export function remindAtForReleaseDate(date: string | null, now: Date = new Date()): Date | null {
  const instant = earliestInstant(date);
  if (!instant) return null;

  // Year-only: only meaningful when the whole year is still ahead.
  if (date && date.length === 4 && instant.getUTCFullYear() <= now.getUTCFullYear()) {
    return null;
  }

  return instant.getTime() > now.getTime() ? instant : null;
}

/** A release MusicBrainz says hasn't happened yet. */
export function isAnnouncedRelease(date: string | null, now: Date = new Date()): boolean {
  return remindAtForReleaseDate(date, now) !== null;
}

// ---------------------------------------------------------------------------
// Alert eligibility
// ---------------------------------------------------------------------------

export type AlertReason = "announced" | "new-release" | "catalogue-addition";

export interface ReleaseGroupFacts {
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
}

/** Archival editing churn nobody asked about. */
export function passesNoiseFilters(
  group: ReleaseGroupFacts,
  excludedSecondaryTypes: string[],
): boolean {
  const primary = group.primaryType?.toLowerCase() ?? null;
  if (primary && EXCLUDED_PRIMARY_TYPES.has(primary)) return false;

  const excluded = new Set(excludedSecondaryTypes.map((type) => type.toLowerCase()));
  return !group.secondaryTypes.some((type) => excluded.has(type.toLowerCase()));
}

/**
 * Why a newly-seen release group should alert, or null for "record it but stay
 * quiet". Age is a filter on *presentation*, not on detection: the group is
 * always stored, so turning `alert_on_catalogue_additions` on later surfaces
 * history we already captured rather than needing a re-scan.
 */
export function alertReasonFor(
  group: ReleaseGroupFacts,
  settings: ArtistWatchSettings,
  now: Date = new Date(),
): AlertReason | null {
  if (!passesNoiseFilters(group, settings.excludedSecondaryTypes)) return null;

  if (isAnnouncedRelease(group.firstReleaseDate, now)) return "announced";

  const instant = earliestInstant(group.firstReleaseDate);
  if (instant) {
    const cutoff = new Date(now.getTime());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - settings.freshnessMonths);
    if (instant.getTime() >= cutoff.getTime()) return "new-release";
  }

  return settings.alertOnCatalogueAdditions ? "catalogue-addition" : null;
}

// ---------------------------------------------------------------------------
// Polling cadence
// ---------------------------------------------------------------------------

/**
 * Most artists are dormant and don't deserve weekly polls. Jitter keeps an
 * import batch from resynchronising into a thundering herd forever after.
 */
export function nextPollInterval(
  mostRecentReleaseYear: number | null,
  now: Date = new Date(),
  jitter: number = Math.random(),
): number {
  const currentYear = now.getUTCFullYear();
  const age = mostRecentReleaseYear === null ? Infinity : currentYear - mostRecentReleaseYear;

  const baseDays = age <= 2 ? 7 : age <= 10 ? 21 : 60;
  // ±20%
  const factor = 0.8 + jitter * 0.4;
  return Math.round(baseDays * DAY_MS * factor);
}

function backoffMs(failureCount: number): number {
  return Math.min(2 ** failureCount * HOUR_MS, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Which artists get tracked
// ---------------------------------------------------------------------------

export interface TrackedArtistRow {
  id: number;
  name: string;
  musicbrainzArtistId: string | null;
  mbidConfidence: string | null;
  followState: string;
  lastPolledAt: Date | null;
  nextPollAt: Date | null;
  pollFailureCount: number;
}

/**
 * An artist is tracked when `follow_state` is `always`, or when it is `auto`
 * and they have at least one listened item. `to-listen` is not evidence of
 * wanting an artist's whole future output — a record sits in To Listen
 * precisely because you haven't formed that opinion yet. Listening is the
 * signal, and this predicate is the one place to widen it.
 *
 * With `min_artist_rating` set, the auto rule also demands a release rated at
 * or above the bar — having merely listened stops being enough. The rated item
 * needn't be the listened one; any release good enough to earn the rating
 * vouches for the artist. `always` is an explicit user choice and bypasses the
 * bar, exactly as it bypasses the listened-item rule.
 */
function trackedArtistPredicate(minArtistRating: number) {
  const hasListenedItem = sql`EXISTS (
    SELECT 1 FROM ${musicItems}
    WHERE ${musicItems.artistId} = ${artists.id}
      AND ${musicItems.listenStatus} = 'listened'
  )`;

  const hasQualifyingRating = sql`EXISTS (
    SELECT 1 FROM ${musicItems}
    WHERE ${musicItems.artistId} = ${artists.id}
      AND ${musicItems.rating} >= ${minArtistRating}
  )`;

  const autoTracked =
    minArtistRating > 0 ? and(hasListenedItem, hasQualifyingRating) : hasListenedItem;

  return and(
    sql`${artists.followState} != 'muted'`,
    or(eq(artists.followState, "always"), autoTracked),
  );
}

export async function listTrackedArtists(
  settings?: ArtistWatchSettings,
): Promise<TrackedArtistRow[]> {
  const { minArtistRating } = settings ?? (await getArtistWatchSettings());
  return db
    .select({
      id: artists.id,
      name: artists.name,
      musicbrainzArtistId: artists.musicbrainzArtistId,
      mbidConfidence: artists.mbidConfidence,
      followState: artists.followState,
      lastPolledAt: artists.lastPolledAt,
      nextPollAt: artists.nextPollAt,
      pollFailureCount: artists.pollFailureCount,
    })
    .from(artists)
    .where(trackedArtistPredicate(minArtistRating))
    .orderBy(asc(artists.name));
}

/** Tracked, identified artists whose `next_poll_at` has come round. */
async function artistsDueForPoll(
  now: Date,
  limit: number,
  minArtistRating: number,
): Promise<TrackedArtistRow[]> {
  return (
    db
      .select({
        id: artists.id,
        name: artists.name,
        musicbrainzArtistId: artists.musicbrainzArtistId,
        mbidConfidence: artists.mbidConfidence,
        followState: artists.followState,
        lastPolledAt: artists.lastPolledAt,
        nextPollAt: artists.nextPollAt,
        pollFailureCount: artists.pollFailureCount,
      })
      .from(artists)
      .where(
        and(
          trackedArtistPredicate(minArtistRating),
          isNotNull(artists.musicbrainzArtistId),
          sql`${artists.musicbrainzArtistId} != ${VARIOUS_ARTISTS_MBID}`,
          inArray(artists.mbidConfidence, ["confirmed", "probable"]),
          or(isNull(artists.nextPollAt), lte(artists.nextPollAt, now)),
        ),
      )
      // Oldest first — never-polled artists (NULL) sort ahead of scheduled ones.
      .orderBy(asc(artists.nextPollAt))
      .limit(limit)
  );
}

// ---------------------------------------------------------------------------
// Polling one artist
// ---------------------------------------------------------------------------

export interface PollOutcome {
  status: "polled" | "skipped" | "failed";
  baseline: boolean;
  newReleases: number;
  alertsRaised: number;
  rescheduled: number;
  /** Set when the failure was MusicBrainz asking us to back off. */
  rateLimited?: boolean;
}

/**
 * Fetch, diff and record one artist's release groups. Never throws: a failure
 * backs the artist off and is reported, because one bad artist must not stop
 * the queue.
 */
export async function pollArtist(
  artist: TrackedArtistRow,
  settings: ArtistWatchSettings,
  now: Date = new Date(),
): Promise<PollOutcome> {
  const mbid = artist.musicbrainzArtistId;
  if (!mbid || mbid === VARIOUS_ARTISTS_MBID) {
    return { status: "skipped", baseline: false, newReleases: 0, alertsRaised: 0, rescheduled: 0 };
  }

  let groups: MbReleaseGroup[];
  try {
    groups = await fetchArtistReleaseGroups(mbid);
  } catch (err) {
    const failureCount = artist.pollFailureCount + 1;
    await db
      .update(artists)
      .set({
        pollFailureCount: failureCount,
        // `last_polled_at` is deliberately untouched so the artist keeps its
        // baseline: a failed poll must not look like a successful empty one.
        nextPollAt: new Date(now.getTime() + backoffMs(failureCount)),
        updatedAt: now,
      })
      .where(eq(artists.id, artist.id));

    const rateLimited = err instanceof MusicBrainzHttpError && err.status === 503;
    console.error(
      `[artist-watch] poll failed for "${artist.name}" (attempt ${failureCount}):`,
      err,
    );
    return {
      status: "failed",
      baseline: false,
      newReleases: 0,
      alertsRaised: 0,
      rescheduled: 0,
      rateLimited,
    };
  }

  const existing = await db
    .select()
    .from(artistReleases)
    .where(eq(artistReleases.artistId, artist.id));
  const existingByGroup = new Map(existing.map((row) => [row.mbReleaseGroupId, row]));

  // The first successful poll records the whole discography silently. Only
  // rows first seen after the baseline can ever alert.
  //
  // Keyed on `last_polled_at` alone, deliberately: it is stamped only after
  // every insert below has landed, so a process that dies mid-baseline leaves
  // it null and the next poll resumes as a baseline. Also requiring
  // `existing.length === 0` would make that interrupted run look like an
  // established artist, and the rest of the discography would drip out as
  // alerts three per sweep.
  const isBaselinePoll = artist.lastPolledAt === null;

  let newReleases = 0;
  let rescheduled = 0;

  for (const group of groups) {
    const stored = existingByGroup.get(group.id);

    if (!stored) {
      await db.insert(artistReleases).values({
        artistId: artist.id,
        mbReleaseGroupId: group.id,
        title: group.title,
        normalizedTitle: normalize(group.title),
        primaryType: group.primaryType,
        secondaryTypes: JSON.stringify(group.secondaryTypes),
        firstReleaseDate: group.firstReleaseDate,
        firstReleaseYear: parseReleaseYear(group.firstReleaseDate),
        isBaseline: isBaselinePoll,
        firstSeenAt: now,
      });
      newReleases += 1;
      continue;
    }

    if (stored.firstReleaseDate !== group.firstReleaseDate) {
      await db
        .update(artistReleases)
        .set({
          title: group.title,
          normalizedTitle: normalize(group.title),
          primaryType: group.primaryType,
          secondaryTypes: JSON.stringify(group.secondaryTypes),
          firstReleaseDate: group.firstReleaseDate,
          firstReleaseYear: parseReleaseYear(group.firstReleaseDate),
        })
        .where(eq(artistReleases.id, stored.id));

      if (await reconcileReminderForRelease(stored.id, group.firstReleaseDate, now)) {
        rescheduled += 1;
      }
    }
  }

  const alertsRaised = isBaselinePoll ? 0 : await raiseAlertsForArtist(artist.id, settings, now);

  const mostRecentYear = groups.reduce<number | null>((latest, group) => {
    const year = parseReleaseYear(group.firstReleaseDate);
    if (year === null) return latest;
    return latest === null || year > latest ? year : latest;
  }, null);

  await db
    .update(artists)
    .set({
      lastPolledAt: now,
      pollFailureCount: 0,
      nextPollAt: new Date(now.getTime() + nextPollInterval(mostRecentYear, now)),
      updatedAt: now,
    })
    .where(eq(artists.id, artist.id));

  return {
    status: "polled",
    baseline: isBaselinePoll,
    newReleases,
    alertsRaised,
    rescheduled,
  };
}

/**
 * Raise alerts for this artist's recorded-but-unalerted releases, newest
 * first, up to the per-sweep cap. Working from the table rather than from the
 * diff is what makes the cap a *deferral*: whatever doesn't fit this sweep is
 * still a candidate on the next one, and flipping
 * `alert_on_catalogue_additions` on surfaces history already captured.
 */
async function raiseAlertsForArtist(
  artistId: number,
  settings: ArtistWatchSettings,
  now: Date,
): Promise<number> {
  const candidates = await db
    .select({
      id: artistReleases.id,
      primaryType: artistReleases.primaryType,
      secondaryTypes: artistReleases.secondaryTypes,
      firstReleaseDate: artistReleases.firstReleaseDate,
      firstSeenAt: artistReleases.firstSeenAt,
      alertId: releaseAlerts.id,
    })
    .from(artistReleases)
    .leftJoin(releaseAlerts, eq(releaseAlerts.artistReleaseId, artistReleases.id))
    .where(and(eq(artistReleases.artistId, artistId), eq(artistReleases.isBaseline, false)));

  const eligible = candidates
    .filter((row) => row.alertId === null)
    .map((row) => ({
      row,
      reason: alertReasonFor(
        {
          primaryType: row.primaryType,
          secondaryTypes: parseSecondaryTypes(row.secondaryTypes),
          firstReleaseDate: row.firstReleaseDate,
        },
        settings,
        now,
      ),
    }))
    .filter(
      (entry): entry is { row: (typeof candidates)[number]; reason: AlertReason } =>
        entry.reason !== null,
    )
    // Announced records first, then by release date, newest first.
    .sort((a, b) => {
      const rank = (reason: AlertReason): number => (reason === "announced" ? 0 : 1);
      return (
        rank(a.reason) - rank(b.reason) ||
        (earliestInstant(b.row.firstReleaseDate)?.getTime() ?? 0) -
          (earliestInstant(a.row.firstReleaseDate)?.getTime() ?? 0)
      );
    })
    .slice(0, MAX_ALERTS_PER_ARTIST_PER_SWEEP);

  let raised = 0;
  for (const { row, reason } of eligible) {
    // The unique index on artist_release_id is the real idempotency guarantee:
    // a release alerts once, ever, however the sweep is retried or restarted.
    const inserted = await db
      .insert(releaseAlerts)
      .values({
        artistId,
        artistReleaseId: row.id,
        status: "pending",
        reason,
        createdAt: now,
      })
      .onConflictDoNothing({ target: releaseAlerts.artistReleaseId })
      .returning({ id: releaseAlerts.id });
    if (inserted.length > 0) raised += 1;
  }

  return raised;
}

export function parseSecondaryTypes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Announced dates slip; delayed albums are the norm. When MusicBrainz moves a
 * date, move the reminder we derived from it — but only ours. The alert → item
 * link is what tells the two apart: a reminder on an item that never came from
 * an alert is never touched.
 *
 * The link proves the item's *origin*, not that its date is still untouched —
 * if the user hand-edited `remind_at` on an accepted item, a later MusicBrainz
 * date change will overwrite that edit. Distinguishing the two would mean
 * recording the date we set and comparing, which is more bookkeeping than a
 * rare case is worth: the release date moving is the more likely reason the
 * two disagree.
 *
 * When MusicBrainz drops the date entirely, clear `remind_at` rather than
 * leaving a reminder standing against a value nobody stands behind any more.
 * The item falls out of Scheduled and into To Listen, which does mean
 * surfacing a record that may not be out yet — that's the accepted cost, and
 * it beats holding the item against a phantom date, which fails silently.
 */
async function reconcileReminderForRelease(
  artistReleaseId: number,
  newDate: string | null,
  now: Date,
): Promise<boolean> {
  const alert = await db
    .select({ musicItemId: releaseAlerts.musicItemId })
    .from(releaseAlerts)
    .where(eq(releaseAlerts.artistReleaseId, artistReleaseId))
    .get();
  if (!alert?.musicItemId) return false;

  const item = await db
    .select({
      id: musicItems.id,
      remindAt: musicItems.remindAt,
      reminderPending: musicItems.reminderPending,
    })
    .from(musicItems)
    .where(eq(musicItems.id, alert.musicItemId))
    .get();

  // Only an unfired reminder this system created is ours to move.
  if (!item || item.remindAt === null || item.reminderPending) return false;

  const remindAt = remindAtForReleaseDate(newDate, now);
  if (remindAt !== null && item.remindAt.getTime() === remindAt.getTime()) return false;

  await db.update(musicItems).set({ remindAt, updatedAt: now }).where(eq(musicItems.id, item.id));

  console.info("[artist-watch] reconciled reminder after a MusicBrainz date change", {
    itemId: item.id,
    from: item.remindAt.toISOString(),
    to: remindAt?.toISOString() ?? null,
    newDate,
  });
  return true;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface SweepSummary {
  artistsPolled: number;
  artistsResolved: number;
  alertsRaised: number;
  failures: number;
  stoppedEarly: boolean;
}

/**
 * Drain the due queue. Runs on startup and then daily (see hooks.server.ts) —
 * both paths ask the database the same question, so a deployment that restarts
 * more than once a day neither skips artists nor polls them twice.
 */
export async function sweepArtistReleases(now: Date = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = {
    artistsPolled: 0,
    artistsResolved: 0,
    alertsRaised: 0,
    failures: 0,
    stoppedEarly: false,
  };

  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return summary;

  const settings = await getArtistWatchSettings();
  if (!settings.enabled) return summary;

  // Rung 1 of the identity ladder is free — no network — so it runs every
  // sweep and picks up artists whose items gained an MBID since last time.
  await backfillArtistMbidsFromItems();

  const throttle = sweepThrottleMs();
  let requests = 0;

  // Tracked artists we still can't identify get a network resolution attempt,
  // at most once every 30 days each, sharing the sweep's request budget.
  const trackedIds = new Set((await listTrackedArtists(settings)).map((artist) => artist.id));
  const resolutionQueue = (await artistsDueForResolution(now)).filter((id) => trackedIds.has(id));

  for (const artistId of resolutionQueue) {
    if (requests >= MAX_ARTISTS_PER_SWEEP) break;
    if (requests > 0) await sleep(throttle);
    requests += 1;

    try {
      const resolution = await resolveArtistMbid(artistId);
      if (resolution.mbid) summary.artistsResolved += 1;
    } catch (err) {
      console.error("[artist-watch] MBID resolution failed for artist", artistId, err);
    }
  }

  const due = await artistsDueForPoll(
    now,
    MAX_ARTISTS_PER_SWEEP - requests,
    settings.minArtistRating,
  );

  for (const artist of due) {
    if (requests >= MAX_ARTISTS_PER_SWEEP) break;
    if (requests > 0) await sleep(throttle);
    requests += 1;

    const outcome = await pollArtist(artist, settings, now);
    if (outcome.status === "polled") summary.artistsPolled += 1;
    if (outcome.status === "failed") summary.failures += 1;
    summary.alertsRaised += outcome.alertsRaised;

    if (outcome.rateLimited) {
      // MusicBrainz is asking us to stop. The remaining artists keep their due
      // times and are picked up by the next run.
      console.warn("[artist-watch] rate limited by MusicBrainz — pausing the rest of this sweep");
      summary.stoppedEarly = true;
      break;
    }
  }

  if (requests > 0) {
    console.log(`[artist-watch] sweep visited ${requests} artist(s):`, summary);
  }

  return summary;
}

/** Force one artist to the front of the queue ("check now" / debug). */
export async function pollArtistNow(artistId: number): Promise<PollOutcome | null> {
  const artist = await db
    .select({
      id: artists.id,
      name: artists.name,
      musicbrainzArtistId: artists.musicbrainzArtistId,
      mbidConfidence: artists.mbidConfidence,
      followState: artists.followState,
      lastPolledAt: artists.lastPolledAt,
      nextPollAt: artists.nextPollAt,
      pollFailureCount: artists.pollFailureCount,
    })
    .from(artists)
    .where(eq(artists.id, artistId))
    .get();
  if (!artist) return null;

  // Same guard the sweep and the candidate search carry: "check now" is still
  // an external lookup, and an environment that switched them off means it.
  // Below the existence check, so a bad id still 404s rather than reporting a
  // skipped poll for an artist that doesn't exist.
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) {
    return { status: "skipped", baseline: false, newReleases: 0, alertsRaised: 0, rescheduled: 0 };
  }

  if (!artist.musicbrainzArtistId) {
    const resolution = await resolveArtistMbid(artistId);
    if (!resolution.mbid) {
      return {
        status: "skipped",
        baseline: false,
        newReleases: 0,
        alertsRaised: 0,
        rescheduled: 0,
      };
    }
    artist.musicbrainzArtistId = resolution.mbid;
    artist.mbidConfidence = resolution.confidence;
  }

  return pollArtist(artist, await getArtistWatchSettings());
}
