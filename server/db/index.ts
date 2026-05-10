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
  db.insert(schema.sources)
    .values(source)
    .onConflictDoNothing({ target: schema.sources.name })
    .run();
}
