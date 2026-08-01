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

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function putSetting(key: string, value: string): Promise<void> {
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

// ---------------------------------------------------------------------------
// Artist watch / new-release alerts
// ---------------------------------------------------------------------------

export const ARTIST_WATCH_KEYS = {
  enabled: "artist_watch_enabled",
  freshnessMonths: "alert_freshness_months",
  catalogueAdditions: "alert_on_catalogue_additions",
  excludedSecondaryTypes: "alert_excluded_secondary_types",
  newReleasesStackId: "new_releases_stack_id",
  scheduleAnnounced: "schedule_announced_releases",
  minArtistRating: "alert_min_artist_rating",
} as const;

/** Star ratings run 0.5–5 in half steps (see src/ui/components/star-rating.ts). */
export const MAX_STAR_RATING = 5;

export interface ArtistWatchSettings {
  /** Master switch for the sweep. */
  enabled: boolean;
  /** Age window, in months, for "new release" alerts. Future dates always qualify. */
  freshnessMonths: number;
  /** Also alert on records newly *added to MusicBrainz* however old they are. */
  alertOnCatalogueAdditions: boolean;
  /** Secondary types that never raise an alert, lower-cased. */
  excludedSecondaryTypes: string[];
  /** Set `remind_at` from a future release date when an alert is accepted. */
  scheduleAnnouncedReleases: boolean;
  /**
   * Only auto-track artists with at least one release rated this many stars
   * or higher. 0 disables the bar (any listened artist qualifies).
   */
  minArtistRating: number;
}

// The noise filter defaults: archival editing churn the user did not ask about.
const DEFAULT_EXCLUDED_SECONDARY_TYPES = [
  "compilation",
  "live",
  "remix",
  "dj-mix",
  "interview",
  "audiobook",
];

export const DEFAULT_ARTIST_WATCH_SETTINGS: ArtistWatchSettings = {
  enabled: true,
  freshnessMonths: 18,
  alertOnCatalogueAdditions: false,
  excludedSecondaryTypes: DEFAULT_EXCLUDED_SECONDARY_TYPES,
  scheduleAnnouncedReleases: true,
  minArtistRating: 0,
};

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return value === "true" || value === "1";
}

export async function getArtistWatchSettings(): Promise<ArtistWatchSettings> {
  const [enabled, freshness, catalogue, excluded, schedule, minRating] = await Promise.all([
    getSetting(ARTIST_WATCH_KEYS.enabled),
    getSetting(ARTIST_WATCH_KEYS.freshnessMonths),
    getSetting(ARTIST_WATCH_KEYS.catalogueAdditions),
    getSetting(ARTIST_WATCH_KEYS.excludedSecondaryTypes),
    getSetting(ARTIST_WATCH_KEYS.scheduleAnnounced),
    getSetting(ARTIST_WATCH_KEYS.minArtistRating),
  ]);

  // `Number(null)` is 0, which is a perfectly valid freshness window — so the
  // unset case has to be ruled out before parsing, or the default never applies.
  const months = freshness === null ? Number.NaN : Number(freshness);
  const rating = minRating === null ? Number.NaN : Number(minRating);

  return {
    enabled: parseBoolean(enabled, DEFAULT_ARTIST_WATCH_SETTINGS.enabled),
    freshnessMonths:
      Number.isFinite(months) && months >= 0
        ? months
        : DEFAULT_ARTIST_WATCH_SETTINGS.freshnessMonths,
    alertOnCatalogueAdditions: parseBoolean(
      catalogue,
      DEFAULT_ARTIST_WATCH_SETTINGS.alertOnCatalogueAdditions,
    ),
    excludedSecondaryTypes:
      excluded === null
        ? DEFAULT_ARTIST_WATCH_SETTINGS.excludedSecondaryTypes
        : excluded
            .split(",")
            .map((type) => type.trim().toLowerCase())
            .filter(Boolean),
    scheduleAnnouncedReleases: parseBoolean(
      schedule,
      DEFAULT_ARTIST_WATCH_SETTINGS.scheduleAnnouncedReleases,
    ),
    minArtistRating:
      Number.isFinite(rating) && rating >= 0 && rating <= MAX_STAR_RATING
        ? rating
        : DEFAULT_ARTIST_WATCH_SETTINGS.minArtistRating,
  };
}

export async function setArtistWatchSettings(
  update: Partial<ArtistWatchSettings>,
): Promise<ArtistWatchSettings> {
  if (update.enabled !== undefined) {
    await putSetting(ARTIST_WATCH_KEYS.enabled, String(update.enabled));
  }
  if (update.freshnessMonths !== undefined) {
    await putSetting(ARTIST_WATCH_KEYS.freshnessMonths, String(update.freshnessMonths));
  }
  if (update.alertOnCatalogueAdditions !== undefined) {
    await putSetting(
      ARTIST_WATCH_KEYS.catalogueAdditions,
      String(update.alertOnCatalogueAdditions),
    );
  }
  if (update.excludedSecondaryTypes !== undefined) {
    // Stored comma-joined, which is safe only because MusicBrainz secondary
    // types are a closed vocabulary with no commas in it ("compilation",
    // "live", "dj-mix"…). A free-text value here would not survive the round
    // trip through `getArtistWatchSettings`.
    await putSetting(
      ARTIST_WATCH_KEYS.excludedSecondaryTypes,
      update.excludedSecondaryTypes.join(","),
    );
  }
  if (update.scheduleAnnouncedReleases !== undefined) {
    await putSetting(ARTIST_WATCH_KEYS.scheduleAnnounced, String(update.scheduleAnnouncedReleases));
  }
  if (update.minArtistRating !== undefined) {
    await putSetting(ARTIST_WATCH_KEYS.minArtistRating, String(update.minArtistRating));
  }

  return getArtistWatchSettings();
}

/**
 * The stack accepted alerts are filed into, referenced **by id**. `stacks.name`
 * is unique and user-editable, so name-matching would silently create a
 * duplicate the moment the user renames it.
 */
export async function getNewReleasesStackId(): Promise<number | null> {
  const value = await getSetting(ARTIST_WATCH_KEYS.newReleasesStackId);
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function setNewReleasesStackId(stackId: number): Promise<void> {
  await putSetting(ARTIST_WATCH_KEYS.newReleasesStackId, String(stackId));
}
