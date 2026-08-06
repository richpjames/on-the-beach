import { eq } from "drizzle-orm";
import { assign, createActor, fromPromise, setup, waitFor } from "xstate";
import { db } from "./db/index";
import { musicItems, musicLinks, sources } from "./db/schema";
import { parseUrl, isValidUrl, normalize, capitalize } from "./utils";
import { scrapeUrl, UnsupportedMusicLinkError } from "./scraper";
import { enrichSecondaryLinkInBackground } from "./secondary-link-enrichment";
import { pickPrimaryReleaseCandidate } from "./link-extractor";
import { fullItemSelect } from "./queries/full-item-select";
import {
  createMusicItemDirect as createMusicItemDirectInStore,
  fetchFullItem,
  getOrCreateArtist,
  queueSuggestionPrefetch,
  type CreateMusicItemDirectOptions,
  type CreateResult,
} from "./music-item-store";
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

// Re-exported for backwards compatibility — see ./queries/full-item-select.ts
// for the actual implementation. New code should prefer importing it from
// there directly so that mocking this module in tests doesn't accidentally
// break SSR paths that need the real query builder.
export { fullItemSelect };

// Item reads and URL-less writes live in ./music-item-store.ts, out of reach
// of the process-wide `mock.module` on this file (see that module's header).
export { getOrCreateArtist, fetchFullItem };
export type { CreateResult, CreateMusicItemDirectOptions };

/**
 * Create a music item without a URL — no scraping, no link inserted.
 *
 * A wrapper, deliberately: a bare `export { createMusicItemDirect }` would be
 * a re-export, and bun's `mock.module` on *this* module follows re-export
 * chains all the way back to the defining module — which would hand the stub
 * to callers that import from `./music-item-store` precisely to avoid it.
 */
export async function createMusicItemDirect(
  overrides: Partial<CreateMusicItemInput>,
  options?: CreateMusicItemDirectOptions,
): Promise<CreateResult> {
  return createMusicItemDirectInStore(overrides, options);
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
// `hydrateItemStacks` is intentionally not re-exported. Importing it from this
// module would let `mock.module(".../music-item-creator")` (used by ingest
// tests) shadow the real implementation, which then breaks unrelated tests
// that import the helper from `./hydrate-item-stacks` directly. New code
// should import it from `./hydrate-item-stacks`.

// ---------------------------------------------------------------------------
// Shared creation logic
// ---------------------------------------------------------------------------

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
  year?: number;
  genre?: string;
  /** Provenance line for a release lifted off a page that named several — see `formatPageSourceNote`. */
  sourceNote?: string;
}

const MAX_SOURCE_NOTE_TITLE_CHARS = 120;

/**
 * The provenance line stamped on items pulled off a page listing several
 * releases. A single item's title says nothing about the round-up, chart, or
 * label page it came from, so record the page itself: its title when the
 * scrape found one, and the URL either way.
 */
export function formatPageSourceNote(url: string, pageTitle?: string): string {
  const title = pageTitle?.replace(/\s+/g, " ").trim();
  if (!title) return `From ${url}`;

  const truncated =
    title.length > MAX_SOURCE_NOTE_TITLE_CHARS
      ? `${title.slice(0, MAX_SOURCE_NOTE_TITLE_CHARS - 1).trimEnd()}…`
      : title;
  return `From ${truncated} (${url})`;
}

/**
 * Join whatever note the request supplied with the page's provenance line,
 * using the same " — " separator the photo ingest uses for its "Via photo
 * from …" suffix. Returns null when there's nothing to store.
 */
function composeNotes(notes: string | null | undefined, sourceNote?: string): string | null {
  const parts = [notes, sourceNote]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length ? parts.join(" — ") : null;
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
      notes: composeNotes(overrides?.notes, candidate.sourceNote),
      artworkUrl: overrides?.artworkUrl ?? candidate.artworkUrl ?? null,
      label: overrides?.label ?? null,
      year: overrides?.year ?? candidate.year ?? null,
      country: overrides?.country ?? null,
      genre: overrides?.genre ?? candidate.genre ?? null,
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

  // Eagerly look up a secondary link on the active streaming service in the
  // background so it's ready by the time the item is viewed. Non-blocking —
  // never delays creation.
  enrichSecondaryLinkInBackground(inserted.id);
  queueSuggestionPrefetch(item);

  return item;
}

