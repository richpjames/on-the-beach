# Vision Eval Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a batch-based eval workflow to compare all Mistral vision models at identifying artist/title from album cover images.

**Architecture:** Three standalone CLI scripts (`submit`, `status`, `results`) that use Mistral's batch API via the `@mistralai/mistralai` SDK. Test cases stored as images + JSON manifest. Scoring uses exact + fuzzy string matching. `parseScanJson` is extracted from `server/vision.ts` to a shared module.

**Tech Stack:** Bun, TypeScript, `@mistralai/mistralai` SDK (already installed)

---

### Task 1: Extract `parseScanJson` to shared module

The eval needs the same JSON parsing logic as the app. Extract it so both can import it.

**Files:**
- Create: `server/scan-parser.ts`
- Modify: `server/vision.ts`
- Test: `tests/unit/scan-parser.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/scan-parser.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { parseScanJson } from "../../server/scan-parser";

describe("parseScanJson", () => {
  test("parses valid JSON with artist and title", () => {
    expect(parseScanJson('{"artist":"Radiohead","title":"OK Computer"}')).toEqual({
      artist: "Radiohead",
      title: "OK Computer",
    });
  });

  test("handles fenced JSON", () => {
    expect(parseScanJson('```json\n{"artist":"Bonobo","title":"Migration"}\n```')).toEqual({
      artist: "Bonobo",
      title: "Migration",
    });
  });

  test("coerces empty strings to null", () => {
    expect(parseScanJson('{"artist":"","title":"OK Computer"}')).toEqual({
      artist: null,
      title: "OK Computer",
    });
  });

  test("returns null for invalid JSON", () => {
    expect(parseScanJson("not json")).toBeNull();
  });

  test("returns null for non-object JSON", () => {
    expect(parseScanJson('"just a string"')).toBeNull();
  });

  test("returns null when artist is a number", () => {
    expect(parseScanJson('{"artist":123,"title":"OK Computer"}')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/scan-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Create the shared module**

Create `server/scan-parser.ts` — move `parseScanJson` from `server/vision.ts`:

```typescript
import type { ScanResult } from "../src/types";

export function parseScanJson(rawContent: string): ScanResult | null {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const artist = typeof parsed.artist === "string" ? parsed.artist.trim() || null : null;
    const title = typeof parsed.title === "string" ? parsed.title.trim() || null : null;

    if (parsed.artist !== null && parsed.artist !== undefined && typeof parsed.artist !== "string") {
      return null;
    }

    if (parsed.title !== null && parsed.title !== undefined && typeof parsed.title !== "string") {
      return null;
    }

    return { artist, title };
  } catch {
    return null;
  }
}
```

**Step 4: Update `server/vision.ts` to import from shared module**

Replace the local `parseScanJson` function with an import:

```typescript
import { parseScanJson } from "./scan-parser";
```

Remove the `parseScanJson` function body from `vision.ts`. Keep everything else.

**Step 5: Run all tests to verify nothing broke**

Run: `bun test tests/unit/scan-parser.test.ts && bun test tests/unit/vision.test.ts`
Expected: All PASS

**Step 6: Commit**

```bash
git add server/scan-parser.ts server/vision.ts tests/unit/scan-parser.test.ts
git commit -m "refactor: extract parseScanJson to shared module"
```

---

### Task 2: Create models list and manifest schema

**Files:**
- Create: `eval/models.ts`
- Create: `eval/types.ts`
- Create: `eval/fixtures/manifest.json`
- Create: `eval/fixtures/images/` (directory)

**Step 1: Create eval types**

Create `eval/types.ts`:

```typescript
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
  jobs: Array<{ model: string; jobId: string }>;
}
```

**Step 2: Create models list**

Create `eval/models.ts`:

```typescript
export const VISION_MODELS = [
  "mistral-small-3-2-25-06",
  "mistral-medium-3-1-25-08",
  "mistral-large-3-25-12",
  "ministral-3-14b-25-12",
  "ministral-3-8b-25-12",
  "ministral-3-3b-25-12",
  "pixtral-large-2411",
];
```

**Step 3: Create empty manifest with one placeholder entry**

Create `eval/fixtures/manifest.json`:

```json
{
  "cases": []
}
```

Create `eval/fixtures/images/` directory (add a `.gitkeep`).

**Step 4: Commit**

```bash
mkdir -p eval/fixtures/images
touch eval/fixtures/images/.gitkeep
git add eval/types.ts eval/models.ts eval/fixtures/manifest.json eval/fixtures/images/.gitkeep
git commit -m "feat(eval): add types, model list, and manifest scaffold"
```

---

### Task 3: Create scoring module with tests

**Files:**
- Create: `eval/scoring.ts`
- Create: `tests/unit/eval-scoring.test.ts`

**Step 1: Write the failing tests**

Create `tests/unit/eval-scoring.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { levenshteinSimilarity, scoreResult } from "../../eval/scoring";

