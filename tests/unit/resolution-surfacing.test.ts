import { afterAll, describe, expect, test } from "bun:test";
import { createMusicItemDirect, fetchFullItem } from "../../app/music-item-store";
import { musicItemRoutes } from "../../server/routes/music-items";
import { Hono } from "hono";

// The release resolver stamps work-level ids and a resolution status into
// `music_items`; these tests pin that the pair survives the trip back out —
// through `fetchFullItem` (the release page's load) and the items API —
// because the page's provenance line renders from exactly those fields.

// Same setup as music-item-duplicates.test.ts: the Mistral client reads its
// key when this file's imports evaluate, so the env has to be set at module
// scope, and restored afterwards so it doesn't leak into the next test file.
const ENV_BEFORE = {
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OTB_DISABLE_EXTERNAL_LOOKUPS: process.env.OTB_DISABLE_EXTERNAL_LOOKUPS,
};
process.env.MISTRAL_API_KEY = "test-key";
process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";

afterAll(() => {
  for (const [key, value] of Object.entries(ENV_BEFORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolution surfacing", () => {
  test("fetchFullItem carries the work ids and status the resolver stamped", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Orquesta El Macabeo",
      title: "Salsa Bestial",
      musicbrainzReleaseId: "mb-release-1",
      musicbrainzReleaseGroupId: "mb-group-1",
      discogsReleaseId: 4419535,
      discogsMasterId: 706722,
      resolutionStatus: "matched",
    });

    const fetched = await fetchFullItem(item.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.musicbrainz_release_group_id).toBe("mb-group-1");
    expect(fetched!.discogs_release_id).toBe(4419535);
    expect(fetched!.discogs_master_id).toBe(706722);
    expect(fetched!.resolution_status).toBe("matched");
  });

  test("an item resolution never touched reads null, not a guessed status", async () => {
    const { item } = await createMusicItemDirect({ artistName: "Artist One", title: "Plain Add" });

    const fetched = await fetchFullItem(item.id);
    expect(fetched!.musicbrainz_release_group_id).toBeNull();
    expect(fetched!.discogs_release_id).toBeNull();
    expect(fetched!.discogs_master_id).toBeNull();
    // The release page hides its provenance line on exactly this null — a
    // row that predates the resolver, or never went through it.
    expect(fetched!.resolution_status).toBeNull();
  });

  test("the items API returns the same fields to the client", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Celia Cruz",
      title: "Son con Guaguancó",
      discogsReleaseId: 111111,
      discogsMasterId: 706722,
      resolutionStatus: "partial",
    });

    const app = new Hono();
    app.route("/api/music-items", musicItemRoutes);
    const response = await app.request(`/api/music-items/${item.id}`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.discogs_master_id).toBe(706722);
    expect(body.resolution_status).toBe("partial");
  });
});