/**
 * The candidates a client explicitly picked, in selection order. Accepts both
 * the single `selectedCandidateId` (web link picker resubmits one at a time)
 * and the plural `selectedCandidateIds` (the share sheet's release picker
 * posts its whole selection in one request). Unknown ids are dropped — a
 * candidate list is regenerated per scrape, so a stale id just falls through
 * to the ambiguous flow again rather than erroring.
 */
function resolveSelectedCandidates(
  candidates: ReleaseCandidateInput[],
  overrides: Partial<CreateMusicItemInput> | undefined,
): ReleaseCandidateInput[] {
  const ids: string[] = [];
  if (overrides?.selectedCandidateId) ids.push(overrides.selectedCandidateId);
  for (const id of overrides?.selectedCandidateIds ?? []) {
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }

  return ids
    .map((id) => candidates.find((candidate) => candidate.candidateId === id))
    .filter((candidate): candidate is ReleaseCandidateInput => candidate != null);
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
      normalizedUrl: scraped?.canonicalUrl || parsed.normalizedUrl,
      source: parsed.source,
      candidates: [
        {
          title,
          artistName,
          itemType: overrides?.itemType ?? scraped?.itemType ?? "album",
          artworkUrl: overrides?.artworkUrl ?? scraped?.imageUrl ?? null,
          embedMetadata: scraped?.embedMetadata,
          year: overrides?.year ?? scraped?.year,
          genre: overrides?.genre ?? scraped?.genre,
        },
      ],
    };
  }

  const releases = scraped?.releases ?? [];

  // A page naming several releases is a round-up, chart, or label page rather
  // than a release page: which page an item came off is worth keeping, so every
  // item created from it gets the page stamped on its notes. A page that named
  // just the one release needs no such note — its link says it all.
  const sourceNote =
    releases.length > 1
      ? formatPageSourceNote(parsed.normalizedUrl, scraped?.pageTitle)
      : undefined;

  const extractedCandidates = releases.map((release) => ({
    candidateId: release.candidateId,
    title: release.title || "Untitled",
    artistName: release.artist,
    itemType: release.itemType ?? "album",
    artworkUrl: overrides?.artworkUrl ?? scraped?.imageUrl ?? null,
    confidence: release.confidence,
    evidence: release.evidence,
    isPrimary: release.isPrimary,
    sourceNote,
  }));

  if (extractedCandidates.length === 0) {
    throw new UnsupportedMusicLinkError("Couldn't extract a release from this link");
  }

  const selectedCandidates = resolveSelectedCandidates(extractedCandidates, overrides);

  if (selectedCandidates.length === 1) {
    const selectedCandidate = selectedCandidates[0]!;
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

  if (selectedCandidates.length > 1) {
    // Several releases picked from one page: create each as extracted. The
    // title/artist/itemType overrides are per-item corrections, so they only
    // make sense for a single selection and are ignored here.
    return {
      normalizedUrl: parsed.normalizedUrl,
      source: parsed.source,
      candidates: selectedCandidates,
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
          sourceNote,
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
        // The page mentioned others but is mainly about this release — it *is*
        // the release's page, so its link already says where the item came
        // from and a provenance note would only repeat it.
        candidates: [{ ...chosen, sourceNote: undefined }],
      };
    }
  }

  throw new AmbiguousLinkSelectionError({
    kind: "ambiguous_link",
    url: parsed.normalizedUrl,
    message: "This link mentions several releases. Pick one or more to add.",
    candidates: extractedCandidates.map(toReleaseCandidate),
  });
}

// ---------------------------------------------------------------------------
// XState scraping machine
// ---------------------------------------------------------------------------

type ResolveOutput = {
  normalizedUrl: string;
  source: ReturnType<typeof parseUrl>["source"];
  candidates: ReleaseCandidateInput[];
};

interface ScrapingMachineContext {
  url: string;
  overrides: Partial<CreateMusicItemInput> | undefined;
  resolvedUrl: string;
  resolvedSource: ReturnType<typeof parseUrl>["source"];
  candidates: ReleaseCandidateInput[];
  existingItems: MusicItemFull[];
  results: CreateResult[];
  ambiguousPayload: AmbiguousLinkPayload | null;
  error: Error | null;
}

