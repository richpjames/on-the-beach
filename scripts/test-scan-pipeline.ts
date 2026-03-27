#!/usr/bin/env bun
// E2E test for the scanning pipeline.
// Usage: MISTRAL_API_KEY=... GOOGLE_VISION_API_KEY=... bun run scripts/test-scan-pipeline.ts <image.jpg>

import { readFileSync } from "node:fs";
import { extractReleaseInfo, extractReleaseInfoFromWebContext } from "../server/vision";
import { getWebContext } from "../server/google-vision";
import { createScanEnricher } from "../server/scan-enricher";
import { lookupRelease } from "../server/musicbrainz";

const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Usage: bun run scripts/test-scan-pipeline.ts <image.jpg>");
  process.exit(1);
}

const base64 = readFileSync(imagePath).toString("base64");

console.log("=== First pass (Mistral OCR) ===");
const first = await extractReleaseInfo(base64);
console.log(first);

if (first && first.confidence < 0.8) {
  console.log("\n=== Web context (Google Vision) ===");
  const ctx = await getWebContext(base64);
  console.log(ctx);

  if (ctx) {
    console.log("\n=== Second pass (Mistral + web context) ===");
    const second = await extractReleaseInfoFromWebContext(base64, ctx);
    console.log(second);
  }
}

console.log("\n=== Full pipeline ===");
const enrich = createScanEnricher(
  extractReleaseInfo,
  lookupRelease,
  getWebContext,
  extractReleaseInfoFromWebContext,
);
const result = await enrich(base64);
console.log(result);
