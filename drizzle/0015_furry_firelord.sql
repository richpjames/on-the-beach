ALTER TABLE `music_items` ADD `musicbrainz_release_group_id` text;--> statement-breakpoint
ALTER TABLE `music_items` ADD `discogs_release_id` integer;--> statement-breakpoint
ALTER TABLE `music_items` ADD `discogs_master_id` integer;--> statement-breakpoint
ALTER TABLE `music_items` ADD `resolution_status` text;--> statement-breakpoint
ALTER TABLE `music_items` ADD `resolution_attempted_at` integer;