import { describe, expect, test } from "bun:test";
import { scoreCase, summarise, type ReturnedIds } from "../../eval/resolution/score";
import type { EvalCase } from "../../eval/types";

function fixture(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "the-earons-land-of-hunger",
    image: "images/IMG_0613.jpeg",
    artist: "The Earons",
    title: "Land Of Hunger",
    expected: {
      mb: { resolvable: true, releaseGroupIds: ["rg-1"], releaseIds: ["rel-1"] },
      discogs: { resolvable: true, masterIds: [147257], releaseIds: [3846849] },
    },
    ...overrides,
  };
}

function returned(overrides: Partial<ReturnedIds> = {}): ReturnedIds {
  return {
    musicbrainzReleaseGroupId: null,
    musicbrainzReleaseId: null,
    discogsMasterId: null,
    discogsReleaseId: null,
    ...overrides,
  };
}

describe("scoreCase", () => {
  test("counts a different pressing of the right work as a hit", () => {
    // The fixture is a photograph of one pressing; a resolver cannot know
    // which. Any pressing of the right record is the right answer.
    const score = scoreCase(
      fixture(),
      returned({
        musicbrainzReleaseGroupId: "rg-1",
        musicbrainzReleaseId: "some-other-pressing",
        discogsMasterId: 147257,
        discogsReleaseId: 99999999,
      }),
    );
    expect(score.mb).toBe("hit");
    expect(score.discogs).toBe("hit");
    expect(score.either).toBe("hit");
  });

  test("uses the release id as the work key when Discogs has no master", () => {
    // 17 of the 97 identified fixtures have master_id 0. Reading the absent
    // master as a gap would discard a sixth of the set.
    const noMaster = fixture({
      expected: {
        mb: { resolvable: false, releaseGroupIds: [], releaseIds: [] },
        discogs: { resolvable: true, masterIds: [], releaseIds: [4419535] },
      },
    });
    const score = scoreCase(noMaster, returned({ discogsReleaseId: 4419535 }));
    expect(score.discogs).toBe("hit");
  });

  test("scores abstention as correct for a record the database does not hold", () => {
    const absent = fixture({
      expected: {
        mb: { resolvable: false, releaseGroupIds: [], releaseIds: [] },
        discogs: { resolvable: false, masterIds: [], releaseIds: [] },
      },
    });
    const score = scoreCase(absent, returned());
    expect(score.mb).toBe("correct-abstain");
    expect(score.either).toBe("correct-abstain");
  });

  test("scores abstention as a miss when the record is there to be found", () => {
    expect(scoreCase(fixture(), returned()).mb).toBe("miss");
  });

  test("scores a wrong id as a false id, not a miss", () => {
    const score = scoreCase(fixture(), returned({ musicbrainzReleaseGroupId: "rg-wrong" }));
    expect(score.mb).toBe("false-id");
  });

  test("scores any returned id for an unresolvable record as a false id", () => {
    // Returning something for a record that exists in neither database is the
    // worst outcome available, and must never be scored as a correct abstain.
    const absent = fixture({
      expected: {
        mb: { resolvable: false, releaseGroupIds: [], releaseIds: [] },
        discogs: { resolvable: false, masterIds: [], releaseIds: [] },
      },
    });
    expect(scoreCase(absent, returned({ discogsMasterId: 1 })).discogs).toBe("false-id");
  });

  test("a Discogs-only hit is a hit for coverage, and the MB column still says miss", () => {
    const score = scoreCase(fixture(), returned({ discogsMasterId: 147257 }));
    expect(score.discogs).toBe("hit");
    expect(score.mb).toBe("miss");
    expect(score.either).toBe("hit");
  });

  test("a false id counts against the run even when the other database was right", () => {
    const score = scoreCase(
      fixture(),
      returned({ discogsMasterId: 999, musicbrainzReleaseGroupId: null }),
    );
    // The wrong Discogs id gets stored regardless of what MusicBrainz said.
    expect(score.either).toBe("false-id");
  });
});

describe("summarise", () => {
  const fixtures = [
    fixture({ id: "a" }),
    fixture({ id: "b" }),
    fixture({
      id: "c",
      expected: {
        mb: { resolvable: false, releaseGroupIds: [], releaseIds: [] },
        discogs: { resolvable: false, masterIds: [], releaseIds: [] },
      },
    }),
  ];

  test("rates resolution against what the database actually holds", () => {
    const scores = [
      scoreCase(fixtures[0], returned({ musicbrainzReleaseGroupId: "rg-1" })),
      scoreCase(fixtures[1], returned()),
      scoreCase(fixtures[2], returned()),
    ];
    const summary = summarise(fixtures, scores);

    // Two resolvable in MB, one hit — the unresolvable fixture is not in the
    // denominator, so the catalogue's gaps cannot drag the rate down.
    expect(summary.mb.resolvable).toBe(2);
    expect(summary.mb.hit).toBe(1);
    expect(summary.mb.resolutionRate).toBe(0.5);
    expect(summary.mb["correct-abstain"]).toBe(1);
    expect(summary.mb.falseIdRate).toBe(0);
  });

  test("reports NaN rather than 0 when nothing is resolvable", () => {
    // A silent 0% would read as total failure when the honest answer is that
    // the question was not asked.
    const summary = summarise([fixtures[2]], [scoreCase(fixtures[2], returned())]);
    expect(summary.mb.resolutionRate).toBeNaN();
  });
});
