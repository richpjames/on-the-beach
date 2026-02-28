import { Hono } from "hono";
import { db } from "../db/index";
import { musicItems, artists, musicLinks, sources, stacks, musicItemStacks } from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { MusicItemFull } from "../../src/types";

type StackInfo = { id: number; name: string };

export type FetchStackFn = (stackId: number) => Promise<StackInfo | null>;
export type FetchStackItemsFn = (stackId: number) => Promise<MusicItemFull[]>;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRfc2822(isoDate: string): string {
  return new Date(isoDate).toUTCString();
}

// ---------------------------------------------------------------------------
// RSS rendering
// ---------------------------------------------------------------------------

function itemTitle(item: MusicItemFull): string {
  return item.artist_name ? `${item.artist_name} — ${item.title}` : item.title;
}

function renderRss(stack: StackInfo, items: MusicItemFull[]): string {
  const itemsXml = items
    .map((item) => {
      const title = escapeXml(itemTitle(item));
      const link = item.primary_url ? escapeXml(item.primary_url) : "";
      const pubDate = toRfc2822(item.created_at);
      const guid = `music-item-${item.id}`;

      return `    <item>
      <title>${title}</title>
      ${link ? `<link>${link}</link>` : ""}
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(stack.name)}</title>
    <description>Items in the ${escapeXml(stack.name)} stack</description>
${itemsXml}
  </channel>
</rss>`;
}

// ---------------------------------------------------------------------------
// Default DB implementations
// ---------------------------------------------------------------------------

async function defaultFetchStack(stackId: number): Promise<StackInfo | null> {
  const row = await db
    .select({ id: stacks.id, name: stacks.name })
    .from(stacks)
    .where(eq(stacks.id, stackId))
    .get();
  return row ?? null;
}

async function defaultFetchStackItems(stackId: number): Promise<MusicItemFull[]> {
  const memberships = await db
    .select({ musicItemId: musicItemStacks.musicItemId })
    .from(musicItemStacks)
    .where(eq(musicItemStacks.stackId, stackId));

  if (memberships.length === 0) return [];

  const itemIds = memberships.map((m) => m.musicItemId);

  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      normalized_title: musicItems.normalizedTitle,
      item_type: musicItems.itemType,
      artist_id: musicItems.artistId,
      artist_name: artists.name,
      listen_status: musicItems.listenStatus,
      purchase_intent: musicItems.purchaseIntent,
      price_cents: musicItems.priceCents,
      currency: musicItems.currency,
      notes: musicItems.notes,
      rating: musicItems.rating,
      created_at: musicItems.createdAt,
      updated_at: musicItems.updatedAt,
      listened_at: musicItems.listenedAt,
      artwork_url: musicItems.artworkUrl,
      is_physical: musicItems.isPhysical,
      physical_format: musicItems.physicalFormat,
      label: musicItems.label,
      year: musicItems.year,
      country: musicItems.country,
      genre: musicItems.genre,
      catalogue_number: musicItems.catalogueNumber,
      primary_url: musicLinks.url,
      primary_source: sources.name,
    })
    .from(musicItems)
    .leftJoin(artists, eq(artists.id, musicItems.artistId))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, 1)),
    )
    .leftJoin(sources, eq(sources.id, musicLinks.sourceId))
    .where(inArray(musicItems.id, itemIds))
    .orderBy(musicItems.createdAt);

  return rows.map((row) => ({
    ...row,
    id: row.id as number,
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    listened_at:
      row.listened_at instanceof Date
        ? row.listened_at.toISOString()
        : row.listened_at
          ? String(row.listened_at)
          : null,
    stacks: [],
  }));
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRssRoutes(
  fetchStack: FetchStackFn = defaultFetchStack,
  fetchStackItems: FetchStackItemsFn = defaultFetchStackItems,
): Hono {
  const routes = new Hono();

  routes.get("/stacks/:stackId.rss", async (c) => {
    // Hono v4 includes the ".rss" literal in the param name
    const raw = (c.req.param("stackId.rss") ?? "").replace(/\.rss$/, "");
    const stackId = Number(raw);
    if (!Number.isInteger(stackId) || stackId <= 0) {
      return c.json({ error: "Invalid stack ID" }, 400);
    }

    const stack = await fetchStack(stackId);
    if (!stack) {
      return c.json({ error: "Stack not found" }, 404);
    }

    const items = await fetchStackItems(stackId);
    const xml = renderRss(stack, items);

    return c.body(xml, 200, {
      "Content-Type": "application/rss+xml; charset=utf-8",
    });
  });

  return routes;
}

export const rssRoutes = createRssRoutes();
