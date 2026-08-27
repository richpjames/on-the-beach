import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../server/db/index";
import {
  artistReleases,
  artists,
  musicItemStacks,
  musicItems,
  musicLinks,
  releaseAlerts,
  sources,
  stacks,
} from "../../server/db/schema";
import { normalize } from "../../server/utils";
import { createReleaseAlertRoutes } from "../../server/routes/release-alerts";
import { createArtistRoutes } from "../../server/routes/artists";
import {
  acceptAlert,
  ensureNewReleasesStack,
  itemTypeForReleaseGroup,
  NEW_RELEASES_STACK_NAME,
} from "../../server/release-alerts";
import type { ReleaseLinkOutcome } from "../../server/release-link-check";
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

  test("concurrent accepts create exactly one item", async () => {
    // The sequential case above is covered by the status check; this is the
    // interleaved one it can't catch. Both requests read the alert as
    // acceptable before either writes, so only an atomic claim keeps them from
    // both creating an item for the same release.
    const { alertId } = await makeAlert({ title: "Raced Record" });
    const app = makeApp();

    const responses = await Promise.all([
      app.request(`http://localhost/api/release-alerts/${alertId}/add`, { method: "POST" }),
      app.request(`http://localhost/api/release-alerts/${alertId}/add`, { method: "POST" }),
    ]);

    expect(responses.filter((res) => res.ok)).toHaveLength(1);

    const created = await db
      .select({ id: musicItems.id })
      .from(musicItems)
      .where(eq(musicItems.normalizedTitle, normalize("Raced Record")));
    expect(created).toHaveLength(1);

    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("added");
    expect(alert?.musicItemId).toBe(created[0].id);
  });

  test("404s for an alert that doesn't exist", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/release-alerts/999999/add", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The link gate
//
// Every test above runs with OTB_DISABLE_EXTERNAL_LOOKUPS set, which switches
// the gate off — that is the point of these: they drive `acceptAlert` with the
// check stubbed, and the last two let the real one run against a mocked fetch
// to prove the route reports a refusal rather than a failure.
// ---------------------------------------------------------------------------

const NO_LINK: ReleaseLinkOutcome = {
  kind: "none",
  service: "apple_music",
  providerSearched: true,
};

function providerLink(url: string): ReleaseLinkOutcome {
  return {
    kind: "found",
    link: {
      url,
      sourceName: "apple_music",
      via: "provider",
      foundBy: "Apple Music",
      artworkUrl: "https://example.test/cover.jpg",
      service: "apple_music",
      providerSearched: true,
    },
  };
}

function musicbrainzLink(url: string): ReleaseLinkOutcome {
  return {
    kind: "found",
    link: {
      url,
      sourceName: "bandcamp",
      via: "musicbrainz",
      foundBy: "MusicBrainz",
      artworkUrl: null,
      service: "apple_music",
      providerSearched: true,
    },
  };
}

async function linksFor(itemId: number): Promise<Array<{ url: string; source: string | null }>> {
  const rows = await db
    .select({ url: musicLinks.url, source: sources.name })
    .from(musicLinks)
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id))
    .where(eq(musicLinks.musicItemId, itemId));
  return rows.map((row) => ({ url: row.url, source: row.source ?? null }));
}

