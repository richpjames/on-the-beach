import type { ResolverOptions } from "../../server/release-resolver";

/**
 * A strategy is a resolver configuration, not a separate implementation. The
 * point of running them side by side is to attribute the score to a decision —
 * which database, how loose the query cascade, how high the abstention bar —
 * rather than to a monolith that can only be judged as a whole.
 */
export interface ResolutionStrategy {
  id: string;
  name: string;
  /** Why the configuration is worth a run, in one line, for the report. */
  rationale: string;
  options: ResolverOptions;
}

export const strategies: ResolutionStrategy[] = [
  {
    id: "R1",
    name: "MusicBrainz, quoted phrase only",
    rationale: "Baseline: high precision, and the recall ceiling without a cascade.",
    options: { musicbrainz: true, discogs: false, maxVariants: 1 },
  },
  {
    id: "R2",
    name: "MusicBrainz cascade",
    rationale: "Quoted, then credit-stripped, then unquoted — every candidate verified.",
    options: { musicbrainz: true, discogs: false },
  },
  {
    id: "R3",
    name: "Discogs cascade",
    rationale: "The higher-recall source on this catalogue: 97 of 99 fixtures against MB's 53.",
    options: { musicbrainz: false, discogs: true },
  },
  {
    id: "R4",
    name: "Both databases",
    rationale: "Candidate production behaviour. Both are queried; both ids are kept.",
    options: {},
  },
  {
    id: "R5",
    name: "Both databases, strict abstention",
    rationale: "Trades resolution rate for a lower false-ID rate. The two are not equally costly.",
    options: { thresholds: { artist: 0.85, title: 0.85, confidence: 0.9 } },
  },
];
