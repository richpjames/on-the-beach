import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

// The layer boundaries live in .oxlintrc.json, which covers every .ts file in
// domain/, ports/, app/, adapters/, server/, src/lib and src/ui. It does not
// cover .svelte, because oxlint doesn't parse it — a component with a server
// import inside <script> lints clean. This closes that one gap; delete it if
// oxlint learns Svelte. It also guards the Stryker↔Bun integration
// (scripts/stryker-bun/), whose .mjs file oxlint may not lint: that folder is
// self-contained tooling and must never import app code.

const repoRoot = resolve(import.meta.dir, "../..");

function svelteFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFilesUnder(full, out);
    else if (entry.endsWith(".svelte")) out.push(full);
  }
  return out;
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

const SPECIFIER = /(?:from\s+|import\s*\(\s*)(["'])([^"']+)\1/g;

describe("client components do not pull in server modules", () => {
  test("no .svelte file in src/lib or src/ui imports from server/", () => {
    // src/routes is excluded deliberately: a +page.svelte is allowed to name a
    // type from server/, and SvelteKit strips it. Components are not.
    const serverDir = join(repoRoot, "server");
    const offenders: string[] = [];

    for (const dir of ["src/lib", "src/ui"]) {
      for (const file of svelteFilesUnder(join(repoRoot, dir))) {
        for (const [, , specifier] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
          if (!specifier.startsWith(".")) continue;
          const target = resolve(dirname(file), specifier);
          if (target === serverDir || target.startsWith(serverDir + "/")) {
            offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
          }
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});

describe("the Stryker↔Bun integration never imports app code", () => {
  test("scripts/stryker-bun imports only its own folder and builtins", () => {
    // The runner and harness are tooling, not a layer: if they ever import
    // domain/, app/, adapters/, server/, src/, eval/ or tests/, the repo's
    // refactorings start breaking mutation testing and vice versa. Relative
    // imports must stay inside the folder; $lib/$app/$env aliases would reach
    // src/ without a relative path, so they are banned outright. Everything
    // else (node:*, bun:*, @stryker-mutator/*) is outside the repo by design.
    const toolDir = join(repoRoot, "scripts", "stryker-bun");
    const offenders: string[] = [];

    for (const file of filesUnder(toolDir)) {
      for (const [, , specifier] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (target !== toolDir && !target.startsWith(toolDir + "/")) {
            offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
          }
        } else if (/^\$(lib|app|env)(\/|$)/.test(specifier)) {
          offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
        }
      }
    }

    expect(offenders.sort()).toEqual([]);
  });
});
