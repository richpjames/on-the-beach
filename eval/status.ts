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
      console.log(
        `${model.padEnd(colModel)} ${status.padEnd(colStatus)} ${progress.padEnd(colProgress)}`,
      );
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
