import { sqliteTable, text, integer, unique, index, primaryKey } from "drizzle-orm/sqlite-core";

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  urlPattern: text("url_pattern"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const artists = sqliteTable(
  "artists",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    // ---- Artist watch (see server/artist-identity.ts, server/artist-watch.ts) ----
    // The artist's MusicBrainz id, promoted from music_items so that an artist —
    // not an item — is the unit of release tracking.
    musicbrainzArtistId: text("musicbrainz_artist_id"),
    // 'confirmed' | 'probable' | 'unresolved'. Only the first two are polled:
    // no alerts is the correct failure mode, alerts for the wrong band is not.
    mbidConfidence: text("mbid_confidence"),
    // Last resolution attempt, hit or miss — throttles re-resolution.
    mbidResolvedAt: integer("mbid_resolved_at", { mode: "timestamp" }),
    // 'auto' | 'always' | 'muted'. `auto` defers to the derived rule (tracked
    // iff the artist has a listened item).
    followState: text("follow_state").notNull().default("auto"),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    // Due time — the sweep's work queue. Held in the database, not the timer,
    // so a restart neither skips nor double-polls.
    nextPollAt: integer("next_poll_at", { mode: "timestamp" }),
    pollFailureCount: integer("poll_failure_count").notNull().default(0),
  },
  (table) => [index("idx_artists_next_poll_at").on(table.nextPollAt)],
);

export const musicItems = sqliteTable(
  "music_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    itemType: text("item_type").notNull().default("album"),
    artistId: integer("artist_id").references(() => artists.id, { onDelete: "set null" }),
    listenStatus: text("listen_status").notNull().default("to-listen"),
    purchaseIntent: text("purchase_intent").notNull().default("no"),
    priceCents: integer("price_cents"),
    currency: text("currency").default("USD"),
    notes: text("notes"),
    rating: integer("rating"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    addedToListenAt: integer("added_to_listen_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    listenedAt: integer("listened_at", { mode: "timestamp" }),
    artworkUrl: text("artwork_url"),
    isPhysical: integer("is_physical", { mode: "boolean" }).notNull().default(false),
    physicalFormat: text("physical_format"),
    label: text("label"),
    year: integer("year"),
    country: text("country"),
    genre: text("genre"),
    catalogueNumber: text("catalogue_number"),
    musicbrainzReleaseId: text("musicbrainz_release_id"),
    musicbrainzArtistId: text("musicbrainz_artist_id"),
    // Timestamp of the last secondary-link lookup attempt against the active
    // streaming service. Set on both a hit and a miss so we don't re-query on
    // every page view for items with no match. Cleared for all items when the
    // active service is switched (see server/settings.ts) so they're re-queried
    // against the new service. The column keeps its original name for migration
    // continuity; the field name is service-agnostic.
    lookupAttemptedAt: integer("apple_music_lookup_at", { mode: "timestamp" }),
    remindAt: integer("remind_at", { mode: "timestamp" }),
    reminderPending: integer("reminder_pending", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    index("idx_music_items_listen_status").on(table.listenStatus),
    index("idx_music_items_purchase_intent").on(table.purchaseIntent),
    index("idx_music_items_artist_id").on(table.artistId),
    index("idx_music_items_created_at").on(table.createdAt),
    index("idx_music_items_added_to_listen_at").on(table.addedToListenAt),
  ],
);

export const musicLinks = sqliteTable(
  "music_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    musicItemId: integer("music_item_id")
      .notNull()
      .references(() => musicItems.id, { onDelete: "cascade" }),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    // Source-specific embed metadata as JSON (e.g. { album_id, item_type } for Bandcamp)
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    unique("music_links_item_url").on(table.musicItemId, table.url),
    index("idx_music_links_music_item_id").on(table.musicItemId),
    index("idx_music_links_url").on(table.url),
  ],
);

export const stacks = sqliteTable("stacks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const musicItemOrder = sqliteTable("music_item_order", {
  contextKey: text("context_key").primaryKey(),
  itemIds: text("item_ids").notNull(), // JSON array of item IDs
});

export const musicItemStacks = sqliteTable(
  "music_item_stacks",
  {
    musicItemId: integer("music_item_id")
      .notNull()
      .references(() => musicItems.id, { onDelete: "cascade" }),
    stackId: integer("stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.musicItemId, table.stackId] }),
    index("idx_music_item_stacks_stack_id").on(table.stackId),
    index("idx_music_item_stacks_music_item_id").on(table.musicItemId),
  ],
);

export const stackParents = sqliteTable(
  "stack_parents",
  {
    parentStackId: integer("parent_stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    childStackId: integer("child_stack_id")
      .notNull()
      .references(() => stacks.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.parentStackId, table.childStackId] }),
    index("idx_stack_parents_parent_stack_id").on(table.parentStackId),
    index("idx_stack_parents_child_stack_id").on(table.childStackId),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const itemSuggestions = sqliteTable(
  "item_suggestions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceItemId: integer("source_item_id")
      .notNull()
      .references(() => musicItems.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    artistName: text("artist_name").notNull(),
    itemType: text("item_type").notNull().default("album"),
    year: integer("year"),
    musicbrainzReleaseId: text("musicbrainz_release_id"),
    musicbrainzReleaseGroupId: text("musicbrainz_release_group_id"),
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("idx_item_suggestions_source_item_id").on(table.sourceItemId)],
);

/**
 * Every MusicBrainz release group we've seen for a tracked artist. The first
 * successful poll writes the artist's whole discography with `isBaseline` set
 * and raises no alerts; only rows first seen after that can alert.
 */
export const artistReleases = sqliteTable(
  "artist_releases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    mbReleaseGroupId: text("mb_release_group_id").notNull(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    primaryType: text("primary_type"),
    secondaryTypes: text("secondary_types"), // JSON array
    // MusicBrainz's date verbatim — partial dates ("1974", "1974-05") are
    // normal and coercing them to a full Date invents precision.
    firstReleaseDate: text("first_release_date"),
    firstReleaseYear: integer("first_release_year"),
    isBaseline: integer("is_baseline", { mode: "boolean" }).notNull().default(false),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    unique("artist_releases_artist_group").on(table.artistId, table.mbReleaseGroupId),
    index("idx_artist_releases_artist_id").on(table.artistId),
  ],
);

/**
 * The user-facing alert queue. The unique index on `artistReleaseId` is the
 * idempotency guarantee: a release can alert once, ever, however the sweep is
 * retried or restarted.
 */
export const releaseAlerts = sqliteTable(
  "release_alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    artistReleaseId: integer("artist_release_id")
      .notNull()
      .references(() => artistReleases.id, { onDelete: "cascade" }),
    // pending | seen | added | dismissed
    status: text("status").notNull().default("pending"),
    // Why it fired: announced | new-release | catalogue-addition
    reason: text("reason").notNull().default("new-release"),
    musicItemId: integer("music_item_id").references(() => musicItems.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (table) => [
    unique("release_alerts_release").on(table.artistReleaseId),
    index("idx_release_alerts_status").on(table.status),
  ],
);
