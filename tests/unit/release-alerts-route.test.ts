import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../server/db/index";
import {
  artistReleases,
  artists,
  musicItemStacks,
  musicItems,
  releaseAlerts,
  stacks,
} from "../../server/db/schema";
import { normalize } from "../../server/utils";
import { createReleaseAlertRoutes } from "../../server/routes/release-alerts";
import { createArtistRoutes } from "../../server/routes/artists";
import {
  ensureNewReleasesStack,
  itemTypeForReleaseGroup,
  NEW_RELEASES_STACK_NAME,
} from "../../server/release-alerts";
import { DEFAULT_ARTIST_WATCH_SETTINGS, setArtistWatchSettings } from "../../server/settings";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/release-alerts", createReleaseAlertRoutes());
  app.route("/api/artists", createArtistRoutes());
  return app;
}

interface AlertFixture {
  alertId: number;
  artistId: number;
  releaseId: number;
}

let sequence = 0;

async function makeAlert(
  overrides: {
    firstReleaseDate?: string | null;
    primaryType?: string;
    reason?: string;
    title?: string;
  } = {},
): Promise<AlertFixture> {
  sequence += 1;
  const name = `Alert Artist ${Date.now()}-${sequence}`;

  const [artist] = await db
    .insert(artists)
    .values({
      name,
      normalizedName: normalize(name),
      musicbrainzArtistId: `mbid-${sequence}`,
      mbidConfidence: "confirmed",
    })
    .returning({ id: artists.id });

  const title = overrides.title ?? `Alerted Record ${sequence}`;
  const [release] = await db
    .insert(artistReleases)
    .values({
      artistId: artist.id,
      mbReleaseGroupId: `rg-alert-${sequence}`,
      title,
      normalizedTitle: normalize(title),
      primaryType: overrides.primaryType ?? "Album",
      secondaryTypes: "[]",
      firstReleaseDate:
        overrides.firstReleaseDate === undefined ? "2026-06-01" : overrides.firstReleaseDate,
      firstReleaseYear: 2026,
    })
    .returning({ id: artistReleases.id });

  const [alert] = await db
    .insert(releaseAlerts)
    .values({
      artistId: artist.id,
      artistReleaseId: release.id,
      reason: overrides.reason ?? "new-release",
    })
    .returning({ id: releaseAlerts.id });

  return { alertId: alert.id, artistId: artist.id, releaseId: release.id };
}

beforeEach(async () => {
  // Creating an item fires the background suggestion prefetch.
  process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
  await setArtistWatchSettings(DEFAULT_ARTIST_WATCH_SETTINGS);
});

afterEach(() => {
  delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
});

describe("itemTypeForReleaseGroup", () => {
  test("maps MusicBrainz primary types onto our item types where they overlap", () => {
    expect(itemTypeForReleaseGroup("Album")).toBe("album");
    expect(itemTypeForReleaseGroup("EP")).toBe("ep");
    expect(itemTypeForReleaseGroup("Single")).toBe("single");
  });

  test("falls back to album for types we don't model", () => {
    expect(itemTypeForReleaseGroup("Broadcast")).toBe("album");
    expect(itemTypeForReleaseGroup(null)).toBe("album");
  });
});

