import { eq, and } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems, artists, musicLinks, sources, musicItemStacks, stacks } from "./db/schema";
import { parseUrl, isValidUrl, normalize, capitalize } from "./utils";
import { scrapeUrl, UnsupportedMusicLinkError } from "./scraper";
import { pickPrimaryReleaseCandidate } from "./link-extractor";
import type {
  AmbiguousLinkPayload,
  CreateMusicItemInput,
  ItemType,
  LinkReleaseCandidate,
  MusicItemFull,
} from "../src/types";

// ---------------------------------------------------------------------------
// Helpers (moved from routes/music-items.ts for shared use)
// ---------------------------------------------------------------------------

/**
 * Build the "full" music-item query that joins artists, primary music_link,
 * and sources to produce the MusicItemFull shape the frontend expects.
 */
export function fullItemSelect() {
  return db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      normalized_title: musicItems.normalizedTitle,
      item_type: musicItems.itemType,
      artist_id: musicItems.artistId,
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
      artist_name: artists.name,
      primary_url: musicLinks.url,
      primary_source: sources.name,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .leftJoin(
      musicLinks,
      and(eq(musicLinks.musicItemId, musicItems.id), eq(musicLinks.isPrimary, true)),
    )
    .leftJoin(sources, eq(musicLinks.sourceId, sources.id));
}

/** Look up an existing artist by normalized name, or create a new one. */
export async function getOrCreateArtist(name: string): Promise<number> {
  const normalizedName = normalize(name);

  const existing = await db
    .select({ id: artists.id })
    .from(artists)
    .where(eq(artists.normalizedName, normalizedName))
    .limit(1);

  if (existing[0]) {
    return existing[0].id;
  }

  const [created] = await db
    .insert(artists)
    .values({ name: capitalize(name), normalizedName })
    .returning({ id: artists.id });

  return created.id;
}

/** Resolve the DB id for a source name (e.g. "bandcamp"). */
export async function getSourceId(sourceName: string): Promise<number | null> {
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.name, sourceName))
    .limit(1);

  return rows[0]?.id ?? null;
}

export type { ItemWithStacks } from "./hydrate-item-stacks";
export { hydrateItemStacks } from "./hydrate-item-stacks";

/** Fetch a single full item by its id, including stacks. */
export async function fetchFullItem(id: number): Promise<MusicItemFull | null> {
  const rows = await fullItemSelect().where(eq(musicItems.id, id));
  if (!rows[0]) return null;

  const stackRows = await db
    .select({ musicItemId: musicItemStacks.musicItemId, id: stacks.id, name: stacks.name })
    .from(musicItemStacks)
    .innerJoin(stacks, eq(stacks.id, musicItemStacks.stackId))
    .where(eq(musicItemStacks.musicItemId, id));

  const item = {
    ...(rows[0] as unknown as MusicItemFull),
    stacks: [] as Array<{ id: number; name: string }>,
  };
  item.stacks = stackRows.map((r) => ({ id: r.id, name: r.name }));
  return item;
}

// ---------------------------------------------------------------------------
// Shared creation logic
// ---------------------------------------------------------------------------

export interface CreateResult {
  item: MusicItemFull;
  created: boolean;
}

interface ReleaseCandidateInput {
  candidateId?: string;
  title: string;
  artistName?: string;
  itemType: ItemType;
  artworkUrl?: string | null;
  confidence?: number;
  evidence?: string;
  isPrimary?: boolean;
  embedMetadata?: Record<string, string>;
}

export class AmbiguousLinkSelectionError extends Error {
  payload: AmbiguousLinkPayload;

  constructor(payload: AmbiguousLinkPayload) {
    super(payload.message);
    this.name = "AmbiguousLinkSelectionError";
    this.payload = payload;
  }
}

function toReleaseCandidate(input: ReleaseCandidateInput): LinkReleaseCandidate {
  return {
    candidateId: input.candidateId ?? `${normalize(input.title)}`,
    artist: input.artistName,
    title: input.title,
    itemType: input.itemType,
    confidence: input.confidence,
    evidence: input.evidence,
    isPrimary: input.isPrimary,
  };
}

function matchExistingItem(
  items: MusicItemFull[],
  candidate: ReleaseCandidateInput,
): MusicItemFull | null {
  const normalizedTitle = normalize(candidate.title);
  const normalizedArtist = candidate.artistName ? normalize(candidate.artistName) : null;

  for (const item of items) {
    if (item.normalized_title !== normalizedTitle) {
      continue;
    }

    const itemArtist = item.artist_name ? normalize(item.artist_name) : null;
    if (normalizedArtist !== itemArtist) {
      continue;
    }

    return item;
  }

  return null;
}

