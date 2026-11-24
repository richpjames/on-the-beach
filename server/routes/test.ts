import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../adapters/db/index";
import {
  appSettings,
  externalLinkSources,
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
  sources,
} from "../../adapters/db/schema";
import { recordLinkSource, setLinkSourceRank } from "../../app/notes-enrichment";
import { RATING_KEYS } from "../../app/settings";
import { normalize } from "../../domain/text";

export const testRoutes = new Hono();

testRoutes.post("/reset", async (c) => {
  // Truncate in dependency order (respecting foreign keys)
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
  // Encountered link-source hosts are per-spec state (the admin rankings
  // list), not static seed data like the music sources below.
  await db.delete(externalLinkSources);
  // sources are seeded/static — leave them alone. The rating scale is a
  // per-spec setting, so it goes back to the default instead of leaking
  // between specs.
  await db
    .delete(appSettings)
    .where(inArray(appSettings.key, [RATING_KEYS.enabled, RATING_KEYS.starCount]));
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
      musicbrainzReleaseGroupId: body.musicbrainzReleaseGroupId ?? null,
      status: "pending",
    })
    .returning();
  return c.json(inserted, 201);
});

// Seed a release with its links directly, standing in for the creation path
// (which scrapes the pasted page — live-web state a visual baseline can't
// depend on). The first link becomes the primary one, exactly as a release
// whose first link is a playable page plays "here". A link's `metadata` is
// what its scrape would have stored (Bandcamp's album_id, SoundCloud's urn),
// so a playable embed can be seeded without the live web.
testRoutes.post("/music-items", async (c) => {
  const body = await c.req.json();
  const title: string = body.title;
  const artistName: string | undefined = body.artistName;
  const links: Array<{ sourceName: string; url: string; metadata?: Record<string, string> }> =
    body.links ?? [];

  let artistId: number | null = null;
  if (artistName) {
    const existingArtist = await db
      .select({ id: artists.id })
      .from(artists)
      .where(eq(artists.normalizedName, normalize(artistName)))
      .get();
    artistId =
      existingArtist?.id ??
      (
        await db
          .insert(artists)
          .values({ name: artistName, normalizedName: normalize(artistName) })
          .returning({ id: artists.id })
      )[0].id;
  }

  const [item] = await db
    .insert(musicItems)
    .values({ title, normalizedTitle: normalize(title), artistId })
    .returning({ id: musicItems.id });

  for (const [index, link] of links.entries()) {
    const name = link.sourceName.trim().toLowerCase().replace(/\s+/g, "_");
    const displayName = link.sourceName.charAt(0).toUpperCase() + link.sourceName.slice(1);
    await db.insert(sources).values({ name, displayName }).onConflictDoNothing();
    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.name, name))
      .limit(1);

    await db.insert(musicLinks).values({
      musicItemId: item.id,
      sourceId: source.id,
      url: link.url,
      isPrimary: index === 0,
      metadata: link.metadata ? JSON.stringify(link.metadata) : null,
    });
  }

  return c.json({ id: item.id }, 201);
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

// Seed an encountered external-link source directly, standing in for the
// notes enrichment's record-as-met pass (external lookups are disabled under
// test). First sight wins, as in production; an explicit rank re-ranks the
// row so the admin page can be exercised without a live MusicBrainz.
testRoutes.post("/link-sources", async (c) => {
  const body = await c.req.json().catch(() => null);
  const host = typeof body?.host === "string" ? body.host.trim() : "";
  if (!host) {
    return c.json({ error: "host is required" }, 400);
  }
  const rank = body.rank;
  if (rank !== undefined && (typeof rank !== "number" || !Number.isInteger(rank))) {
    return c.json({ error: "rank must be an integer" }, 400);
  }
  await recordLinkSource(host, body.displayName ?? host);
  if (rank !== undefined) await setLinkSourceRank(host, rank);
  const [row] = await db
    .select()
    .from(externalLinkSources)
    .where(eq(externalLinkSources.host, host));
  if (!row) {
    return c.json({ error: "Unknown link source" }, 404);
  }
  return c.json(row, 201);
});
