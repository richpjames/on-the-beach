# Reverse Image Search Eval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evaluate how Google Vision reverse image search improves album recognition accuracy for low-confidence cases, by first splitting confidence into per-field scores and then building an eval pipeline against fixtures seeded from the live database.

**Architecture:** Split `ScanResult.confidence` into `artistConfidence` + `titleConfidence` so each field can be evaluated independently. Seed the eval manifest from live DB items (with a review step to filter bad ground truth). Then run a script that does first-pass vision scan, identifies low-confidence cases, runs Google Vision + Mistral second pass, and scores improvement against ground truth.

**Tech Stack:** Bun, TypeScript, Drizzle ORM (bun:sqlite), Mistral AI SDK, Google Vision REST API, existing `eval/scoring.ts`

---

### Task 1: Update `ScanResult` type — split `confidence` into two fields

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Write the failing test**

In `tests/unit/scan-parser.test.ts`, update the existing `"parses valid JSON with artist and title"` test and add new ones. Replace the existing confidence tests with:

```ts
test("parses valid JSON with artist and title", () => {
  expect(parseScanJson('{"artist":"Radiohead","title":"OK Computer"}')).toEqual({
    artist: "Radiohead",
    title: "OK Computer",
    artistConfidence: 0,
    titleConfidence: 0,
  });
});

test("parses per-field confidence when present", () => {
  expect(
    parseScanJson(
      '{"artist":"Radiohead","title":"OK Computer","artistConfidence":0.95,"titleConfidence":0.7}',
    ),
  ).toEqual({
    artist: "Radiohead",
    title: "OK Computer",
    artistConfidence: 0.95,
    titleConfidence: 0.7,
  });
});

test("clamps artistConfidence and titleConfidence to [0, 1]", () => {
  expect(
    parseScanJson('{"artist":"X","title":"Y","artistConfidence":1.5,"titleConfidence":-0.5}'),
  ).toEqual({
    artist: "X",
    title: "Y",
    artistConfidence: 1,
    titleConfidence: 0,
  });
});
```

Remove the old `"parses confidence when present"` and `"clamps confidence to [0, 1]"` tests.

**Step 2: Run tests to verify they fail**

```bash
bun run test:unit 2>&1 | grep -E "FAIL|PASS|confidence"
```

Expected: failures referencing `confidence`, `artistConfidence`, `titleConfidence`.

**Step 3: Update `ScanResult` in `src/types/index.ts`**

Replace:
```ts
export interface ScanResult {
  artist: string | null;
  title: string | null;
  confidence: number;
  // Optional fields populated by MusicBrainz enrichment...
```
With:
```ts
export interface ScanResult {
  artist: string | null;
  title: string | null;
  artistConfidence: number;
  titleConfidence: number;
  // Optional fields populated by MusicBrainz enrichment...
```

**Step 4: Run typecheck to find all broken callsites**

```bash
bun run typecheck 2>&1 | head -50
```

Note every file listed — the next tasks fix them.

**Step 5: Commit (type change only — tests still failing)**

```bash
git add src/types/index.ts
git commit -m "feat: split ScanResult.confidence into artistConfidence + titleConfidence"
```

---

### Task 2: Update `scan-parser.ts` to parse per-field confidence

**Files:**
- Modify: `server/scan-parser.ts`
- Test: `tests/unit/scan-parser.test.ts` (already updated in Task 1)

**Step 1: Update `parseScanJson` in `server/scan-parser.ts`**

Replace the confidence parsing block:
```ts
const confidence =
  typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;

return { artist, title, confidence };
```
With:
```ts
const artistConfidence =
  typeof parsed.artistConfidence === "number"
    ? Math.max(0, Math.min(1, parsed.artistConfidence))
    : 0;
const titleConfidence =
  typeof parsed.titleConfidence === "number"
    ? Math.max(0, Math.min(1, parsed.titleConfidence))
    : 0;

return { artist, title, artistConfidence, titleConfidence };
```

**Step 2: Run parser tests**

```bash
bun run test:unit --testPathPattern scan-parser
```

Expected: all pass.

**Step 3: Commit**

```bash
git add server/scan-parser.ts tests/unit/scan-parser.test.ts
git commit -m "feat: parse artistConfidence and titleConfidence in scan-parser"
```

---

### Task 3: Update `vision.ts` prompts and OCR schema for per-field confidence

**Files:**
- Modify: `server/vision.ts`

**Step 1: Update the two scan prompts**