describe("acceptAlert link gate", () => {
  test("a release with no link anywhere is refused, and the alert survives it", async () => {
    const { alertId } = await makeAlert({ title: "Unlinked Record" });

    const outcome = await acceptAlert(alertId, new Date(), async () => NO_LINK);
    expect(outcome).toEqual({ status: "no-link", serviceName: "Apple Music" });

    // Untouched: the record may well turn up on the service next week.
    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("pending");
    expect(alert?.musicItemId).toBeNull();

    const created = await db
      .select({ id: musicItems.id })
      .from(musicItems)
      .where(eq(musicItems.normalizedTitle, normalize("Unlinked Record")));
    expect(created).toHaveLength(0);
  });

  test("a check that didn't complete is reported as retryable, not as a refusal", async () => {
    const { alertId } = await makeAlert();

    const outcome = await acceptAlert(alertId, new Date(), async () => ({
      kind: "failed",
      message: "MusicBrainz returned 503",
    }));

    expect(outcome.status).toBe("check-failed");
    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("pending");
  });

  test("the provider link the gate found is filed with the item, artwork and all", async () => {
    const url = "https://music.apple.com/gb/album/linked-record/1";
    const { alertId } = await makeAlert({ title: "Linked Record" });

    const outcome = await acceptAlert(alertId, new Date(), async () => providerLink(url));
    expect(outcome.status).toBe("added");
    if (outcome.status !== "added") return;
    expect(outcome.link).toEqual({ url, foundBy: "Apple Music", via: "provider" });

    expect(await linksFor(outcome.itemId)).toEqual([{ url, source: "apple_music" }]);

    const item = await db.select().from(musicItems).where(eq(musicItems.id, outcome.itemId)).get();
    expect(item?.artworkUrl).toBe("https://example.test/cover.jpg");
    // The provider answered, so there is no missed lookup to remember.
    expect(item?.lookupAttemptedAt).toBeNull();
  });

  test("a MusicBrainz external link is filed, and the provider's miss is remembered", async () => {
    const url = "https://ordinary.bandcamp.com/album/external-record";
    const { alertId } = await makeAlert({ title: "External Record" });

    const outcome = await acceptAlert(alertId, new Date(), async () => musicbrainzLink(url));
    expect(outcome.status).toBe("added");
    if (outcome.status !== "added") return;

    expect(await linksFor(outcome.itemId)).toEqual([{ url, source: "bandcamp" }]);

    const item = await db.select().from(musicItems).where(eq(musicItems.id, outcome.itemId)).get();
    expect(item?.lookupAttemptedAt).toBeInstanceOf(Date);
  });

  test("an announced release is filed unchecked — its check is release day's job", async () => {
    const checkLink = mock(async () => NO_LINK);
    const { alertId } = await makeAlert({
      title: "Announced Record",
      firstReleaseDate: "2099-09-18",
      reason: "announced",
    });

    const outcome = await acceptAlert(alertId, new Date(), checkLink);

    // Nobody carries an album that isn't out, so nobody is asked: the item is
    // scheduled, and processReminders() runs the check on the day.
    expect(checkLink).not.toHaveBeenCalled();
    expect(outcome.status).toBe("added");
    if (outcome.status !== "added") return;
    expect(outcome.link).toBeNull();
    expect(outcome.remindAt?.toISOString()).toBe("2099-09-18T00:00:00.000Z");
  });

  test("…and with scheduling off it is an ordinary add, gate and all", async () => {
    await setArtistWatchSettings({ scheduleAnnouncedReleases: false });
    const checkLink = mock(async () => NO_LINK);
    const { alertId } = await makeAlert({
      title: "Unscheduled Announced Record",
      firstReleaseDate: "2099-09-18",
      reason: "announced",
    });

    const outcome = await acceptAlert(alertId, new Date(), checkLink);

    expect(checkLink).toHaveBeenCalled();
    expect(outcome.status).toBe("no-link");
  });

  test("a link found for a record that isn't out keeps its provider lookup alive", async () => {
    // Scheduling off, so an announced record is filed straight into To Listen
    // and the gate applies — but the provider's "no" is still about today.
    await setArtistWatchSettings({ scheduleAnnouncedReleases: false });
    const { alertId } = await makeAlert({
      title: "Unscheduled Record",
      firstReleaseDate: "2099-09-18",
      reason: "announced",
    });

    const outcome = await acceptAlert(alertId, new Date(), async () =>
      musicbrainzLink("https://ordinary.bandcamp.com/album/unscheduled-record"),
    );
    expect(outcome.status).toBe("added");
    if (outcome.status !== "added") return;

    const item = await db.select().from(musicItems).where(eq(musicItems.id, outcome.itemId)).get();
    expect(item?.remindAt).toBeNull();
    expect(item?.lookupAttemptedAt).toBeNull();
  });
});

describe("POST /api/release-alerts/:id/add — gate responses", () => {
  // These let the real check run, so the environment switch has to come off.
  afterEach(() => {
    mock.restore();
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
  });

  function mockLookups(musicbrainz: () => Response): void {
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("itunes.apple.com") || url.includes("api.music.apple.com")) {
        return Response.json({ results: {}, resultCount: 0 });
      }
      if (url.includes("/ws/2/release-group/")) return musicbrainz();
      // Accepting an alert also fires the background suggestion prefetch, which
      // asks MusicBrainz about the artist. Answer it emptily rather than
      // letting a real request escape the suite.
      if (url.includes("musicbrainz.org")) return Response.json({});
      throw new Error(`unexpected fetch in test: ${url}`);
    });
  }

  test("422s a release neither the provider nor MusicBrainz has a link for", async () => {
    const { alertId } = await makeAlert({ title: "Nowhere Record" });
    const app = makeApp();
    mockLookups(() => Response.json({ relations: [] }));

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe("no_link");
    expect(body.error).toContain("Apple Music");

    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("pending");
  });

  test("503s when the check itself couldn't complete", async () => {
    const { alertId } = await makeAlert({ title: "Unknowable Record" });
    const app = makeApp();
    mockLookups(() => new Response("", { status: 503 }));

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });

    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("link_check_failed");

    const alert = await db.select().from(releaseAlerts).where(eq(releaseAlerts.id, alertId)).get();
    expect(alert?.status).toBe("pending");
  });

  test("201s once MusicBrainz has an external link for it", async () => {
    const { alertId } = await makeAlert({ title: "Findable Record" });
    const app = makeApp();
    mockLookups(() =>
      Response.json({
        relations: [{ type: "streaming", url: { resource: "https://open.spotify.com/album/abc" } }],
      }),
    );

    const res = await app.request(`http://localhost/api/release-alerts/${alertId}/add`, {
      method: "POST",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link).toEqual({
      url: "https://open.spotify.com/album/abc",
      foundBy: "MusicBrainz",
      via: "musicbrainz",
    });
    expect(await linksFor(body.item.id)).toEqual([
      { url: "https://open.spotify.com/album/abc", source: "spotify" },
    ]);
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
      body: JSON.stringify({ musicbrainzArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711" }),
    });
    expect(res.status).toBe(200);

    const artist = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(artist?.musicbrainzArtistId).toBe("a74b1b7f-71a5-4011-9441-d0b5e4122711");
    expect(artist?.mbidConfidence).toBe("confirmed");
  });

  test("rejects an MBID that isn't a UUID", async () => {
    // A confirmed MBID drives every future poll, so a paste error should fail
    // here rather than as a run of MusicBrainz 404s weeks later.
    const { artistId } = await makeAlert();
    const app = makeApp();

    const res = await app.request(`http://localhost/api/artists/${artistId}/mbid`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ musicbrainzArtistId: "picked-by-hand" }),
    });
    expect(res.status).toBe(400);

    const artist = await db.select().from(artists).where(eq(artists.id, artistId)).get();
    expect(artist?.musicbrainzArtistId).not.toBe("picked-by-hand");
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
