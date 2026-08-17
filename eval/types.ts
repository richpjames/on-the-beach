export type EvalEndpoint = "/v1/chat/completions" | "/v1/ocr";
export type EvalModelKind = "chat" | "ocr";

/**
 * How far a fixture could be resolved against MusicBrainz. Recorded so a null
 * `musicbrainzReleaseId` isn't ambiguous: roughly a fifth of this set is
 * regional Latin American and Iberian pressings MusicBrainz simply doesn't
 * catalogue, and those must not be retried or read as a lookup bug.
 */
export type MbFixtureStatus =
  /** Release MBID confirmed against MusicBrainz. */
  | "matched"
  /** Release absent from MusicBrainz, but the artist is catalogued. */
  | "artist-only"
  /** Verified absent from MusicBrainz — no release, no artist match. */
  | "absent"
  /** Search returned only candidates that were rejected as the wrong record. */
  | "unresolved";

export interface EvalCase {
  id: string;
  image: string; // relative to eval/fixtures/
  artist: string;
  title: string;
  /**
   * MusicBrainz identifiers, where they could be established. `artist` and
   * `title` above remain the scoring ground truth — these are metadata for
   * enrichment and for segmenting results by whether MusicBrainz knows the
   * record at all.
   */
  mbStatus?: MbFixtureStatus;
  musicbrainzReleaseId?: string;
  musicbrainzArtistId?: string;
  /**
   * Discogs identifiers, looked up only for fixtures MusicBrainz could not
   * resolve. Discogs covers this set's regional Latin American and Iberian
   * pressings far better, so most cases carry one or the other rather than
   * both. `discogsMasterId` is absent when the release has no master.
   */
  discogsReleaseId?: number;
  discogsMasterId?: number;
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