Replace `SCAN_PROMPT`:
```ts
const SCAN_PROMPT =
  "You are reading a photo of a music release cover. Respond with JSON only using keys artist, title, artistConfidence, and titleConfidence. " +
  "artistConfidence and titleConfidence are numbers from 0 to 1 reflecting your certainty about each extracted field independently. " +
  'If uncertain about a field, use null for its value and a low confidence score. Example: {"artist":"Radiohead","title":"OK Computer","artistConfidence":0.95,"titleConfidence":0.9}';
```

Replace `WEB_CONTEXT_PROMPT`:
```ts
const WEB_CONTEXT_PROMPT =
  "You are reading a photo of a music release cover. Web search results for this image are provided below to help identify the release. " +
  "Respond with JSON only using keys artist, title, artistConfidence, and titleConfidence. " +
  "artistConfidence and titleConfidence are numbers from 0 to 1 reflecting your certainty about each extracted field independently. " +
  'If uncertain about a field, use null for its value and a low confidence score. Example: {"artist":"Radiohead","title":"OK Computer","artistConfidence":0.95,"titleConfidence":0.9}';
```

Replace `OCR_SCHEMA` properties:
```ts
properties: {
  artist: { type: ["string", "null"] },
  title: { type: ["string", "null"] },
  artistConfidence: { type: "number" },
  titleConfidence: { type: "number" },
},
required: ["artist", "title", "artistConfidence", "titleConfidence"],
```

**Step 2: Run typecheck**

```bash
bun run typecheck 2>&1 | grep vision
```

Expected: no errors in vision.ts.

**Step 3: Commit**

```bash
git add server/vision.ts
git commit -m "feat: update vision prompts and schema for per-field confidence"
```

---

### Task 4: Update `scan-enricher.ts` and its tests

**Files:**
- Modify: `server/scan-enricher.ts`
- Modify: `tests/unit/scan-enricher.test.ts`

**Step 1: Update the test fixtures in `tests/unit/scan-enricher.test.ts`**

Replace all `ScanResult` fixtures that use `confidence:` with `artistConfidence:` + `titleConfidence:`. Example:

```ts
const highConfidenceResult: ScanResult = {
  artist: "Radiohead",
  title: "OK Computer",
  artistConfidence: 0.95,
  titleConfidence: 0.95,
};
const lowConfidenceResult: ScanResult = {
  artist: "Radiohead",
  title: "OK Computer",
  artistConfidence: 0.5,
  titleConfidence: 0.5,
};
```

Update all inline `ScanResult` objects in the tests similarly (there are several — `noArtist`, `noTitle`, `secondPassResult`).

Update the `toEqual` assertions that check `confidence:` → `artistConfidence:` + `titleConfidence:`.

**Step 2: Run enricher tests to verify they fail**

```bash
bun run test:unit --testPathPattern scan-enricher
```

Expected: type errors or assertion failures.

**Step 3: Update `scan-enricher.ts` threshold check**

Replace:
```ts
if (firstPass.confidence >= CONFIDENCE_THRESHOLD) {
```
With:
```ts
if (
  firstPass.artistConfidence >= CONFIDENCE_THRESHOLD &&
  firstPass.titleConfidence >= CONFIDENCE_THRESHOLD
) {
```

**Step 4: Run enricher tests**

```bash
bun run test:unit --testPathPattern scan-enricher
```

Expected: all pass.

**Step 5: Commit**

```bash
git add server/scan-enricher.ts tests/unit/scan-enricher.test.ts
git commit -m "feat: use per-field confidence threshold in scan-enricher"
```

---

### Task 5: Fix remaining callsites — `scripts/test-scan-pipeline.ts`

**Files:**
- Modify: `scripts/test-scan-pipeline.ts`

**Step 1: Update the confidence check**

Replace:
```ts
if (first && first.confidence < 0.8) {
```
With:
```ts
if (
  first &&
  (first.artistConfidence < 0.8 || first.titleConfidence < 0.8)
) {
```

**Step 2: Run typecheck to confirm clean**

```bash
bun run typecheck
```

Expected: no errors.

**Step 3: Run all unit tests**

```bash
bun run test:unit
```

Expected: all pass.

**Step 4: Commit**

```bash
git add scripts/test-scan-pipeline.ts
git commit -m "fix: update test-scan-pipeline to use per-field confidence"
```

---

### Task 6: Build `eval/seed-from-db.ts` — extract live DB images into eval fixtures

