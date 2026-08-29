import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

// Policy: the app is one package, so nothing at the module-resolution level
// stops a layer importing outward. These checks stand in for the boundary a
// separate package would have given us — they are how we found out that
// fifteen files under server/ had grown imports back into src/types.

const repoRoot = resolve(import.meta.dir, "../..");

const IGNORED_DIRS = new Set(["node_modules", ".svelte-kit", "build", "dist-server"]);

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFilesUnder(full, out);
    else if (/\.(ts|svelte)$/.test(entry)) out.push(full);
  }
  return out;
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*)(["'])([^"']+)\1/g;

/**
 * Relative imports only — bare specifiers resolve to packages, which these
 * rules deliberately say nothing about.
 */
function relativeImportsOf(file: string): Array<{ specifier: string; target: string }> {
  const source = readFileSync(file, "utf8");
  const found: Array<{ specifier: string; target: string }> = [];
  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    if (!specifier.startsWith(".")) continue;
    found.push({ specifier, target: resolve(dirname(file), specifier) });
  }
  return found;
}

/** Import sites crossing out of `fromDir` into `intoDir`, as readable strings. */
function crossings(fromDir: string, intoDir: string): string[] {
  const from = join(repoRoot, fromDir);
  const into = join(repoRoot, intoDir);
  const offenders: string[] = [];

  for (const file of sourceFilesUnder(from)) {
    for (const { specifier, target } of relativeImportsOf(file)) {
      if (target === into || target.startsWith(into + "/")) {
        offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
      }
    }
  }
  return offenders.sort();
}

describe("domain/ is the core", () => {
  test("nothing in domain/ reaches outside it", () => {
    const domain = join(repoRoot, "domain");
    const escapes: string[] = [];

    for (const file of sourceFilesUnder(domain)) {
      for (const { specifier, target } of relativeImportsOf(file)) {
        if (!target.startsWith(domain + "/")) {
          escapes.push(`${relative(repoRoot, file)} imports ${specifier}`);
        }
      }
    }

    expect(escapes).toEqual([]);
  });
});

describe("server/ does not depend on the SvelteKit app", () => {
  test("nothing in server/ imports from src/", () => {
    // The reverse — src/ route loaders calling into server/ — is the correct
    // direction and is deliberately not checked.
    expect(crossings("server", "src")).toEqual([]);
  });
});

describe("client code does not pull in server modules", () => {
  test("nothing in src/lib or src/ui imports from server/", () => {
    // src/routes and src/hooks.server.ts are exempt: those run on the server
    // and calling into server/ is their job.
    expect([...crossings("src/lib", "server"), ...crossings("src/ui", "server")]).toEqual([]);
  });
});