describe("levenshteinSimilarity", () => {
  test("identical strings return 1.0", () => {
    expect(levenshteinSimilarity("Radiohead", "Radiohead")).toBe(1.0);
  });

  test("completely different strings return low score", () => {
    expect(levenshteinSimilarity("abc", "xyz")).toBeLessThan(0.2);
  });

  test("case-insensitive comparison", () => {
    expect(levenshteinSimilarity("RADIOHEAD", "radiohead")).toBe(1.0);
  });

  test("similar strings return high score", () => {
    const score = levenshteinSimilarity("Radiohead", "Radioheed");
    expect(score).toBeGreaterThan(0.8);
  });

  test("empty strings return 1.0", () => {
    expect(levenshteinSimilarity("", "")).toBe(1.0);
  });

  test("one empty string returns 0.0", () => {
    expect(levenshteinSimilarity("abc", "")).toBe(0.0);
  });
});

describe("scoreResult", () => {
  test("exact match scores 1 on all metrics", () => {
    const scores = scoreResult(
      { artist: "Radiohead", title: "OK Computer" },
      { artist: "Radiohead", title: "OK Computer" },
    );
    expect(scores).toEqual({
      artistExact: 1,
      titleExact: 1,
      artistFuzzy: 1.0,
      titleFuzzy: 1.0,
    });
  });

  test("case-insensitive exact match", () => {
    const scores = scoreResult(
      { artist: "RADIOHEAD", title: "ok computer" },
      { artist: "Radiohead", title: "OK Computer" },
    );
    expect(scores.artistExact).toBe(1);
    expect(scores.titleExact).toBe(1);
  });

  test("null actual when expected non-null scores 0", () => {
    const scores = scoreResult(
      { artist: null, title: null },
      { artist: "Radiohead", title: "OK Computer" },
    );
    expect(scores.artistExact).toBe(0);
    expect(scores.titleExact).toBe(0);
    expect(scores.artistFuzzy).toBe(0);
    expect(scores.titleFuzzy).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/eval-scoring.test.ts`
Expected: FAIL — module not found

**Step 3: Implement scoring**

Create `eval/scoring.ts`:

```typescript
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

export function levenshteinSimilarity(a: string, b: string): number {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al.length === 0 && bl.length === 0) return 1.0;
  if (al.length === 0 || bl.length === 0) return 0.0;
  const dist = levenshteinDistance(al, bl);
  return 1 - dist / Math.max(al.length, bl.length);
}

export function scoreResult(
  actual: { artist: string | null; title: string | null },
  expected: { artist: string; title: string },
): { artistExact: number; titleExact: number; artistFuzzy: number; titleFuzzy: number } {
  const artistExact =
    actual.artist !== null && actual.artist.toLowerCase().trim() === expected.artist.toLowerCase().trim() ? 1 : 0;
  const titleExact =
    actual.title !== null && actual.title.toLowerCase().trim() === expected.title.toLowerCase().trim() ? 1 : 0;

  const artistFuzzy = actual.artist !== null ? levenshteinSimilarity(actual.artist, expected.artist) : 0;
  const titleFuzzy = actual.title !== null ? levenshteinSimilarity(actual.title, expected.title) : 0;

  return { artistExact, titleExact, artistFuzzy, titleFuzzy };
}
```

**Step 4: Run tests**

Run: `bun test tests/unit/eval-scoring.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add eval/scoring.ts tests/unit/eval-scoring.test.ts
git commit -m "feat(eval): add scoring module with exact + fuzzy matching"
```

---

### Task 4: Create `submit.ts` batch submission script

**Files:**
- Create: `eval/submit.ts`

**Step 1: Implement the submit script**

Create `eval/submit.ts`:

```typescript
import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { VISION_MODELS } from "./models";
import type { EvalManifest, PendingJobs } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");

const SCAN_PROMPT =
  "You are reading a photo of a music release cover. Respond with JSON only using keys artist and title. " +
  'If uncertain, use null values. Example: {"artist":"Radiohead","title":"OK Computer"}';

function loadManifest(): EvalManifest {
  const raw = readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8");
  return JSON.parse(raw);
}

function imageToBase64(imagePath: string): string {
  const fullPath = resolve(FIXTURES_DIR, imagePath);
  const buffer = readFileSync(fullPath);
  return buffer.toString("base64");
}

async function main() {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    console.error("MISTRAL_API_KEY is required");
    process.exit(1);
  }

  const manifest = loadManifest();
  if (manifest.cases.length === 0) {
    console.error("No test cases in manifest. Add images and cases to eval/fixtures/manifest.json");
    process.exit(1);
  }

  console.log(`Submitting ${manifest.cases.length} cases across ${VISION_MODELS.length} models...\n`);

  const client = new Mistral({ apiKey });

  // Build requests (shared across all models — same images, same prompt)
  const requests = manifest.cases.map((c) => ({
    customId: c.id,
    body: {
      temperature: 0,
      response_format: { type: "json_object" as const },
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: SCAN_PROMPT },
            { type: "image_url" as const, image_url: `data:image/jpeg;base64,${imageToBase64(c.image)}` },
          ],
        },
      ],
    },
  }));

  const jobs: PendingJobs["jobs"] = [];

  for (const model of VISION_MODELS) {
    try {
      const job = await client.batch.jobs.create({
        model,
        endpoint: "/v1/chat/completions",
        requests,
      });
      jobs.push({ model, jobId: job.id });
      console.log(`  ✓ ${model} → job ${job.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${model} → ${msg}`);
    }
  }

  if (jobs.length === 0) {
    console.error("\nNo jobs submitted successfully.");
    process.exit(1);
  }

  // Save job IDs for status/results scripts
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const pending: PendingJobs = { submittedAt: new Date().toISOString(), jobs };
  writeFileSync(resolve(RESULTS_DIR, "pending-jobs.json"), JSON.stringify(pending, null, 2));

  console.log(`\n${jobs.length}/${VISION_MODELS.length} batch jobs submitted.`);
  console.log("Run `bun eval/status.ts` to check progress.");
}

