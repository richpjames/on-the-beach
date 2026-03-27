import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { callMistral } from "./api";
import { strategies } from "./strategies";
import { scoreResult } from "./score";
import type { EvalManifest } from "../eval/types";

// --- CLI args ---
const args = process.argv.slice(2);

function getFlag(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const strategyFilter = getFlag("--strategy")
  ?.split(",")
  .map((s) => s.trim().toUpperCase());
const limit = getFlag("--limit") ? parseInt(getFlag("--limit")!, 10) : undefined;
const delay = getFlag("--delay") ? parseInt(getFlag("--delay")!, 10) : 500;
const model = getFlag("--model") ?? "pixtral-large-latest";

// --- Setup ---
const API_KEY = process.env.MISTRAL_API_KEY;
if (!API_KEY) {
  console.error("MISTRAL_API_KEY is not set");
  process.exit(1);
}

const PIXTRAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(PIXTRAL_DIR, "../eval/fixtures");
const RESULTS_DIR = resolve(PIXTRAL_DIR, "results");
const OUTPUT_PATH = resolve(RESULTS_DIR, `eval-results-${model}.json`);

const manifest: EvalManifest = JSON.parse(
  readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8"),
);

const cases = limit ? manifest.cases.slice(0, limit) : manifest.cases;

const selectedStrategies = strategies.filter(
  (s) => !strategyFilter || strategyFilter.includes(s.id),
);

if (selectedStrategies.length === 0) {
  console.error(`No strategies matched: ${strategyFilter?.join(", ")}`);
  process.exit(1);
}

function imageToDataUri(imagePath: string): string {
  const fullPath = resolve(FIXTURES_DIR, imagePath);
  const buffer = readFileSync(fullPath);
  const ext = extname(imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// --- Types ---
interface ImageResult {
  id: string;
  ground_truth: { artist: string; title: string };
  raw_response: string;
  parsed: { artist: string; title: string };
  score: 0 | 1 | 2;
  match_type: string;
  error?: string;
  parse_error?: boolean;
}

interface StrategySummary {
  exact: number;
  partial: number;
  none: number;
  parse_errors: number;
  total_score: number;
  max_score: number;
}

// --- Run ---
const client = new Mistral({ apiKey: API_KEY });
const output: Record<string, { results: ImageResult[]; summary: StrategySummary }> = {};

// Pre-encode images once
const imageCache = new Map<string, string>();
for (const c of cases) {
  imageCache.set(c.id, imageToDataUri(c.image));
}

for (const strategy of selectedStrategies) {
  console.log(`\nRunning strategy ${strategy.id} — ${strategy.name}`);
  const results: ImageResult[] = [];

  for (const testCase of cases) {
    const dataUri = imageCache.get(testCase.id)!;

    process.stdout.write(`  ${testCase.id} ... `);

    const { content, error } = await callMistral(client, strategy.prompt, dataUri, model);

    let result: ImageResult;

    if (error) {
      console.log(`ERROR: ${error}`);
      result = {
        id: testCase.id,
        ground_truth: { artist: testCase.artist, title: testCase.title },
        raw_response: "",
        parsed: { artist: "", title: "" },
        score: 0,
        match_type: "none",
        error,
      };
    } else {
      const parsed = strategy.parseResponse(content);
      const { score, match_type } = scoreResult(parsed, testCase);

      console.log(`${match_type} (${score})`);

      result = {
        id: testCase.id,
        ground_truth: { artist: testCase.artist, title: testCase.title },
        raw_response: content,
        parsed: { artist: parsed.artist, title: parsed.title },
        score,
        match_type,
        ...(parsed.parseError ? { parse_error: true } : {}),
      };
    }

    results.push(result);
    await new Promise((r) => setTimeout(r, delay));
  }

  const summary: StrategySummary = {
    exact: results.filter((r) => r.match_type === "exact").length,
    partial: results.filter((r) => r.match_type === "partial").length,
    none: results.filter((r) => r.match_type === "none").length,
    parse_errors: results.filter((r) => r.parse_error || r.error).length,
    total_score: results.reduce((acc, r) => acc + r.score, 0),
    max_score: results.length * 2,
  };

  output[strategy.id] = { results, summary };
}

// --- Write results ---
if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

const finalOutput = {
  run_at: new Date().toISOString(),
  model,
  total_cases: cases.length,
  strategies: output,
};

writeFileSync(OUTPUT_PATH, JSON.stringify(finalOutput, null, 2));

// --- Print table ---
console.log("\n");
const col = (s: string, w: number) => s.padEnd(w);
const header =
  col("Strategy", 20) +
  col("Exact", 8) +
  col("Partial", 10) +
  col("None", 8) +
  col("Score", 12) +
  "Parse Errors";

console.log(header);
console.log("─".repeat(header.length));

for (const strategy of selectedStrategies) {
  const s = output[strategy.id];
  if (!s) continue;
  const { exact, partial, none, parse_errors, total_score, max_score } = s.summary;
  console.log(
    col(`${strategy.id} - ${strategy.name}`, 20) +
      col(String(exact), 8) +
      col(String(partial), 10) +
      col(String(none), 8) +
      col(`${total_score}/${max_score}`, 12) +
      String(parse_errors),
  );
}

console.log(`\nResults written to ${OUTPUT_PATH}`);
