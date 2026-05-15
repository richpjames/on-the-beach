ALTER TABLE `music_items` ADD `added_to_listen_at` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `music_items` SET `added_to_listen_at` = `created_at`;--> statement-breakpoint
CREATE INDEX `idx_music_items_added_to_listen_at` ON `music_items` (`added_to_listen_at`);