describe("GET /api/release-alerts", () => {
  test("returns pending alerts with the artist and release joined in", async () => {
    const { alertId } = await makeAlert({ title: "Joined Record" });
    const app = makeApp();

    const res = await app.request("http://localhost/api/release-alerts?status=pending");
    expect(res.status).toBe(200);

    const body = await res.json();
    const alert = body.alerts.find((row: { id: number }) => row.id === alertId);
    expect(alert.title).toBe("Joined Record");
    expect(alert.artist_name).toBeTruthy();
    expect(alert.reason).toBe("new-release");
    expect(body.pendingCount).toBeGreaterThan(0);
  });

  test("rejects an unknown status", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release-alerts?status=maybe");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/release-alerts/mark-seen", () => {
  test("clears the badge without forcing a decision on each card", async () => {
    const { alertId } = await makeAlert();
    const app = makeApp();

    const res = await app.request("http://localhost/api/release-alerts/mark-seen", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const row = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(row?.status).toBe("seen");
  });
});

describe("POST /api/release-alerts/:id/add", () => {
  test("creates the item and files it in the New Releases stack", async () => {
    const { alertId } = await makeAlert({ title: "Accepted Record" });
    const app = makeApp();

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.item.title).toBe("Accepted Record");
    // Already out, so nothing to schedule.
    expect(body.remindAt).toBeNull();

    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("added");
    expect(alert?.musicItemId).toBe(body.item.id);

    const stackId = await ensureNewReleasesStack();
    const membership = await db
      .select()
      .from(musicItemStacks)
      .where(
        and(eq(musicItemStacks.musicItemId, body.item.id), eq(musicItemStacks.stackId, stackId)),
      )
      .get();
    expect(membership).toBeDefined();
  });

  test("an announced release is handed to the reminder cron via remind_at", async () => {
    const { alertId } = await makeAlert({
      firstReleaseDate: "2099-09-18",
      reason: "announced",
    });
    const app = makeApp();

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });
    const body = await res.json();

    expect(body.remindAt).toBe("2099-09-18T00:00:00.000Z");
    const item = await db.select().from(musicItems).where(eq(musicItems.id, body.item.id)).get();
    expect(item?.remindAt?.toISOString()).toBe("2099-09-18T00:00:00.000Z");
    expect(item?.reminderPending).toBe(false);
  });

  test("scheduling can be turned off, leaving the item in To Listen", async () => {
    await setArtistWatchSettings({ scheduleAnnouncedReleases: false });
    const { alertId } = await makeAlert({ firstReleaseDate: "2099-09-18", reason: "announced" });
    const app = makeApp();

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });
    const body = await res.json();

    expect(body.remindAt).toBeNull();
    const item = await db.select().from(musicItems).where(eq(musicItems.id, body.item.id)).get();
    expect(item?.remindAt).toBeNull();
  });

  test("accepting the same alert twice is a 404 rather than a second item", async () => {
    const { alertId } = await makeAlert();
    const app = makeApp();

    await app.request(`http://localhost/api/release-alerts/${alertId}/add`, { method: "POST" });
    const second = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });

    expect(second.status).toBe(404);
  });

  test("404s for an alert that doesn't exist", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release-alerts/999999/add", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/release-alerts/:id/dismiss", () => {
  test("marks the alert dismissed", async () => {
    const { alertId } = await makeAlert();
    const app = makeApp();

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/dismiss`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const row = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(row?.status).toBe("dismissed");
    expect(row?.resolvedAt).toBeInstanceOf(Date);
  });
});

describe("ensureNewReleasesStack", () => {
  test("is referenced by id, so renaming the stack doesn't fork it", async () => {
    const stackId = await ensureNewReleasesStack();
    await db.update(stacks).set({ name: "Fresh Cuts" }).where(eq(stacks.id, stackId));

    expect(await ensureNewReleasesStack()).toBe(stackId);

    // Restore so later runs in this file see the canonical name.
    await db.update(stacks).set({ name: NEW_RELEASES_STACK_NAME }).where(eq(stacks.id, stackId));
  });
});

describe("PUT /api/artists/:id/follow", () => {
  test("muting an artist also clears the alerts already queued for them", async () => {
    const { alertId, artistId } = await makeAlert();
    const app = makeApp();

    const res = await app.request(`http://localhost/api/artists/${artistId}/follow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followState: "muted" }),
    });
    expect(res.status).toBe(200);

    const artist = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(artist?.followState).toBe("muted");
    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("dismissed");
  });

  test("rejects an unknown follow state", async () => {
    const { artistId } = await makeAlert();
    const app = makeApp();

    const res = await app.request(`http://localhost/api/artists/${artistId}/follow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followState: "sometimes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/artists/:id/mbid", () => {
  test("confirming an MBID marks it confirmed", async () => {
    const { artistId } = await makeAlert();
    const app = makeApp();

    const res = await app.request(`http://localhost/api/artists/${artistId}/mbid`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ musicbrainzArtistId: "picked-by-hand" }),
    });
    expect(res.status).toBe(200);

    const artist = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(artist?.musicbrainzArtistId).toBe("picked-by-hand");
    expect(artist?.mbidConfidence).toBe("confirmed");
  });

  test("rejects a missing MBID", async () => {
    const { artistId } = await makeAlert();
    const app = makeApp();

    const res = await app.request(`http://localhost/api/artists/${artistId}/mbid`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/artists/tracked", () => {
  test("lists tracked artists with their confidence and poll state", async () => {
    const name = `Tracked Panel ${Date.now()}`;
    const [artist] = await db
      .insert(artists)
      .values({
        name,
        normalizedName: normalize(name),
        musicbrainzArtistId: "mbid-panel",
        mbidConfidence: "probable",
        followState: "always",
      })
      .returning({ id: artists.id });

    const app = makeApp();
    const body = await (await app.request("http://localhost/api/artists/tracked")).json();
    const row = body.artists.find((entry: { id: number }) => entry.id === artist.id);

    expect(row.mbid_confidence).toBe("probable");
    expect(row.follow_state).toBe("always");
    expect(row.last_polled_at).toBeNull();
  });
});
