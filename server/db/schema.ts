import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  unique,
  index,
  primaryKey,
  pgEnum,
} from 'drizzle-orm/pg-core'

export const listenStatusEnum = pgEnum('listen_status', [
  'to-listen',
  'listening',
  'listened',
  'to-revisit',
  'done',
])

export const purchaseIntentEnum = pgEnum('purchase_intent', [
  'no',
  'maybe',
  'want',
  'owned',
])

export const itemTypeEnum = pgEnum('item_type', [
  'album',
  'ep',
  'single',
  'track',
  'mix',
  'compilation',
])

export const sources = pgTable('sources', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  displayName: text('display_name').notNull(),
  urlPattern: text('url_pattern'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const artists = pgTable('artists', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const musicItems = pgTable('music_items', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  normalizedTitle: text('normalized_title').notNull(),
  itemType: itemTypeEnum('item_type').notNull().default('album'),
  artistId: integer('artist_id').references(() => artists.id, { onDelete: 'set null' }),
  listenStatus: listenStatusEnum('listen_status').notNull().default('to-listen'),
  purchaseIntent: purchaseIntentEnum('purchase_intent').notNull().default('no'),
  priceCents: integer('price_cents'),
  currency: text('currency').default('USD'),
  notes: text('notes'),
  rating: integer('rating'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  listenedAt: timestamp('listened_at', { withTimezone: true }),
  isPhysical: boolean('is_physical').notNull().default(false),
  physicalFormat: text('physical_format'),
}, (table) => [
  index('idx_music_items_listen_status').on(table.listenStatus),
  index('idx_music_items_purchase_intent').on(table.purchaseIntent),
  index('idx_music_items_artist_id').on(table.artistId),
  index('idx_music_items_created_at').on(table.createdAt),
])

export const musicLinks = pgTable('music_links', {
  id: serial('id').primaryKey(),
  musicItemId: integer('music_item_id')
    .notNull()
    .references(() => musicItems.id, { onDelete: 'cascade' }),
  sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
  url: text('url').notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('music_links_item_url').on(table.musicItemId, table.url),
  index('idx_music_links_music_item_id').on(table.musicItemId),
  index('idx_music_links_url').on(table.url),
])

export const stacks = pgTable('stacks', {
  id: serial('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const musicItemStacks = pgTable('music_item_stacks', {
  musicItemId: integer('music_item_id')
    .notNull()
    .references(() => musicItems.id, { onDelete: 'cascade' }),
  stackId: integer('stack_id')
    .notNull()
    .references(() => stacks.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.musicItemId, table.stackId] }),
  index('idx_music_item_stacks_stack_id').on(table.stackId),
  index('idx_music_item_stacks_music_item_id').on(table.musicItemId),
])
