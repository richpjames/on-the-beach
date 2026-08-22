import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveRelease } from "../../server/release-resolver";
import type { EvalManifest } from "../types";
import { scoreCase, summarise, type CaseScore, type ReturnedIds, type Summary } from "./score";
import { strategies, type ResolutionStrategy } from "./strategies";

// ---------------------------------------------------------------------------
// Release resolution eval
//
// Measures the second stage of the scan pipeline in isolation:
//
//   photo ──[A: vision]──> {artist, title} ──[B: resolver]──> ids | abstain
//
// Run with `--config oracle` the resolver is fed the manifest's verified
// artist/title, which removes vision error and shows the resolver's ceiling.
// Run with `--config e2e` it is fed a vision model's output, replayed from a
// vision-eval results file so a resolver change is measurable without
// re-spending vision API calls. The difference between the two is the loss
// attributable to vision — and exploratory work suggests the resolver, not the
// vision model, is the dominant one.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const hasFlag = (name: string): boolean => args.includes(name);

const strategyFilter = flag("--strategy")
  ?.split(",")
  .map((s) => s.trim().toUpperCase());
const limit = flag("--limit") ? Number.parseInt(flag("--limit")!, 10) : undefined;
const config = (flag("--config") ?? "oracle").toLowerCase();
const visionResultsPath = flag("--vision-results");
const visionStrategyId = flag("--vision-strategy");

if (config !== "oracle" && config !== "e2e") {
  console.error(`--config must be "oracle" or "e2e", got "${config}"`);
  process.exit(1);
}
if (config === "e2e" && !visionResultsPath) {
  console.error("--config e2e needs --vision-results <path to a vision-eval results json>");
  process.exit(1);
}

const HERE = dirname(import.meta.path);
const FIXTURES_DIR = resolve(HERE, "../fixtures");
const RESULTS_DIR = resolve(HERE, "results");
const CACHE_PATH = resolve(RESULTS_DIR, "search-cache.json");

// ---------------------------------------------------------------------------
// Request cache and pacing
//
// The strategies overlap heavily — R1, R2 and R4 all issue the same quoted
// MusicBrainz query — so without a cache a five-strategy run re-asks both
// providers for answers it already has, and at one request per second that is
// the difference between minutes and an hour.
//
// Pacing moves here from the provider gates, which are switched off below.
// Those gates sleep after every call, including one served from cache, which
// would make the cache buy nothing. The harness is single-threaded and serial,
// so it can pace only the requests that actually reach the network.
// ---------------------------------------------------------------------------

process.env.OTB_MB_MIN_REQUEST_GAP_MS = "0";
process.env.OTB_DISCOGS_MIN_REQUEST_GAP_MS = "0";

/**
 * Per-host minimum gap. MusicBrainz's documented allowance is ~1 req/s, but
 * 1.1s measured out at a 503 on roughly a third of a 99-fixture run — the
 * limiter is stricter than the documentation over a sustained sweep. Discogs
 * at 60/min authenticated has been comfortable at 1.1s.
 */
const MIN_GAP_MS: Record<string, number> = { "musicbrainz.org": 1_500 };
const DEFAULT_GAP_MS = 1_100;

/**
 * A 503 from MusicBrainz means "slow down", not "no such record". Retried with
 * backoff rather than surfaced, because a throttled request recorded as an
 * absence is the exact error that put three wrong entries in the manifest —
 * and here it would silently deflate the resolution rate instead.
 */
const RETRY_BACKOFF_MS = [2_000, 5_000, 12_000];

const useCache = !hasFlag("--no-cache");

interface CachedResponse {
  status: number;
  body: string;
}

const cache: Record<string, CachedResponse> =
  useCache && existsSync(CACHE_PATH)
    ? (JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, CachedResponse>)
    : {};

let cacheHits = 0;
let networkCalls = 0;
let retries = 0;
const lastRequestAt = new Map<string, number>();
const realFetch = globalThis.fetch;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const cached = cache[url];
  if (cached) {
    cacheHits += 1;
    return new Response(cached.body, {
      status: cached.status,
      headers: { "content-type": "application/json" },
    });
  }

  const host = new URL(url).host;
  const gap = MIN_GAP_MS[host] ?? DEFAULT_GAP_MS;

  let response: Response | null = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) {
      retries += 1;
      await sleep(RETRY_BACKOFF_MS[attempt - 1]);
    }
    await sleep(gap - (Date.now() - (lastRequestAt.get(host) ?? 0)));
    lastRequestAt.set(host, Date.now());
    networkCalls += 1;
    try {
      response = await realFetch(input, init);
    } catch {
      // A timeout is throttling by another name at this rate. Retry it too,
      // and let the last attempt's failure propagate if it never clears.
      if (attempt === RETRY_BACKOFF_MS.length) throw new Error(`request failed: ${url}`);
      continue;
    }
    if (response.status !== 503 && response.status !== 429) break;
  }

  if (!response) throw new Error(`request failed: ${url}`);
  const body = await response.clone().text();
  // Only successes are cached. A 503 is a fact about the moment, not about the
  // catalogue, and caching one would bake a transient failure into every
  // later run — the same conflation that recorded three fixtures as absent
  // from MusicBrainz when their requests had merely been throttled.
  if (response.ok) cache[url] = { status: response.status, body };
  return response;
}) as typeof fetch;

