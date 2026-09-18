// Listen/purchase status types
export type ListenStatus = "to-listen" | "listened";
export type PurchaseIntent = "no" | "maybe" | "want" | "owned";
export type ItemType = "album" | "ep" | "single" | "track" | "mix" | "compilation";
export type PhysicalFormat = "vinyl" | "cd" | "cassette" | "minidisc" | "other";
export type MusicItemSort =
  | "date-added"
  | "date-listened"
  | "artist-name"
  | "release-name"
  | "star-rating";
export type MusicItemSortDirection = "asc" | "desc";
/** What a browse list is filtered down to — the statuses plus the two pseudo-filters. */
export type FilterSelection = ListenStatus | "all" | "scheduled";

export type SourceName =
  | "bandcamp"
  | "spotify"
  | "soundcloud"
  | "youtube"
  | "apple_music"
  | "discogs"
  | "tidal"
  | "deezer"
  | "mixcloud"
  | "nts"
  | "pitchfork"
  | "physical"
  | "unknown";

/**
 * What a source lets you do with a record, independent of which service it is.
 *
 * `SourceName` says *who* a link is with; this says *what for*. The three flags
 * are independent rather than one role, because the cases overlap: Bandcamp
 * plays and sells, Discogs sells without playing, Pitchfork does neither. All
 * three false is meaningful — a physical copy, or a link to somewhere we don't
 * model.
 *
 * Authoritative values live on the `sources` table (see `server/db/seed.ts`),
 * so they can be corrected without a deploy.
 */
export interface SourceCapabilities {
  /** You can hear the recording here, in full or as a preview. */
  can_play: boolean;
  /** You can acquire a copy here, digital or physical. */
  can_buy: boolean;
  /** The page writes *about* the record rather than carrying it. */
  is_editorial: boolean;
}

/** What a link on a source we don't model can be assumed to offer: nothing. */
export const NO_SOURCE_CAPABILITIES: SourceCapabilities = {
  can_play: false,
  can_buy: false,
  is_editorial: false,
};

// Database entities
export interface Source extends SourceCapabilities {
  id: number;
  name: SourceName;
  display_name: string;
  url_pattern: string | null;
  created_at: string;
}

export interface Artist {
  id: number;
  name: string;
  normalized_name: string;
  created_at: string;
  updated_at: string;
}

export interface MusicItem {
  id: number;
  title: string;
  normalized_title: string;
  item_type: ItemType;
  artist_id: number | null;
  listen_status: ListenStatus;
  purchase_intent: PurchaseIntent;
  price_cents: number | null;
  currency: string;
  notes: string | null;
  rating: number | null;
  created_at: string;
  updated_at: string;
  listened_at: string | null;
  artwork_url: string | null;
  is_physical: number;
  physical_format: PhysicalFormat | null;
  label: string | null;
  year: number | null;
  country: string | null;
  genre: string | null;
  catalogue_number: string | null;
  musicbrainz_release_id: string | null;
  musicbrainz_artist_id: string | null;
  remind_at: string | null;
  reminder_pending: boolean;
}

export interface MusicLink {
  id: number;
  music_item_id: number;
  source_id: number | null;
  url: string;
  is_primary: number;
  created_at: string;
}

// Full view with joins
export interface MusicItemFull extends MusicItem {
  artist_name: string | null;
  primary_url: string | null;
  primary_source: SourceName | null;
  primary_link_metadata: string | null;
  stacks: Array<{ id: number; name: string }>;
  links: MusicItemLink[];
}

/**
 * A link on an item, carrying its source's capabilities so the UI can sort
 * "listen here" from "read about it" without a second lookup. The flags are
 * non-null even when `source_name` is — a link to somewhere unmodelled offers
 * nothing we can promise, which is `NO_SOURCE_CAPABILITIES`.
 */
export interface MusicItemLink extends SourceCapabilities {
  id: number;
  url: string;
  source_name: string | null;
  display_name: string | null;
  is_primary: boolean;
  /** Embed ids scraped from the linked page (e.g. Bandcamp's album_id). */
  metadata: string | null;
}

