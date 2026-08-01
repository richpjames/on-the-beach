import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as musicbrainz from "../../server/musicbrainz";
import { db } from "../../server/db/index";
import { artistReleases, artists, musicItems, releaseAlerts } from "../../server/db/schema";
import { normalize } from "../../server/utils";
import {
  alertReasonFor,
  earliestInstant,
  isAnnouncedRelease,
  listTrackedArtists,
  nextPollInterval,
  parseReleaseYear,
  passesNoiseFilters,
  pollArtist,
  remindAtForReleaseDate,
  sweepArtistReleases,
  type TrackedArtistRow,
} from "../../server/artist-watch";
import {
  DEFAULT_ARTIST_WATCH_SETTINGS,
  setArtistWatchSettings,
  type ArtistWatchSettings,
} from "../../server/settings";

const NOW = new Date("2026-07-31T00:00:00.000Z");

function settings(overrides: Partial<ArtistWatchSettings> = {}): ArtistWatchSettings {
  return { ...DEFAULT_ARTIST_WATCH_SETTINGS, ...overrides };
}

function group(overrides: Partial<musicbrainz.MbReleaseGroup> = {}): musicbrainz.MbReleaseGroup {
  return {
    id: `rg-${Math.random().toString(36).slice(2)}`,
    title: "A Record",
    primaryType: "Album",
    secondaryTypes: [],
    firstReleaseDate: "2026-06-01",
    ...overrides,
  };
}

/** An artist with one listened item — the derived tracking rule's happy path. */
async function makeTrackedArtist(
  name: string,
  options: {
    listenStatus?: "to-listen" | "listened";
    followState?: string;
    mbid?: string;
    rating?: number;
  } = {},
): Promise<TrackedArtistRow> {
  const [artist] = await db
    .insert(artists)
    .values({
      name,
      normalizedName: normalize(name),
      musicbrainzArtistId: options.mbid ?? `mbid-${normalize(name).replace(/\W+/g, "-")}`,
      mbidConfidence: "confirmed",
      followState: options.followState ?? "auto",
    })
    .returning({ id: artists.id });

  await db.insert(musicItems).values({
    title: `${name} Debut`,
    normalizedTitle: normalize(`${name} Debut`),
    artistId: artist.id,
    listenStatus: options.listenStatus ?? "listened",
    rating: options.rating ?? null,
  });

  return (await db
    .select({
      id: artists.id,
      name: artists.name,
      musicbrainzArtistId: artists.musicbrainzArtistId,
      mbidConfidence: artists.mbidConfidence,
      followState: artists.followState,
      lastPolledAt: artists.lastPolledAt,
      nextPollAt: artists.nextPollAt,
      pollFailureCount: artists.pollFailureCount,
    })
    .from(artists)
    .where(eq(artists.id, artist.id))
    .get())!;
}

async function reload(artistId: number): Promise<TrackedArtistRow> {
  return (await db
    .select({
      id: artists.id,
      name: artists.name,
      musicbrainzArtistId: artists.musicbrainzArtistId,
      mbidConfidence: artists.mbidConfidence,
      followState: artists.followState,
      lastPolledAt: artists.lastPolledAt,
      nextPollAt: artists.nextPollAt,
      pollFailureCount: artists.pollFailureCount,
    })
    .from(artists)
    .where(eq(artists.id, artistId))
    .get())!;
}

