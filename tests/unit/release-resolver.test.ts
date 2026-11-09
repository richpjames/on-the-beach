import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  artistSimilarity,
  normalizeForMatch,
  pickBest,
  recoverMusicBrainzArtistId,
  resolveDiscogs,
  resolveMusicBrainz,
  resolveRelease,
  scoreCandidate,
  similarity,
  stripCreditClause,
} from "../../app/release-resolver";

describe("normalizeForMatch", () => {
  test("strips diacritics so a sleeve without accents matches a catalogue with them", () => {
    // The common case on this catalogue, not an exotic one: shop-written
    // strings routinely drop accents the databases keep.
    expect(normalizeForMatch("Estados de Ánimo")).toBe(normalizeForMatch("Estados De Animo"));
  });

  test("collapses punctuation and case", () => {
    expect(normalizeForMatch("  Tri-Repetae++ ")).toBe("tri repetae");
  });
});

describe("stripCreditClause", () => {
  test("drops a Spanish backing-band credit", () => {
    expect(stripCreditClause("Celia Cruz y La Sonora Matancera")).toBe("Celia Cruz");
  });

  test("drops an English feature credit", () => {
    expect(stripCreditClause("Yellowman feat. Josey Wales")).toBe("Yellowman");
  });

  test("leaves a name with no credit clause alone", () => {
    expect(stripCreditClause("Dorival Caymmi")).toBe("Dorival Caymmi");
  });

  test("mangles a band name containing a conjunction, which is why it is never used alone", () => {
    // Documented rather than fixed: the full string is always tried too, so
    // this variant only ever adds recall, never decides a match by itself.
    expect(stripCreditClause("Earth, Wind & Fire")).toBe("Earth, Wind");
  });
});

describe("similarity", () => {
  test("scores identical strings 1", () => {
    expect(similarity("Land of Hunger", "Land Of Hunger")).toBe(1);
  });

  test("treats a missing subtitle as near-identity", () => {
    // "Compact Jazz" and "Compact Jazz: Astrud Gilberto" share under half their
    // characters; any edit-distance threshold loose enough to match them would
    // match most of the catalogue to each other.
    expect(similarity("Compact Jazz", "Compact Jazz: Astrud Gilberto")).toBeGreaterThan(0.85);
  });

  test("scores unrelated titles low", () => {
    expect(similarity("Mi Raza", "Mi Gente")).toBeLessThan(0.6);
  });

  test("does not let a very short string match by containment", () => {
    expect(similarity("II", "II Sounds of Brazil")).toBeLessThan(0.5);
  });
});

describe("artistSimilarity", () => {
  test("matches a bare name against a full backing-band credit", () => {
    expect(artistSimilarity("Celia Cruz", "Celia Cruz y La Sonora Matancera")).toBe(1);
  });

  test("stays low for unrelated artists", () => {
    expect(artistSimilarity("Kamac Pacha Inti", "J Balvin")).toBeLessThan(0.4);
  });
});

describe("scoreCandidate", () => {
  test("accepts a diacritic-only difference", () => {
    const score = scoreCandidate(
      { artist: "Hugo Jasa", title: "Estados De Animo" },
      { artist: "Hugo Jasa", title: "Estados de Ánimo" },
    );
    expect(score.accepted).toBe(true);
    expect(score.confidence).toBe(1);
  });

  test("rejects the confident false positive both providers return", () => {
    // MusicBrainz returned J Balvin's "Mi gente" for "Kamac Pacha Inti — Mi
    // Raza" at relevance score 100. Local comparison is the only thing that
    // catches this, which is why the provider's score is not an input here.
    const score = scoreCandidate(
      { artist: "Kamac Pacha Inti", title: "Mi Raza" },
      { artist: "J Balvin", title: "Mi gente" },
    );
    expect(score.accepted).toBe(false);
  });

  test("rejects a right artist with a wrong title", () => {
    const score = scoreCandidate(
      { artist: "Guaco", title: "Guaco 76" },
      { artist: "Guaco", title: "Guaco 77" },
    );
    // A different record by the same act — the exact miss that put three wrong
    // ids into the fixture manifest on an earlier pass.
    expect(score.accepted).toBe(false);
  });

  test("ignores a year difference, because pressings of one work span decades", () => {
    const score = scoreCandidate(
      { artist: "Ernesto Lecuona", title: "Lecuona Plays For Two", year: 1957 },
      { artist: "Ernesto Lecuona", title: "Lecuona Plays For Two" },
    );
    expect(score.accepted).toBe(true);
  });
});

