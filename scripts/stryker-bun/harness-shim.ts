// Stands in for `bun:test` inside test files during Stryker runs (the rewrite
// happens in harness-preload.ts). Wraps the test-registration APIs so that:
// - every test gets a stable id (`<file>#<registration index>`),
// - Stryker's mutant coverage is attributed to the test being executed
//   (`globalThis.__stryker__.currentTestId`),
// - only the tests covering the active mutant run (test filter),
// - the run stops after the first failure when bailing is allowed.
//
// `bun test` never fires process exit handlers, so results are streamed as
// newline-delimited JSON records instead of written at the end — per-test
// records as tests finish, per-test coverage after each test (and again after
// its afterEach; the last record for an id wins), and cumulative static
// coverage at each file's afterAll. The Node-side plugin reassembles them.
//
// Everything else is re-exported untouched via `export * from "bun:test"`;
// explicit exports below shadow the same names from the star export.
import * as real from "bun:test";
import { appendFileSync } from "node:fs";

type Fn = (...args: any[]) => any;

const RESULT_FILE = process.env.__STRYKER_BUN_RESULT_FILE__;
const FILTER: Set<string> | undefined = process.env.__STRYKER_BUN_TEST_FILTER__
  ? new Set(JSON.parse(process.env.__STRYKER_BUN_TEST_FILTER__))
  : undefined;
const BAIL = process.env.__STRYKER_BUN_BAIL__ === "1";
// Set for 'runtime' mutant activation: the mutant must only be switched on
// once the (unmutated) environment has been imported and tests begin.
const RUNTIME_MUTANT_ID = process.env.__STRYKER_BUN_MUTANT_ID__;

const bailState = { bailed: false };
let activated = false;
let currentFileName = "unknown-file";
const describeStack: string[] = [];
const perFile = new Map<string, { ids: string[]; executed: number }>();

function emit(record: unknown): void {
  if (RESULT_FILE) appendFileSync(RESULT_FILE, `${JSON.stringify(record)}\n`);
}

function fileState(): { ids: string[]; executed: number } {
  let state = perFile.get(currentFileName);
  if (!state) {
    state = { ids: [], executed: 0 };
    perFile.set(currentFileName, state);
  }
  return state;
}

function fullName(name: unknown): string {
  return [...describeStack, String(name)].join(" > ");
}

function strykerNamespace(): Record<string, any> {
  return ((globalThis as Record<string, any>).__stryker__ ??= {});
}

function ensureActivated(): void {
  if (!activated) {
    activated = true;
    if (RUNTIME_MUTANT_ID) strykerNamespace().activeMutant = RUNTIME_MUTANT_ID;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack ?? ""}`.slice(0, 2000);
  }
  return String(error).slice(0, 2000);
}

function emitTestCoverage(id: string | undefined): void {
  if (!id) return;
  const bucket = strykerNamespace().mutantCoverage?.perTest?.[id];
  if (bucket) emit({ kind: "coverage", id, mutants: bucket });
}

// Called at the top of every rewritten test file (injected by the transform),
// so hooks attach to each file's own lifecycle — the shim module itself is
// only evaluated once per process.
export function __strykerFile(file: string): void {
  currentFileName = file;
  perFile.set(file, { ids: [], executed: 0 });
  real.afterAll(() => {
    const coverage = strykerNamespace().mutantCoverage;
    if (coverage) emit({ kind: "static", mutants: coverage.static });
  });
}

function registerTest(rawName: unknown, fn: Fn | undefined, ...rest: unknown[]): unknown {
  const file = currentFileName;
  const state = fileState();
  const id = `${file}#${state.ids.length}`;
  state.ids.push(id);

  if (FILTER && !FILTER.has(id)) {
    // Not selected for this mutant run: keep the suite shape, execute nothing.
    return (real.test.skip as Fn)(rawName as string, fn, ...rest);
  }

  const wrapped = async (...args: unknown[]): Promise<void> => {
    state.executed++;
    if (bailState.bailed) return;
    ensureActivated();
    const start = performance.now();
    const ns = strykerNamespace();
    const previousTestId = ns.currentTestId;
    ns.currentTestId = id;
    try {
      await fn?.(...args);
      emit({
        kind: "test",
        id,
        name: fullName(rawName),
        fileName: file,
        status: "success",
        timeSpentMs: performance.now() - start,
      });
    } catch (error) {
      emit({
        kind: "test",
        id,
        name: fullName(rawName),
        fileName: file,
        status: "failed",
        failureMessage: errorText(error),
        timeSpentMs: performance.now() - start,
      });
      if (BAIL) bailState.bailed = true;
      // Rethrow so bun itself (and its exit code) stay truthful.
      throw error;
    } finally {
      ns.currentTestId = previousTestId;
      // afterEach may add to this test's coverage bucket afterwards; the
      // plugin keeps the last coverage record per id.
      emitTestCoverage(id);
    }
  };
  return (real.test as Fn)(rawName as string, wrapped, ...rest);
}

