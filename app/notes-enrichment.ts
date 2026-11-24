import { and, eq, sql } from "drizzle-orm";
import { db } from "../adapters/db/index";
import { externalLinkSources, musicItems } from "../adapters/db/schema";
import {
  fetchReleaseGroupIdForRelease,
  fetchReleaseGroupUrlRelations,
  type MbUrlRelation,
} from "../adapters/musicbrainz/index";
import { fetchPageHtml, MAX_REVIEW_BYTES } from "../adapters/web/fetch-page";
import { extractFirstParagraph } from "../adapters/web/first-paragraph";
import {
  composeEnrichedNotes,
  defaultRankForHost,
  isAtLeastASentence,
  isKnownLinkSource,
  linkSourceForUrl,
} from "../domain/link-sources";

// ---------------------------------------------------------------------------
// Notes enrichment — the first paragraph of the release's best external link
//
// A MusicBrainz release group carries the external links editors attached to
// the work: a Wikipedia article, a Pitchfork review, an AllMusic entry, the
// band's own page. When an item's notes are empty (or less than a sentence),
// the highest-ranked link's page is fetched and its first paragraph stored as
// the notes, with a "From X (url)" provenance line. A curated host's scoped
// article body is trusted; an unrecognised host's paragraph must read as a
// sentence first, so player-page boilerplate doesn't become notes. Rankings
// are the user's —
// recorded per host as links are met, re-rankable on /admin — and even a
// rank-0 link is fetched when nothing better is attached.
//
// Like the secondary-link lookup, this runs in three places sharing the
// orchestration below: eagerly at creation, lazily when a release page is
// opened, and in bulk via the backfill script. The attempt marker keeps a
// miss from being re-fetched on every view; a MusicBrainz failure is left
// unstamped so a later view or sweep can retry.
// ---------------------------------------------------------------------------

export interface ItemForNotesEnrichment {
  id: number;
  notes: string | null;
  notesEnrichmentAttemptedAt: Date | null;
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
}

