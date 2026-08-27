import { lte, eq, and, inArray, sql } from "drizzle-orm";
import { db } from "./db/index";
import { artistReleases, artists, musicItems, musicLinks, releaseAlerts } from "./db/schema";
import { earliestInstant } from "./artist-watch";
import { enrichSecondaryLinkInBackground } from "./secondary-link-enrichment";
import {
  checkReleaseLink,
  persistReleaseLink,
  type ReleaseLinkOutcome,
  type ReleaseLinkQuery,
} from "./release-link-check";

// ---------------------------------------------------------------------------
// Reminders
//
// The cron that lets a scheduled record into To Listen on its release day.
//
// For a record that came from a release alert this is also where the New
// Releases link gate is actually enforced. Accepting an announced record can't
// demand a link — nobody carries an album that isn't out — so the check is
// deferred to here, where the record IS out and the provider of choice has had
// its chance to list it. An item with nothing to show for itself is held back
// and asked about again a week later, rather than being dropped into To Listen
// with nowhere to play it.
//
// Everything else — a reminder the user set on an item of their own — is
// published exactly as before. The alert link is what tells the two apart.
// ---------------------------------------------------------------------------

/** How long to wait before asking the services again about a held release. */
const HOLD_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** A check that didn't complete is retried tomorrow, not next week. */
const CHECK_FAILED_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * How long past the release date a record can be held for.
 *
 * The hold has to end somewhere: a record held forever is one the user
 * accepted and can then never find under To Listen, and it would be asked
 * about weekly for the rest of the install's life. Two months is long enough
 * for a licensing delay or a slow MusicBrainz edit, and short enough that the
 * item doesn't quietly vanish. Past it the item is published as it stands,
 * with a line in the log saying so.
 */
const MAX_HOLD_MS = 56 * 24 * 60 * 60 * 1000;

interface OverdueItem {
  id: number;
  title: string;
  artistName: string | null;
  /** Set only for items filed from a release alert — the ones the gate covers. */
  fromAlert: boolean;
  mbReleaseGroupId: string | null;
  firstReleaseDate: string | null;
  linkCount: number;
}

async function overdueItems(now: Date): Promise<OverdueItem[]> {
  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artistName: artists.name,
      alertId: releaseAlerts.id,
      mbReleaseGroupId: artistReleases.mbReleaseGroupId,
      firstReleaseDate: artistReleases.firstReleaseDate,
      linkCount: sql<number>`(
        SELECT COUNT(*) FROM ${musicLinks} WHERE ${musicLinks.musicItemId} = ${musicItems.id}
      )`,
    })
    .from(musicItems)
    .leftJoin(artists, eq(artists.id, musicItems.artistId))
    .leftJoin(releaseAlerts, eq(releaseAlerts.musicItemId, musicItems.id))
    .leftJoin(artistReleases, eq(artistReleases.id, releaseAlerts.artistReleaseId))
    .where(and(lte(musicItems.remindAt, now), eq(musicItems.reminderPending, false)));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    artistName: row.artistName ?? null,
    fromAlert: row.alertId !== null,
    mbReleaseGroupId: row.mbReleaseGroupId ?? null,
    firstReleaseDate: row.firstReleaseDate ?? null,
    linkCount: Number(row.linkCount ?? 0),
  }));
}

/** Whether a record is still inside the window in which it can be held back. */
function holdable(firstReleaseDate: string | null, now: Date): boolean {
  const released = earliestInstant(firstReleaseDate);
  // No date to measure from — MusicBrainz dropped it, or never had one. There
  // is no window to be inside, so let the item through.
  if (!released) return false;
  return now.getTime() - released.getTime() < MAX_HOLD_MS;
}

/** Push the reminder out so the record is asked about again, still Scheduled. */
async function holdItem(itemId: number, until: Date, now: Date): Promise<void> {
  await db
    .update(musicItems)
    .set({ remindAt: until, updatedAt: now })
    .where(eq(musicItems.id, itemId));
}

async function publishItems(ids: number[], now: Date): Promise<void> {
  await db
    .update(musicItems)
    .set({
      listenStatus: "to-listen",
      // Clear the reminder now that its date has passed: a release whose
      // scheduled date is in the past is no longer "scheduled", so drop it out
      // of the Scheduled filter and let it surface under "To Listen".
      remindAt: null,
      reminderPending: true,
      updatedAt: now,
      addedToListenAt: now,
    })
    .where(inArray(musicItems.id, ids));
}

/**
 * Release day for everything whose reminder has come round.
 *
 * `checkLink` is injectable for the tests; the app takes the default. Checks
 * run one item at a time on purpose — each is a provider search and possibly a
 * MusicBrainz request, and this is a background cron with nobody waiting.
 */
export async function processReminders(
  now: Date = new Date(),
  checkLink: (query: ReleaseLinkQuery) => Promise<ReleaseLinkOutcome> = checkReleaseLink,
): Promise<void> {
  const overdue = await overdueItems(now);
  if (overdue.length === 0) return;

  const publish: number[] = [];
  const held: number[] = [];
  const enrich: number[] = [];

  for (const item of overdue) {
    // Not from an alert, or it already has somewhere to go: nothing to check.
    if (!item.fromAlert || item.linkCount > 0) {
      publish.push(item.id);
      if (item.fromAlert) enrich.push(item.id);
      continue;
    }

    const outcome = await checkLink({
      title: item.title,
      artistName: item.artistName,
      mbReleaseGroupId: item.mbReleaseGroupId,
    });

    if (outcome.kind === "found") {
      await persistReleaseLink(item.id, outcome.link, { released: true });
      publish.push(item.id);
      enrich.push(item.id);
      continue;
    }

    // `unchecked` means external lookups are switched off, so there is no
    // answer to hold out for — the gate stands aside exactly as it does when
    // an alert is accepted.
    if (outcome.kind === "unchecked" || !holdable(item.firstReleaseDate, now)) {
      if (outcome.kind !== "unchecked") {
        console.log(
          `[reminders] releasing "${item.title}" with no link — held since ${item.firstReleaseDate}`,
        );
      }
      publish.push(item.id);
      enrich.push(item.id);
      continue;
    }

    const wait = outcome.kind === "failed" ? CHECK_FAILED_RETRY_MS : HOLD_RETRY_MS;
    await holdItem(item.id, new Date(now.getTime() + wait), now);
    held.push(item.id);
  }

  if (publish.length > 0) await publishItems(publish, now);

  // Now the record is out, fill in the provider link the accept path couldn't
  // find. No-ops for an item that already has one, and for one whose provider
  // lookup has already been attempted and stamped.
  for (const id of enrich) enrichSecondaryLinkInBackground(id);

  if (publish.length > 0) {
    console.log(
      `[reminders] processed ${publish.length} overdue reminder(s): [${publish.join(", ")}]`,
    );
  }
  if (held.length > 0) {
    console.log(
      `[reminders] held ${held.length} release(s) with no link yet: [${held.join(", ")}]`,
    );
  }
}
