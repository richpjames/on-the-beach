import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { appSettings, musicItems } from "./db/schema";

// ---------------------------------------------------------------------------
// App settings (key/value, global — this is a single-user app)
// ---------------------------------------------------------------------------

/** Streaming service used for secondary-link lookups. */
export type LookupService = "apple_music" | "spotify";

export const LOOKUP_SERVICES: readonly LookupService[] = ["apple_music", "spotify"];

export function isLookupService(value: unknown): value is LookupService {
  return typeof value === "string" && (LOOKUP_SERVICES as readonly string[]).includes(value);
}

const LOOKUP_SERVICE_KEY = "lookup_service";
const DEFAULT_LOOKUP_SERVICE: LookupService = "apple_music";

async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function putSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** The streaming service currently used for secondary-link lookups. */
export async function getLookupService(): Promise<LookupService> {
  const value = await getSetting(LOOKUP_SERVICE_KEY);
  return isLookupService(value) ? value : DEFAULT_LOOKUP_SERVICE;
}

/**
 * Set the active lookup service. When it actually changes, clears the
 * `apple_music_lookup_at` marker on every item so they're re-queried against
 * the newly selected service on next view / backfill (re-lookup on switch).
 * Returns whether the value changed.
 */
export async function setLookupService(service: LookupService): Promise<{ changed: boolean }> {
  const current = await getLookupService();
  if (current === service) {
    return { changed: false };
  }

  await putSetting(LOOKUP_SERVICE_KEY, service);
  // Re-lookup on switch: clear every item's attempt marker.
  await db.update(musicItems).set({ lookupAttemptedAt: null });
  return { changed: true };
}
