import type { EvalCase } from "./types";

export interface RawOcrCaseResult {
  id: string;
  text: string | null;
}

export interface RawOcrReport {
  timestamp: string;
  caseCount: number;
  models: string[];
  results: Record<string, RawOcrCaseResult[]>;
}

interface BuildRawOcrReportInput {
  timestamp: string;
  cases: EvalCase[];
  ocrTextByModel: Map<string, Map<string, string>>;
}

export function buildRawOcrReport({
  timestamp,
  cases,
  ocrTextByModel,
}: BuildRawOcrReportInput): RawOcrReport {
  const models = [...ocrTextByModel.keys()];
  const results: Record<string, RawOcrCaseResult[]> = {};

  for (const model of models) {
    const ocrTextByCase = ocrTextByModel.get(model) ?? new Map<string, string>();
    results[model] = cases.map((testCase) => ({
      id: testCase.id,
      text: ocrTextByCase.get(testCase.id) ?? null,
    }));
  }

  return {
    timestamp,
    caseCount: cases.length,
    models,
    results,
  };
}
