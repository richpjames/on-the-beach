import { fetchReleaseGroupUrlRelations, type MbUrlRelation } from "./musicbrainz";
import {
  LOOKUP_SERVICE_CONFIG,
  saveArtwork,
  saveLink,
  stampLookup,
} from "./secondary-link-enrichment";
import { getLookupService, type LookupService } from "./settings";
import type { ServiceSearchResult } from "../ports/service-search";
import { parseUrl } from "./utils";

// ---------------------------------------------------------------------------
// The New Releases link gate
//
// A release alert is a row in a database, not a record you can play. Accepting
// one used to file an item whatever the outcome, and the queue's long tail —
// announced-only titles, catalogue rows an editor typed in from a sleeve —
// filed items with nothing behind them: no artwork, no link, nothing to click.
//
// So an alert now has to bring evidence that the record exists somewhere you
// could go and hear it, in one of two forms:
//
//   1. The provider of choice (Apple Music, or Spotify when selected) has it.
//   2. MusicBrainz's own "external links" — the url relationships on the
//      release group — point somewhere.
//
// The provider is asked first: its answer is a link on the service the user
// actually listens on, and it doubles as cover art. MusicBrainz is the
// fallback, and a broad one on purpose — any external link counts as evidence,
// though a streaming or purchase link is preferred over a database entry when
// choosing which one to keep.
//
// A check that could not complete is NOT an absence. It comes back `failed`,
// the alert stays where it is, and the user can try again — refusing a record
// because MusicBrainz was throttled would be indistinguishable, from the
// queue, from refusing it because nobody carries it.
// ---------------------------------------------------------------------------

export interface ReleaseLinkQuery {
  title: string;
  artistName: string | null;
  /** The release group whose external links stand in for the provider's answer. */
  mbReleaseGroupId: string | null;
}

export interface ReleaseLink {
  url: string;
  /** `sources.name` for the link, or null when the URL is on no service we model. */
  sourceName: string | null;
  /** Where the evidence came from, for the message shown back to the user. */
  via: "provider" | "musicbrainz";
  /** Display name of the thing that vouched for the release. */
  foundBy: string;
  /** Cover art the provider returned alongside the match, when it had any. */
  artworkUrl: string | null;
  /** The provider that was queried, and whether it was the one that answered. */
  service: LookupService;
  providerSearched: boolean;
}

export type ReleaseLinkOutcome =
  | { kind: "found"; link: ReleaseLink }
  | { kind: "none"; service: LookupService; providerSearched: boolean }
  /** External lookups are switched off (tests, offline installs) — nothing was asked. */
  | { kind: "unchecked" }
  | { kind: "failed"; message: string };

export type SearchServiceFn = (
  title: string,
  artist: string | null,
  service: LookupService,
) => Promise<ServiceSearchResult | null>;

export interface ReleaseLinkDeps {
  getService: () => Promise<LookupService>;
  searchService: SearchServiceFn;
  fetchExternalLinks: (releaseGroupId: string) => Promise<MbUrlRelation[]>;
}

export const defaultReleaseLinkDeps: ReleaseLinkDeps = {
  getService: getLookupService,
  searchService: (title, artist, service) => LOOKUP_SERVICE_CONFIG[service].search(title, artist),
  fetchExternalLinks: fetchReleaseGroupUrlRelations,
};

/**
 * Relationship types worth keeping, best first. A streaming link is the point
 * of the exercise; a Discogs or Wikidata relation still counts as evidence
 * (see the note above) but is the last thing to hand back as *the* link.
 */
const RELATION_PRIORITY = [
  "streaming",
  "free streaming",
  "purchase for download",
  "download for free",
  "purchase for mail-order",
];

function relationRank(relation: MbUrlRelation): number {
  const type = relation.type?.toLowerCase() ?? "";
  const index = RELATION_PRIORITY.indexOf(type);
  return index === -1 ? RELATION_PRIORITY.length : index;
}

/** The most useful of a release group's external links. */
export function pickExternalLink(relations: MbUrlRelation[]): MbUrlRelation | null {
  if (relations.length === 0) return null;
  return [...relations].sort((a, b) => relationRank(a) - relationRank(b))[0];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Does this release have a link anywhere the user could follow? Never throws —
 * every failure is reported as an outcome, because the caller's job is to
 * decide whether to file an item, not to handle transport errors.
 */
export async function checkReleaseLink(
  query: ReleaseLinkQuery,
  deps: ReleaseLinkDeps = defaultReleaseLinkDeps,
): Promise<ReleaseLinkOutcome> {
  // Nothing can be verified with the network switched off, and refusing every
  // release would be a worse answer than the one the gate exists to prevent.
  if (process.env.OTB_DISABLE_EXTERNAL_LOOKUPS) return { kind: "unchecked" };

  const service = await deps.getService();
  const cfg = LOOKUP_SERVICE_CONFIG[service];

  let providerSearched = false;
  let providerError: string | null = null;
  try {
    const hit = await deps.searchService(query.title, query.artistName, service);
    providerSearched = true;
    if (hit) {
      return {
        kind: "found",
        link: {
          url: hit.url,
          sourceName: cfg.sourceName,
          via: "provider",
          foundBy: cfg.displayName,
          artworkUrl: hit.artworkUrl ?? null,
          service,
          providerSearched,
        },
      };
    }
  } catch (error) {
    // A provider that refused the request has said nothing about the record.
    // Keep the reason: if MusicBrainz then comes back empty, "no link" would
    // be a conclusion drawn from half an answer.
    providerError = messageOf(error);
  }

  if (query.mbReleaseGroupId) {
    let relations: MbUrlRelation[];
    try {
      relations = await deps.fetchExternalLinks(query.mbReleaseGroupId);
    } catch (error) {
      return { kind: "failed", message: messageOf(error) };
    }

    const picked = pickExternalLink(relations);
    if (picked) {
      const parsed = parseUrl(picked.url);
      return {
        kind: "found",
        link: {
          url: picked.url,
          sourceName: parsed.source === "unknown" ? null : parsed.source,
          via: "musicbrainz",
          foundBy: "MusicBrainz",
          artworkUrl: null,
          service,
          providerSearched,
        },
      };
    }
  }

  if (providerError !== null) return { kind: "failed", message: providerError };
  return { kind: "none", service, providerSearched };
}

/**
 * Keep what a check found: the link itself, the cover art that came with it,
 * and — when the provider was asked and had nothing — the attempt marker, so
 * the release page doesn't re-ask on every view.
 *
 * The marker is withheld for a record that isn't out yet (`released` false):
 * the provider's "no" is about today, and stamping it would keep the item out
 * of the backfill for good once the record actually appeared.
 */
export async function persistReleaseLink(
  itemId: number,
  link: ReleaseLink,
  { released }: { released: boolean },
): Promise<void> {
  await saveLink(itemId, link.url, link.sourceName);
  if (link.artworkUrl) await saveArtwork(itemId, link.artworkUrl);
  if (link.via === "musicbrainz" && link.providerSearched && released) {
    await stampLookup(itemId);
  }
}
