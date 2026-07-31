import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import {
  musicItemStacks,
  musicLinks,
  musicItems,
  artists,
  artistReleases,
  releaseAlerts,
  stacks,
  stackParents,
  musicItemOrder,
  itemSuggestions,
} from "../db/schema";
import { normalize } from "../utils";

export const testRoutes = new Hono();

testRoutes.post("/reset", async (c) => {
  // Truncate in dependency order (respect foreign keys)
  await db.delete(musicItemStacks);
  await db.delete(stackParents);
  await db.delete(musicLinks);
  await db.delete(itemSuggestions);
  await db.delete(releaseAlerts);
  await db.delete(artistReleases);
  await db.delete(musicItems);
  await db.delete(musicItemOrder);
  await db.delete(artists);
  await db.delete(stacks);
  // sources are seeded/static — leave them alone
  return c.json({ success: true });
});

// Seed a pending suggestion directly, standing in for the MusicBrainz
// prefetch (external lookups are disabled under test).
testRoutes.post("/suggestions", async (c) => {
  const body = await c.req.json();
  const [inserted] = await db
    .insert(itemSuggestions)
    .values({
      sourceItemId: body.sourceItemId,
      title: body.title,
      artistName: body.artistName,
      itemType: body.itemType ?? "album",
      year: body.year ?? null,
      musicbrainzReleaseId: body.musicbrainzReleaseId ?? null,
      status: "pending",
    })
    .returning();
  return c.json(inserted, 201);
});

// Seed a pending new-release alert directly, standing in for the artist watch
// sweep (external lookups are disabled under test).
testRoutes.post("/release-alerts", async (c) => {
  const body = await c.req.json();
  const artistName: string = body.artistName;

  const existingArtist = await db
    .select({ id: artists.id })
    .from(artists)
    .where(eq(artists.normalizedName, normalize(artistName)))
    .get();

  const artistId =
    existingArtist?.id ??
    (
      await db
        .insert(artists)
        .values({
          name: artistName,
          normalizedName: normalize(artistName),
          musicbrainzArtistId: body.musicbrainzArtistId ?? `mbid-${normalize(artistName)}`,
          mbidConfidence: "confirmed",
        })
        .returning({ id: artists.id })
    )[0].id;

  const [release] = await db
    .insert(artistReleases)
    .values({
      artistId,
      mbReleaseGroupId: body.mbReleaseGroupId ?? `rg-${Date.now()}-${Math.random()}`,
      title: body.title,
      normalizedTitle: normalize(body.title),
      primaryType: body.primaryType ?? "Album",
      secondaryTypes: "[]",
      firstReleaseDate: body.firstReleaseDate ?? null,
      firstReleaseYear: body.firstReleaseDate
        ? Number.parseInt(String(body.firstReleaseDate).slice(0, 4), 10)
        : null,
    })
    .returning({ id: artistReleases.id });

  const [alert] = await db
    .insert(releaseAlerts)
    .values({
      artistId,
      artistReleaseId: release.id,
      reason: body.reason ?? "new-release",
    })
    .returning();

  return c.json(alert, 201);
});
