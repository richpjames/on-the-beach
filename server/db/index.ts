import { Database } from "bun:sqlite";
import path from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

type AppDatabase = BunSQLiteDatabase<typeof schema>;

let instance: AppDatabase | null = null;

function openDatabase(): AppDatabase {
  const dbPath = process.env.DATABASE_PATH ?? "on_the_beach.db";
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const database = drizzle(sqlite, { schema });

  // Apply any pending migrations on first open (idempotent). Resolved from the
  // working directory (repo root / container WORKDIR) rather than import.meta
  // so the path survives the SvelteKit server bundle.
  migrate(database, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

  // Seed reference data (idempotent — onConflictDoNothing)
  const SEED_SOURCES = [
    { name: "bandcamp", displayName: "Bandcamp", urlPattern: "bandcamp.com" },
    { name: "spotify", displayName: "Spotify", urlPattern: "open.spotify.com" },
    { name: "soundcloud", displayName: "SoundCloud", urlPattern: "soundcloud.com" },
    { name: "youtube", displayName: "YouTube", urlPattern: "youtube.com" },
    { name: "apple_music", displayName: "Apple Music", urlPattern: "music.apple.com" },
    { name: "discogs", displayName: "Discogs", urlPattern: "discogs.com" },
    { name: "tidal", displayName: "Tidal", urlPattern: "tidal.com" },
    { name: "deezer", displayName: "Deezer", urlPattern: "deezer.com" },
    { name: "mixcloud", displayName: "Mixcloud", urlPattern: "mixcloud.com" },
    { name: "nts", displayName: "NTS Radio", urlPattern: "nts.live" },
    { name: "pitchfork", displayName: "Pitchfork", urlPattern: "pitchfork.com" },
    { name: "physical", displayName: "Physical Media", urlPattern: null },
  ] as const;

  for (const source of SEED_SOURCES) {
    database
      .insert(schema.sources)
      .values(source)
      .onConflictDoNothing({ target: schema.sources.name })
      .run();
  }

  return database;
}

function getDatabase(): AppDatabase {
  if (!instance) {
    instance = openDatabase();
  }
  return instance;
}

// The database opens lazily on first query rather than at import time.
// SvelteKit's build imports the server modules while analysing routes (in a
// worker thread, inside the Docker build container where no database file can
// be created) — merely importing this module must not touch the filesystem.
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    const database = getDatabase();
    const value = Reflect.get(database as object, prop, database);
    return typeof value === "function" ? value.bind(database) : value;
  },
  has(_target, prop) {
    return prop in (getDatabase() as object);
  },
});