**Files:**
- Create: `eval/seed-from-db.ts`

This script queries the live database for all music items with artwork, downloads each image (remote URL or copies local file), and writes a `pending-review.json` for human review. It skips items already in `manifest.json`.

**Step 1: Write `eval/seed-from-db.ts`**

```ts
#!/usr/bin/env bun
// Extracts music items from the live DB and seeds eval/fixtures/pending-review.json.
// Review pending-review.json then run eval/merge-reviewed.ts to add approved entries.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { db } from "../server/db/index";
import { musicItems, artists } from "../server/db/schema";
import { eq } from "drizzle-orm";
import type { EvalManifest } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const IMAGES_DIR = resolve(FIXTURES_DIR, "images");
const MANIFEST_PATH = resolve(FIXTURES_DIR, "manifest.json");
const PENDING_PATH = resolve(FIXTURES_DIR, "pending-review.json");
const UPLOADS_DIR = resolve(import.meta.dir, "../uploads");

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isGeneric(value: string | null): boolean {
  if (!value) return true;
  const lower = value.toLowerCase().trim();
  return (
    lower === "unknown" ||
    lower === "unknown artist" ||
    lower === "untitled" ||
    lower === "various" ||
    lower === "various artists" ||
    lower === "va" ||
    lower.startsWith("[") ||
    lower.length < 2
  );
}

function loadExistingIds(): Set<string> {
  if (!existsSync(MANIFEST_PATH)) return new Set();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as EvalManifest;
  return new Set(manifest.cases.map((c) => c.id));
}

async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(IMAGES_DIR, { recursive: true });

  const existingIds = loadExistingIds();

  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artworkUrl: musicItems.artworkUrl,
      artistName: artists.name,
      musicbrainzReleaseId: musicItems.musicbrainzReleaseId,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .where(eq(musicItems.artworkUrl, musicItems.artworkUrl)); // all rows with artworkUrl

  const pending: Array<{
    id: string;
    image: string;
    artist: string;
    title: string;
    flag?: string;
  }> = [];

  let skipped = 0;
  let downloaded = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.artworkUrl) { skipped++; continue; }

    const id = slugify(`${row.artistName ?? "unknown"}-${row.title}`);
    if (existingIds.has(id)) { skipped++; continue; }

    const ext = row.artworkUrl.match(/\.(jpe?g|png|webp)(\?|$)/i)?.[1] ?? "jpg";
    const imageFilename = `db-${row.id}.${ext}`;
    const imageDest = resolve(IMAGES_DIR, imageFilename);

    let saved = false;
    if (row.artworkUrl.startsWith("/uploads/")) {
      const localFile = resolve(UPLOADS_DIR, basename(row.artworkUrl));
      if (existsSync(localFile)) {
        copyFileSync(localFile, imageDest);
        saved = true;
      }
    } else if (row.artworkUrl.startsWith("http")) {
      saved = await downloadImage(row.artworkUrl, imageDest);
    }

    if (!saved) {
      console.warn(`  ✗ Could not fetch image for item ${row.id} (${row.artworkUrl})`);
      failed++;
      continue;
    }

    const entry: (typeof pending)[number] = {
      id,
      image: `images/${imageFilename}`,
      artist: row.artistName ?? "",
      title: row.title,
    };

    const flag =
      !row.artistName ? "missing-artist" :
      isGeneric(row.artistName) ? "generic-artist" :
      isGeneric(row.title) ? "generic-title" :
      !row.musicbrainzReleaseId ? "no-musicbrainz" :
      undefined;

    if (flag) entry.flag = flag;

    pending.push(entry);
    downloaded++;
    console.log(`  ${flag ? "⚠" : "✓"} [${id}]${flag ? ` (${flag})` : ""}`);
  }

  writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));

  console.log(`\nDone. ${downloaded} entries written to eval/fixtures/pending-review.json`);
  console.log(`${skipped} skipped (no artwork or already in manifest), ${failed} failed to fetch.`);
  console.log(`\nReview pending-review.json, then run: bun eval/merge-reviewed.ts`);
}

main();
```

**Step 2: Run the script against the live DB (dry-run check)**

```bash
bun eval/seed-from-db.ts 2>&1 | head -30
```

Expected: output listing items with ✓ or ⚠ flags, then a summary line.

**Step 3: Inspect the output**

```bash
cat eval/fixtures/pending-review.json | head -60
```

Review flagged entries and delete or fix any that look wrong directly in `pending-review.json`.

