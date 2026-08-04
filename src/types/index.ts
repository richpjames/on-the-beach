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

// Database entities
export interface Source {
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
  links: Array<{
    id: number;
    url: string;
    source_name: string | null;
    display_name: string | null;
    is_primary: boolean;
  }>;
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
