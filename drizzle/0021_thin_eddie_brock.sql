CREATE TABLE `external_link_sources` (
	`host` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`rank` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `music_items` ADD `notes_enrichment_attempted_at` integer;