**Step 4: Commit**

```bash
git add eval/seed-from-db.ts
git commit -m "feat: add eval/seed-from-db script to extract live DB items into eval fixtures"
```

---

### Task 7: Build `eval/merge-reviewed.ts` — merge approved entries into manifest

**Files:**
- Create: `eval/merge-reviewed.ts`

**Step 1: Write `eval/merge-reviewed.ts`**

```ts
#!/usr/bin/env bun
// Merges approved entries from eval/fixtures/pending-review.json into eval/fixtures/manifest.json.
// Entries with a "flag" field are skipped unless --include-flagged is passed.
// Usage: bun eval/merge-reviewed.ts [--include-flagged]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { EvalManifest, EvalCase } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const MANIFEST_PATH = resolve(FIXTURES_DIR, "manifest.json");
const PENDING_PATH = resolve(FIXTURES_DIR, "pending-review.json");

const includeFlagged = process.argv.includes("--include-flagged");

if (!existsSync(PENDING_PATH)) {
  console.error("No pending-review.json found. Run bun eval/seed-from-db.ts first.");
  process.exit(1);
}

const pending = JSON.parse(readFileSync(PENDING_PATH, "utf-8")) as Array<
  EvalCase & { flag?: string }
>;

const manifest: EvalManifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"))
  : { cases: [] };

const existingIds = new Set(manifest.cases.map((c) => c.id));

let added = 0;
let skipped = 0;

for (const entry of pending) {
  if (existingIds.has(entry.id)) {
    console.log(`  ~ skipping duplicate: ${entry.id}`);
    skipped++;
    continue;
  }
  if (entry.flag && !includeFlagged) {
    console.log(`  ⚠ skipping flagged (${entry.flag}): ${entry.id}`);
    skipped++;
    continue;
  }
  const { flag: _flag, ...clean } = entry;
  manifest.cases.push(clean);
  existingIds.add(entry.id);
  console.log(`  ✓ added: ${entry.id}`);
  added++;
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(`\nAdded ${added} entries to manifest.json (${skipped} skipped).`);
```

**Step 2: Run merge against pending-review.json**

```bash
bun eval/merge-reviewed.ts
```

Expected: lists added/skipped entries and updated manifest.

**Step 3: Verify manifest grew**

```bash
cat eval/fixtures/manifest.json | bun -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).cases.length + ' cases')"
```

**Step 4: Commit**

```bash
git add eval/merge-reviewed.ts eval/fixtures/manifest.json eval/fixtures/pending-review.json
git commit -m "feat: add eval/merge-reviewed script and seed manifest from live DB"
```

---

### Task 8: Build `eval/reverse-image-search.ts` — the full eval

**Files:**
- Create: `eval/reverse-image-search.ts`

This script runs each manifest case through the full two-pass pipeline and scores improvement from reverse image search.

**Step 1: Write `eval/reverse-image-search.ts`**