// Input types for create/update
export interface CreateMusicItemInput {
  title?: string;
  url?: string;
  artistName?: string;
  itemType?: ItemType;
  listenStatus?: ListenStatus;
  purchaseIntent?: PurchaseIntent;
  notes?: string;
  artworkUrl?: string;
  label?: string;
  year?: number;
  country?: string;
  genre?: string;
  catalogueNumber?: string;
  musicbrainzReleaseId?: string;
  musicbrainzArtistId?: string;
  selectedCandidateId?: string;
  /**
   * Multi-select counterpart to `selectedCandidateId`, used when a page names
   * several releases and the client picked more than one — the share sheet's
   * release picker sends these. One item is created per resolved candidate.
   */
  selectedCandidateIds?: string[];
  /**
   * Ask the server to reject a would-be duplicate with a 409 `duplicate_item`
   * payload instead of inserting (or silently returning the existing item).
   * Set by the web add form; ingest paths leave it off.
   */
  warnOnDuplicate?: boolean;
  /** Confirmed "add anyway" — insert even when it matches an existing item. */
  forceDuplicate?: boolean;
}

export interface UpdateMusicItemInput {
  title?: string;
  artistName?: string;
  itemType?: ItemType;
  listenStatus?: ListenStatus;
  purchaseIntent?: PurchaseIntent;
  priceCents?: number | null;
  currency?: string;
  notes?: string | null;
  rating?: number | null;
  artworkUrl?: string | null;
  label?: string | null;
  year?: number | null;
  country?: string | null;
  genre?: string | null;
  catalogueNumber?: string | null;
  musicbrainzReleaseId?: string | null;
  musicbrainzArtistId?: string | null;
}

// Query/filter types
export interface MusicItemFilters {
  listenStatus?: ListenStatus | ListenStatus[];
  purchaseIntent?: PurchaseIntent | PurchaseIntent[];
  search?: string;
  stackId?: number;
  sort?: MusicItemSort;
  sortDirection?: MusicItemSortDirection;
  hasReminder?: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
}

export interface ScanResult {
  artist: string | null;
  title: string | null;
  artistConfidence: number;
  titleConfidence: number;
  // Optional fields populated by MusicBrainz enrichment. genre is omitted
  // intentionally — it requires a separate release-group lookup.
  year?: number | null;
  label?: string | null;
  country?: string | null;
  catalogueNumber?: string | null;
  musicbrainzReleaseId?: string | null;
  musicbrainzArtistId?: string | null;
}

export interface UploadImageResult {
  artworkUrl: string;
}

export interface LookupReleaseResult {
  year?: number | null;
  label?: string | null;
  country?: string | null;
  catalogueNumber?: string | null;
  musicbrainzReleaseId?: string | null;
  musicbrainzArtistId?: string | null;
  artworkUrl?: string;
}

export interface LinkReleaseCandidate {
  candidateId: string;
  artist?: string;
  title: string;
  itemType?: ItemType;
  confidence?: number;
  evidence?: string;
  isPrimary?: boolean;
  /** The release's own page, when the link that was added merely listed it. */
  url?: string;
}

export interface RecognizeResult {
  recognized: boolean;
  artist?: string;
  title?: string;
  album?: string;
  year?: string;
}

export interface AmbiguousLinkPayload {
  kind: "ambiguous_link";
  url: string;
  message: string;
  candidates: LinkReleaseCandidate[];
}

/**
 * The `409` a warn-mode create returns when the release matches something
 * already in the list. `items` carries the matches so the client can show
 * them; the user decides whether to add a second copy anyway.
 */
export interface DuplicateItemPayload {
  kind: "duplicate_item";
  url?: string;
  message: string;
  items: MusicItemFull[];
}

// Stacks
export interface Stack {
  id: number;
  name: string;
  created_at: string;
  parent_stack_ids: number[];
}

export interface StackWithCount extends Stack {
  item_count: number;
}

export interface ItemSuggestion {
  id: number;
  sourceItemId: number;
  title: string;
  artistName: string;
  itemType: string;
  year: number | null;
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
  status: string;
  createdAt: string;
}

// ── Artist tracking & new-release alerts ────────────────────────────────────

