import { db } from "./index";
import { sources } from "./schema";
import { SEED_SOURCES } from "./seed-sources";

/**
 * Explicit re-seed (`bun run db:seed`). The same list runs automatically on
 * first database open in ./index.ts, so this is only needed to repair a
 * database whose reference rows were deleted.
 */
async function seed() {
  console.log("Seeding sources...");
  for (const source of SEED_SOURCES) {
    await db.insert(sources).values(source).onConflictDoNothing({ target: sources.name });
  }
  console.log("Seeding complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