main();
```

**Step 2: Run a quick syntax check**

Run: `bunx tsc --noEmit eval/submit.ts --skipLibCheck --moduleResolution bundler --module esnext --target esnext`

Note: this won't fully typecheck due to isolated module context, but catches obvious errors. The real test is running it with actual images later.

**Step 3: Commit**

```bash
git add eval/submit.ts
git commit -m "feat(eval): add batch submit script"
```

---

### Task 5: Create `status.ts` batch status checker

**Files:**
- Create: `eval/status.ts`

**Step 1: Implement the status script**

Create `eval/status.ts`:

```typescript
import { Mistral } from "@mistralai/mistralai";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { PendingJobs } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const RESULTS_DIR = resolve(EVAL_DIR, "results");
const PENDING_PATH = resolve(RESULTS_DIR, "pending-jobs.json");

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
  const client = new Mistral({ apiKey });

  console.log(`Batch submitted at: ${pending.submittedAt}\n`);

  const colModel = 30;
  const colStatus = 22;
  const colProgress = 15;

  const header = `${"Model".padEnd(colModel)} ${"Status".padEnd(colStatus)} ${"Progress".padEnd(colProgress)}`;
  console.log(header);
  console.log("─".repeat(header.length));

  let allDone = true;

  for (const { model, jobId } of pending.jobs) {
    try {
      const job = await client.batch.jobs.get({ jobId });
      const progress = `${job.succeededRequests + job.failedRequests}/${job.totalRequests}`;
      const status = job.status;
      if (status !== "SUCCESS" && status !== "FAILED" && status !== "CANCELLED") {
        allDone = false;
      }
      console.log(`${model.padEnd(colModel)} ${status.padEnd(colStatus)} ${progress.padEnd(colProgress)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${model.padEnd(colModel)} ${"ERROR".padEnd(colStatus)} ${msg}`);
      allDone = false;
    }
  }

  console.log("");
  if (allDone) {
    console.log("All jobs complete. Run `bun eval/results.ts` to score.");
  } else {
    console.log("Some jobs still running. Check again shortly.");
  }
}