async function fetchItemsByUrl(url: string): Promise<MusicItemFull[]> {
  const rows = await db
    .select({ musicItemId: musicLinks.musicItemId })
    .from(musicLinks)
    .where(eq(musicLinks.url, url));

  const items = await Promise.all(rows.map((row) => fetchFullItem(row.musicItemId)));
  return items.filter((item): item is MusicItemFull => item !== null);
}

async function insertMusicItemWithLink(
  normalizedUrl: string,
  sourceName: string,
  candidate: ReleaseCandidateInput,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<MusicItemFull> {
  let artistId: number | null = null;
  if (candidate.artistName) {
    artistId = await getOrCreateArtist(candidate.artistName);
  }

  const sourceId = await getSourceId(sourceName);

  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: capitalize(candidate.title),
      normalizedTitle: normalize(candidate.title),
      itemType: candidate.itemType,
      artistId,
      listenStatus: overrides?.listenStatus ?? "to-listen",
      purchaseIntent: overrides?.purchaseIntent ?? "no",
      notes: overrides?.notes ?? null,
      artworkUrl: overrides?.artworkUrl ?? candidate.artworkUrl ?? null,
      label: overrides?.label ?? null,
      year: overrides?.year ?? null,
      country: overrides?.country ?? null,
      genre: overrides?.genre ?? null,
      catalogueNumber: overrides?.catalogueNumber ?? null,
      musicbrainzReleaseId: overrides?.musicbrainzReleaseId ?? null,
      musicbrainzArtistId: overrides?.musicbrainzArtistId ?? null,
    })
    .returning({ id: musicItems.id });

  await db.insert(musicLinks).values({
    musicItemId: inserted.id,
    sourceId,
    url: normalizedUrl,
    isPrimary: true,
    metadata: candidate.embedMetadata ? JSON.stringify(candidate.embedMetadata) : null,
  });

  const item = await fetchFullItem(inserted.id);
  if (!item) {
    throw new Error("Failed to fetch created item");
  }

  return item;
}

function resolveSelectedCandidate(
  candidates: ReleaseCandidateInput[],
  selectedCandidateId: string | undefined,
): ReleaseCandidateInput | null {
  if (!selectedCandidateId) {
    return null;
  }

  return candidates.find((candidate) => candidate.candidateId === selectedCandidateId) ?? null;
}

