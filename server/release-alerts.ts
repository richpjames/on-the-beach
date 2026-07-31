import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index";
import {
  artistReleases,
  artists,
  musicItemStacks,
  musicItems,
  releaseAlerts,
  stacks,
} from "./db/schema";
// Deliberately not via ./music-item-creator: `ingest.test.ts` mocks that
// module process-wide (see ./music-item-store.ts).
import { createMusicItemDirect } from "./music-item-store";
import { remindAtForReleaseDate, parseSecondaryTypes, type AlertReason } from "./artist-watch";
import { getArtistWatchSettings, getNewReleasesStackId, setNewReleasesStackId } from "./settings";
import type { ItemType } from "../src/types";

// ---------------------------------------------------------------------------
// The alert queue: reading it, and the three things you can do with a card.
//
// Alerts aren't music items until accepted, which is why the queue is its own
// table rather than a stack. Accepting one files a real item into the New
// Releases stack; if the record isn't out yet it's scheduled to arrive in To
// Listen on release day, by handing `remind_at` to the reminder cron that
// already runs.
// ---------------------------------------------------------------------------

export const NEW_RELEASES_STACK_NAME = "New Releases";

export type AlertStatus = "pending" | "seen" | "added" | "dismissed";

export interface ReleaseAlertView {
  id: number;
  status: AlertStatus;
  reason: AlertReason;
  created_at: string;
  resolved_at: string | null;
  music_item_id: number | null;
  artist_id: number;
  artist_name: string;
  musicbrainz_artist_id: string | null;
  release_id: number;
  mb_release_group_id: string;
  title: string;
  primary_type: string | null;
  secondary_types: string[];
  first_release_date: string | null;
  first_release_year: number | null;
}

function toIso(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

export async function listReleaseAlerts(
  statuses: AlertStatus[] = ["pending"],
): Promise<ReleaseAlertView[]> {
  const rows = await db
    .select({
      id: releaseAlerts.id,
      status: releaseAlerts.status,
      reason: releaseAlerts.reason,
      createdAt: releaseAlerts.createdAt,
      resolvedAt: releaseAlerts.resolvedAt,
      musicItemId: releaseAlerts.musicItemId,
      artistId: artists.id,
      artistName: artists.name,
      musicbrainzArtistId: artists.musicbrainzArtistId,
      releaseId: artistReleases.id,
      mbReleaseGroupId: artistReleases.mbReleaseGroupId,
      title: artistReleases.title,
      primaryType: artistReleases.primaryType,
      secondaryTypes: artistReleases.secondaryTypes,
      firstReleaseDate: artistReleases.firstReleaseDate,
      firstReleaseYear: artistReleases.firstReleaseYear,
    })
    .from(releaseAlerts)
    .innerJoin(artistReleases, eq(artistReleases.id, releaseAlerts.artistReleaseId))
    .innerJoin(artists, eq(artists.id, releaseAlerts.artistId))
    .where(inArray(releaseAlerts.status, statuses))
    .orderBy(desc(releaseAlerts.createdAt), desc(releaseAlerts.id));

  return rows.map((row) => ({
    id: row.id,
    status: row.status as AlertStatus,
    reason: row.reason as AlertReason,
    created_at: toIso(row.createdAt) ?? new Date(0).toISOString(),
    resolved_at: toIso(row.resolvedAt),
    music_item_id: row.musicItemId,
    artist_id: row.artistId,
    artist_name: row.artistName,
    musicbrainz_artist_id: row.musicbrainzArtistId,
    release_id: row.releaseId,
    mb_release_group_id: row.mbReleaseGroupId,
    title: row.title,
    primary_type: row.primaryType,
    secondary_types: parseSecondaryTypes(row.secondaryTypes),
    first_release_date: row.firstReleaseDate,
    first_release_year: row.firstReleaseYear,
  }));
}

export async function countPendingAlerts(): Promise<number> {
  const rows = await db
    .select({ id: releaseAlerts.id })
    .from(releaseAlerts)
    .where(eq(releaseAlerts.status, "pending"));
  return rows.length;
}

/** Bulk `pending` → `seen`, so the taskbar badge clears without forcing a decision. */
export async function markAlertsSeen(): Promise<number> {
  const updated = await db
    .update(releaseAlerts)
    .set({ status: "seen" })
    .where(eq(releaseAlerts.status, "pending"))
    .returning({ id: releaseAlerts.id });
  return updated.length;
}

export async function dismissAlert(alertId: number): Promise<boolean> {
  const updated = await db
    .update(releaseAlerts)
    .set({ status: "dismissed", resolvedAt: new Date() })
    .where(eq(releaseAlerts.id, alertId))
    .returning({ id: releaseAlerts.id });
  return updated.length > 0;
}

/**
 * Mute an artist and clear the alerts already queued for them. Compilation
 * credits and one-off features generate alerts nobody wants, and the only
 * person who can tell is the user.
 */
export async function muteArtist(artistId: number): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(artists)
    .set({ followState: "muted", nextPollAt: null, updatedAt: now })
    .where(eq(artists.id, artistId))
    .returning({ id: artists.id });
  if (updated.length === 0) return false;

  await db
    .update(releaseAlerts)
    .set({ status: "dismissed", resolvedAt: now })
    .where(
      and(eq(releaseAlerts.artistId, artistId), inArray(releaseAlerts.status, ["pending", "seen"])),
    );

  return true;
}

