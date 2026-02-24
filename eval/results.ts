import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseScanJson } from "../server/scan-parser";
import { OCR_TEXT_PARSER_MODELS, getVisionModelConfigById } from "./models";
import { parseBatchOutput, parseOcrTextBatchOutput } from "./output-parser";
import { buildRawOcrReport } from "./raw-ocr-report";
import { scoreResult } from "./scoring";
import { generateHtml } from "./html-report";
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
const OCR_TO_RELEASE_PROMPT =
  "You are given OCR text extracted from a photo of a CD or vinyl cover. " +
  "Infer the release artist and title from this OCR text only. " +
  'Respond with JSON only using keys artist and title. If unknown, use null values. Example: {"artist":"Radiohead","title":"OK Computer"}';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((chunk): string => {
      const chunkObj = asRecord(chunk);
      if (!chunkObj) return "";
      return chunkObj.type === "text" && typeof chunkObj.text === "string" ? chunkObj.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

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

async function parseReleaseFromOcrText(
  client: Mistral,
  model: string,
  ocrText: string,
): Promise<{ artist: string | null; title: string | null }> {
  try {
    const response = await client.chat.complete({
      model,
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${OCR_TO_RELEASE_PROMPT}\n\n` + "OCR text (raw):\n" + ocrText.slice(0, 12_000),
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    const text = extractContentText(content);
    const parsed = text ? parseScanJson(text) : null;
    return parsed ?? { artist: null, title: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error parsing OCR text with ${model}: ${msg}`);
    return { artist: null, title: null };
  }
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
    models: [...new Set(pending.jobs.map((job) => job.model))],
    caseCount: manifest.cases.length,
    results: {},
  };
  const ocrTextByModel = new Map<string, Map<string, string>>();

  // Group pending jobs by model to merge chunked results
  const jobsByModel = new Map<string, PendingJobs["jobs"]>();
  for (const job of pending.jobs) {
    const existing = jobsByModel.get(job.model) ?? [];
    existing.push(job);
    jobsByModel.set(job.model, existing);
  }

  for (const [model, modelJobs] of jobsByModel.entries()) {
    const kind = getKindForPendingJob(modelJobs[0]);
    const outputByCaseId = new Map<string, { artist: string | null; title: string | null }>();
    const ocrTextByCaseId = new Map<string, string>();
    let allSucceeded = true;

    for (const pendingJob of modelJobs) {
      try {
        const job = await client.batch.jobs.get({ jobId: pendingJob.jobId, inline: true });

        if (job.status !== "SUCCESS") {
          console.error(`Skipping ${model} job ${pendingJob.jobId}: status=${job.status}`);
          allSucceeded = false;
          continue;
        }

        for (const output of job.outputs ?? []) {
          const parsed = parseBatchOutput(output, kind);
          if (!parsed.customId) continue;
          outputByCaseId.set(parsed.customId, parsed.actual ?? { artist: null, title: null });

          if (kind === "ocr") {
            const parsedOcrText = parseOcrTextBatchOutput(output);
            if (parsedOcrText.customId && parsedOcrText.text) {
              ocrTextByCaseId.set(parsedOcrText.customId, parsedOcrText.text);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error fetching results for ${model} job ${pendingJob.jobId}: ${msg}`);
        allSucceeded = false;
      }
    }

    if (outputByCaseId.size === 0 && !allSucceeded) continue;

    if (kind === "ocr") {
      ocrTextByModel.set(model, ocrTextByCaseId);
    }

    const details: ModelResult[] = manifest.cases.map((testCase) => {
      const actual = outputByCaseId.get(testCase.id) ?? { artist: null, title: null };
      const scores = scoreResult(actual, { artist: testCase.artist, title: testCase.title });
      const ocrText = kind === "ocr" ? (ocrTextByCaseId.get(testCase.id) ?? null) : undefined;
      return {
        id: testCase.id,
        expected: { artist: testCase.artist, title: testCase.title },
        actual,
        ...(kind === "ocr" ? { ocrText } : {}),
        scores,
      };
    });

    report.results[model] = { summary: summarize(details), details };
  }

  for (const [ocrModel, ocrTextByCaseId] of ocrTextByModel.entries()) {
    for (const parserModel of OCR_TEXT_PARSER_MODELS) {
      const label = `ocr:${ocrModel} -> parse:${parserModel}`;
      const details: ModelResult[] = [];

      for (const testCase of manifest.cases) {
        const ocrText = ocrTextByCaseId.get(testCase.id) ?? null;
        const actual = ocrText
          ? await parseReleaseFromOcrText(client, parserModel, ocrText)
          : { artist: null, title: null };
        const scores = scoreResult(actual, { artist: testCase.artist, title: testCase.title });

        details.push({
          id: testCase.id,
          expected: { artist: testCase.artist, title: testCase.title },
          actual,
          ocrText,
          scores,
        });
      }

      report.results[label] = { summary: summarize(details), details };
      report.models.push(label);
    }
  }

  printTable(report);

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = report.timestamp.replace(/[:.]/g, "-");
  const reportPath = resolve(RESULTS_DIR, filename + ".json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Detailed report saved to: ${reportPath}`);

  const rawOcrReport = buildRawOcrReport({
    timestamp: report.timestamp,
    cases: manifest.cases,
    ocrTextByModel,
  });
  const rawOcrPath = resolve(RESULTS_DIR, filename + ".raw-ocr.json");
  writeFileSync(rawOcrPath, JSON.stringify(rawOcrReport, null, 2));
  console.log(`Raw OCR output saved to: ${rawOcrPath}`);

  const htmlPath = resolve(RESULTS_DIR, filename + ".html");
  writeFileSync(htmlPath, generateHtml(report));
  console.log(`HTML report saved to: ${htmlPath}`);
}

main();
