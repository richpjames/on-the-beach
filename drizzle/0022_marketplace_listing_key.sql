ALTER TABLE `music_links` ADD `listing_key` text;--> statement-breakpoint
CREATE INDEX `idx_music_links_listing_key` ON `music_links` (`listing_key`);