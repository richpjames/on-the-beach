// Stryker test runner plugin for `bun test`.
//
// Stryker has no Bun-native runner, which previously forced the generic
// command runner: one full-suite run per mutant, no per-test coverage, and
// "no coverage" indistinguishable from "survived". This plugin spawns
// `bun test` per run with the harness from this directory active (see
// harness-preload.ts / harness-shim.ts), which reports per-test results and
// per-test mutant coverage, so Stryker can run only the tests that cover a
// mutant and mark uncovered mutants as "no coverage".
//
// Loaded via `plugins` in stryker.config.json. The environment variables used
// here match the ones the harness reads.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declareClassPlugin, PluginKind, commonTokens, tokens } from "@stryker-mutator/api/plugin";

const HARNESS = "__STRYKER_BUN_HARNESS__";
const RESULT_FILE = "__STRYKER_BUN_RESULT_FILE__";
// Read natively by Stryker's instrumented code (INSTRUMENTER_CONSTANTS).
const ACTIVE_MUTANT = "__STRYKER_ACTIVE_MUTANT__";
const RUNTIME_MUTANT_ID = "__STRYKER_BUN_MUTANT_ID__";
const TEST_FILTER = "__STRYKER_BUN_TEST_FILTER__";
const BAIL = "__STRYKER_BUN_BAIL__";
const HIT_LIMIT = "__STRYKER_BUN_HIT_LIMIT__";

const OUTPUT_LIMIT = 8192;

export class BunTestRunner {
  static inject = tokens(commonTokens.logger);

  /**
   * @param {import('@stryker-mutator/api/logging').Logger} log
   */
  constructor(log) {
    this.log = log;
  }

  capabilities() {
    // Every run is a fresh `bun test` process, so the environment is always
    // reloaded (needed for statically-activated mutants).
    return { reloadEnvironment: true };
  }

  async init() {}

  /**
   * @param {import('@stryker-mutator/api/test-runner').DryRunOptions} options
   * @returns {Promise<import('@stryker-mutator/api/test-runner').DryRunResult>}
   */
  async dryRun(options) {
    const run = await this.#run(options.timeout, {
      [HARNESS]: "1",
      [ACTIVE_MUTANT]: "", // never activate a mutant during a dry run
    });
    if (run.timedOut) {
      return { status: "timeout", reason: "Bun test dry run timed out" };
    }
    if (!run.parsed) {
      return { status: "error", errorMessage: run.outputTail() };
    }
    const tests = run.parsed.tests;
    // A non-zero exit without a failed test means bun died between tests
    // (e.g. a file failed to import). Surface it so Stryker aborts the run
    // instead of silently accepting a partial suite.
    if (run.exitCode !== 0 && !tests.some((t) => t.status === "failed")) {
      tests.push({
        id: `${tests.length}-unhandled`,
        name: "<unhandled error>",
        fileName: "unknown",
        timeSpentMs: 0,
        status: "failed",
        failureMessage: run.outputTail(),
      });
    }
    return {
      status: "complete",
      tests,
      mutantCoverage: run.parsed.mutantCoverage,
    };
  }

  /**
   * @param {import('@stryker-mutator/api/test-runner').MutantRunOptions} options
   * @returns {Promise<import('@stryker-mutator/api/test-runner').MutantRunResult>}
   */
  async mutantRun(options) {
    // Unfiltered runs activate the mutant from process start ('static');
    // filtered runs load the environment unmutated and let the harness switch
    // the mutant on when test execution begins ('runtime').
    const staticActivation = !options.testFilter || options.mutantActivation === "static";
    const run = await this.#run(options.timeout, {
      [HARNESS]: "1",
      [ACTIVE_MUTANT]: staticActivation ? options.activeMutant.id : "",
      ...(staticActivation ? {} : { [RUNTIME_MUTANT_ID]: options.activeMutant.id }),
      ...(options.testFilter ? { [TEST_FILTER]: JSON.stringify(options.testFilter) } : {}),
      ...(options.disableBail ? {} : { [BAIL]: "1" }),
      ...(options.hitLimit != null ? { [HIT_LIMIT]: String(options.hitLimit) } : {}),
    });
    const duration = Date.now() - run.startedAt;
    if (run.timedOut) {
      return { status: "timeout", reason: "Bun test run timed out", duration };
    }
    if (run.parsed) {
      const executed = run.parsed.tests.filter((t) => t.status !== "skipped").length;
      const firstFailure = run.parsed.tests.find((t) => t.status === "failed");
      if (firstFailure) {
        return {
          status: "killed",
          killedBy: [firstFailure.id],
          failureMessage: firstFailure.failureMessage ?? "",
          nrOfTests: executed,
          duration,
        };
      }
      if (run.exitCode !== 0) {
        // bun failed outside of test assertions (unhandled error) — the mutant
        // broke the environment, which counts as killed.
        return {
          status: "killed",
          killedBy: [],
          failureMessage: run.outputTail(),
          nrOfTests: executed,
          duration,
        };
      }
      return { status: "survived", nrOfTests: executed, duration };
    }
    if (run.exitCode !== 0) {
      return {
        status: "killed",
        killedBy: [],
        failureMessage: run.outputTail(),
        nrOfTests: 0,
        duration,
      };
    }
    return { status: "error", errorMessage: run.outputTail() };
  }

  async dispose() {}

  /**
   * Runs `bun test tests/unit` with the harness active and collects its
   * result file, exit code and (bounded) output.
   *
   * @param {number} timeoutMs
   * @param {Record<string, string>} extraEnv
   */
  async #run(timeoutMs, extraEnv) {
    const dir = mkdtempSync(join(tmpdir(), "stryker-bun-"));
    const resultFile = join(dir, "result.json");
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn("bun", ["test", "tests/unit"], {
      cwd: process.cwd(),
      env: { ...process.env, [RESULT_FILE]: resultFile, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += String(chunk);
    });
    const [exitCode, timedOut] = await new Promise((resolve) => {
      let timedOutResolved = false;
      const timer = setTimeout(() => {
        timedOutResolved = true;
        child.kill("SIGKILL");
        resolve([null, true]);
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        stderr += String(error);
        resolve([null, false]);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve([code, timedOutResolved]);
      });
    });
    let parsed = null;
    try {
      const lines = readFileSync(resultFile, "utf8")
        .split("\n")
        .filter((line) => line.trim());
      const tests = new Map();
      const perTest = {};
      let staticCoverage = {};
      for (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // partial trailing line after a kill
        }
        if (record.kind === "test") tests.set(record.id, record);
        else if (record.kind === "coverage") perTest[record.id] = record.mutants;
        else if (record.kind === "static") staticCoverage = record.mutants;
      }
      if (lines.length > 0) {
        parsed = {
          tests: [...tests.values()],
          mutantCoverage: { static: staticCoverage, perTest },
        };
      }
    } catch {
      // No result file: bun was killed or crashed before writing it.
    }
    rmSync(dir, { recursive: true, force: true });
    const combined = () => (stderr.trim() ? stderr : stdout).trim();
    return {
      parsed,
      exitCode,
      timedOut,
      startedAt,
      outputTail: () => combined().slice(-4000),
    };
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.TestRunner, "bun", BunTestRunner)];
