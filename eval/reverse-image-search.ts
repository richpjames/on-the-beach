import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../server/vision";
import { getWebContext } from "../server/google-vision";
import { scoreResult } from "./scoring";
import type { EvalManifest, EvalCase } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");

// --- Types ---

interface PassScores {
  artistExact: number;
  titleExact: number;
  artistFuzzy: number;
  titleFuzzy: number;
}

interface PassResult {
  artist: string | null;
  title: string | null;
  artistConfidence: number;
  titleConfidence: number;
  scores: PassScores;
}

interface CaseResult {
  id: string;
  expected: { artist: string; title: string };
  firstPass: PassResult;
  webContext: string | null;
  secondPass: PassResult | null;
  improved: boolean | null;
}

interface OutputJson {
  threshold: number;
  results: CaseResult[];
}

// --- Helpers ---

function loadManifest(): EvalManifest {
  const raw = readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8");
  return JSON.parse(raw) as EvalManifest;
}

function imageToBase64(imagePath: string): string {
  const fullPath = resolve(FIXTURES_DIR, imagePath);
  const buffer = readFileSync(fullPath);
  return buffer.toString("base64");
}

function parseArgs(): { threshold: number; limit: number | null; delay: number } {
  const args = process.argv.slice(2);
  let threshold = 0.8;
  let limit: number | null = null;
  let delay = 500;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold" && args[i + 1] !== undefined) {
      threshold = parseFloat(args[++i]);
    } else if (args[i] === "--limit" && args[i + 1] !== undefined) {
      limit = parseInt(args[++i], 10);
    } else if (args[i] === "--delay" && args[i + 1] !== undefined) {
      delay = parseInt(args[++i], 10);
    }
  }

  return { threshold, limit, delay };
}

function overallFuzzy(scores: PassScores): number {
  return (scores.artistFuzzy + scores.titleFuzzy) / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

async function main() {
  // Check required env vars
  if (!process.env.MISTRAL_API_KEY) {
    console.error("Error: MISTRAL_API_KEY environment variable is required");
    process.exit(1);
  }
  if (!process.env.GOOGLE_VISION_API_KEY) {
    console.error("Error: GOOGLE_VISION_API_KEY environment variable is required");
    process.exit(1);
  }

  const { threshold, limit, delay } = parseArgs();

  const manifest = loadManifest();
  const cases: EvalCase[] = limit !== null ? manifest.cases.slice(0, limit) : manifest.cases;

  console.log(`Reverse image search eval`);
  console.log(`  threshold: ${threshold}`);
  console.log(`  cases: ${cases.length}`);
  console.log(`  delay: ${delay}ms`);
  console.log();

  const results: CaseResult[] = [];

  let lowConfidenceCount = 0;
  let secondPassAttempted = 0;
  let improvedCount = 0;
  let worseCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const evalCase = cases[i];
    const progress = `[${i + 1}/${cases.length}]`;
    process.stdout.write(`${progress} ${evalCase.id} — first pass... `);

    const base64Image = imageToBase64(evalCase.image);
    const expected = { artist: evalCase.artist, title: evalCase.title };

    // First pass
    const firstPassRaw = await extractReleaseInfo(base64Image);
    const firstPassActual = {
      artist: firstPassRaw?.artist ?? null,
      title: firstPassRaw?.title ?? null,
    };
    const firstPassScores = scoreResult(firstPassActual, expected);
    const firstPass: PassResult = {
      artist: firstPassActual.artist,
      title: firstPassActual.title,
      artistConfidence: firstPassRaw?.artistConfidence ?? 0,
      titleConfidence: firstPassRaw?.titleConfidence ?? 0,
      scores: firstPassScores,
    };

    const isLowConfidence =
      firstPass.artistConfidence < threshold || firstPass.titleConfidence < threshold;

    if (isLowConfidence) {
      lowConfidenceCount++;
    }

    process.stdout.write(
      `a=${firstPass.artistConfidence.toFixed(2)} t=${firstPass.titleConfidence.toFixed(2)} fuzzy=${overallFuzzy(firstPassScores).toFixed(3)}`,
    );

    let webContext: string | null = null;
    let secondPass: PassResult | null = null;
    let improved: boolean | null = null;

    if (isLowConfidence) {
      process.stdout.write(" — web context... ");
      webContext = await getWebContext(base64Image);
      await sleep(delay);

      if (webContext !== null) {
        process.stdout.write("second pass... ");
        secondPassAttempted++;

        const secondPassRaw = await extractReleaseInfoFromWebContext(base64Image, webContext);
        const secondPassActual = {
          artist: secondPassRaw?.artist ?? null,
          title: secondPassRaw?.title ?? null,
        };
        const secondPassScores = scoreResult(secondPassActual, expected);
        secondPass = {
          artist: secondPassActual.artist,
          title: secondPassActual.title,
          artistConfidence: secondPassRaw?.artistConfidence ?? 0,
          titleConfidence: secondPassRaw?.titleConfidence ?? 0,
          scores: secondPassScores,
        };

        const firstFuzzy = overallFuzzy(firstPassScores);
        const secondFuzzy = overallFuzzy(secondPassScores);
        improved = secondFuzzy > firstFuzzy;

        if (improved) {
          improvedCount++;
        } else {
          worseCount++;
        }

        process.stdout.write(`fuzzy=${secondFuzzy.toFixed(3)} (${improved ? "+" : "="})`);

        await sleep(delay);
      } else {
        process.stdout.write("no web context");
      }
    }

    process.stdout.write("\n");

    results.push({
      id: evalCase.id,
      expected,
      firstPass,
      webContext,
      secondPass,
      improved,
    });

    // Delay between cases (only if not the last case)
    if (i < cases.length - 1) {
      await sleep(delay);
    }
  }

  // Write results
  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(RESULTS_DIR, `reverse-image-search-${timestamp}.json`);
  const output: OutputJson = { threshold, results };
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // Print summary
  console.log();
  console.log("--- Summary ---");
  console.log(`Total cases: ${cases.length}`);
  console.log(`Low confidence: ${lowConfidenceCount}`);
  console.log(`Second pass attempted: ${secondPassAttempted}`);
  const improvedPct =
    secondPassAttempted > 0 ? ((improvedCount / secondPassAttempted) * 100).toFixed(0) : "0";
  console.log(`Improved: ${improvedCount} (${improvedPct}%)`);
  console.log(`Worse: ${worseCount}`);
  console.log();
  console.log(`Results written to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
