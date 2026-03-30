import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { EvalCase, EvalManifest } from "./types";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");
const MANIFEST_PATH = join(FIXTURES_DIR, "manifest.json");
const PENDING_PATH = join(FIXTURES_DIR, "pending-review.json");

const includeFlagged = process.argv.includes("--include-flagged");

if (!existsSync(PENDING_PATH)) {
  console.error(
    "Error: eval/fixtures/pending-review.json not found. Run bun eval/seed-from-db.ts first.",
  );
  process.exit(1);
}

interface PendingCase extends EvalCase {
  dbId?: number;
  flag?: string;
}

interface PendingReview {
  generatedAt: string;
  cases: PendingCase[];
}

const pending: PendingReview = JSON.parse(readFileSync(PENDING_PATH, "utf-8"));
const manifest: EvalManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

const existingIds = new Set(manifest.cases.map((c) => c.id));

let added = 0;
let skipped = 0;

for (const entry of pending.cases) {
  if (entry.flag && !includeFlagged) {
    console.log(`~ skipping flagged (${entry.flag}): ${entry.id}`);
    skipped++;
    continue;
  }

  if (existingIds.has(entry.id)) {
    console.log(`~ skipping duplicate: ${entry.id}`);
    skipped++;
    continue;
  }

  const { dbId: _dbId, flag: _flag, ...evalCase } = entry;
  manifest.cases.push(evalCase);
  existingIds.add(entry.id);
  console.log(`✓ added: ${entry.id}`);
  added++;
}

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

console.log(`\nAdded ${added} entries to manifest.json (${skipped} skipped).`);
