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

export const artists = sqliteTable("artists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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
    listenedAt: integer("listened_at", { mode: "timestamp" }),
    artworkUrl: text("artwork_url"),
    isPhysical: integer("is_physical", { mode: "boolean" }).notNull().default(false),
    physicalFormat: text("physical_format"),
    label: text("label"),
    year: integer("year"),
    country: text("country"),
    genre: text("genre"),
    catalogueNumber: text("catalogue_number"),
  },
  (table) => [
    index("idx_music_items_listen_status").on(table.listenStatus),
    index("idx_music_items_purchase_intent").on(table.purchaseIntent),
    index("idx_music_items_artist_id").on(table.artistId),
    index("idx_music_items_created_at").on(table.createdAt),
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