async function alertsFor(artistId: number) {
  return db.select().from(releaseAlerts).where(eq(releaseAlerts.artistId, artistId));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe("release date parsing", () => {
  test("reads the year out of every MusicBrainz date shape", () => {
    expect(parseReleaseYear("1974")).toBe(1974);
    expect(parseReleaseYear("1974-05")).toBe(1974);
    expect(parseReleaseYear("1974-05-01")).toBe(1974);
    expect(parseReleaseYear(null)).toBeNull();
    expect(parseReleaseYear("")).toBeNull();
  });

  test("the earliest instant of a partial date is the start of its period", () => {
    expect(earliestInstant("1974")?.toISOString()).toBe("1974-01-01T00:00:00.000Z");
    expect(earliestInstant("1974-05")?.toISOString()).toBe("1974-05-01T00:00:00.000Z");
    expect(earliestInstant("1974-05-09")?.toISOString()).toBe("1974-05-09T00:00:00.000Z");
  });
});

describe("remindAtForReleaseDate", () => {
  test("a full future date schedules that day", () => {
    expect(remindAtForReleaseDate("2026-09-18", NOW)?.toISOString()).toBe(
      "2026-09-18T00:00:00.000Z",
    );
  });

  test("a future year-month schedules the 1st of that month", () => {
    expect(remindAtForReleaseDate("2026-09", NOW)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  test("a future year schedules the 1st of January", () => {
    expect(remindAtForReleaseDate("2027", NOW)?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  test("a year-only date in the current year is not scheduled", () => {
    // It may already have passed — scheduling it would be scheduling into the
    // past, so the item goes straight to To Listen instead.
    expect(remindAtForReleaseDate("2026", NOW)).toBeNull();
  });

  test("a date already gone by is not scheduled", () => {
    expect(remindAtForReleaseDate("2026-01-15", NOW)).toBeNull();
    expect(remindAtForReleaseDate("1974", NOW)).toBeNull();
  });

  test("no date at all is not scheduled", () => {
    expect(remindAtForReleaseDate(null, NOW)).toBeNull();
  });

  test("announced-ness and schedulability are the same question", () => {
    expect(isAnnouncedRelease("2026-09-18", NOW)).toBe(true);
    expect(isAnnouncedRelease("2026", NOW)).toBe(false);
    expect(isAnnouncedRelease("1974", NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alert eligibility
// ---------------------------------------------------------------------------

describe("noise filters", () => {
  test("skips excluded secondary types", () => {
    const excluded = DEFAULT_ARTIST_WATCH_SETTINGS.excludedSecondaryTypes;
    expect(
      passesNoiseFilters(
        { primaryType: "Album", secondaryTypes: ["Live"], firstReleaseDate: "2026-06" },
        excluded,
      ),
    ).toBe(false);
    expect(
      passesNoiseFilters(
        { primaryType: "Album", secondaryTypes: [], firstReleaseDate: "2026-06" },
        excluded,
      ),
    ).toBe(true);
  });

  test("skips the 'other' primary type", () => {
    expect(
      passesNoiseFilters(
        { primaryType: "Other", secondaryTypes: [], firstReleaseDate: "2026-06" },
        [],
      ),
    ).toBe(false);
  });
});

describe("alertReasonFor", () => {
  test("a future-dated release is announced", () => {
    expect(
      alertReasonFor(
        { primaryType: "Album", secondaryTypes: [], firstReleaseDate: "2026-09-18" },
        settings(),
        NOW,
      ),
    ).toBe("announced");
  });

  test("a future-dated release alerts even outside the freshness window", () => {
    // The window is an age filter; "the future" is never too old.
    expect(
      alertReasonFor(
        { primaryType: "Album", secondaryTypes: [], firstReleaseDate: "2027-03-01" },
        settings({ freshnessMonths: 1 }),
        NOW,
      ),
    ).toBe("announced");
  });

  test("a recent release is a new release", () => {
    expect(
      alertReasonFor(
        { primaryType: "Album", secondaryTypes: [], firstReleaseDate: "2026-03-01" },
        settings(),
        NOW,
      ),
    ).toBe("new-release");
  });

  test("an old release stays quiet unless catalogue additions are on", () => {
    const old = { primaryType: "Album", secondaryTypes: [], firstReleaseDate: "1978-04-01" };

    expect(alertReasonFor(old, settings(), NOW)).toBeNull();
    expect(alertReasonFor(old, settings({ alertOnCatalogueAdditions: true }), NOW)).toBe(
      "catalogue-addition",
    );
  });

  test("a dateless release only surfaces as a catalogue addition", () => {
    const undated = { primaryType: "Album", secondaryTypes: [], firstReleaseDate: null };

    expect(alertReasonFor(undated, settings(), NOW)).toBeNull();
    expect(alertReasonFor(undated, settings({ alertOnCatalogueAdditions: true }), NOW)).toBe(
      "catalogue-addition",
    );
  });

  test("a filtered type never alerts, however fresh", () => {
    expect(
      alertReasonFor(
        { primaryType: "Album", secondaryTypes: ["Compilation"], firstReleaseDate: "2026-09-18" },
        settings({ alertOnCatalogueAdditions: true }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("nextPollInterval", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("an active artist is polled weekly", () => {
    expect(nextPollInterval(2026, NOW, 0.5)).toBe(7 * DAY);
  });

  test("a semi-dormant artist waits three weeks", () => {
    expect(nextPollInterval(2020, NOW, 0.5)).toBe(21 * DAY);
  });

  test("a long-dormant artist waits two months", () => {
    expect(nextPollInterval(1978, NOW, 0.5)).toBe(60 * DAY);
  });

  test("an artist with no dated releases is treated as dormant", () => {
    expect(nextPollInterval(null, NOW, 0.5)).toBe(60 * DAY);
  });

  test("jitter spreads an import batch by ±20%", () => {
    expect(nextPollInterval(2026, NOW, 0)).toBe(Math.round(7 * DAY * 0.8));
    expect(nextPollInterval(2026, NOW, 1)).toBe(Math.round(7 * DAY * 1.2));
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe("pollArtist", () => {
  afterEach(() => {
    mock.restore();
  });

  test("the first poll is a silent baseline", async () => {
    const groups = [group({ id: "rg-base-1" }), group({ id: "rg-base-2" })];
    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue(groups);
    const artist = await makeTrackedArtist(`Baseline Band ${Date.now()}`);

    const outcome = await pollArtist(artist, settings(), NOW);

    expect(outcome.baseline).toBe(true);
    expect(outcome.newReleases).toBe(2);
    expect(outcome.alertsRaised).toBe(0);
    expect(await alertsFor(artist.id)).toHaveLength(0);

    const stored = await db
      .select()
      .from(artistReleases)
      .where(eq(artistReleases.artistId, artist.id));
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.isBaseline)).toBe(true);
  });

  test("an interrupted baseline resumes as a baseline rather than alerting", async () => {
    // A process that dies mid-baseline leaves rows behind but never stamps
    // `last_polled_at`. The rest of the discography must not then drip out as
    // alerts on the next poll.
    const artist = await makeTrackedArtist(`Interrupted Band ${Date.now()}`);
    await db.insert(artistReleases).values({
      artistId: artist.id,
      mbReleaseGroupId: "rg-partial",
      title: "Got There First",
      normalizedTitle: normalize("Got There First"),
      primaryType: "Album",
      secondaryTypes: "[]",
      firstReleaseDate: "2026-06-01",
      firstReleaseYear: 2026,
      isBaseline: true,
      firstSeenAt: NOW,
    });

    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-partial" }),
      group({ id: "rg-rest-1" }),
      group({ id: "rg-rest-2" }),
    ]);

    const outcome = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(outcome.baseline).toBe(true);
    expect(outcome.newReleases).toBe(2);
    expect(outcome.alertsRaised).toBe(0);
    expect(await alertsFor(artist.id)).toHaveLength(0);
  });

  test("a group first seen after the baseline raises one alert", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-known" }),
    ]);
    const artist = await makeTrackedArtist(`Diffing Band ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);

    mbSpy.mockResolvedValue([
      group({ id: "rg-known" }),
      group({ id: "rg-new", title: "Brand New", firstReleaseDate: "2026-07-01" }),
    ]);
    const outcome = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(outcome.baseline).toBe(false);
    expect(outcome.alertsRaised).toBe(1);
    const alerts = await alertsFor(artist.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].status).toBe("pending");
    expect(alerts[0].reason).toBe("new-release");
  });

  test("re-polling the same discography raises nothing further", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-idem" }),
    ]);
    const artist = await makeTrackedArtist(`Idempotent Band ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);

    mbSpy.mockResolvedValue([group({ id: "rg-idem" }), group({ id: "rg-idem-new" })]);
    await pollArtist(await reload(artist.id), settings(), NOW);
    const after = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(after.alertsRaised).toBe(0);
    expect(await alertsFor(artist.id)).toHaveLength(1);
  });

  test("filtered secondary types are recorded but never alert", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-filter-base" }),
    ]);
    const artist = await makeTrackedArtist(`Filtered Band ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);

    mbSpy.mockResolvedValue([
      group({ id: "rg-filter-base" }),
      group({ id: "rg-live", secondaryTypes: ["Live"], firstReleaseDate: "2026-07-01" }),
    ]);
    const outcome = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(outcome.newReleases).toBe(1);
    expect(outcome.alertsRaised).toBe(0);
  });

  test("a future-dated release alerts as announced, freshness window notwithstanding", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-announced-base" }),
    ]);
    const artist = await makeTrackedArtist(`Announced Band ${Date.now()}`);
    await pollArtist(artist, settings({ freshnessMonths: 0 }), NOW);

    mbSpy.mockResolvedValue([
      group({ id: "rg-announced-base" }),
      group({ id: "rg-announced", firstReleaseDate: "2026-09-18" }),
    ]);
    await pollArtist(await reload(artist.id), settings({ freshnessMonths: 0 }), NOW);

    const alerts = await alertsFor(artist.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].reason).toBe("announced");
  });

  test("caps alerts at three per sweep and carries the rest to the next one", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-cap-base" }),
    ]);
    const artist = await makeTrackedArtist(`Prolific Band ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);

    mbSpy.mockResolvedValue([
      group({ id: "rg-cap-base" }),
      ...Array.from({ length: 5 }, (_unused, index) =>
        group({ id: `rg-cap-${index}`, firstReleaseDate: `2026-0${index + 1}-01` }),
      ),
    ]);

    const first = await pollArtist(await reload(artist.id), settings(), NOW);
    expect(first.alertsRaised).toBe(3);

    const second = await pollArtist(await reload(artist.id), settings(), NOW);
    expect(second.alertsRaised).toBe(2);
    expect(await alertsFor(artist.id)).toHaveLength(5);
  });

  test("turning catalogue additions on surfaces history already captured", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-archive-base" }),
    ]);
    const artist = await makeTrackedArtist(`Archive Band ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);

    mbSpy.mockResolvedValue([
      group({ id: "rg-archive-base" }),
      group({ id: "rg-archive-old", firstReleaseDate: "1978-04-01" }),
    ]);
    const quiet = await pollArtist(await reload(artist.id), settings(), NOW);
    expect(quiet.alertsRaised).toBe(0);

    // No re-scan needed: the group was recorded all along.
    const loud = await pollArtist(
      await reload(artist.id),
      settings({ alertOnCatalogueAdditions: true }),
      NOW,
    );
    expect(loud.alertsRaised).toBe(1);
    expect((await alertsFor(artist.id))[0].reason).toBe("catalogue-addition");
  });

  test("a failed poll backs off and keeps the artist's baseline", async () => {
    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([group({ id: "rg-fail" })]);
    const artist = await makeTrackedArtist(`Flaky Band ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);
    const polledAt = (await reload(artist.id)).lastPolledAt;

    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockRejectedValue(new Error("network down"));
    const outcome = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(outcome.status).toBe("failed");
    const row = await reload(artist.id);
    expect(row.pollFailureCount).toBe(1);
    // 2^1 hours out.
    expect(row.nextPollAt!.getTime()).toBe(NOW.getTime() + 2 * 60 * 60 * 1000);
    // Untouched, so the next successful poll isn't mistaken for a baseline.
    expect(row.lastPolledAt?.getTime()).toBe(polledAt?.getTime());
  });

  test("backoff is exponential and capped at seven days", async () => {
    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockRejectedValue(new Error("still down"));
    const artist = await makeTrackedArtist(`Backoff Band ${Date.now()}`);
    await db.update(artists).set({ pollFailureCount: 20 }).where(eq(artists.id, artist.id));

    await pollArtist(await reload(artist.id), settings(), NOW);

    const row = await reload(artist.id);
    expect(row.nextPollAt!.getTime()).toBe(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
  });

  test("a successful poll clears the failure count and schedules the next one", async () => {
    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-recover", firstReleaseDate: "2026-01-01" }),
    ]);
    const artist = await makeTrackedArtist(`Recovering Band ${Date.now()}`);
    await db.update(artists).set({ pollFailureCount: 3 }).where(eq(artists.id, artist.id));

    await pollArtist(await reload(artist.id), settings(), NOW);

    const row = await reload(artist.id);
    expect(row.pollFailureCount).toBe(0);
    expect(row.lastPolledAt?.getTime()).toBe(NOW.getTime());
    expect(row.nextPollAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("a 503 is reported as rate limiting so the sweep can pause", async () => {
    spyOn(musicbrainz, "fetchArtistReleaseGroups").mockRejectedValue(
      new musicbrainz.MusicBrainzHttpError(503, "slow down"),
    );
    const artist = await makeTrackedArtist(`Throttled Band ${Date.now()}`);

    const outcome = await pollArtist(artist, settings(), NOW);

    expect(outcome.rateLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Date drift
// ---------------------------------------------------------------------------

describe("date drift reconciliation", () => {
  afterEach(() => {
    mock.restore();
  });

  /** An accepted alert whose item carries a reminder this system created. */
  async function acceptedAnnouncedRelease(name: string) {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-drift-base" }),
    ]);
    const artist = await makeTrackedArtist(name);
    await pollArtist(artist, settings(), NOW);

    mbSpy.mockResolvedValue([
      group({ id: "rg-drift-base" }),
      group({ id: "rg-drift", title: "Delayed", firstReleaseDate: "2026-09-18" }),
    ]);
    await pollArtist(await reload(artist.id), settings(), NOW);

    const [item] = await db
      .insert(musicItems)
      .values({
        title: "Delayed",
        normalizedTitle: "delayed",
        artistId: artist.id,
        remindAt: new Date("2026-09-18T00:00:00.000Z"),
      })
      .returning({ id: musicItems.id });

    const release = (await db
      .select()
      .from(artistReleases)
      .where(
        and(
          eq(artistReleases.artistId, artist.id),
          eq(artistReleases.mbReleaseGroupId, "rg-drift"),
        ),
      )
      .get())!;
    await db
      .update(releaseAlerts)
      .set({ status: "added", musicItemId: item.id })
      .where(eq(releaseAlerts.artistReleaseId, release.id));

    return { artist, itemId: item.id, mbSpy };
  }

  test("a slipped date moves the reminder we created", async () => {
    const { artist, itemId, mbSpy } = await acceptedAnnouncedRelease(`Drift Band ${Date.now()}`);

    mbSpy.mockResolvedValue([
      group({ id: "rg-drift-base" }),
      group({ id: "rg-drift", title: "Delayed", firstReleaseDate: "2026-11-20" }),
    ]);
    const outcome = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(outcome.rescheduled).toBe(1);
    const item = await db.select().from(musicItems).where(eq(musicItems.id, itemId)).get();
    expect(item?.remindAt?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
  });

  test("a date removed from MusicBrainz un-schedules the item", async () => {
    // A reminder derived from a value MusicBrainz has retracted asserts
    // something nobody stands behind any more; the item falls into To Listen.
    const { artist, itemId, mbSpy } = await acceptedAnnouncedRelease(`Retracted ${Date.now()}`);

    mbSpy.mockResolvedValue([
      group({ id: "rg-drift-base" }),
      group({ id: "rg-drift", title: "Delayed", firstReleaseDate: null }),
    ]);
    await pollArtist(await reload(artist.id), settings(), NOW);

    const item = await db.select().from(musicItems).where(eq(musicItems.id, itemId)).get();
    expect(item?.remindAt).toBeNull();
  });

  test("a reminder the user set themselves is never touched", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-manual", firstReleaseDate: "2026-09-18" }),
    ]);
    const artist = await makeTrackedArtist(`Manual Reminder ${Date.now()}`);
    await pollArtist(artist, settings(), NOW);

    // An item with a reminder but no alert linking it to the release.
    const userDate = new Date("2026-12-25T00:00:00.000Z");
    const [item] = await db
      .insert(musicItems)
      .values({
        title: "Hand Scheduled",
        normalizedTitle: "hand scheduled",
        artistId: artist.id,
        remindAt: userDate,
      })
      .returning({ id: musicItems.id });

    mbSpy.mockResolvedValue([group({ id: "rg-manual", firstReleaseDate: "2027-02-01" })]);
    await pollArtist(await reload(artist.id), settings(), NOW);

    const row = await db.select().from(musicItems).where(eq(musicItems.id, item.id)).get();
    expect(row?.remindAt?.getTime()).toBe(userDate.getTime());
  });

  test("a reminder that has already fired is left alone", async () => {
    const { artist, itemId, mbSpy } = await acceptedAnnouncedRelease(
      `Fired Reminder ${Date.now()}`,
    );
    await db.update(musicItems).set({ reminderPending: true }).where(eq(musicItems.id, itemId));

    mbSpy.mockResolvedValue([
      group({ id: "rg-drift-base" }),
      group({ id: "rg-drift", title: "Delayed", firstReleaseDate: "2027-01-05" }),
    ]);
    const outcome = await pollArtist(await reload(artist.id), settings(), NOW);

    expect(outcome.rescheduled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Which artists get tracked, and the sweep around them
// ---------------------------------------------------------------------------

describe("tracked artists", () => {
  test("a listened artist is tracked; a to-listen-only artist is not", async () => {
    const listened = await makeTrackedArtist(`Listened Only ${Date.now()}`);
    const queued = await makeTrackedArtist(`Queued Only ${Date.now()}`, {
      listenStatus: "to-listen",
    });

    const tracked = (await listTrackedArtists()).map((artist) => artist.id);

    expect(tracked).toContain(listened.id);
    expect(tracked).not.toContain(queued.id);
  });

  test("follow_state 'always' tracks an artist with nothing listened", async () => {
    const forced = await makeTrackedArtist(`Always Followed ${Date.now()}`, {
      listenStatus: "to-listen",
      followState: "always",
    });

    expect((await listTrackedArtists()).map((a) => a.id)).toContain(forced.id);
  });

  test("muted beats everything", async () => {
    const muted = await makeTrackedArtist(`Muted Band ${Date.now()}`, { followState: "muted" });

    expect((await listTrackedArtists()).map((a) => a.id)).not.toContain(muted.id);
  });

  test("the rating bar drops listened artists whose releases fall below it", async () => {
    const loved = await makeTrackedArtist(`Loved Band ${Date.now()}`, { rating: 4.5 });
    const middling = await makeTrackedArtist(`Middling Band ${Date.now()}`, { rating: 2 });
    const unrated = await makeTrackedArtist(`Unrated Band ${Date.now()}`);

    const gated = (await listTrackedArtists(settings({ minArtistRating: 4 }))).map((a) => a.id);
    expect(gated).toContain(loved.id);
    expect(gated).not.toContain(middling.id);
    expect(gated).not.toContain(unrated.id);

    // With the bar off (the default), having listened is still enough.
    const open = (await listTrackedArtists(settings())).map((a) => a.id);
    expect(open).toContain(loved.id);
    expect(open).toContain(middling.id);
    expect(open).toContain(unrated.id);
  });

  test("a rating alone doesn't track an artist nothing was listened to by", async () => {
    // The bar narrows the listened rule; it doesn't replace it.
    const ratedButQueued = await makeTrackedArtist(`Rated Queue ${Date.now()}`, {
      listenStatus: "to-listen",
      rating: 5,
    });

    const tracked = (await listTrackedArtists(settings({ minArtistRating: 4 }))).map((a) => a.id);
    expect(tracked).not.toContain(ratedButQueued.id);
  });

  test("follow_state 'always' bypasses the rating bar", async () => {
    const forced = await makeTrackedArtist(`Always Unrated ${Date.now()}`, {
      followState: "always",
    });

    const tracked = (await listTrackedArtists(settings({ minArtistRating: 5 }))).map((a) => a.id);
    expect(tracked).toContain(forced.id);
  });
});

describe("sweepArtistReleases", () => {
  beforeEach(async () => {
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
    process.env.OTB_ARTIST_WATCH_THROTTLE_MS = "0";
    await setArtistWatchSettings(DEFAULT_ARTIST_WATCH_SETTINGS);
  });

  afterEach(async () => {
    mock.restore();
    delete process.env.OTB_ARTIST_WATCH_THROTTLE_MS;
    await setArtistWatchSettings(DEFAULT_ARTIST_WATCH_SETTINGS);
  });

  test("no-ops under OTB_DISABLE_EXTERNAL_LOOKUPS", async () => {
    process.env.OTB_DISABLE_EXTERNAL_LOOKUPS = "1";
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups");
    await makeTrackedArtist(`Disabled Sweep ${Date.now()}`);

    await sweepArtistReleases(NOW);

    expect(mbSpy).not.toHaveBeenCalled();
    delete process.env.OTB_DISABLE_EXTERNAL_LOOKUPS;
  });

  test("no-ops when the master switch is off", async () => {
    await setArtistWatchSettings({ enabled: false });
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups");
    await makeTrackedArtist(`Switched Off ${Date.now()}`);

    await sweepArtistReleases(NOW);

    expect(mbSpy).not.toHaveBeenCalled();
  });

  test("polls a due artist and leaves one that isn't due alone", async () => {
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-sweep" }),
    ]);
    spyOn(musicbrainz, "searchArtistCandidates").mockResolvedValue([]);
    spyOn(musicbrainz, "lookupRelease").mockResolvedValue(null);

    const due = await makeTrackedArtist(`Sweep Due ${Date.now()}`, { mbid: "mbid-sweep-due" });
    const notDue = await makeTrackedArtist(`Sweep Later ${Date.now()}`, {
      mbid: "mbid-sweep-later",
    });
    await db
      .update(artists)
      .set({ nextPollAt: new Date(NOW.getTime() + 7 * 24 * 3600_000), lastPolledAt: NOW })
      .where(eq(artists.id, notDue.id));

    await sweepArtistReleases(NOW);

    expect(mbSpy).toHaveBeenCalledWith("mbid-sweep-due");
    expect(mbSpy).not.toHaveBeenCalledWith("mbid-sweep-later");
    expect((await reload(due.id)).lastPolledAt).not.toBeNull();
  });

  test("the rating bar keeps below-bar artists out of the poll queue", async () => {
    await setArtistWatchSettings({ minArtistRating: 4 });
    const mbSpy = spyOn(musicbrainz, "fetchArtistReleaseGroups").mockResolvedValue([
      group({ id: "rg-rated-sweep" }),
    ]);
    spyOn(musicbrainz, "searchArtistCandidates").mockResolvedValue([]);

    await makeTrackedArtist(`Sweep Loved ${Date.now()}`, {
      mbid: "mbid-sweep-loved",
      rating: 4.5,
    });
    await makeTrackedArtist(`Sweep Middling ${Date.now()}`, {
      mbid: "mbid-sweep-middling",
      rating: 2,
    });

    await sweepArtistReleases(NOW);

    expect(mbSpy).toHaveBeenCalledWith("mbid-sweep-loved");
    expect(mbSpy).not.toHaveBeenCalledWith("mbid-sweep-middling");
  });
});