export type ReleaseAlertStatus = "pending" | "seen" | "added" | "dismissed";
/** Why an alert fired: it's announced, it's recent, or MusicBrainz just got it. */
export type ReleaseAlertReason = "announced" | "new-release" | "catalogue-addition";
export type ArtistFollowState = "auto" | "always" | "muted";
export type MbidConfidence = "confirmed" | "probable" | "unresolved";

export interface ReleaseAlert {
  id: number;
  status: ReleaseAlertStatus;
  reason: ReleaseAlertReason;
  created_at: string;
  resolved_at: string | null;
  music_item_id: number | null;
  artist_id: number;
  artist_name: string;
  musicbrainz_artist_id: string | null;
  release_id: number;
  mb_release_group_id: string;
  title: string;
  primary_type: string | null;
  secondary_types: string[];
  /** MusicBrainz's date verbatim — may be partial ("2026", "2026-09"). */
  first_release_date: string | null;
  first_release_year: number | null;
}

/** One of MusicBrainz's external links, tidied for display on a card. */
export interface ReleaseAlertDetailLink {
  url: string;
  /** The site, as a person would name it — "Bandcamp", "Apple Music". */
  label: string;
  /** MB's relationship type: "streaming", "free streaming", "discogs"… */
  kind: string | null;
  /** Somewhere you can actually hear the record, as opposed to read about it. */
  listenable: boolean;
}

export interface ReleaseAlertTrack {
  /** MB's track number verbatim — "1", or "A2" on a vinyl tracklist. */
  number: string | null;
  title: string;
  lengthMs: number | null;
}

/**
 * The expanded view of an alert: what MusicBrainz knows about the record
 * beyond the handful of fields the watcher stored when it raised the alert.
 * Fetched on demand when a card is opened, never as part of the queue.
 */
export interface ReleaseAlertDetail {
  musicbrainzUrl: string;
  artistMusicbrainzUrl: string | null;
  coverArtUrl: string;
  disambiguation: string | null;
  artistCredit: string | null;
  firstReleaseDate: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
  links: ReleaseAlertDetailLink[];
  tracks: ReleaseAlertTrack[];
  trackCount: number | null;
  totalLengthMs: number | null;
  label: string | null;
  country: string | null;
  format: string | null;
  /** The edition `tracks` was read from — editions differ, so it's named. */
  releaseTitle: string | null;
  releaseDate: string | null;
}

/**
 * MusicBrainz is a third party that can be down, throttling, or switched off
 * (`OTB_DISABLE_EXTERNAL_LOOKUPS`). A panel that can't be filled says so
 * rather than rendering an empty tracklist as though the record had none.
 */
export type ReleaseAlertDetailResult =
  | { detail: ReleaseAlertDetail; error: null }
  | { detail: null; error: string };

/** The link that vouched for an accepted release. */
export interface ReleaseAlertLink {
  url: string;
  /** "Apple Music", "Spotify" or "MusicBrainz". */
  foundBy: string;
  via: "provider" | "musicbrainz";
}

/**
 * Accepting an alert can be refused: a release is only filed once there is a
 * link to it, either on the provider of choice or among MusicBrainz's external
 * links. `no_link` is a decision about the record; `link_check_failed` means
 * the lookup itself didn't complete and the alert is worth retrying.
 *
 * A record that isn't out yet is exempt — it is scheduled unchecked, and the
 * server runs the check on release day before letting it into To Listen.
 */
export type AddReleaseAlertResult =
  | { added: true; item: MusicItemFull; remindAt: string | null; link: ReleaseAlertLink | null }
  | { added: false; reason: "no_link" | "link_check_failed"; message: string };

export interface TrackedArtist {
  id: number;
  name: string;
  musicbrainz_artist_id: string | null;
  mbid_confidence: MbidConfidence;
  follow_state: ArtistFollowState;
  last_polled_at: string | null;
  next_poll_at: string | null;
  poll_failure_count: number;
}

export interface MbArtistCandidateView {
  id: string;
  name: string;
  score: number;
  disambiguation: string | null;
  country: string | null;
  type: string | null;
  lifeSpanBegin: string | null;
  lifeSpanEnd: string | null;
}