async function resolveReleaseCandidates(
  normalizedUrl: string,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<{
  normalizedUrl: string;
  source: ReturnType<typeof parseUrl>["source"];
  candidates: ReleaseCandidateInput[];
}> {
  const parsed = parseUrl(normalizedUrl);
  const scraped = await scrapeUrl(parsed.normalizedUrl, parsed.source);

  if (parsed.source !== "unknown") {
    const title =
      overrides?.title || scraped?.potentialTitle || parsed.potentialTitle || "Untitled";
    const artistName = overrides?.artistName || scraped?.potentialArtist || parsed.potentialArtist;

    return {
      normalizedUrl: parsed.normalizedUrl,
      source: parsed.source,
      candidates: [
        {
          title,
          artistName,
          itemType: overrides?.itemType ?? scraped?.itemType ?? "album",
          artworkUrl: overrides?.artworkUrl ?? scraped?.imageUrl ?? null,
          embedMetadata: scraped?.embedMetadata,
        },
      ],
    };
  }

  const extractedCandidates =
    scraped?.releases?.map((release) => ({
      candidateId: release.candidateId,
      title: release.title || "Untitled",
      artistName: release.artist,
      itemType: release.itemType ?? "album",
      artworkUrl: overrides?.artworkUrl ?? scraped?.imageUrl ?? null,
      confidence: release.confidence,
      evidence: release.evidence,
      isPrimary: release.isPrimary,
    })) ?? [];

  if (extractedCandidates.length === 0) {
    throw new UnsupportedMusicLinkError("Couldn't extract a release from this link");
  }

  const selectedCandidate = resolveSelectedCandidate(
    extractedCandidates,
    overrides?.selectedCandidateId,
  );

  if (selectedCandidate) {
    return {
      normalizedUrl: parsed.normalizedUrl,
      source: parsed.source,
      candidates: [
        {
          ...selectedCandidate,
          title: overrides?.title || selectedCandidate.title,
          artistName: overrides?.artistName || selectedCandidate.artistName,
          itemType: overrides?.itemType ?? selectedCandidate.itemType,
        },
      ],
    };
  }

  if (overrides?.title?.trim()) {
    return {
      normalizedUrl: parsed.normalizedUrl,
      source: parsed.source,
      candidates: [
        {
          title: overrides.title.trim(),
          artistName: overrides.artistName?.trim() || undefined,
          itemType: overrides.itemType ?? "album",
          artworkUrl: overrides.artworkUrl ?? scraped?.imageUrl ?? null,
        },
      ],
    };
  }

  const primaryCandidate = pickPrimaryReleaseCandidate(
    parsed.normalizedUrl,
    extractedCandidates.map(toReleaseCandidate),
  );

  if (primaryCandidate) {
    const chosen = extractedCandidates.find(
      (candidate) => candidate.candidateId === primaryCandidate.candidateId,
    );
    if (chosen) {
      return {
        normalizedUrl: parsed.normalizedUrl,
        source: parsed.source,
        candidates: [chosen],
      };
    }
  }

  throw new AmbiguousLinkSelectionError({
    kind: "ambiguous_link",
    url: parsed.normalizedUrl,
    message: "This link mentions several releases. Pick one to add.",
    candidates: extractedCandidates.map(toReleaseCandidate),
  });
}

/**
 * Create a music item from a URL. Handles URL parsing, OG scraping,
 * artist resolution, and duplicate detection.
 *
 * Returns `{ created: false }` if the URL already exists in music_links.
 */
export async function createMusicItemFromUrl(
  url: string,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<CreateResult> {
  const results = await createMusicItemsFromUrl(url, overrides);
  const preferred = results.find((result) => result.created) ?? results[0];
  if (!preferred) {
    throw new Error("Failed to create music item");
  }

  return preferred;
}

/**
 * Create music items from a URL, returning results as an array.
 */
export async function createMusicItemsFromUrl(
  url: string,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<CreateResult[]> {
  if (!isValidUrl(url)) {
    throw new Error("Invalid URL");
  }

  const parsed = parseUrl(url);
  const resolved = await resolveReleaseCandidates(parsed.normalizedUrl, overrides);
  const existingItems = await fetchItemsByUrl(resolved.normalizedUrl);

  if (resolved.source !== "unknown" && existingItems[0]) {
    return [{ item: existingItems[0], created: false }];
  }

  const results: CreateResult[] = [];

  for (const candidate of resolved.candidates) {
    const existing = matchExistingItem(existingItems, candidate);
    if (existing) {
      results.push({ item: existing, created: false });
      continue;
    }

    const item = await insertMusicItemWithLink(
      resolved.normalizedUrl,
      resolved.source,
      candidate,
      overrides,
    );
    existingItems.push(item);
    results.push({ item, created: true });
  }

  return results;
}

/**
 * Create a music item without a URL — no scraping, no link inserted.
 * Used for physical records or items known only from memory.
 */
export async function createMusicItemDirect(
  overrides: Partial<CreateMusicItemInput>,
): Promise<CreateResult> {
  const title = overrides.title || "Untitled";
  const artistName = overrides.artistName;

  let artistId: number | null = null;
  if (artistName) {
    artistId = await getOrCreateArtist(artistName);
  }

  const [inserted] = await db
    .insert(musicItems)
    .values({
      title: capitalize(title),
      normalizedTitle: normalize(title),
      itemType: overrides.itemType ?? "album",
      artistId,
      listenStatus: overrides.listenStatus ?? "to-listen",
      purchaseIntent: overrides.purchaseIntent ?? "no",
      notes: overrides.notes ?? null,
      artworkUrl: overrides.artworkUrl ?? null,
      label: overrides.label ?? null,
      year: overrides.year ?? null,
      country: overrides.country ?? null,
      genre: overrides.genre ?? null,
      catalogueNumber: overrides.catalogueNumber ?? null,
      musicbrainzReleaseId: overrides.musicbrainzReleaseId ?? null,
      musicbrainzArtistId: overrides.musicbrainzArtistId ?? null,
    })
    .returning({ id: musicItems.id });

  const item = await fetchFullItem(inserted.id);
  if (!item) {
    throw new Error("Failed to fetch created item");
  }

  return { item, created: true };
}
