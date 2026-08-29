import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";

// The layer boundaries live in .oxlintrc.json, which covers every .ts file in
// domain/, server/, src/lib and src/ui. It does not cover .svelte, because
// oxlint doesn't parse it — a component with a server import inside <script>
// lints clean. This closes that one gap; delete it if oxlint learns Svelte.

const repoRoot = resolve(import.meta.dir, "../..");

function svelteFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) svelteFilesUnder(full, out);
    else if (entry.endsWith(".svelte")) out.push(full);
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
