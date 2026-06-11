// Preloaded before any unit test module (see bunfig.toml). The drizzle db
// module binds to DATABASE_PATH at first import, and test files that set the
// env var themselves do so too late when another test file has already
// imported the db module. Without this, unit tests fall back to the real
// `on_the_beach.db` in the repo root and leave rows behind, breaking later
// runs (UNIQUE constraints) and polluting dev data.
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = join(
    tmpdir(),
    `on-the-beach-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}
