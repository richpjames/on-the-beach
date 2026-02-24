import { Mistral } from "@mistralai/mistralai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { VISION_MODELS, type EvalModelConfig } from "./models";
import type { EvalManifest, PendingJobs } from "./types";

const EVAL_DIR = dirname(import.meta.path);
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
const RESULTS_DIR = resolve(EVAL_DIR, "results");

const SCAN_PROMPT =
  "You are reading a photo of a CD or vinyl cover. Respond with JSON only using keys artist and title of the release." +
  'If uncertain, use null values. Example: {"artist":"Radiohead","title":"OK Computer"}';

const OCR_SCHEMA = {
  name: "music_release_scan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      artist: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
    },
    required: ["artist", "title"],
  },
} as const;

function loadManifest(): EvalManifest {
  const raw = readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8");
  return JSON.parse(raw);
}

function imageToDataUri(imagePath: string): string {
  const fullPath = resolve(FIXTURES_DIR, imagePath);
  const buffer = readFileSync(fullPath);
  const ext = extname(imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function buildRequestBody(model: EvalModelConfig, dataUri: string): Record<string, unknown> {
  if (model.kind === "ocr") {
    return {
      model: model.id,
      document: {
        type: "image_url",
        image_url: dataUri,
      },
      document_annotation_format: {
        type: "json_schema",
        json_schema: OCR_SCHEMA,
      },
      document_annotation_prompt: SCAN_PROMPT,
    };
  }

  return {
    model: model.id,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SCAN_PROMPT },
          { type: "image_url", image_url: dataUri },
        ],
      },
    ],
  };
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
  const imageByCaseId = new Map(
    manifest.cases.map((testCase) => [testCase.id, imageToDataUri(testCase.image)]),
  );

  const jobs: PendingJobs["jobs"] = [];

  const CHUNK_SIZE = 20;

  for (const model of VISION_MODELS) {
    const allRequests = manifest.cases.map((testCase) => {
      const dataUri = imageByCaseId.get(testCase.id);
      if (!dataUri) {
        throw new Error(`Missing image data for case ${testCase.id}`);
      }
      return {
        customId: testCase.id,
        body: buildRequestBody(model, dataUri),
      };
    });

    const chunks = [];
    for (let i = 0; i < allRequests.length; i += CHUNK_SIZE) {
      chunks.push(allRequests.slice(i, i + CHUNK_SIZE));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const label = chunks.length > 1 ? ` [chunk ${ci + 1}/${chunks.length}]` : "";
      try {
        const job = await client.batch.jobs.create({
          model: model.id,
          endpoint: model.endpoint,
          requests: chunk,
        });

        jobs.push({
          model: model.id,
          jobId: job.id,
          endpoint: model.endpoint,
          kind: model.kind,
        });

        console.log(`  ✓ ${model.id} (${model.endpoint})${label} → job ${job.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${model.id} (${model.endpoint})${label} → ${msg}`);
      }
    }
  }

  if (jobs.length === 0) {
    console.error("\nNo jobs submitted successfully.");
    process.exit(1);
  }

  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const pending: PendingJobs = { submittedAt: new Date().toISOString(), jobs };
  writeFileSync(resolve(RESULTS_DIR, "pending-jobs.json"), JSON.stringify(pending, null, 2));

  console.log(`\n${jobs.length}/${VISION_MODELS.length} batch jobs submitted.`);
  console.log("Run `bun eval/status.ts` to check progress.");
}

main();