const scrapingMachine = setup({
  types: {} as {
    context: ScrapingMachineContext;
    input: { url: string; overrides?: Partial<CreateMusicItemInput> };
  },
  actors: {
    resolve: fromPromise<ResolveOutput, { url: string; overrides?: Partial<CreateMusicItemInput> }>(
      async ({ input }) => resolveReleaseCandidates(input.url, input.overrides),
    ),
    checkDuplicates: fromPromise<MusicItemFull[], { normalizedUrl: string }>(async ({ input }) =>
      fetchItemsByUrl(input.normalizedUrl),
    ),
    insert: fromPromise<
      CreateResult[],
      {
        normalizedUrl: string;
        source: ReturnType<typeof parseUrl>["source"];
        candidates: ReleaseCandidateInput[];
        existingItems: MusicItemFull[];
        overrides?: Partial<CreateMusicItemInput>;
      }
    >(async ({ input }) => {
      const { normalizedUrl, source, candidates, existingItems: baseItems, overrides } = input;
      const existingItems = [...baseItems];
      const results: CreateResult[] = [];

      for (const candidate of candidates) {
        const existing = matchExistingItem(existingItems, candidate);
        if (existing) {
          results.push({ item: existing, created: false });
          continue;
        }

        const item = await insertMusicItemWithLink(normalizedUrl, source, candidate, overrides);
        existingItems.push(item);
        results.push({ item, created: true });
      }

      return results;
    }),
  },
}).createMachine({
  context: ({ input }) => ({
    url: input.url,
    overrides: input.overrides,
    resolvedUrl: "",
    resolvedSource: "unknown" as ReturnType<typeof parseUrl>["source"],
    candidates: [],
    existingItems: [],
    results: [],
    ambiguousPayload: null,
    error: null,
  }),
  initial: "resolving",
  states: {
    resolving: {
      invoke: {
        src: "resolve",
        input: ({ context }) => ({ url: context.url, overrides: context.overrides }),
        onDone: {
          target: "checkingDuplicates",
          actions: assign(({ event }) => ({
            resolvedUrl: event.output.normalizedUrl,
            resolvedSource: event.output.source,
            candidates: event.output.candidates,
          })),
        },
        onError: [
          {
            guard: ({ event }) => event.error instanceof AmbiguousLinkSelectionError,
            target: "ambiguous",
            actions: assign(({ event }) => ({
              ambiguousPayload: (event.error as AmbiguousLinkSelectionError).payload,
            })),
          },
          {
            target: "failed",
            actions: assign(({ event }) => ({
              error: event.error instanceof Error ? event.error : new Error(String(event.error)),
            })),
          },
        ],
      },
    },
    checkingDuplicates: {
      invoke: {
        src: "checkDuplicates",
        input: ({ context }) => ({ normalizedUrl: context.resolvedUrl }),
        onDone: [
          {
            // Known source with an existing item — return it without inserting.
            guard: ({ context, event }) =>
              context.resolvedSource !== "unknown" && event.output.length > 0,
            target: "done",
            actions: assign(({ event }) => ({
              results: [{ item: event.output[0]!, created: false }],
            })),
          },
          {
            target: "inserting",
            actions: assign(({ event }) => ({ existingItems: event.output })),
          },
        ],
        onError: {
          target: "failed",
          actions: assign(({ event }) => ({
            error: event.error instanceof Error ? event.error : new Error(String(event.error)),
          })),
        },
      },
    },
    inserting: {
      invoke: {
        src: "insert",
        input: ({ context }) => ({
          normalizedUrl: context.resolvedUrl,
          source: context.resolvedSource,
          candidates: context.candidates,
          existingItems: context.existingItems,
          overrides: context.overrides,
        }),
        onDone: {
          target: "done",
          actions: assign(({ event }) => ({ results: event.output })),
        },
        onError: {
          target: "failed",
          actions: assign(({ event }) => ({
            error: event.error instanceof Error ? event.error : new Error(String(event.error)),
          })),
        },
      },
    },
    done: { type: "final" },
    ambiguous: { type: "final" },
    failed: { type: "final" },
  },
});

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
 * Orchestrated via an XState machine with explicit states for resolving,
 * duplicate checking, and inserting.
 */
export async function createMusicItemsFromUrl(
  url: string,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<CreateResult[]> {
  if (!isValidUrl(url)) {
    throw new Error("Invalid URL");
  }

  const { normalizedUrl } = parseUrl(url);
  const actor = createActor(scrapingMachine, { input: { url: normalizedUrl, overrides } });
  actor.start();

  const snapshot = await waitFor(
    actor,
    (state) => state.matches("done") || state.matches("ambiguous") || state.matches("failed"),
  );

  actor.stop();

  if (snapshot.matches("ambiguous")) {
    throw new AmbiguousLinkSelectionError(snapshot.context.ambiguousPayload!);
  }

  if (snapshot.matches("failed")) {
    throw snapshot.context.error!;
  }

  return snapshot.context.results;
}