function saveCache(): void {
  if (!useCache) return;
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const manifest: EvalManifest = JSON.parse(
  readFileSync(resolve(FIXTURES_DIR, "manifest.json"), "utf-8"),
);
const fixtures = limit ? manifest.cases.slice(0, limit) : manifest.cases;

interface VisionResults {
  model?: string;
  strategies?: Record<
    string,
    { results?: Array<{ id?: string; parsed?: { artist?: string; title?: string } }> }
  >;
}

/** What the resolver is fed for a fixture: verified truth, or a model's guess. */
function buildInputs(): Map<string, { artist: string; title: string }> {
  const inputs = new Map<string, { artist: string; title: string }>();
  if (config === "oracle") {
    for (const fixture of fixtures) {
      inputs.set(fixture.id, { artist: fixture.artist, title: fixture.title });
    }
    return inputs;
  }

  const vision = JSON.parse(readFileSync(resolve(visionResultsPath!), "utf-8")) as VisionResults;
  const available = Object.keys(vision.strategies ?? {});
  const chosen = visionStrategyId ?? available[0];
  const results = vision.strategies?.[chosen]?.results;
  if (!results) {
    console.error(
      `No results for vision strategy "${chosen}". Available: ${available.join(", ") || "none"}`,
    );
    process.exit(1);
  }
  for (const result of results) {
    if (!result.id) continue;
    inputs.set(result.id, {
      artist: result.parsed?.artist ?? "",
      title: result.parsed?.title ?? "",
    });
  }
  console.log(`Replaying vision output: ${vision.model ?? "unknown model"}, strategy ${chosen}`);
  return inputs;
}

const inputs = buildInputs();

const selected = strategies.filter((s) => !strategyFilter || strategyFilter.includes(s.id));
if (selected.length === 0) {
  console.error(`No strategies matched. Available: ${strategies.map((s) => s.id).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

interface CaseRecord extends CaseScore {
  input: { artist: string; title: string };
  returned: ReturnedIds;
  status: string;
  errors: string[];
}

async function runStrategy(
  strategy: ResolutionStrategy,
): Promise<{ cases: CaseRecord[]; summary: Summary; failures: number }> {
  const records: CaseRecord[] = [];
  let failures = 0;

  for (const [index, fixture] of fixtures.entries()) {
    const input = inputs.get(fixture.id);
    if (!input) {
      console.warn(`  ${fixture.id}: no input for this fixture, skipped`);
      continue;
    }

    const outcome = await resolveRelease(input, strategy.options);
    if (outcome.status === "failed") failures += 1;

    const returned: ReturnedIds = {
      musicbrainzReleaseGroupId: outcome.ids?.musicbrainzReleaseGroupId ?? null,
      musicbrainzReleaseId: outcome.ids?.musicbrainzReleaseId ?? null,
      discogsMasterId: outcome.ids?.discogsMasterId ?? null,
      discogsReleaseId: outcome.ids?.discogsReleaseId ?? null,
    };
    const score = scoreCase(fixture, returned);
    records.push({
      ...score,
      input,
      returned,
      status: outcome.status,
      errors: outcome.errors.map((e) => `${e.provider}: ${e.message}`),
    });

    process.stdout.write(
      `\r  ${strategy.id}  ${index + 1}/${fixtures.length}  ` +
        `net ${networkCalls} cached ${cacheHits} retried ${retries}   `,
    );
  }
  process.stdout.write("\n");

  return { cases: records, summary: summarise(fixtures, records), failures };
}

function formatRate(value: number): string {
  return Number.isNaN(value) ? "  —  " : `${(value * 100).toFixed(1)}%`;
}

function printReport(strategy: ResolutionStrategy, summary: Summary, failures: number): void {
  console.log(`\nstrategy ${strategy.id}  ${strategy.name}`);
  console.log(`  ${strategy.rationale}`);
  const rows: Array<[string, (t: Summary["mb"]) => string]> = [
    ["resolvable", (t) => String(t.resolvable)],
    ["hit", (t) => String(t.hit)],
    ["false-id", (t) => String(t["false-id"])],
    ["miss", (t) => String(t.miss)],
    ["correct-abstain", (t) => String(t["correct-abstain"])],
    ["resolution rate", (t) => formatRate(t.resolutionRate)],
    ["false-ID rate", (t) => formatRate(t.falseIdRate)],
  ];
  console.log(
    `  ${"".padEnd(18)}${"MB".padStart(8)}${"Discogs".padStart(10)}${"Either".padStart(9)}`,
  );
  for (const [label, read] of rows) {
    console.log(
      `  ${label.padEnd(18)}${read(summary.mb).padStart(8)}` +
        `${read(summary.discogs).padStart(10)}${read(summary.either).padStart(9)}`,
    );
  }
  if (failures > 0) {
    // Not a resolver result. These fixtures were never actually asked about,
    // so the rates above are computed over an incomplete run.
    console.log(`  ⚠ ${failures} fixture(s) had a request that did not complete — rerun to fill.`);
  }
}

const runAt = new Date().toISOString();
const report: Record<string, unknown> = {};

for (const strategy of selected) {
  console.log(`\n▶ ${strategy.id} — ${strategy.name}`);
  const { cases, summary, failures } = await runStrategy(strategy);
  printReport(strategy, summary, failures);
  report[strategy.id] = {
    name: strategy.name,
    options: strategy.options,
    summary,
    failures,
    cases,
  };
  saveCache();
}

mkdirSync(RESULTS_DIR, { recursive: true });
const outputPath = resolve(RESULTS_DIR, `resolution-${config}-${runAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(
  outputPath,
  JSON.stringify({ runAt, config, caseCount: fixtures.length, strategies: report }, null, 2),
);
console.log(`\nWrote ${outputPath}`);
console.log(`Requests: ${networkCalls} network, ${cacheHits} cached, ${retries} retried`);
