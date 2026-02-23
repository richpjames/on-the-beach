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

  console.log(
    `Submitting ${manifest.cases.length} cases across ${VISION_MODELS.length} models...\n`,
  );

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
            {
              type: "image_url" as const,
              image_url: `data:image/jpeg;base64,${imageToBase64(c.image)}`,
            },
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
