import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as musicbrainz from "../../server/musicbrainz";
import { db } from "../../server/db/index";
import { artists, musicItems } from "../../server/db/schema";
import { normalize } from "../../server/utils";
import {
  backfillArtistMbidsFromItems,
  isVariousArtists,
  mbidFromItems,
  pickArtistFromSearch,
  resolveArtistMbid,
  setArtistMbid,
  VARIOUS_ARTISTS_MBID,
} from "../../server/artist-identity";

function candidate(
  overrides: Partial<musicbrainz.MbArtistCandidate>,
): musicbrainz.MbArtistCandidate {
  return {
    id: "mbid-1",
    name: "Some Artist",
    score: 100,
    disambiguation: null,
    country: null,
    type: null,
    lifeSpanBegin: null,
    lifeSpanEnd: null,
    ...overrides,
  };
}

async function makeArtist(name: string): Promise<number> {
  const [row] = await db
    .insert(artists)
    .values({ name, normalizedName: normalize(name) })
    .returning({ id: artists.id });
  return row.id;
}

async function addItem(
  artistId: number,
  title: string,
  mbArtistId: string | null = null,
): Promise<number> {
  const [row] = await db
    .insert(musicItems)
    .values({
      title,
      normalizedTitle: normalize(title),
      artistId,
      musicbrainzArtistId: mbArtistId,
    })
    .returning({ id: musicItems.id });
  return row.id;
}

describe("pickArtistFromSearch", () => {
  test("accepts a strong, clearly-ahead hit as probable", () => {
    const result = pickArtistFromSearch([
      candidate({ id: "strong", score: 100 }),
      candidate({ id: "runner-up", score: 70 }),
    ]);

    expect(result.mbid).toBe("strong");
    expect(result.confidence).toBe("probable");
  });

  test("refuses a strong hit shadowed by an almost-as-strong one", () => {
    // The "Nirvana" case: two real artists, both plausible. Wrong alerts are
    // worse than no alerts, so this must resolve to nothing.
    const result = pickArtistFromSearch([
      candidate({ id: "us-band", score: 100 }),
      candidate({ id: "uk-band", score: 90 }),
    ]);

    expect(result.mbid).toBeNull();
    expect(result.confidence).toBe("unresolved");
  });

  test("refuses a top hit below the score floor even when unopposed", () => {
    const result = pickArtistFromSearch([candidate({ id: "weak", score: 80 })]);

    expect(result.mbid).toBeNull();
    expect(result.confidence).toBe("unresolved");
  });

  test("accepts the boundary case: exactly 95, exactly 20 clear", () => {
    const result = pickArtistFromSearch([
      candidate({ id: "boundary", score: 95 }),
      candidate({ id: "second", score: 75 }),
    ]);

    expect(result.mbid).toBe("boundary");
  });

  test("never picks Various Artists", () => {
    const result = pickArtistFromSearch([
      candidate({ id: VARIOUS_ARTISTS_MBID, score: 100 }),
      candidate({ id: "real-artist", score: 40 }),
    ]);

    expect(result.mbid).toBeNull();
  });

  test("returns nothing for an empty search", () => {
    expect(pickArtistFromSearch([]).confidence).toBe("unresolved");
  });

  test("ranks by score rather than trusting the response order", () => {
    const result = pickArtistFromSearch([
      candidate({ id: "second", score: 60 }),
      candidate({ id: "first", score: 100 }),
    ]);

    expect(result.mbid).toBe("first");
  });
});

describe("mbidFromItems", () => {
  test("takes the most frequent non-null MBID across the artist's items", async () => {
    const artistId = await makeArtist(`Frequency Band ${Date.now()}`);
    await addItem(artistId, "One", "mbid-a");
    await addItem(artistId, "Two", "mbid-a");
    await addItem(artistId, "Three", "mbid-b");
    await addItem(artistId, "Four", null);

    expect(await mbidFromItems(artistId)).toBe("mbid-a");
  });

  test("ignores the Various Artists placeholder", async () => {
    const artistId = await makeArtist(`VA Band ${Date.now()}`);
    await addItem(artistId, "Comp One", VARIOUS_ARTISTS_MBID);
    await addItem(artistId, "Comp Two", VARIOUS_ARTISTS_MBID);
    await addItem(artistId, "Real One", "mbid-real");

    expect(await mbidFromItems(artistId)).toBe("mbid-real");
  });

  test("returns null when no item carries an MBID", async () => {
    const artistId = await makeArtist(`Blank Band ${Date.now()}`);
    await addItem(artistId, "Nothing");

    expect(await mbidFromItems(artistId)).toBeNull();
  });
});

