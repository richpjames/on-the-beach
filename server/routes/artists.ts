import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { artists } from "../db/schema";
import { listTrackedArtists, pollArtistNow } from "../artist-watch";
import { muteArtist } from "../release-alerts";
import { searchArtistCandidates } from "../musicbrainz";
import { setArtistMbid } from "../artist-identity";

const FOLLOW_STATES = ["auto", "always", "muted"] as const;
type FollowState = (typeof FOLLOW_STATES)[number];

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createArtistRoutes(): Hono {
  const routes = new Hono();

  // GET /tracked — the artist-management panel: follow state, MBID confidence,
  // last poll.
  routes.get("/tracked", async (c) => {
    const tracked = await listTrackedArtists();
    return c.json({
      artists: tracked.map((artist) => ({
        id: artist.id,
        name: artist.name,
        musicbrainz_artist_id: artist.musicbrainzArtistId,
        mbid_confidence: artist.mbidConfidence ?? "unresolved",
        follow_state: artist.followState,
        last_polled_at: artist.lastPolledAt?.toISOString() ?? null,
        next_poll_at: artist.nextPollAt?.toISOString() ?? null,
        poll_failure_count: artist.pollFailureCount,
      })),
    });
  });

  // GET /:id/mbid-candidates — the disambiguation list for an unresolved
  // artist: name, disambiguation comment, country and life span, so the user
  // can pick the one we refused to guess at.
  routes.get("/:id/mbid-candidates", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid ID" }, 400);

    const artist = await db
      .select({ name: artists.name })
      .from(artists)
      .where(eq(artists.id, id))
      .get();
    if (!artist) return c.json({ error: "Artist not found" }, 404);

    if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return c.json({ candidates: [] });

    try {
      return c.json({ candidates: await searchArtistCandidates(artist.name) });
    } catch (err) {
      console.error("[api] artist MBID candidate search failed:", err);
      return c.json({ error: "MusicBrainz lookup failed" }, 502);
    }
  });

  // PUT /:id/follow — auto | always | muted.
  routes.put("/:id/follow", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid ID" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const followState = (body as { followState?: unknown } | null)?.followState;
    if (!FOLLOW_STATES.includes(followState as FollowState)) {
      return c.json({ error: `followState must be one of: ${FOLLOW_STATES.join(", ")}` }, 400);
    }

    if (followState === "muted") {
      // Muting also clears the alerts already queued for that artist.
      const muted = await muteArtist(id);
      return muted ? c.json({ followState }) : c.json({ error: "Artist not found" }, 404);
    }

    const updated = await db
      .update(artists)
      .set({ followState: followState as FollowState, updatedAt: new Date() })
      .where(eq(artists.id, id))
      .returning({ id: artists.id });
    if (updated.length === 0) return c.json({ error: "Artist not found" }, 404);

    return c.json({ followState });
  });

  // PUT /:id/mbid — confirm an MBID from the disambiguation dialog.
  routes.put("/:id/mbid", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid ID" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const mbid = (body as { musicbrainzArtistId?: unknown } | null)?.musicbrainzArtistId;
    if (typeof mbid !== "string" || mbid.trim().length === 0) {
      return c.json({ error: "musicbrainzArtistId is required" }, 400);
    }

    const updated = await setArtistMbid(id, mbid.trim());
    if (!updated) return c.json({ error: "Artist not found" }, 404);
    return c.json({ musicbrainzArtistId: mbid.trim(), mbidConfidence: "confirmed" });
  });

  // POST /:id/poll — "check now".
  routes.post("/:id/poll", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid ID" }, 400);

    const outcome = await pollArtistNow(id);
    if (!outcome) return c.json({ error: "Artist not found" }, 404);
    return c.json(outcome);
  });

  return routes;
}

export const artistRoutes = createArtistRoutes();