// beforeEach/afterEach run adjacent to a test, so coverage hits inside them
// are attributed to the upcoming / just-finished test in registration order.
function wrapAdjacentHook(hook: Fn, mode: "before" | "after"): Fn {
  return ((fn: Fn | undefined, ...rest: unknown[]) => {
    if (typeof fn !== "function") return hook(fn, ...rest);
    const hooked = async (...args: unknown[]): Promise<unknown> => {
      const state = fileState();
      const ns = strykerNamespace();
      const previousTestId = ns.currentTestId;
      ensureActivated();
      const adjacentIndex = mode === "before" ? state.executed : state.executed - 1;
      ns.currentTestId = state.ids[adjacentIndex] ?? previousTestId;
      try {
        return await fn(...args);
      } finally {
        ns.currentTestId = previousTestId;
        if (mode === "after") emitTestCoverage(state.ids[state.executed - 1]);
      }
    };
    return hook(hooked as Fn, ...rest);
  }) as Fn;
}

// beforeAll/afterAll coverage cannot be tied to one test; Stryker counts it as
// "static" coverage (covered by every test). They still trigger activation.
function wrapAllHook(hook: Fn): Fn {
  return ((fn: Fn | undefined, ...rest: unknown[]) => {
    if (typeof fn !== "function") return hook(fn, ...rest);
    return hook(
      async (...args: unknown[]) => {
        ensureActivated();
        return fn(...args);
      },
      ...rest,
    );
  }) as Fn;
}

const wrappedDescribe = ((name: unknown, fn: Fn | undefined, ...rest: unknown[]) => {
  describeStack.push(String(name));
  try {
    return (real.describe as Fn)(name, fn, ...rest);
  } finally {
    describeStack.pop();
  }
}) as Fn & Record<string, any>;
// describe.skip/only/if/each keep bun's behaviour; tests registered inside
// their bodies still route through the wrapped `test` above.
Object.assign(wrappedDescribe, real.describe);

const wrappedTest = ((name: unknown, fn: Fn | undefined, ...rest: unknown[]) =>
  registerTest(name, fn, ...rest)) as Fn & Record<string, any>;
Object.assign(wrappedTest, real.test);

wrappedTest.skip = ((name: unknown, fn?: Fn, ...rest: unknown[]) => {
  const file = currentFileName;
  const state = fileState();
  const id = `${file}#${state.ids.length}`;
  state.ids.push(id);
  emit({
    kind: "test",
    id,
    name: fullName(name),
    fileName: file,
    status: "skipped",
    timeSpentMs: 0,
  });
  return (real.test.skip as Fn)(name, fn, ...rest);
}) as Fn;

wrappedTest.todo = ((name: unknown, ...rest: unknown[]) => {
  const file = currentFileName;
  const state = fileState();
  const id = `${file}#${state.ids.length}`;
  state.ids.push(id);
  emit({
    kind: "test",
    id,
    name: fullName(name),
    fileName: file,
    status: "skipped",
    timeSpentMs: 0,
  });
  return (real.test.todo as Fn)(name, ...rest);
}) as Fn;

// test.each: expand the table here so each generated case gets its own wrapped
// registration (printf-style names as used by this suite).
wrappedTest.each =
  (table: unknown[]) =>
  (name: unknown, fn?: Fn, ...rest: unknown[]): void => {
    for (const row of table) {
      const args = Array.isArray(row) ? [...row] : [row];
      let caseName: unknown = name;
      if (typeof name === "string") {
        let argIndex = 0;
        caseName = name.replace(/%[sdifjO%]/g, (specifier) => {
          if (specifier === "%%") return "%";
          const value = args[argIndex++];
          return typeof value === "object" ? JSON.stringify(value) : String(value);
        });
      } else if (typeof name === "function") {
        caseName = (...extra: unknown[]) => (name as Fn)(...args, ...extra);
      }
      registerTest(caseName, (...extra: unknown[]) => fn?.(...args, ...extra), ...rest);
    }
  };

export * from "bun:test";
export const test = wrappedTest;
export const it = wrappedTest;
export const describe = wrappedDescribe;
export const beforeEach = wrapAdjacentHook(real.beforeEach as Fn, "before");
export const afterEach = wrapAdjacentHook(real.afterEach as Fn, "after");
export const beforeAll = wrapAllHook(real.beforeAll as Fn);
export const afterAll = wrapAllHook(real.afterAll as Fn);
