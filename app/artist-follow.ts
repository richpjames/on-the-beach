import { and, eq, inArray } from "drizzle-orm";
import type { ArtistFollowState } from "../domain/types";
import { db } from "../adapters/db/index";
import { artists, releaseAlerts } from "../adapters/db/schema";

// ---------------------------------------------------------------------------
// Following an artist
//
// Following is the only way an artist enters the release watch (see
// ./artist-watch.ts). `follow_state` has three values:
//
//   always — followed; polled for new releases
//   auto   — the default: never followed, or followed once and then unfollowed
//   muted  — a deliberate "no": never followed, and any alerts already queued
//            were thrown out when the user said so
//
// `auto` and `muted` both mean "not watched". The name `auto` is a leftover
// from when tracking was inferred from listening; it's kept rather than
// renamed because it is the column default and changing a default is a
// migration for the sake of a word.
// ---------------------------------------------------------------------------

export async function getArtistFollowState(artistId: number): Promise<ArtistFollowState | null> {
  const row = await db
    .select({ followState: artists.followState })
    .from(artists)
    .where(eq(artists.id, artistId))
    .get();
  return (row?.followState as ArtistFollowState | undefined) ?? null;
}

/**
 * Follow an artist. Clearing `next_poll_at` puts them at the front of the
 * sweep's queue, so the watch starts on the next run rather than whenever a
 * due time left over from an earlier spell of following happens to come
 * round. An artist never polled before gets a silent baseline; one polled
 * before is diffed against that baseline, so records that came out while they
 * weren't followed surface as alerts.
 */
export async function followArtist(artistId: number): Promise<boolean> {
  const updated = await db
    .update(artists)
    .set({ followState: "always", nextPollAt: null, updatedAt: new Date() })
    .where(eq(artists.id, artistId))
    .returning({ id: artists.id });
  return updated.length > 0;
}

/**
 * Stop following an artist. The alerts already queued for them go too: an
 * unfollowed artist's cards lingering in New Releases would be the watch
 * carrying on by other means. The release snapshot stays, so following again
 * later picks up where it left off.
 */
export async function unfollowArtist(artistId: number): Promise<boolean> {
  return setNotFollowed(artistId, "auto");
}

/**
 * Mute an artist: stop following, clear their queue, and remember that the
 * answer was no. Compilation credits and one-off features generate alerts
 * nobody wants, and the only person who can tell is the user.
 */
export async function muteArtist(artistId: number): Promise<boolean> {
  return setNotFollowed(artistId, "muted");
}

async function setNotFollowed(artistId: number, state: "auto" | "muted"): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(artists)
    .set({ followState: state, nextPollAt: null, updatedAt: now })
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
