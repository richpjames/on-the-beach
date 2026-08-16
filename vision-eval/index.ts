import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { callMistral, callOpenAICompatible } from "./api";
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
const model = getFlag("--model") ?? "mistral-medium-2604";
const provider = (getFlag("--provider") ?? "mistral").toLowerCase();

// Known OpenAI-compatible endpoints, so common providers need only --provider.
// Any other base URL can be passed with --base-url.
const PRESET_BASE_URLS: Record<string, string> = {
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  "qwen-cn": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// --- Setup ---
if (provider !== "mistral" && !PRESET_BASE_URLS[provider] && !getFlag("--base-url")) {
  console.error(
    `Unknown --provider "${provider}". Use "mistral", one of ` +
      `${Object.keys(PRESET_BASE_URLS).join(", ")}, or pass --base-url explicitly.`,
  );
  process.exit(1);
}

// Mistral reads MISTRAL_API_KEY; every other provider reads EVAL_API_KEY so a
// single variable covers Qwen, OpenRouter and anything else OpenAI-compatible.
const API_KEY = provider === "mistral" ? process.env.MISTRAL_API_KEY : process.env.EVAL_API_KEY;
if (!API_KEY) {
  console.error(provider === "mistral" ? "MISTRAL_API_KEY is not set" : "EVAL_API_KEY is not set");
  process.exit(1);
}

const BASE_URL = getFlag("--base-url") ?? PRESET_BASE_URLS[provider];

const VISION_EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(VISION_EVAL_DIR, "../eval/fixtures");
const RESULTS_DIR = resolve(VISION_EVAL_DIR, "results");
// Timestamped so repeat runs of the same model accumulate instead of overwriting
// each other. Matches the naming used by eval/results.ts and eval/reverse-image-search.ts.
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_PATH = resolve(RESULTS_DIR, `eval-results-${model}-${RUN_TIMESTAMP}.json`);

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

// Pre-flight: one real call before the loop. A retired model or bad key fails
// identically on every case, so without this the run burns the whole fixture
// set producing a score table made entirely of errors.
{
  const probe = imageCache.get(cases[0]!.id)!;
  console.log(`Pre-flight: ${model} via ${provider}${BASE_URL ? ` (${BASE_URL})` : ""} ...`);
  const { error } = await (provider === "mistral"
    ? callMistral(client, "Reply with the word: ok", probe, model)
    : callOpenAICompatible(BASE_URL!, API_KEY, "Reply with the word: ok", probe, model));
  if (error) {
    console.error(
      `\nPre-flight failed — aborting before spending ${cases.length} calls.\n${error}`,
    );
    process.exit(1);
  }
  console.log("Pre-flight OK\n");
}

for (const strategy of selectedStrategies) {
  console.log(`\nRunning strategy ${strategy.id} — ${strategy.name}`);
  const results: ImageResult[] = [];

  for (const testCase of cases) {
    const dataUri = imageCache.get(testCase.id)!;

    process.stdout.write(`  ${testCase.id} ... `);

    const { content, error } =
      provider === "mistral"
        ? await callMistral(client, strategy.prompt, dataUri, model)
        : await callOpenAICompatible(BASE_URL!, API_KEY, strategy.prompt, dataUri, model);

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

// A run that mostly errored (rate limits, transport failures) still produces a
// full score table, because failed cases score 0 and look like wrong answers.
// Call that out rather than letting a throttled run be read as a bad model.
for (const strategy of selectedStrategies) {
  const s = output[strategy.id];
  if (!s) continue;
  const errored = s.results.filter((r) => r.error).length;
  if (errored > 0) {
    const pct = Math.round((errored / s.results.length) * 100);
    console.warn(
      `\n⚠️  Strategy ${strategy.id}: ${errored}/${s.results.length} cases (${pct}%) failed with ` +
        `API errors and scored 0. This score measures the failures, not the model. ` +
        `Re-run with a longer --delay before comparing.`,
    );
  }
}
