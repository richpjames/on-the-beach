// Loaded by bunfig.toml's [test] preload list, but inert outside Stryker runs
// (gated on __STRYKER_BUN_HARNESS__, which the test-runner plugin sets on each
// `bun test` it spawns). When active, it rewrites test files' `bun:test`
// imports to point at harness-shim.ts, which gives Stryker per-test results,
// per-test mutant coverage, test filtering and bail-on-failure.
if (process.env.__STRYKER_BUN_HARNESS__) {
  const shimPath = `${import.meta.dir}/harness-shim.ts`;

  // Seed the namespace Stryker's instrumented code talks to
  // (see @stryker-mutator/api/core InstrumenterContext). The hit limit turns
  // runaway mutants into an exception instead of an infinite loop.
  const ns = ((globalThis as Record<string, unknown>).__stryker__ ??= {}) as Record<
    string,
    unknown
  >;
  if (process.env.__STRYKER_BUN_HIT_LIMIT__) {
    ns.hitCount = 0;
    ns.hitLimit = Number(process.env.__STRYKER_BUN_HIT_LIMIT__);
  }

  Bun.plugin({
    name: "stryker-bun-harness",
    setup(build) {
      build.onLoad({ filter: /\.test\.ts$/ }, async (args) => {
        const source = await Bun.file(args.path).text();
        if (!source.includes("bun:test")) return undefined;
        // Tag the file so the shim can build stable per-file test ids and
        // attach its per-file hooks (its module body runs only once).
        const relPath = args.path.replace(`${process.cwd()}/`, "");
        return {
          contents: `import { __strykerFile } from ${JSON.stringify(shimPath)};\n__strykerFile(${JSON.stringify(relPath)});\n${source.replace(
            /from\s+(['"])bun:test\1/g,
            `from ${JSON.stringify(shimPath)}`,
          )}`,
          loader: "ts",
        };
      });
    },
  });
}
