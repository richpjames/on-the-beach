-- Re-create item_suggestions for databases that skipped migration 0007.
--
-- 0007_item_suggestions was retro-inserted into the journal with a fabricated
-- timestamp (1775150000000) that slots between 0006 and 0008. Drizzle's
-- migrator only applies entries newer than the last applied migration's
-- timestamp, so any database that had already applied 0008 by then — i.e.
-- production — skipped 0007 forever and never got the table. Every
-- suggestion query has thrown since, which is why the "you might also like"
-- prompt never worked in production while passing in every fresh database.
--
-- IF NOT EXISTS makes this a no-op for databases that did apply 0007.
CREATE TABLE IF NOT EXISTS `item_suggestions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `source_item_id` integer NOT NULL REFERENCES `music_items`(`id`) ON DELETE CASCADE,
  `title` text NOT NULL,
  `artist_name` text NOT NULL,
  `item_type` text NOT NULL DEFAULT 'album',
  `year` integer,
  `musicbrainz_release_id` text,
  `status` text NOT NULL DEFAULT 'pending',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_item_suggestions_source_item_id` ON `item_suggestions` (`source_item_id`);
