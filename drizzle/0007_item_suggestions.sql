CREATE TABLE `item_suggestions` (
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
CREATE INDEX `idx_item_suggestions_source_item_id` ON `item_suggestions` (`source_item_id`);
