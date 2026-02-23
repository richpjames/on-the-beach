export type EvalEndpoint = "/v1/chat/completions" | "/v1/ocr";
export type EvalModelKind = "chat" | "ocr";

export interface EvalCase {
  id: string;
  image: string; // relative to eval/fixtures/
  artist: string;
  title: string;
}

export interface EvalManifest {
  cases: EvalCase[];
}

export interface ModelResult {
  id: string;
  expected: { artist: string; title: string };
  actual: { artist: string | null; title: string | null };
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
