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
} from "../settings";
import { ensureSuggestionsForToListenArtists } from "../suggestions";

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

    const { lookupService, releaseLengthPreference } = body as Record<string, unknown>;
    if (lookupService === undefined && releaseLengthPreference === undefined) {
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

    return c.json(
      {
        lookupService: await getLookupService(),
        releaseLengthPreference: await getReleaseLengthPreference(),
        changed,
      },
      200,
    );
  });

  return routes;
}

export const settingsRoutes = createSettingsRoutes();
