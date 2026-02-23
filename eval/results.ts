import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { getVisionModelConfigById } from "./models";
import { parseBatchOutput } from "./output-parser";
import { scoreResult } from "./scoring";
import type {
  EvalManifest,
  EvalModelKind,
  EvalReport,
  ModelResult,
  ModelSummary,
  PendingJobs,
} from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");
const PENDING_PATH = resolve(RESULTS_DIR, "pending-jobs.json");

function loadManifest(): EvalManifest {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8"));
}

function summarize(details: ModelResult[]): ModelSummary {
  const n = details.length;
  if (n === 0) return { artistExact: 0, titleExact: 0, artistFuzzy: 0, titleFuzzy: 0, overall: 0 };

  const sums = details.reduce(
    (acc, detail) => ({
      artistExact: acc.artistExact + detail.scores.artistExact,
      titleExact: acc.titleExact + detail.scores.titleExact,
      artistFuzzy: acc.artistFuzzy + detail.scores.artistFuzzy,
      titleFuzzy: acc.titleFuzzy + detail.scores.titleFuzzy,
    }),
    { artistExact: 0, titleExact: 0, artistFuzzy: 0, titleFuzzy: 0 },
  );

  const artistExact = sums.artistExact / n;
  const titleExact = sums.titleExact / n;
  const artistFuzzy = sums.artistFuzzy / n;
  const titleFuzzy = sums.titleFuzzy / n;
  const overall = (artistExact + titleExact + artistFuzzy + titleFuzzy) / 4;

  return { artistExact, titleExact, artistFuzzy, titleFuzzy, overall };
}

function printTable(report: EvalReport) {
  const colModel = 30;
  const colNum = 12;

  const header =
    `${"Model".padEnd(colModel)} ` +
    `${"Artist Ex".padEnd(colNum)} ` +
    `${"Title Ex".padEnd(colNum)} ` +
    `${"Artist Fz".padEnd(colNum)} ` +
    `${"Title Fz".padEnd(colNum)} ` +
    `${"Overall".padEnd(colNum)}`;

  console.log(`\nResults (${report.caseCount} test cases)\n`);
  console.log(header);
  console.log("─".repeat(header.length));

  const sorted = Object.entries(report.results).sort(
    ([, left], [, right]) => right.summary.overall - left.summary.overall,
  );

  for (const [model, { summary }] of sorted) {
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`.padEnd(colNum);
    const fz = (value: number) => value.toFixed(3).padEnd(colNum);
    console.log(
      `${model.padEnd(colModel)} ${pct(summary.artistExact)} ${pct(summary.titleExact)} ${fz(summary.artistFuzzy)} ${fz(summary.titleFuzzy)} ${pct(summary.overall)}`,
    );
  }
  console.log("");
}

function getKindForPendingJob(pendingJob: PendingJobs["jobs"][number]): EvalModelKind {
  if (pendingJob.kind) return pendingJob.kind;
  const config = getVisionModelConfigById(pendingJob.model);
  return config?.kind ?? "chat";
}

async function main() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    console.error("MISTRAL_API_KEY is required");
    process.exit(1);
  }

  if (!existsSync(PENDING_PATH)) {
    console.error("No pending jobs found. Run `bun eval/submit.ts` first.");
    process.exit(1);
  }

  const pending: PendingJobs = JSON.parse(readFileSync(PENDING_PATH, "utf-8"));
  const manifest = loadManifest();
  const client = new Mistral({ apiKey });

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    models: pending.jobs.map((job) => job.model),
    caseCount: manifest.cases.length,
    results: {},
  };

  for (const pendingJob of pending.jobs) {
    const { model, jobId } = pendingJob;
    const kind = getKindForPendingJob(pendingJob);

    try {
      const job = await client.batch.jobs.get({ jobId, inline: true });

      if (job.status !== "SUCCESS") {
        console.error(`Skipping ${model}: status=${job.status}`);
        continue;
      }

      const outputByCaseId = new Map<string, { artist: string | null; title: string | null }>();
      for (const output of job.outputs ?? []) {
        const parsed = parseBatchOutput(output, kind);
        if (!parsed.customId) continue;
        outputByCaseId.set(parsed.customId, parsed.actual ?? { artist: null, title: null });
      }

      const details: ModelResult[] = manifest.cases.map((testCase) => {
        const actual = outputByCaseId.get(testCase.id) ?? { artist: null, title: null };
        const scores = scoreResult(actual, { artist: testCase.artist, title: testCase.title });
        return {
          id: testCase.id,
          expected: { artist: testCase.artist, title: testCase.title },
          actual,
          scores,
        };
      });

      report.results[model] = { summary: summarize(details), details };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error fetching results for ${model}: ${msg}`);
    }
  }

  printTable(report);

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = report.timestamp.replace(/[:.]/g, "-") + ".json";
  const reportPath = resolve(RESULTS_DIR, filename);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Detailed report saved to: ${reportPath}`);
}

main();
