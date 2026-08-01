import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createSettingsRoutes } from "../../server/routes/settings";
import { db } from "../../server/db/index";
import { appSettings, itemSuggestions, musicItems } from "../../server/db/schema";
import {
  getLookupService,
  setLookupService,
  getReleaseLengthPreference,
  setReleaseLengthPreference,
  getArtistWatchSettings,
  setArtistWatchSettings,
  DEFAULT_ARTIST_WATCH_SETTINGS,
  ARTIST_WATCH_KEYS,
} from "../../server/settings";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/settings", createSettingsRoutes());
  return app;
}

beforeEach(async () => {
  // Changing the length preference fires a background suggestion sweep;
  // never let tests hit MusicBrainz.
  process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
  await setLookupService("apple_music");
  await setReleaseLengthPreference("longer");
});

afterEach(() => {
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
});

describe("settings module", () => {
  test("defaults to apple_music and round-trips a change", async () => {
    expect(await getLookupService()).toBe("apple_music");

    const first = await setLookupService("spotify");
    expect(first.changed).toBe(true);
    expect(await getLookupService()).toBe("spotify");

    const again = await setLookupService("spotify");
    expect(again.changed).toBe(false);
  });

  test("defaults to longer releases and round-trips a change", async () => {
    expect(await getReleaseLengthPreference()).toBe("longer");

    const first = await setReleaseLengthPreference("shorter");
    expect(first.changed).toBe(true);
    expect(await getReleaseLengthPreference()).toBe("shorter");

    const again = await setReleaseLengthPreference("shorter");
    expect(again.changed).toBe(false);
  });

  test("changing the length preference discards pending suggestions only", async () => {
    const [item] = await db
      .insert(musicItems)
      .values({ title: "Preference Album", normalizedTitle: "preference album" })
      .returning({ id: musicItems.id });
    const inserted = await db
      .insert(itemSuggestions)
      .values([
        { sourceItemId: item.id, title: "Pending Pick", artistName: "Pref Band" },
        {
          sourceItemId: item.id,
          title: "Dismissed Pick",
          artistName: "Pref Band",
          status: "dismissed",
        },
      ])
      .returning({ id: itemSuggestions.id });

    await setReleaseLengthPreference("shorter");

    const remaining = await Promise.all(
      inserted.map((row) =>
        db.select().from(itemSuggestions).where(eq(itemSuggestions.id, row.id)).get(),
      ),
    );
    expect(remaining[0]).toBeUndefined();
    expect(remaining[1]?.status).toBe("dismissed");
  });
});

describe("GET /api/settings", () => {
  test("returns the active service, length preference, and available options", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lookupService).toBe("apple_music");
    expect(body.lookupServices).toEqual(["apple_music", "spotify"]);
    expect(body.releaseLengthPreference).toBe("longer");
    expect(body.releaseLengthPreferences).toEqual(["longer", "shorter"]);
  });
});

describe("PUT /api/settings", () => {
  test("sets a valid service and reports the change", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupService: "spotify" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      lookupService: "spotify",
      releaseLengthPreference: "longer",
      changed: true,
    });
    expect(await getLookupService()).toBe("spotify");
  });

  test("sets the release length preference and reports the change", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseLengthPreference: "shorter" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      lookupService: "apple_music",
      releaseLengthPreference: "shorter",
      changed: true,
    });
    expect(await getReleaseLengthPreference()).toBe("shorter");
  });

  test("reports changed=false when set to the current values", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupService: "apple_music", releaseLengthPreference: "longer" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      lookupService: "apple_music",
      releaseLengthPreference: "longer",
      changed: false,
    });
  });

  test("rejects an unknown service", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupService: "soundcloud" }),
    });
    expect(res.status).toBe(400);
    expect(await getLookupService()).toBe("apple_music");
  });

  test("rejects an unknown length preference", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseLengthPreference: "medium" }),
    });
    expect(res.status).toBe(400);
    expect(await getReleaseLengthPreference()).toBe("longer");
  });

  test("rejects a payload with no recognised settings", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("artist watch settings", () => {
  beforeEach(async () => {
    await setArtistWatchSettings(DEFAULT_ARTIST_WATCH_SETTINGS);
  });

  test("an unset freshness window falls back to the default, not to zero", async () => {
    // `Number(null)` is 0 — a valid window — so "unset" has to be ruled out
    // before parsing or every fresh install alerts on nothing.
    await db.delete(appSettings).where(eq(appSettings.key, ARTIST_WATCH_KEYS.freshnessMonths));

    expect((await getArtistWatchSettings()).freshnessMonths).toBe(18);
  });

  test("an explicit zero window is honoured", async () => {
    await setArtistWatchSettings({ freshnessMonths: 0 });

    expect((await getArtistWatchSettings()).freshnessMonths).toBe(0);
  });

  test("GET exposes the artist watch block with its defaults", async () => {
    const app = makeApp();
    const body = await (await app.request("http://localhost/api/settings")).json();

    expect(body.artistWatch.enabled).toBe(true);
    expect(body.artistWatch.freshnessMonths).toBe(18);
    // Conservative by default: alerting on every archival edit is noise.
    expect(body.artistWatch.alertOnCatalogueAdditions).toBe(false);
    expect(body.artistWatch.scheduleAnnouncedReleases).toBe(true);
    expect(body.artistWatch.excludedSecondaryTypes).toContain("compilation");
    // Off by default: every listened artist is watched until a bar is set.
    expect(body.artistWatch.minArtistRating).toBe(0);
  });

  test("PUT round-trips the artist watch toggles", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artistWatchEnabled: false,
        alertFreshnessMonths: 6,
        alertOnCatalogueAdditions: true,
        alertExcludedSecondaryTypes: ["Live", "Remix"],
        scheduleAnnouncedReleases: false,
        alertMinArtistRating: 3.5,
      }),
    });

    expect(res.status).toBe(200);
    const stored = await getArtistWatchSettings();
    expect(stored.enabled).toBe(false);
    expect(stored.freshnessMonths).toBe(6);
    expect(stored.alertOnCatalogueAdditions).toBe(true);
    expect(stored.excludedSecondaryTypes).toEqual(["live", "remix"]);
    expect(stored.scheduleAnnouncedReleases).toBe(false);
    expect(stored.minArtistRating).toBe(3.5);
  });

  test("rejects a minimum rating outside the star scale", async () => {
    const app = makeApp();
    for (const alertMinArtistRating of [-1, 6, "four"]) {
      const res = await app.request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertMinArtistRating }),
      });
      expect(res.status).toBe(400);
    }
    expect((await getArtistWatchSettings()).minArtistRating).toBe(0);
  });

  test("rejects a non-numeric freshness window rather than coercing it", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alertFreshnessMonths: "soon" }),
    });

    expect(res.status).toBe(400);
    expect((await getArtistWatchSettings()).freshnessMonths).toBe(18);
  });
});
