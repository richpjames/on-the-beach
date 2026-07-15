import { Hono } from "hono";
import { db } from "../db/index";
import {
  musicItemStacks,
  musicLinks,
  musicItems,
  artists,
  stacks,
  stackParents,
  musicItemOrder,
  itemSuggestions,
} from "../db/schema";

export const testRoutes = new Hono();

testRoutes.post("/reset", async (c) => {
  // Truncate in dependency order (respect foreign keys)
  await db.delete(musicItemStacks);
  await db.delete(stackParents);
  await db.delete(musicLinks);
  await db.delete(itemSuggestions);
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
