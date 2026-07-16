import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { appSettings, itemSuggestions, musicItems } from "./db/schema";

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

// ---------------------------------------------------------------------------
// Release length preference
// ---------------------------------------------------------------------------

/** Whether "you might also like" suggestions favour longer or shorter releases. */
export type ReleaseLengthPreference = "longer" | "shorter";

export const RELEASE_LENGTH_PREFERENCES: readonly ReleaseLengthPreference[] = ["longer", "shorter"];

export function isReleaseLengthPreference(value: unknown): value is ReleaseLengthPreference {
  return (
    typeof value === "string" && (RELEASE_LENGTH_PREFERENCES as readonly string[]).includes(value)
  );
}

const RELEASE_LENGTH_PREFERENCE_KEY = "release_length_preference";
const DEFAULT_RELEASE_LENGTH_PREFERENCE: ReleaseLengthPreference = "longer";

/** The release length currently favoured when picking suggestions. */
export async function getReleaseLengthPreference(): Promise<ReleaseLengthPreference> {
  const value = await getSetting(RELEASE_LENGTH_PREFERENCE_KEY);
  return isReleaseLengthPreference(value) ? value : DEFAULT_RELEASE_LENGTH_PREFERENCE;
}

/**
 * Set the release length preference. When it actually changes, discards
 * pending (not yet accepted/dismissed) suggestions — they were picked under
 * the old preference — so the next prefetch/sweep re-picks under the new one.
 * Returns whether the value changed.
 */
export async function setReleaseLengthPreference(
  preference: ReleaseLengthPreference,
): Promise<{ changed: boolean }> {
  const current = await getReleaseLengthPreference();
  if (current === preference) {
    return { changed: false };
  }

  await putSetting(RELEASE_LENGTH_PREFERENCE_KEY, preference);
  await db.delete(itemSuggestions).where(eq(itemSuggestions.status, "pending"));
  return { changed: true };
}
