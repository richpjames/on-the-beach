import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createMusicItemDirect, fetchFullItem } from "../../app/music-item-store";
import { musicItemRoutes } from "../../server/routes/music-items";

// A hand correction is the fix for a resolver false-ID: paste the right
// catalogue reference, or clear the match entirely. These tests pin the PATCH
// route's rules — what a hand-set id means for `resolution_status`, what
// clearing returns the row to, and what is refused.

// Same setup as music-item-duplicates.test.ts: the Mistral client reads its
// key when this file's imports evaluate, so the env has to be set at module
// scope, and restored afterwards so it doesn't leak into the next test file.
// OTB_DISABLE_EXTERNAL_LOOKUPS also keeps the release-group derivation below
// off the network in tests.
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

const app = new Hono();
app.route("/api/music-items", musicItemRoutes);

async function patch(id: number, body: Record<string, unknown>): Promise<Response> {
  return app.request(`/api/music-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("hand-corrected catalogue match", () => {
  test("pasting a Discogs id marks the record matched, stamped as of now", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Grupo Guaco",
      title: "Guaco 76",
      // The wrong match a scan left behind: Guaco 77's ids.
      discogsReleaseId: 999999,
      discogsMasterId: 888888,
      resolutionStatus: "matched",
    });

    const response = await patch(item.id, { discogsReleaseId: 123456 });
    expect(response.status).toBe(200);

    const fetched = await fetchFullItem(item.id);
    expect(fetched!.discogs_release_id).toBe(123456);
    // The un-corrected master stays — a correction sets what it was given.
    expect(fetched!.discogs_master_id).toBe(888888);
    expect(fetched!.resolution_status).toBe("matched");
  });

  test("clearing every id returns the row to never-attempted", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Pacho",
      title: "Vía Libre Llegó",
      musicbrainzReleaseId: "2f59e6b5-6c3f-4a2b-b47f-9b0f1d3e4f5a",
      discogsReleaseId: 111111,
      resolutionStatus: "matched",
    });

    const response = await patch(item.id, {
      musicbrainzReleaseId: null,
      discogsReleaseId: null,
    });
    expect(response.status).toBe(200);

    const fetched = await fetchFullItem(item.id);
    expect(fetched!.musicbrainz_release_id).toBeNull();
    expect(fetched!.discogs_release_id).toBeNull();
    // Null, not "absent": a cleared match is retryable, not a verdict.
    expect(fetched!.resolution_status).toBeNull();
  });

  test("clearing one id while another remains keeps the record matched", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Celia Cruz",
      title: "Son con Guaguancó",
      musicbrainzReleaseId: "2f59e6b5-6c3f-4a2b-b47f-9b0f1d3e4f5a",
      discogsReleaseId: 111111,
      resolutionStatus: "matched",
    });

    const response = await patch(item.id, { discogsReleaseId: null });
    expect(response.status).toBe(200);

    const fetched = await fetchFullItem(item.id);
    expect(fetched!.discogs_release_id).toBeNull();
    expect(fetched!.musicbrainz_release_id).not.toBeNull();
    expect(fetched!.resolution_status).toBe("matched");
  });

  test("an unmatched record corrected by hand moves to matched", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Típico Santa Rosa",
      title: "Típico Santa Rosa",
      resolutionStatus: "absent",
    });

    const response = await patch(item.id, { discogsReleaseId: 333333 });
    expect(response.status).toBe(200);

    const fetched = await fetchFullItem(item.id);
    expect(fetched!.discogs_release_id).toBe(333333);
    expect(fetched!.resolution_status).toBe("matched");
  });

  test("a malformed id is refused with a message, changing nothing", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Artist One",
      title: "Never Touched",
      discogsReleaseId: 111111,
      resolutionStatus: "matched",
    });

    const bad = await patch(item.id, { discogsReleaseId: 0 });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string };
    expect(body.error).toContain("discogsReleaseId");

    const junk = await patch(item.id, { musicbrainzReleaseId: "mb-release-1" });
    expect(junk.status).toBe(200); // a non-empty string is stored as given

    const untouched = await fetchFullItem(item.id);
    expect(untouched!.discogs_release_id).toBe(111111);
    expect(untouched!.musicbrainz_release_id).toBe("mb-release-1");
  });

  test("an update with nothing resolution-shaped leaves status and ids alone", async () => {
    const { item } = await createMusicItemDirect({
      artistName: "Artist Two",
      title: "Untouched Match",
      discogsReleaseId: 111111,
      resolutionStatus: "partial",
    });

    const response = await patch(item.id, { notes: "a present" });
    expect(response.status).toBe(200);

    const fetched = await fetchFullItem(item.id);
    expect(fetched!.discogs_release_id).toBe(111111);
    expect(fetched!.resolution_status).toBe("partial");
  });
});