describe("backfillArtistMbidsFromItems", () => {
  afterEach(() => {
    mock.restore();
  });

  test("promotes an item MBID onto the artist as confirmed, with no network", async () => {
    const searchSpy = spyOn(musicbrainz, "searchArtistCandidates");
    const artistId = await makeArtist(`Backfill Band ${Date.now()}`);
    await addItem(artistId, "Backfilled", "mbid-backfill");

    await backfillArtistMbidsFromItems();

    const row = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(row?.musicbrainzArtistId).toBe("mbid-backfill");
    expect(row?.mbidConfidence).toBe("confirmed");
    expect(row?.mbidResolvedAt).toBeInstanceOf(Date);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  test("leaves an already-resolved artist alone", async () => {
    const artistId = await makeArtist(`Already Resolved ${Date.now()}`);
    await setArtistMbid(artistId, "user-confirmed");
    await addItem(artistId, "Different", "mbid-from-scan");

    await backfillArtistMbidsFromItems();

    const row = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(row?.musicbrainzArtistId).toBe("user-confirmed");
  });
});

describe("resolveArtistMbid", () => {
  afterEach(() => {
    mock.restore();
  });

  test("prefers an MBID already on the artist's items over any lookup", async () => {
    const releaseSpy = spyOn(musicbrainz, "lookupRelease");
    const searchSpy = spyOn(musicbrainz, "searchArtistCandidates");
    const artistId = await makeArtist(`Ladder One ${Date.now()}`);
    await addItem(artistId, "Known", "mbid-from-item");

    const result = await resolveArtistMbid(artistId);

    expect(result).toEqual({ mbid: "mbid-from-item", confidence: "confirmed" });
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
  });

  test("falls back to a known release, which pins the artist through a record", async () => {
    const releaseSpy = spyOn(musicbrainz, "lookupRelease").mockResolvedValue({
      year: 1974,
      label: null,
      country: null,
      catalogueNumber: null,
      musicbrainzReleaseId: "release-id",
      musicbrainzArtistId: "mbid-from-release",
    });
    const searchSpy = spyOn(musicbrainz, "searchArtistCandidates");
    const artistId = await makeArtist(`Ladder Two ${Date.now()}`);
    await addItem(artistId, "On the Beach");

    const result = await resolveArtistMbid(artistId);

    expect(result.mbid).toBe("mbid-from-release");
    expect(result.confidence).toBe("confirmed");
    expect(releaseSpy).toHaveBeenCalled();
    // The name search is a last resort, not a parallel path.
    expect(searchSpy).not.toHaveBeenCalled();
  });

  test("falls through to the name search when the release lookup yields nothing", async () => {
    spyOn(musicbrainz, "lookupRelease").mockResolvedValue(null);
    spyOn(musicbrainz, "searchArtistCandidates").mockResolvedValue([
      candidate({ id: "mbid-from-search", score: 100 }),
    ]);
    const artistId = await makeArtist(`Ladder Three ${Date.now()}`);
    await addItem(artistId, "Obscure");

    const result = await resolveArtistMbid(artistId);

    expect(result.mbid).toBe("mbid-from-search");
    expect(result.confidence).toBe("probable");
  });

  test("stores unresolved — and the attempt time — when the search is ambiguous", async () => {
    spyOn(musicbrainz, "lookupRelease").mockResolvedValue(null);
    spyOn(musicbrainz, "searchArtistCandidates").mockResolvedValue([
      candidate({ id: "one", score: 100 }),
      candidate({ id: "two", score: 99 }),
    ]);
    const artistId = await makeArtist(`Ambiguous Band ${Date.now()}`);
    await addItem(artistId, "Which One");

    const result = await resolveArtistMbid(artistId);

    expect(result.mbid).toBeNull();
    const row = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(row?.musicbrainzArtistId).toBeNull();
    expect(row?.mbidConfidence).toBe("unresolved");
    // Stamped so the artist isn't re-searched on every sweep.
    expect(row?.mbidResolvedAt).toBeInstanceOf(Date);
  });

  test("a failing search resolves to unresolved rather than throwing", async () => {
    spyOn(musicbrainz, "lookupRelease").mockResolvedValue(null);
    spyOn(musicbrainz, "searchArtistCandidates").mockRejectedValue(
      new musicbrainz.MusicBrainzHttpError(503, "rate limited"),
    );
    const artistId = await makeArtist(`Failing Search ${Date.now()}`);
    await addItem(artistId, "Unreachable");

    const result = await resolveArtistMbid(artistId);

    expect(result.confidence).toBe("unresolved");
  });
});

describe("setArtistMbid", () => {
  test("confirming an MBID queues an immediate poll and clears the failure count", async () => {
    const artistId = await makeArtist(`Confirmed Band ${Date.now()}`);
    await db
      .update(artists)
      .set({ pollFailureCount: 4, nextPollAt: new Date(Date.now() + 7 * 24 * 3600_000) })
      .where(eq(artists.id, artistId));

    expect(await setArtistMbid(artistId, "mbid-picked")).toBe(true);

    const row = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(row?.musicbrainzArtistId).toBe("mbid-picked");
    expect(row?.mbidConfidence).toBe("confirmed");
    expect(row?.pollFailureCount).toBe(0);
    expect(row!.nextPollAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("isVariousArtists", () => {
  test("recognises the names a compilation credit goes by", () => {
    for (const name of [
      "Various Artists",
      "various artists",
      "  Various   Artists  ",
      "Various Artist",
      "Various",
      "VA",
      "V/A",
      "V.A.",
      "Compilation",
    ]) {
      expect(isVariousArtists(name)).toBe(true);
    }
  });

  test("recognises the MusicBrainz placeholder whatever the name says", () => {
    expect(isVariousArtists("Diverse Interpreten", VARIOUS_ARTISTS_MBID)).toBe(true);
  });

  test("leaves real artists alone", () => {
    for (const name of ["Autechre", "Various Production", "Va Va Voom", "The Compilations"]) {
      expect(isVariousArtists(name)).toBe(false);
    }
    expect(isVariousArtists(null)).toBe(false);
    expect(isVariousArtists("Autechre", "some-other-mbid")).toBe(false);
  });
});