```ts
#!/usr/bin/env bun
// Evaluates Google Vision reverse image search improvement on low-confidence cases.
// Usage: bun eval/reverse-image-search.ts [--threshold 0.8] [--limit 20]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../server/vision";
import { getWebContext } from "../server/google-vision";
import { scoreResult } from "./scoring";
import type { EvalManifest, EvalCase } from "./types";
import type { ScanResult } from "../src/types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");

const args = process.argv.slice(2);
const threshold = parseFloat(args[args.indexOf("--threshold") + 1] ?? "0.8");
const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1]) : Infinity;
const delayMs = args.includes("--delay") ? parseInt(args[args.indexOf("--delay") + 1]) : 500;

function loadManifest(): EvalManifest {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8"));
}

function imageToBase64(imagePath: string): string {
  const fullPath = resolve(FIXTURES_DIR, imagePath);
  return readFileSync(fullPath).toString("base64");
}

function isLowConfidence(result: ScanResult, t: number): boolean {
  return result.artistConfidence < t || result.titleConfidence < t;
}

interface CaseResult {
  id: string;
  expected: { artist: string; title: string };
  firstPass: {
    artist: string | null;
    title: string | null;
    artistConfidence: number;
    titleConfidence: number;
    scores: ReturnType<typeof scoreResult>;
  };
  webContext: string | null;
  secondPass: {
    artist: string | null;
    title: string | null;
    artistConfidence: number;
    titleConfidence: number;
    scores: ReturnType<typeof scoreResult>;
  } | null;
  improved: boolean | null; // null = not attempted
}

async function main() {
  if (!process.env.MISTRAL_API_KEY) {
    console.error("MISTRAL_API_KEY is required");
    process.exit(1);
  }
  if (!process.env.GOOGLE_VISION_API_KEY) {
    console.error("GOOGLE_VISION_API_KEY is required");
    process.exit(1);
  }

  const manifest = loadManifest();
  const cases = manifest.cases.slice(0, isFinite(limit) ? limit : undefined);

  console.log(`Running ${cases.length} cases (threshold: ${threshold})...\n`);

  const results: CaseResult[] = [];

  for (const testCase of cases) {
    process.stdout.write(`  [${testCase.id}] `);
    const base64 = imageToBase64(testCase.image);

    const firstPassRaw = await extractReleaseInfo(base64);
    if (!firstPassRaw) {
      console.log("✗ first pass returned null");
      continue;
    }

    const firstScores = scoreResult(firstPassRaw, testCase);
    const low = isLowConfidence(firstPassRaw, threshold);

    const entry: CaseResult = {
      id: testCase.id,
      expected: { artist: testCase.artist, title: testCase.title },
      firstPass: { ...firstPassRaw, scores: firstScores },
      webContext: null,
      secondPass: null,
      improved: null,
    };

    if (!low) {
      console.log(`✓ high confidence (a:${firstPassRaw.artistConfidence.toFixed(2)} t:${firstPassRaw.titleConfidence.toFixed(2)})`);
      results.push(entry);
      continue;
    }

    process.stdout.write(`⚠ low confidence (a:${firstPassRaw.artistConfidence.toFixed(2)} t:${firstPassRaw.titleConfidence.toFixed(2)}) → web context... `);

    const webContext = await getWebContext(base64);
    entry.webContext = webContext;

    if (!webContext) {
      console.log("no web context");
      results.push(entry);
      continue;
    }

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const secondPassRaw = await extractReleaseInfoFromWebContext(base64, webContext);
    if (!secondPassRaw) {
      console.log("second pass null");
      results.push(entry);
      continue;
    }

    const secondScores = scoreResult(secondPassRaw, testCase);
    entry.secondPass = { ...secondPassRaw, scores: secondScores };

    const firstOverall = (firstScores.artistFuzzy + firstScores.titleFuzzy) / 2;
    const secondOverall = (secondScores.artistFuzzy + secondScores.titleFuzzy) / 2;
    entry.improved = secondOverall > firstOverall;

    console.log(
      `${entry.improved ? "↑ improved" : secondOverall === firstOverall ? "→ same" : "↓ worse"} (${firstOverall.toFixed(2)} → ${secondOverall.toFixed(2)})`,
    );

    results.push(entry);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // Summary
  const lowConfidenceCases = results.filter((r) => r.secondPass !== null || r.webContext !== null);
  const attempted = results.filter((r) => r.secondPass !== null);
  const improved = attempted.filter((r) => r.improved === true);
  const worse = attempted.filter((r) => r.improved === false);

  console.log(`\n--- Summary ---`);
  console.log(`Total cases: ${results.length}`);
  console.log(`Low confidence: ${lowConfidenceCases.length}`);
  console.log(`Second pass attempted: ${attempted.length}`);
  console.log(`Improved: ${improved.length} (${((improved.length / Math.max(1, attempted.length)) * 100).toFixed(0)}%)`);
  console.log(`Worse: ${worse.length}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = resolve(RESULTS_DIR, `reverse-image-search-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ threshold, results }, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

main();
```

**Step 2: Run the eval with a small limit first**

```bash
MISTRAL_API_KEY=... GOOGLE_VISION_API_KEY=... bun eval/reverse-image-search.ts --limit 5 --delay 1000
```

Expected: output showing per-case results and a summary, JSON written to `eval/results/`.

**Step 3: Commit**

```bash
git add eval/reverse-image-search.ts
git commit -m "feat: add eval/reverse-image-search to measure Google Vision improvement on low-confidence cases"
```

---

## Running the Full Workflow

```bash
# 1. Seed from live DB
bun eval/seed-from-db.ts

# 2. Review pending-review.json — delete any bad entries

# 3. Merge approved entries into manifest
bun eval/merge-reviewed.ts

# 4. Run the reverse image search eval
MISTRAL_API_KEY=... GOOGLE_VISION_API_KEY=... bun eval/reverse-image-search.ts --threshold 0.8 --delay 500
```