describe("pickBest", () => {
  const query = { artist: "The Earons", title: "Land of Hunger" };

  test("abstains when nothing verifies", () => {
    expect(pickBest(query, [{ artist: "J Balvin", title: "Mi gente", year: 2017 }])).toBeNull();
  });

  test("prefers the most credible candidate over the first", () => {
    const best = pickBest(query, [
      { artist: "The Earons", title: "Land of Hunger (Remix)", year: 1984 },
      { artist: "The Earons", title: "Land of Hunger", year: 1984 },
    ]);
    expect(best?.candidate.title).toBe("Land of Hunger");
  });

  test("breaks a tie towards the year asked for", () => {
    const best = pickBest({ ...query, year: 1984 }, [
      { artist: "The Earons", title: "Land of Hunger", year: 1999 },
      { artist: "The Earons", title: "Land of Hunger", year: 1984 },
    ]);
    expect(best?.candidate.year).toBe(1984);
  });

  // Jayme Marques' "¡Que Cosa Mas Linda!" is both a Venezuelan LP and a Spanish
  // 7" of the same year, and Discogs returns the 7" first.
  test('breaks a dead heat away from the 7"', () => {
    const best = pickBest({ artist: "Jayme Marques", title: "Que Cosa Mas Linda!" }, [
      { artist: "Jayme Marques", title: "¡Que Cosa Mas Linda!", year: 1981, itemType: "single" },
      { artist: "Jayme Marques", title: "¡Que Cosa Mas Linda!", year: 1981, itemType: "album" },
    ] as const);
    expect(best?.candidate.itemType).toBe("album");
  });

  test("format never outranks the year asked for", () => {
    const best = pickBest({ ...query, year: 1984 }, [
      { artist: "The Earons", title: "Land of Hunger", year: 1984, itemType: "single" },
      { artist: "The Earons", title: "Land of Hunger", year: 1999, itemType: "album" },
    ] as const);
    expect(best?.candidate.year).toBe(1984);
  });

  test("format never outranks confidence", () => {
    const best = pickBest(query, [
      { artist: "The Earons", title: "Land of Hunger", year: 1984, itemType: "single" },
      { artist: "The Earons", title: "Land of Hunger (Remix)", year: 1984, itemType: "album" },
    ] as const);
    expect(best?.candidate.title).toBe("Land of Hunger");
  });

  // Patrick Cowley's "Menergy" is a 12" maxi-single — filed as an EP — sharing
  // its name with the LP. Both are 12", so neither is demoted and the
  // provider's own ordering stands.
  test("leaves the provider's order alone between two full-size formats", () => {
    const best = pickBest({ artist: "Patrick Cowley", title: "Menergy" }, [
      { artist: "Patrick Cowley", title: "Menergy", year: 1981, itemType: "ep" },
      { artist: "Patrick Cowley", title: "Menergy", year: 1981, itemType: "album" },
    ] as const);
    expect(best?.candidate.itemType).toBe("ep");
  });

  test("a candidate with no format is not demoted", () => {
    const best = pickBest(query, [
      { artist: "The Earons", title: "Land of Hunger", year: 1984 },
      { artist: "The Earons", title: "Land of Hunger", year: 1984, itemType: "single" },
    ] as const);
    expect(best?.candidate.itemType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Network cascade. The request gates are zeroed for the whole suite in
// tests/unit/preload.ts.
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Queue a response per outbound endpoint, so tests do not depend on call order. */
function routeFetch(queues: {
  discogs?: Response[];
  mbRelease?: Response[];
  mbArtist?: Response[];
}) {
  const calls: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const queue = url.includes("api.discogs.com")
      ? queues.discogs
      : url.includes("/ws/2/artist")
        ? queues.mbArtist
        : queues.mbRelease;
    const next = queue?.shift();
    return Promise.resolve(next ?? json({ results: [], releases: [], artists: [] }));
  });
  return { spy, calls };
}

const DISCOGS_HIT = {
  id: 3846849,
  master_id: 147257,
  title: "The Earons - Land Of Hunger",
  year: 1984,
  country: "US",
  label: ["Island Records"],
  catno: "0-96923",
};

const MB_HIT = {
  id: "c2ae2f7c-0000-0000-0000-000000000000",
  title: "Land of Hunger",
  date: "1984",
  country: "US",
  "artist-credit": [{ name: "The Earons", artist: { id: "732b0804-aaaa-bbbb-cccc-ddddeeeeffff" } }],
  "release-group": { id: "732b0804-1111-2222-3333-444455556666" },
};

const QUERY = { artist: "The Earons", title: "Land of Hunger" };

describe("resolveDiscogs", () => {
  afterEach(() => {
    mock.restore();
  });

  test("falls through to a later query variant when the first returns nothing usable", async () => {
    const { calls } = routeFetch({
      discogs: [json({ results: [] }), json({ results: [DISCOGS_HIT] })],
    });

    const result = await resolveDiscogs(QUERY);

    expect(result.kind).toBe("found");
    expect(calls).toHaveLength(2);
    // The structured artist/title query first, free text only as a fallback.
    expect(calls[0]).toContain("release_title=");
    expect(calls[1]).toContain("q=");
  });

  test("stops the cascade on a transport error rather than reporting absence", async () => {
    // Four deep: the first try plus each rung of the retry ladder. A 429 that
    // never clears is what "failed" means now — a single one is retried.
    const throttled = (): Response => json({ message: "throttled" }, 429);
    const { calls } = routeFetch({ discogs: [throttled(), throttled(), throttled(), throttled()] });

    const result = await resolveDiscogs(QUERY);

    // A 429 says nothing about whether the record exists. Falling through to
    // the next variant would turn one refused request into a false "absent".
    expect(result.kind).toBe("failed");
    expect(calls).toHaveLength(4);
  });
});

describe("resolveRelease", () => {
  afterEach(() => {
    mock.restore();
  });

  test("reports 'matched' and both work-level ids when both databases hold the record", async () => {
    routeFetch({
      discogs: [json({ results: [DISCOGS_HIT] })],
      mbRelease: [json({ releases: [MB_HIT] })],
    });

    const outcome = await resolveRelease(QUERY);

    expect(outcome.status).toBe("matched");
    expect(outcome.ids?.discogsMasterId).toBe(147257);
    expect(outcome.ids?.musicbrainzReleaseGroupId).toBe("732b0804-1111-2222-3333-444455556666");
    expect(outcome.errors).toEqual([]);
  });

  test("reports 'partial' for a Discogs-only record and still recovers an MB artist id", async () => {
    routeFetch({
      discogs: [json({ results: [DISCOGS_HIT] })],
      mbArtist: [json({ artists: [{ id: "artist-mbid", name: "The Earons", score: 100 }] })],
    });

    const outcome = await resolveRelease(QUERY);

    expect(outcome.status).toBe("partial");
    expect(outcome.ids?.musicbrainzReleaseId).toBeNull();
    // Artist-keyed features — watch baselines, release alerts — keep working
    // for a row whose release exists only in Discogs.
    expect(outcome.ids?.musicbrainzArtistId).toBe("artist-mbid");
  });

  test("reports 'absent' when both databases answer and neither holds the record", async () => {
    routeFetch({});

    const outcome = await resolveRelease({
      artist: "Típico Santa Rosa",
      title: "Típico Santa Rosa",
    });

    expect(outcome.status).toBe("absent");
    expect(outcome.ids).toBeNull();
    expect(outcome.errors).toEqual([]);
  });

  test("reports 'failed', not 'partial', when a provider errors after the other succeeded", async () => {
    const throttled = (): Response => json({ error: "unavailable" }, 503);
    routeFetch({
      discogs: [json({ results: [DISCOGS_HIT] })],
      // MusicBrainz stays throttled across the whole ladder.
      mbRelease: [throttled(), throttled(), throttled(), throttled()],
      mbArtist: [json({ artists: [] })],
    });

    const outcome = await resolveRelease(QUERY);

    // MusicBrainz has not said the record is missing, so the row must stay
    // retryable even though Discogs answered.
    expect(outcome.status).toBe("failed");
    expect(outcome.ids?.discogsReleaseId).toBe(3846849);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]?.provider).toBe("musicbrainz");
  });
});

describe("recoverMusicBrainzArtistId", () => {
  afterEach(() => {
    mock.restore();
  });

  test("rejects an unambiguous but wrong name match", async () => {
    routeFetch({
      // MB matched "Pacho" to a German rapper at score 100 with no runner-up.
      // The score-and-margin rule alone accepts this; the name comparison is
      // what refuses it.
      mbArtist: [json({ artists: [{ id: "wrong-mbid", name: "Pacho", score: 100 }] })],
    });

    expect(await recoverMusicBrainzArtistId("Pacho Alonso")).toBeNull();
  });

  test("accepts a strong, unambiguous, name-verified match", async () => {
    routeFetch({
      mbArtist: [json({ artists: [{ id: "right-mbid", name: "Pacho Alonso", score: 100 }] })],
    });

    expect(await recoverMusicBrainzArtistId("Pacho Alonso")).toBe("right-mbid");
  });
});

describe("containment is anchored", () => {
  test("refuses a title that merely appears inside a longer one", () => {
    // "Vibes of Barry Brown" sits mid-string inside "More Vibes of Barry Brown
    // Along With Stama Rank", which is a different record. Unanchored
    // containment matched them and cost a false id on the fixture set.
    const score = scoreCandidate(
      { artist: "Barry Brown", title: "Vibes of Barry Brown" },
      { artist: "Barry Brown", title: "More Vibes Of Barry Brown Along With Stama Rank" },
    );
    expect(score.accepted).toBe(false);
  });

  test("accepts a suffix match, which is how the two databases' titles differ", () => {
    // Discogs files "Compact Jazz: Astrud Gilberto" as the self-titled
    // "Astrud Gilberto". Dropping the suffix rule cost this fixture its hit.
    const score = scoreCandidate(
      { artist: "Astrud Gilberto", title: "Compact Jazz: Astrud Gilberto" },
      { artist: "Astrud Gilberto", title: "Astrud Gilberto" },
    );
    expect(score.accepted).toBe(true);
  });

  test("still accepts a missing subtitle, which is a prefix", () => {
    const score = scoreCandidate(
      { artist: "Astrud Gilberto", title: "Compact Jazz" },
      { artist: "Astrud Gilberto", title: "Compact Jazz: Astrud Gilberto" },
    );
    expect(score.accepted).toBe(true);
  });
});

describe("credits the sleeve abbreviates", () => {
  // The sleeve names the act; the catalogue names the act plus its band, its
  // collaborator, or the composer first. Every one of these cost a fixture
  // its hit before token-subset matching.
  test.each([
    ["Pacho", "Pacho Alonso"],
    ["Bana", "Bana Et Son Orchestre"],
    ["Natural Black", "Natural Black / Sydney Mills All Stars"],
    ["Jean-Philippe Collard & Pascal Rogé", "Satie / Pascal Rogé, Jean-Philippe Collard"],
  ])("matches %s against %s", (asked, candidate) => {
    expect(artistSimilarity(asked, candidate)).toBeGreaterThanOrEqual(0.85);
  });

  test("refuses a credit shorter than the one asked for", () => {
    // The direction is the safeguard: MusicBrainz's "Pacho" is a German rapper,
    // not the Pacho Alonso we asked about.
    expect(artistSimilarity("Pacho Alonso", "Pacho")).toBeLessThan(0.85);
  });
});

describe("compilations credited to Various", () => {
  test("accepts a compilation whose title matches, ignoring the Various credit", () => {
    const score = scoreCandidate(
      { artist: "Antonio Carlos e Jocafi", title: "O Primeiro Amor" },
      { artist: "Various", title: "O Primeiro Amor (Trilha Sonora Original Da Novela)" },
    );
    expect(score.accepted).toBe(true);
  });

  test("accepts when Discogs folds the act into the title", () => {
    const score = scoreCandidate(
      { artist: "Pipo's 4", title: "O Encontro da Massa" },
      { artist: "Various", title: "PIPO'S O Encontro Da Massa Vol. 4" },
    );
    expect(score.accepted).toBe(true);
  });

  test("still refuses a compilation whose title does not match", () => {
    const score = scoreCandidate(
      { artist: "Antonio Carlos e Jocafi", title: "O Primeiro Amor" },
      { artist: "Various", title: "Beat Girls Español!" },
    );
    expect(score.accepted).toBe(false);
  });

  test("does not waive the artist test for a non-compilation", () => {
    // Title-token matching under the waiver must not leak out to ordinary
    // records, or "Vibes of Barry Brown" is readmitted as "More Vibes of...".
    const score = scoreCandidate(
      { artist: "Barry Brown", title: "Vibes of Barry Brown" },
      { artist: "Barry Brown", title: "More Vibes Of Barry Brown Along With Stama Rank" },
    );
    expect(score.accepted).toBe(false);
  });
});

describe("digits in a subtitle", () => {
  test("accepts a subtitle that carries a year the sleeve does not", () => {
    const score = scoreCandidate(
      { artist: "Various", title: "Beat Girls Español!" },
      { artist: "Various", title: "Beat Girls Español! (1960s She-Pop From Spain)" },
    );
    expect(score.accepted).toBe(true);
  });

  test("still refuses two records whose numbers disagree", () => {
    const score = scoreCandidate(
      { artist: "Guaco", title: "Guaco 76" },
      { artist: "Guaco", title: "Guaco 77" },
    );
    expect(score.accepted).toBe(false);
  });
});

describe("compilation volumes", () => {
  const asked = { artist: "Pipo's 4", title: "O Encontro da Massa" };

  test("accepts the volume asked for", () => {
    const score = scoreCandidate(asked, {
      artist: "Various",
      title: "PIPO'S O Encontro Da Massa Vol. 4",
    });
    expect(score.accepted).toBe(true);
  });

  test("refuses a different volume whose title matches just as well", () => {
    // Both are titled "O Encontro Da Massa" and both are credited to Various;
    // the only thing separating them is a number that lives in the artist
    // field. Ranking picked the wrong one until the number had to be matched.
    const score = scoreCandidate(asked, {
      artist: "Various",
      title: "PIPO'S 2 - O Encontro Da Massa",
    });
    expect(score.accepted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Titles that are only a year. An uploader names a self-titled record by its
// year — "Rosinha de Valença - 1973" — but "Prince - 1999" is an album called
// 1999. The literal reading goes first; the self-titled one must match the year.
// ---------------------------------------------------------------------------

const ROSINHA = { artist: "Rosinha de Valença", title: "1973" };
const ROSINHA_GROUP = "7ce556cd-3316-4e1f-9255-876a08754e06";

/** Her self-titled album as MusicBrainz files it. */
function rosinhaRelease(id: string, date: string) {
  return {
    id,
    title: "Rosinha De Valença",
    date,
    country: "BR",
    "artist-credit": [
      { name: "Rosinha de Valença", artist: { id: "ed6192aa-3abb-4c0b-849e-24eae2ec60ea" } },
    ],
    "release-group": { id: ROSINHA_GROUP, "primary-type": "Album" },
  };
}

const ROSINHA_1973 = rosinhaRelease("e55a94da-3be1-4040-bca3-bd9166a655ed", "1973");
const ROSINHA_2005 = rosinhaRelease("66ec5be2-ad91-45ac-9394-2d030f7083da", "2005");

/** What a search request asked, with its query string decoded. */
function asked(url: string): string {
  return decodeURIComponent(url.replace(/\+/g, " "));
}

describe("titles that are only a year", () => {
  afterEach(() => {
    mock.restore();
  });

  test("resolve to the artist's self-titled record dated that year", async () => {
    routeFetch({
      mbRelease: [
        // The literal reading — quoted, then unquoted — finds nothing called "1973".
        json({ releases: [] }),
        json({ releases: [] }),
        // The reissue comes back first, but only the original is dated 1973.
        json({ releases: [ROSINHA_2005, ROSINHA_1973] }),
      ],
    });

    const outcome = await resolveRelease(ROSINHA);

    expect(outcome.ids?.musicbrainzReleaseId).toBe(ROSINHA_1973.id);
    expect(outcome.ids?.musicbrainzReleaseGroupId).toBe(ROSINHA_GROUP);
  });

  test("search for the self-titled record only once the literal reading has failed", async () => {
    const { calls } = routeFetch({
      mbRelease: [
        json({ releases: [] }),
        json({ releases: [] }),
        json({ releases: [ROSINHA_1973] }),
      ],
    });

    const result = await resolveMusicBrainz(ROSINHA);

    expect(result.kind).toBe("found");
    expect(asked(calls[0]!)).toContain('release:"1973"');
    expect(asked(calls[2]!)).toContain('release:"Rosinha de Valença"');
  });

  test("refuse a self-titled record from another year", async () => {
    // The same work, but nothing in the title says 2005 — taking it would let
    // any self-titled record answer for a year it wasn't released in.
    routeFetch({
      mbRelease: [
        json({ releases: [] }),
        json({ releases: [] }),
        json({ releases: [ROSINHA_2005] }),
        json({ releases: [ROSINHA_2005] }),
      ],
    });

    const result = await resolveMusicBrainz(ROSINHA);

    expect(result.kind).toBe("absent");
  });

  test("find an album named after a year by its name, without the fallback", async () => {
    const { calls } = routeFetch({
      mbRelease: [
        json({
          releases: [
            {
              id: "prince-1999-release",
              title: "1999",
              date: "1982-10-27",
              "artist-credit": [{ name: "Prince", artist: { id: "prince-artist-id" } }],
              "release-group": { id: "prince-1999-group", "primary-type": "Album" },
            },
          ],
        }),
      ],
    });

    const result = await resolveMusicBrainz({ artist: "Prince", title: "1999" });

    expect(result.kind).toBe("found");
    expect(calls).toHaveLength(1);
  });

  test("never put an ordinary title through the self-titled reading", async () => {
    const { calls } = routeFetch({});

    await resolveMusicBrainz(QUERY);

    expect(calls.some((url) => asked(url).includes('release:"The Earons"'))).toBe(false);
  });

  test("hold Discogs to the same year", async () => {
    const discogsHit = (id: number, year: string) => ({
      id,
      master_id: 2_101_973,
      title: "Rosinha De Valença - Rosinha De Valença",
      year,
      country: "Brazil",
    });
    routeFetch({
      discogs: [
        json({ results: [] }),
        json({ results: [] }),
        json({ results: [discogsHit(9_000_005, "2005"), discogsHit(9_001_973, "1973")] }),
      ],
    });

    const result = await resolveDiscogs(ROSINHA);

    expect(result.kind).toBe("found");
    expect(result.kind === "found" && result.value.releaseId).toBe(9_001_973);
  });
});
