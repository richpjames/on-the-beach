import { Hono } from "hono";
import { listLinkSources, setLinkSourceRank, type LinkSourceRow } from "../../app/notes-enrichment";

// ---------------------------------------------------------------------------
// The external-link source rankings behind /admin: every host met among
// MusicBrainz release links, and the rank that decides which one supplies an
// item's notes. Read-only until a host has been encountered; the user re-ranks
// what is there.
// ---------------------------------------------------------------------------

export type ListLinkSourcesFn = () => Promise<LinkSourceRow[]>;
export type SetLinkSourceRankFn = (host: string, rank: number) => Promise<boolean>;

export function createLinkSourceRoutes(
  listSources: ListLinkSourcesFn = listLinkSources,
  setRank: SetLinkSourceRankFn = setLinkSourceRank,
): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const rows = await listSources();
    return c.json(
      rows.map((row) => ({
        host: row.host,
        displayName: row.displayName,
        rank: row.rank,
        firstSeenAt: row.firstSeenAt.toISOString(),
      })),
    );
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

    const { host, rank } = body as Record<string, unknown>;
    if (typeof host !== "string" || !host.trim()) {
      return c.json({ error: "host is required" }, 400);
    }
    if (typeof rank !== "number" || !Number.isInteger(rank)) {
      return c.json({ error: "rank must be an integer" }, 400);
    }

    const updated = await setRank(host.trim(), rank);
    if (!updated) {
      return c.json({ error: "Unknown link source" }, 404);
    }
    return c.json({ host: host.trim(), rank }, 200);
  });

  return routes;
}

export const linkSourceRoutes = createLinkSourceRoutes();
