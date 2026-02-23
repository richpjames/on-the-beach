import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseScanJson } from "../server/scan-parser";
import { scoreResult } from "./scoring";
import type { EvalManifest, EvalReport, ModelResult, ModelSummary, PendingJobs } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");
const PENDING_PATH = resolve(RESULTS_DIR, "pending-jobs.json");

function loadManifest(): EvalManifest {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8"));
}

function parseResponseContent(
  content: unknown,
): { artist: string | null; title: string | null } | null {
  if (typeof content === "string") return parseScanJson(content);
  if (Array.isArray(content)) {
    const text = content
      .filter((c: any) => c?.type === "text" && typeof c?.text === "string")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    return text ? parseScanJson(text) : null;
  }
  return null;
}

function summarize(details: ModelResult[]): ModelSummary {
  const n = details.length;
  if (n === 0) return { artistExact: 0, titleExact: 0, artistFuzzy: 0, titleFuzzy: 0, overall: 0 };

  const sums = details.reduce(
    (acc, d) => ({
      artistExact: acc.artistExact + d.scores.artistExact,
      titleExact: acc.titleExact + d.scores.titleExact,
      artistFuzzy: acc.artistFuzzy + d.scores.artistFuzzy,
      titleFuzzy: acc.titleFuzzy + d.scores.titleFuzzy,
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

  // Sort by overall score descending
  const sorted = Object.entries(report.results).sort(
    ([, a], [, b]) => b.summary.overall - a.summary.overall,
  );

  for (const [model, { summary }] of sorted) {
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padEnd(colNum);
    const fz = (v: number) => v.toFixed(3).padEnd(colNum);
    console.log(
      `${model.padEnd(colModel)} ${pct(summary.artistExact)} ${pct(summary.titleExact)} ${fz(summary.artistFuzzy)} ${fz(summary.titleFuzzy)} ${pct(summary.overall)}`,
    );
  }
  console.log("");
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

  const caseMap = new Map(manifest.cases.map((c) => [c.id, c]));

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    models: pending.jobs.map((j) => j.model),
    caseCount: manifest.cases.length,
    results: {},
  };

  for (const { model, jobId } of pending.jobs) {
    try {
      const job = await client.batch.jobs.get({ jobId, inline: true });

      if (job.status !== "SUCCESS") {
        console.error(`Skipping ${model}: status=${job.status}`);
        continue;
      }

      const details: ModelResult[] = [];

      if (job.outputs) {
        for (const output of job.outputs) {
          const customId = output.custom_id as string;
          const testCase = caseMap.get(customId);
          if (!testCase) continue;

          const response = output.response as any;
          const content = response?.body?.choices?.[0]?.message?.content;
          const actual = parseResponseContent(content) ?? { artist: null, title: null };

          const scores = scoreResult(actual, { artist: testCase.artist, title: testCase.title });
          details.push({
            id: customId,
            expected: { artist: testCase.artist, title: testCase.title },
            actual,
            scores,
          });
        }
      }

      report.results[model] = { summary: summarize(details), details };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error fetching results for ${model}: ${msg}`);
    }
  }

  printTable(report);

  // Save detailed JSON report
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = report.timestamp.replace(/[:.]/g, "-") + ".json";
  const reportPath = resolve(RESULTS_DIR, filename);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Detailed report saved to: ${reportPath}`);
}

main();
