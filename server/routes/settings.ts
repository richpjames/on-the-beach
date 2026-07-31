import { Hono } from "hono";
import {
  getLookupService,
  setLookupService,
  isLookupService,
  LOOKUP_SERVICES,
  getReleaseLengthPreference,
  setReleaseLengthPreference,
  isReleaseLengthPreference,
  RELEASE_LENGTH_PREFERENCES,
  getArtistWatchSettings,
  setArtistWatchSettings,
  type ArtistWatchSettings,
} from "../settings";
import { ensureSuggestionsForToListenArtists } from "../suggestions";

/**
 * Pick the artist-watch fields out of a settings payload, rejecting values of
 * the wrong shape rather than coercing them — a `freshnessMonths` of "soon"
 * should be a 400, not an 18.
 */
function readArtistWatchUpdate(
  body: Record<string, unknown>,
): { update: Partial<ArtistWatchSettings> } | { error: string } {
  const update: Partial<ArtistWatchSettings> = {};

  const booleans: Array<[string, keyof ArtistWatchSettings]> = [
    ["artistWatchEnabled", "enabled"],
    ["alertOnCatalogueAdditions", "alertOnCatalogueAdditions"],
    ["scheduleAnnouncedReleases", "scheduleAnnouncedReleases"],
  ];
  for (const [field, key] of booleans) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return { error: `${field} must be a boolean` };
    (update[key] as boolean) = value;
  }

  if (body.alertFreshnessMonths !== undefined) {
    const months = body.alertFreshnessMonths;
    if (typeof months !== "number" || !Number.isFinite(months) || months < 0) {
      return { error: "alertFreshnessMonths must be a non-negative number" };
    }
    update.freshnessMonths = months;
  }

  if (body.alertExcludedSecondaryTypes !== undefined) {
    const types = body.alertExcludedSecondaryTypes;
    if (!Array.isArray(types) || types.some((type) => typeof type !== "string")) {
      return { error: "alertExcludedSecondaryTypes must be an array of strings" };
    }
    update.excludedSecondaryTypes = (types as string[]).map((type) => type.trim().toLowerCase());
  }

  return { update };
}

export function createSettingsRoutes(): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const lookupService = await getLookupService();
    const releaseLengthPreference = await getReleaseLengthPreference();
    return c.json({
      lookupService,
      lookupServices: LOOKUP_SERVICES,
      releaseLengthPreference,
      releaseLengthPreferences: RELEASE_LENGTH_PREFERENCES,
      artistWatch: await getArtistWatchSettings(),
    });
  });

  routes.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const payload = body as Record<string, unknown>;
    const { lookupService, releaseLengthPreference } = payload;

    const artistWatch = readArtistWatchUpdate(payload);
    if ("error" in artistWatch) return c.json({ error: artistWatch.error }, 400);
    const hasArtistWatchUpdate = Object.keys(artistWatch.update).length > 0;

    if (
      lookupService === undefined &&
      releaseLengthPreference === undefined &&
      !hasArtistWatchUpdate
    ) {
      return c.json({ error: "Provide lookupService and/or releaseLengthPreference" }, 400);
    }
    if (lookupService !== undefined && !isLookupService(lookupService)) {
      return c.json({ error: "lookupService must be one of: " + LOOKUP_SERVICES.join(", ") }, 400);
    }
    if (
      releaseLengthPreference !== undefined &&
      !isReleaseLengthPreference(releaseLengthPreference)
    ) {
      return c.json(
        {
          error: "releaseLengthPreference must be one of: " + RELEASE_LENGTH_PREFERENCES.join(", "),
        },
        400,
      );
    }

    let changed = false;
    if (isLookupService(lookupService)) {
      changed = (await setLookupService(lookupService)).changed || changed;
    }
    if (isReleaseLengthPreference(releaseLengthPreference)) {
      const result = await setReleaseLengthPreference(releaseLengthPreference);
      changed = result.changed || changed;
      if (result.changed) {
        // The setter dropped pending suggestions picked under the old
        // preference; refill them in the background (no-op in tests via
        // OTB_DISABLE_EXTERNAL_LOOKUPS).
        void ensureSuggestionsForToListenArtists().catch((err) => {
          console.error("[settings] suggestion refill after preference change failed:", err);
        });
      }
    }

    if (hasArtistWatchUpdate) {
      await setArtistWatchSettings(artistWatch.update);
      changed = true;
    }

    return c.json(
      {
        lookupService: await getLookupService(),
        releaseLengthPreference: await getReleaseLengthPreference(),
        artistWatch: await getArtistWatchSettings(),
        changed,
      },
      200,
    );
  });

  return routes;
}

export const settingsRoutes = createSettingsRoutes();
