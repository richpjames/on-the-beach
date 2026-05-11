#!/usr/bin/env bun
/**
 * Read-only prod DB query wrapper, for use by Claude / other agents.
 *
 * Usage:
 *   bun run db:prod -- "SELECT id, title FROM items LIMIT 5"
 *   bun run db:prod -- --help
 *
 * Contract (see --help for the full version):
 *   exit 0  -> stdout: JSON array of rows
 *   exit 2  -> stderr: {"error":"rejected", reason, sql}    (pre-flight refused)
 *   exit 3  -> stderr: {"error":"sqlite",   reason}         (remote sqlite3 errored)
 *   exit 4  -> stderr: {"error":"ssh",      reason}         (transport failure)
 *
 * Env vars (put these in .env.local, gitignored):
 *   PROD_DB_HOST  - ssh host alias (see ~/.ssh/config), e.g. "prod-otb"
 *   PROD_DB_PATH  - absolute path to the DB file on the VPS
 *
 * Safety chain:
 *   1. isQueryAllowed() rejects non-SELECT-shape SQL locally
 *   2. ssh runs `sqlite3 -readonly` so even a bypass cannot write
 *   3. Output capped at MAX_BYTES to avoid dumping huge tables into the agent's context
 */

const MAX_BYTES = 1_000_000; // 1 MB output cap
const TIMEOUT_MS = 30_000;

// ────────────────────────────────────────────────────────────────────────────
// Policy: this is the function you're being asked to write.
//
// Decide which SQL shapes are forwarded to prod and which are refused.
// The tests in tests/unit/db-prod-policy.test.ts define the exact contract
// (run `bun test tests/unit/db-prod-policy.test.ts` to see them fail until
// you implement this).
//
// Things to think through:
//   - First-keyword check vs substring blocklist? Either works; pick one.
//   - How do you spot multi-statement injection like "SELECT 1; DROP ..."?
//     (Trailing semicolon is fine; an embedded one with more SQL after is not.)
//   - Case-insensitivity matters (sqlite keywords aren't case-sensitive).
//   - Reason strings should be short and self-explanatory — an agent reads them.
//
// Return shape is fixed; please don't change it (the tests and the runtime
// both depend on `{ ok: true } | { ok: false; reason: string }`).
// ────────────────────────────────────────────────────────────────────────────
const ALLOWED_FIRST_KEYWORDS = new Set(["select", "with", "explain", "pragma"]);

export function isQueryAllowed(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty query" };
  }

  // A single trailing semicolon is fine; an embedded one means multi-statement.
  const body = trimmed.replace(/\s*;\s*$/, "");
  if (body.includes(";")) {
    return {
      ok: false,
      reason: "multiple statements not allowed (embedded ';' found)",
    };
  }

  const firstKeyword = body.split(/\s+/, 1)[0].toLowerCase();
  if (!ALLOWED_FIRST_KEYWORDS.has(firstKeyword)) {
    return {
      ok: false,
      reason: `only SELECT/WITH/EXPLAIN/PRAGMA allowed; got '${firstKeyword}'`,
    };
  }

  return { ok: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime (you shouldn't need to touch anything below)
// ────────────────────────────────────────────────────────────────────────────

const HELP = `\
db:prod — run a read-only SELECT against the production SQLite DB over SSH.

USAGE
  bun run db:prod -- "<sql>"
  bun run db:prod -- --help

ALLOWED STATEMENTS
  SELECT, WITH, EXPLAIN, PRAGMA (introspection only)

REJECTED
  Anything that writes; multi-statement input; ATTACH; empty input.

ENV
  PROD_DB_HOST  ssh host alias (~/.ssh/config), required
  PROD_DB_PATH  absolute path to the prod DB file, required

OUTPUT
  stdout  JSON array of row objects   (success)
  stderr  single-line JSON error      (failure or truncation warning)

EXIT CODES
  0  ok
  2  rejected by local policy
  3  remote sqlite3 error
  4  ssh / transport error
`;

function emitError(code: 2 | 3 | 4, payload: Record<string, unknown>): never {
  process.stderr.write(JSON.stringify(payload) + "\n");
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sql = args.join(" ").trim();

  const verdict = isQueryAllowed(sql);
  if (!verdict.ok) {
    emitError(2, { error: "rejected", reason: verdict.reason, sql });
  }

  const host = process.env.PROD_DB_HOST;
  const path = process.env.PROD_DB_PATH;
  if (!host || !path) {
    emitError(4, {
      error: "ssh",
      reason: "PROD_DB_HOST and PROD_DB_PATH must be set (try .env.local)",
    });
  }

  // sqlite3 -readonly -json <path> "<sql>"
  // The SQL is passed as a single quoted argv element to avoid the remote
  // shell re-parsing it. We escape single quotes by closing/escaping/reopening
  // the quoted string: ' -> '\''
  const remoteSql = sql.replace(/'/g, `'\\''`);
  const remoteCmd = `sqlite3 -readonly -json '${path}' '${remoteSql}'`;

  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", host, remoteCmd], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  if (exitCode !== 0) {
    // ssh exits with the remote command's exit code if it ran, else its own.
    // sqlite3 errors land on remote stderr; ssh transport errors land on local stderr.
    const looksLikeSqliteError =
      stderrText.includes("Error:") || stderrText.includes("Parse error");
    if (looksLikeSqliteError) {
      emitError(3, { error: "sqlite", reason: stderrText.trim() });
    }
    emitError(4, {
      error: "ssh",
      reason: stderrText.trim() || `ssh exited ${exitCode}`,
    });
  }

  const bytes = Buffer.byteLength(stdoutText, "utf8");
  if (bytes > MAX_BYTES) {
    process.stderr.write(
      JSON.stringify({
        warning: "truncated",
        limit: `${MAX_BYTES} bytes`,
        actual: `${bytes} bytes`,
        hint: "add LIMIT or refine WHERE",
      }) + "\n",
    );
    process.stdout.write(stdoutText.slice(0, MAX_BYTES));
    process.exit(0);
  }

  // sqlite3 -json outputs nothing for zero-row results; normalise to "[]".
  process.stdout.write(stdoutText.length === 0 ? "[]" : stdoutText);
  process.exit(0);
}

// Only run main() when invoked directly (not when imported by tests)
if (import.meta.main) {
  await main();
}
