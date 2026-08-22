import type { EvalCase, ExpectedIds } from "../types";

// ---------------------------------------------------------------------------
// Scoring release resolution
//
// Correctness is set membership at the work level, never string comparison. A
// fixture is a photograph of one pressing, and a resolver given "Machito & His
// Afro-Cubans — Tanga" cannot know which of a dozen pressings the photo shows.
// Any pressing of the right record is the right answer.
//
// The four outcomes are deliberately asymmetric. A false id is written into
// music_items and silently poisons artwork, artist-watch baselines and release
// alerts downstream; a miss leaves a row that can be retried. A report that
// blends them into one accuracy number hides the only trade-off that matters.
// ---------------------------------------------------------------------------

export type ResolutionOutcome = "hit" | "false-id" | "miss" | "correct-abstain";

/** What a strategy returned for one fixture, reduced to the scoring keys. */
export interface ReturnedIds {
  musicbrainzReleaseGroupId: string | null;
  musicbrainzReleaseId: string | null;
  discogsMasterId: number | null;
  discogsReleaseId: number | null;
}

/**
 * The work-level keys a returned id is checked against.
 *
 * An empty group list does NOT mean unresolvable. Discogs has no master for 17
 * of this set's 97 identified fixtures, and there the release id IS the work
 * key — reading the absent master as a gap discards a sixth of the set.
 */
function workKeys<Id extends string | number>(expected: ExpectedIds<Id>): Id[] {
  const groups = expected.releaseGroupIds ?? expected.masterIds ?? [];
  return groups.length > 0 ? groups : expected.releaseIds;
}

function scoreDatabase<Id extends string | number>(
  expected: ExpectedIds<Id> | undefined,
  returnedWorkId: Id | null,
  returnedReleaseId: Id | null,
): ResolutionOutcome {
  const returned = returnedWorkId ?? returnedReleaseId;
  if (returned === null) {
    // Abstaining is the correct answer for a record the database does not
    // hold, and must score as such — otherwise a resolver is punished for the
    // catalogue's gaps and the only way to a good number is to guess.
    return expected?.resolvable ? "miss" : "correct-abstain";
  }
  if (!expected) return "false-id";

  if (workKeys(expected).includes(returned)) return "hit";
  // A returned pressing that is one of the recorded pressings is right even if
  // the two sides disagree about which master it belongs to.
  if (returnedReleaseId !== null && expected.releaseIds.includes(returnedReleaseId)) return "hit";
  return "false-id";
}

export interface CaseScore {
  id: string;
  mb: ResolutionOutcome;
  discogs: ResolutionOutcome;
  /** Coverage across both databases — never a verdict on either one. */
  either: ResolutionOutcome;
}

/**
 * Combine the two databases into a coverage outcome.
 *
 * A hit anywhere is a hit: "found in Discogs" and "found in MusicBrainz" are
 * two separate facts and a Discogs-only result is not a lesser one, it is
 * simply where that record lives. A false id anywhere still counts against the
 * run even when the other database was right, because the wrong id is stored
 * either way.
 */
function combine(mb: ResolutionOutcome, discogs: ResolutionOutcome): ResolutionOutcome {
  if (mb === "hit" || discogs === "hit") return "hit";
  if (mb === "false-id" || discogs === "false-id") return "false-id";
  if (mb === "miss" || discogs === "miss") return "miss";
  return "correct-abstain";
}

export function scoreCase(fixture: EvalCase, returned: ReturnedIds): CaseScore {
  const mb = scoreDatabase(
    fixture.expected?.mb,
    returned.musicbrainzReleaseGroupId,
    returned.musicbrainzReleaseId,
  );
  const discogs = scoreDatabase(
    fixture.expected?.discogs,
    returned.discogsMasterId,
    returned.discogsReleaseId,
  );
  return { id: fixture.id, mb, discogs, either: combine(mb, discogs) };
}

export interface OutcomeTally {
  hit: number;
  "false-id": number;
  miss: number;
  "correct-abstain": number;
  /** Fixtures the database is known to hold — the denominator for resolution rate. */
  resolvable: number;
  total: number;
  /** hit / resolvable. NaN when nothing is resolvable, never silently 0. */
  resolutionRate: number;
  /** false-id / total. The number that must stay near zero. */
  falseIdRate: number;
}

function emptyTally(): OutcomeTally {
  return {
    hit: 0,
    "false-id": 0,
    miss: 0,
    "correct-abstain": 0,
    resolvable: 0,
    total: 0,
    resolutionRate: Number.NaN,
    falseIdRate: Number.NaN,
  };
}

function finalise(tally: OutcomeTally): OutcomeTally {
  return {
    ...tally,
    resolutionRate: tally.resolvable > 0 ? tally.hit / tally.resolvable : Number.NaN,
    falseIdRate: tally.total > 0 ? tally["false-id"] / tally.total : Number.NaN,
  };
}

export interface Summary {
  mb: OutcomeTally;
  discogs: OutcomeTally;
  either: OutcomeTally;
}

export function summarise(fixtures: EvalCase[], scores: CaseScore[]): Summary {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const mb = emptyTally();
  const discogs = emptyTally();
  const either = emptyTally();

  for (const score of scores) {
    const fixture = byId.get(score.id);
    const mbResolvable = fixture?.expected?.mb.resolvable ?? false;
    const discogsResolvable = fixture?.expected?.discogs.resolvable ?? false;

    for (const [tally, outcome, resolvable] of [
      [mb, score.mb, mbResolvable],
      [discogs, score.discogs, discogsResolvable],
      [either, score.either, mbResolvable || discogsResolvable],
    ] as const) {
      tally[outcome] += 1;
      tally.total += 1;
      if (resolvable) tally.resolvable += 1;
    }
  }

  return { mb: finalise(mb), discogs: finalise(discogs), either: finalise(either) };
}