/**
 * The stack accepted alerts are filed into, created on first accept and
 * referenced by id in settings. `stacks.name` is unique and user-editable, so
 * name-matching would silently create a duplicate the moment the user renames
 * it — the id is recreated only when it no longer resolves.
 */
export async function ensureNewReleasesStack(): Promise<number> {
  const storedId = await getNewReleasesStackId();
  if (storedId !== null) {
    const existing = await db
      .select({ id: stacks.id })
      .from(stacks)
      .where(eq(stacks.id, storedId))
      .get();
    if (existing) return existing.id;
  }

  // A stack of that name may already exist from a previous install whose
  // setting was lost — adopt it rather than colliding with the unique index.
  const byName = await db
    .select({ id: stacks.id })
    .from(stacks)
    .where(eq(stacks.name, NEW_RELEASES_STACK_NAME))
    .get();
  if (byName) {
    await setNewReleasesStackId(byName.id);
    return byName.id;
  }

  const [created] = await db
    .insert(stacks)
    .values({ name: NEW_RELEASES_STACK_NAME })
    .returning({ id: stacks.id });
  await setNewReleasesStackId(created.id);
  return created.id;
}

const ITEM_TYPES = new Set<ItemType>(["album", "ep", "single", "track", "mix", "compilation"]);

/** MusicBrainz primary types map onto our item types where they overlap. */
export function itemTypeForReleaseGroup(primaryType: string | null): ItemType {
  const candidate = primaryType?.toLowerCase();
  return candidate && ITEM_TYPES.has(candidate as ItemType) ? (candidate as ItemType) : "album";
}

export interface AcceptResult {
  itemId: number;
  remindAt: Date | null;
}

/**
 * Accept an alert: create the item with the MusicBrainz metadata prefilled,
 * file it in the New Releases stack, and — when the record is still
 * announced-only — hand its release date to the reminder cron via `remind_at`.
 * `processReminders()` flips the item to To Listen on release day; until then
 * it sits in Scheduled, already excluded from the To Listen feeds. No new
 * scheduling code.
 */
export async function acceptAlert(
  alertId: number,
  now: Date = new Date(),
): Promise<AcceptResult | null> {
  const alert = await db
    .select({
      id: releaseAlerts.id,
      status: releaseAlerts.status,
      artistName: artists.name,
      title: artistReleases.title,
      primaryType: artistReleases.primaryType,
      firstReleaseDate: artistReleases.firstReleaseDate,
      firstReleaseYear: artistReleases.firstReleaseYear,
    })
    .from(releaseAlerts)
    .innerJoin(artistReleases, eq(artistReleases.id, releaseAlerts.artistReleaseId))
    .innerJoin(artists, eq(artists.id, releaseAlerts.artistId))
    .where(eq(releaseAlerts.id, alertId))
    .get();

  if (!alert || alert.status === "added") return null;

  const settings = await getArtistWatchSettings();
  const remindAt = settings.scheduleAnnouncedReleases
    ? remindAtForReleaseDate(alert.firstReleaseDate, now)
    : null;

  const { item } = await createMusicItemDirect({
    title: alert.title,
    artistName: alert.artistName,
    itemType: itemTypeForReleaseGroup(alert.primaryType),
    listenStatus: "to-listen",
    year: alert.firstReleaseYear ?? undefined,
  });

  if (remindAt) {
    await db
      .update(musicItems)
      .set({ remindAt, reminderPending: false, updatedAt: now })
      .where(eq(musicItems.id, item.id));
  }

  // Items land in the stack *in addition* to normal status handling, so it
  // accumulates as a running record of what the watcher has fed the library.
  const stackId = await ensureNewReleasesStack();
  await db.insert(musicItemStacks).values({ musicItemId: item.id, stackId }).onConflictDoNothing();

  await db
    .update(releaseAlerts)
    .set({ status: "added", musicItemId: item.id, resolvedAt: now })
    .where(eq(releaseAlerts.id, alertId));

  return { itemId: item.id, remindAt };
}