main();
```

**Step 2: Commit**

```bash
git add eval/status.ts
git commit -m "feat(eval): add batch status checker"
```

---

### Task 6: Create `results.ts` scoring and reporting script

**Files:**
- Create: `eval/results.ts`

**Step 1: Implement the results script**

Create `eval/results.ts`:

```typescript
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

function parseResponseContent(content: unknown): { artist: string | null; title: string | null } | null {
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
  const sorted = Object.entries(report.results).sort(([, a], [, b]) => b.summary.overall - a.summary.overall);

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
```

**Step 2: Commit**

```bash
git add eval/results.ts
git commit -m "feat(eval): add results scoring and reporting script"
```

---

### Task 7: Add eval npm scripts to package.json

**Files:**
- Modify: `package.json`

**Step 1: Add scripts**

Add to the `"scripts"` section of `package.json`:

```json
"eval:submit": "bun eval/submit.ts",
"eval:status": "bun eval/status.ts",
"eval:results": "bun eval/results.ts"
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "feat(eval): add eval npm scripts"
```

---

### Task 8: Add .gitignore rules for eval results

**Files:**
- Modify: `.gitignore`

**Step 1: Add rules**

Append to `.gitignore`:

```
# Eval results (generated, may contain large output)
eval/results/*.json
!eval/results/.gitkeep
```

Create `eval/results/.gitkeep` so the directory is tracked.

**Step 2: Commit**

```bash
touch eval/results/.gitkeep
git add .gitignore eval/results/.gitkeep
git commit -m "chore: gitignore eval result files"
```

---

### Task 9: Add first test case to the manifest

This is a manual step. The user should:

1. Place an album cover image in `eval/fixtures/images/` (e.g., `radiohead-ok-computer.jpg`)
2. Update `eval/fixtures/manifest.json` with the expected data

Example after adding:

```json
{
  "cases": [
    {
      "id": "radiohead-ok-computer",
      "image": "images/radiohead-ok-computer.jpg",
      "artist": "Radiohead",
      "title": "OK Computer"
    }
  ]
}
```

Then run the full workflow:

```bash
bun eval:submit    # Submit batch jobs
bun eval:status    # Check if they're done
bun eval:results   # Score and compare
```

---

### Task 10: Run all tests to verify nothing is broken

**Step 1: Run unit tests**

Run: `bun test`
Expected: All existing tests PASS, new scoring tests PASS

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

**Step 3: Run lint**

Run: `bun run lint`
Expected: Clean
