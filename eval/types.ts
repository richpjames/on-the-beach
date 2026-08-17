export type EvalEndpoint = "/v1/chat/completions" | "/v1/ocr";
export type EvalModelKind = "chat" | "ocr";

/**
 * The identifiers a resolver should return for a fixture, per database.
 *
 * Ids are arrays because a split release credits two artists and needs both to
 * count as identified — see `lucho-gatica-antonio-machin`.
 *
 * `resolvable: false` means the record is verifiably absent from that database,
 * and returning nothing is then the CORRECT answer. Two fixtures are absent
 * from both; a resolver must not be penalised for them, and a sweep must not
 * retry them forever.
 */
export interface ExpectedIds<Id extends string | number> {
  resolvable: boolean;
  /**
   * The work-level key — the identity that matters. A specific pressing is not
   * the answer: any pressing of the right record counts, so scoring compares
   * these, never `releaseIds`.
   *
   * EMPTY does not mean unresolvable. Discogs returns no master for 17 of this
   * set's 97 identified fixtures, and there `releaseIds` is the work-level key.
   * Read `groups.length ? groups : releaseIds` — a null check on the group
   * alone silently discards a fifth of the set.
   */
  releaseGroupIds?: Id[];
  masterIds?: Id[];
  /** Specific pressings. Recorded for provenance; not the scoring key. */
  releaseIds: Id[];
}

export interface EvalCase {
  id: string;
  image: string; // relative to eval/fixtures/
  /**
   * Ground truth as the SLEEVE reads, which is not always what the databases
   * say — the O Primeiro Amor soundtrack is credited to Various by both, and
   * five fixtures name an artist Discogs disambiguates differently. That
   * divergence is the resolver's problem to solve, so it stays here rather
   * than being normalised away.
   */
  artist: string;
  title: string;
  /**
   * Verified against the sleeve photograph. Absent only for fixtures that
   * predate that pass.
   */
  expected?: {
    /** MusicBrainz. `releaseGroupIds` is the work-level key. */
    mb: ExpectedIds<string> & { artistIds?: string[] };
    /** Discogs. `masterIds` is the work-level key when non-empty. */
    discogs: ExpectedIds<number>;
  };
}

export interface EvalManifest {
  cases: EvalCase[];
}

export interface ModelResult {
  id: string;
  expected: { artist: string; title: string };
  actual: { artist: string | null; title: string | null };
  ocrText?: string | null;
  scores: {
    artistExact: number;
    titleExact: number;
    artistFuzzy: number;
    titleFuzzy: number;
  };
}

export interface ModelSummary {
  artistExact: number;
  titleExact: number;
  artistFuzzy: number;
  titleFuzzy: number;
  overall: number;
}

export interface EvalReport {
  timestamp: string;
  models: string[];
  caseCount: number;
  results: Record<string, { summary: ModelSummary; details: ModelResult[] }>;
}

export interface PendingJobs {
  submittedAt: string;
  jobs: Array<{
    model: string;
    jobId: string;
    endpoint?: EvalEndpoint;
    kind?: EvalModelKind;
  }>;
}
