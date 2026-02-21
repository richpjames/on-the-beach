import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_PATH ?? "on_the_beach.db";
const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");
export const db = drizzle(sqlite, { schema });

// Apply any pending migrations on startup (idempotent)
migrate(db, { migrationsFolder: `${import.meta.dir}/../../drizzle` });