export async function fetchItemForNotesEnrichment(
  id: number,
): Promise<ItemForNotesEnrichment | null> {
  const rows = await db
    .select({
      id: musicItems.id,
      notes: musicItems.notes,
      notesEnrichmentAttemptedAt: musicItems.notesEnrichmentAttemptedAt,
      musicbrainzReleaseId: musicItems.musicbrainzReleaseId,
      musicbrainzReleaseGroupId: musicItems.musicbrainzReleaseGroupId,
    })
    .from(musicItems)
    .where(eq(musicItems.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Link-source rankings
// ---------------------------------------------------------------------------

export interface LinkSourceRow {
  host: string;
  displayName: string;
  rank: number;
  firstSeenAt: Date;
}

/**
 * Record a host met among a release's external links. First sight wins: the
 * row keeps the rank the user gave it, and a known host arrives with its
 * default (Wikipedia 11, Pitchfork 10, AllMusic 9, everything else 0).
 */
export async function recordLinkSource(host: string, displayName: string): Promise<void> {
  await db
    .insert(externalLinkSources)
    .values({ host, displayName, rank: defaultRankForHost(host) })
    .onConflictDoNothing({ target: externalLinkSources.host });
}

/** Every encountered source, best-ranked first — the admin page's list. */
export async function listLinkSources(): Promise<LinkSourceRow[]> {
  return db
    .select()
    .from(externalLinkSources)
    .orderBy(sql`${externalLinkSources.rank} DESC`, externalLinkSources.displayName);
}

/** The current rankings, for picking the best of a release's links. */
export async function getLinkSourceRanks(): Promise<Map<string, number>> {
  const rows = await db
    .select({ host: externalLinkSources.host, rank: externalLinkSources.rank })
    .from(externalLinkSources);
  return new Map(rows.map((row) => [row.host, row.rank]));
}

/** Re-rank one source. Returns false when the host has never been met. */
export async function setLinkSourceRank(host: string, rank: number): Promise<boolean> {
  const written = await db
    .update(externalLinkSources)
    .set({ rank })
    .where(eq(externalLinkSources.host, host))
    .returning({ host: externalLinkSources.host });
  return written.length > 0;
}

// ---------------------------------------------------------------------------
// Guarded write and attempt marker
// ---------------------------------------------------------------------------

/**
 * Store the enriched notes, but only if the row still holds exactly what the
 * enrichment read — a note the user typed while the page was being fetched
 * outranks anything ingested. SQLite's `IS` compares nulls equal, so an
 * empty-note row is guarded the same way. Returns whether the write landed.
 */
export async function writeEnrichedNotes(
  itemId: number,
  notes: string,
  expectedNotes: string | null,
): Promise<boolean> {
  const written = await db
    .update(musicItems)
    .set({ notes })
    .where(and(eq(musicItems.id, itemId), sql`${musicItems.notes} IS ${expectedNotes}`))
    .returning({ id: musicItems.id });
  return written.length > 0;
}

export async function stampNotesEnrichment(itemId: number): Promise<void> {
  await db
    .update(musicItems)
    .set({ notesEnrichmentAttemptedAt: new Date() })
    .where(eq(musicItems.id, itemId));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type ResolveGroupIdFn = (releaseId: string) => Promise<string | null>;
export type FetchUrlRelationsFn = (releaseGroupId: string) => Promise<MbUrlRelation[]>;
export type RecordSourceFn = (host: string, displayName: string) => Promise<void>;
export type GetRanksFn = () => Promise<Map<string, number>>;
export type FetchHtmlFn = (url: string) => Promise<string | null>;
export type ExtractParagraphFn = (html: string, host: string) => string | null;
export type WriteNotesFn = (
  itemId: number,
  notes: string,
  expectedNotes: string | null,
) => Promise<boolean>;
export type StampNotesFn = (itemId: number) => Promise<void>;

export interface NotesEnrichmentDeps {
  fetchItem: (id: number) => Promise<ItemForNotesEnrichment | null>;
  resolveGroupId: ResolveGroupIdFn;
  fetchUrlRelations: FetchUrlRelationsFn;
  recordSource: RecordSourceFn;
  getRanks: GetRanksFn;
  fetchHtml: FetchHtmlFn;
  extractParagraph: ExtractParagraphFn;
  writeNotes: WriteNotesFn;
  stamp: StampNotesFn;
}

async function defaultResolveGroupId(releaseId: string): Promise<string | null> {
  return fetchReleaseGroupIdForRelease(releaseId);
}

async function defaultFetchHtml(url: string): Promise<string | null> {
  return fetchPageHtml(url, 10_000, { maxBytes: MAX_REVIEW_BYTES, stopAt: "</body>" });
}

export const defaultNotesEnrichmentDeps: NotesEnrichmentDeps = {
  fetchItem: fetchItemForNotesEnrichment,
  resolveGroupId: defaultResolveGroupId,
  fetchUrlRelations: fetchReleaseGroupUrlRelations,
  recordSource: recordLinkSource,
  getRanks: getLinkSourceRanks,
  fetchHtml: defaultFetchHtml,
  extractParagraph: extractFirstParagraph,
  writeNotes: writeEnrichedNotes,
  stamp: stampNotesEnrichment,
};

export type NotesEnrichmentOutcome =
  | { kind: "not_found" }
  | {
      kind: "skipped";
      reason:
        | "lookups_disabled"
        | "already_attempted"
        | "notes_complete"
        | "no_musicbrainz_id"
        | "lookup_failed";
    }
  | {
      kind: "result";
      /** The stored notes when the write landed, null when nothing changed. */
      notes: string | null;
      /** The link the paragraph came from, when one was ingested. */
      source: { displayName: string; url: string } | null;
    };

/**
 * Core enrichment shared by the creation hook, the on-view lookup and the
 * backfill sweep. Records every host met among the release group's external
 * links, fetches the best-ranked one's page, and stores its first paragraph
 * under the notes rules: empty notes take it whole, notes shorter than a
 * sentence take it appended beneath, prose is left alone. The attempt marker
 * is stamped on every settled outcome — hit or miss — but not on a
 * MusicBrainz failure (retryable) or an item with no MusicBrainz ids yet
 * (resolution may still supply them).
 */
export async function enrichNotesForItem(
  itemId: number,
  deps: NotesEnrichmentDeps = defaultNotesEnrichmentDeps,
): Promise<NotesEnrichmentOutcome> {
  const item = await deps.fetchItem(itemId);
  if (!item) return { kind: "not_found" };

  if (item.notesEnrichmentAttemptedAt) {
    return { kind: "skipped", reason: "already_attempted" };
  }
  if (item.notes && isAtLeastASentence(item.notes)) {
    await deps.stamp(itemId);
    return { kind: "skipped", reason: "notes_complete" };
  }
  // No ids at all: nothing to ask MusicBrainz about yet. Left unstamped —
  // the on-view resolution may land ids this item can be enriched from later.
  if (!item.musicbrainzReleaseGroupId && !item.musicbrainzReleaseId) {
    return { kind: "skipped", reason: "no_musicbrainz_id" };
  }

  let relations: MbUrlRelation[];
  try {
    const groupId =
      item.musicbrainzReleaseGroupId ?? (await deps.resolveGroupId(item.musicbrainzReleaseId!));
    if (!groupId) {
      await deps.stamp(itemId);
      return { kind: "result", notes: null, source: null };
    }
    relations = await deps.fetchUrlRelations(groupId);
  } catch (err) {
    console.error("[notes-enrichment] MusicBrainz lookup failed for item", itemId, err);
    return { kind: "skipped", reason: "lookup_failed" };
  }

  // Every host met is recorded, ranked or not — the admin page lists what
  // the catalogue actually points at, not just what won.
  const candidates: Array<{ host: string; displayName: string; url: string }> = [];
  for (const relation of relations) {
    const info = linkSourceForUrl(relation.url);
    if (!info) continue;
    await deps.recordSource(info.host, info.displayName);
    candidates.push({ ...info, url: relation.url });
  }
  if (candidates.length === 0) {
    await deps.stamp(itemId);
    return { kind: "result", notes: null, source: null };
  }

  const ranks = await deps.getRanks();
  const rankOf = (candidate: { host: string }) =>
    ranks.get(candidate.host) ?? defaultRankForHost(candidate.host);
  // Strict `>` keeps MusicBrainz's own ordering on a tie.
  const best = candidates.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a));

  // A page-level failure is a settled miss, not an error: the fetch already
  // degrades to null on its own, and a thrown one (a reset, a TLS failure)
  // must not surface as a 500 or leave the item re-fetching on every view.
  let html: string | null;
  try {
    html = await deps.fetchHtml(best.url);
  } catch (err) {
    console.error("[notes-enrichment] page fetch failed for item", itemId, best.url, err);
    html = null;
  }
  const paragraph = html ? deps.extractParagraph(html, best.host) : null;
  // A curated host's paragraph comes from its scoped article body and is
  // trusted. An unrecognised host has no wrapper to scope to, so its first
  // paragraph must read as a sentence before it may become notes — a player
  // page's cookie banner or nav furniture is not prose.
  const usable =
    paragraph !== null && (isKnownLinkSource(best.host) || isAtLeastASentence(paragraph));
  if (!usable) {
    await deps.stamp(itemId);
    return { kind: "result", notes: null, source: null };
  }

  const notes = composeEnrichedNotes(item.notes, paragraph, best.displayName, best.url);
  const written = await deps.writeNotes(itemId, notes, item.notes);
  await deps.stamp(itemId);
  return {
    kind: "result",
    notes: written ? notes : null,
    source: written ? { displayName: best.displayName, url: best.url } : null,
  };
}

/**
 * Fire-and-forget eager enrichment for a freshly created item. Never throws
 * and never blocks the caller — fetching a review page can take seconds.
 * No-ops under `OTB_DISABLE_EXTERNAL_LOOKUPS` (tests); the remaining skip
 * rules are enforced by the core enrichment.
 *
 * Routed through the on-view lookup so both triggers share one in-flight
 * ask: adding a release and opening it right away is a single enrichment,
 * and the page sees the eager run's result instead of a stale "no change".
 */
export function enrichNotesInBackground(itemId: number): void {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return;

  void lookupNotesForItem(itemId).catch((err) => {
    console.error("[notes-enrichment] eager enrichment failed for item", itemId, err);
  });
}

/**
 * The on-view trigger, with the same courtesies the resolution lookup extends
 * an impatient page: concurrent opens of one release share a single in-flight
 * ask, and the disabled-lookups gate answers before any work starts.
 */
export function lookupNotesForItem(itemId: number): Promise<NotesEnrichmentOutcome> {
  const existing = inFlight.get(itemId);
  if (existing) return existing;
  const pending = enrichNotesForView(itemId).finally(() => {
    inFlight.delete(itemId);
  });
  inFlight.set(itemId, pending);
  return pending;
}

const inFlight = new Map<number, Promise<NotesEnrichmentOutcome>>();

async function enrichNotesForView(itemId: number): Promise<NotesEnrichmentOutcome> {
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) {
    return { kind: "skipped", reason: "lookups_disabled" };
  }
  return enrichNotesForItem(itemId);
}
