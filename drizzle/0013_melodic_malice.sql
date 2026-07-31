CREATE TABLE `artist_releases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artist_id` integer NOT NULL,
	`mb_release_group_id` text NOT NULL,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`primary_type` text,
	`secondary_types` text,
	`first_release_date` text,
	`first_release_year` integer,
	`is_baseline` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_artist_releases_artist_id` ON `artist_releases` (`artist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artist_releases_artist_group` ON `artist_releases` (`artist_id`,`mb_release_group_id`);--> statement-breakpoint
CREATE TABLE `release_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`artist_id` integer NOT NULL,
	`artist_release_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT 'new-release' NOT NULL,
	`music_item_id` integer,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artist_release_id`) REFERENCES `artist_releases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`music_item_id`) REFERENCES `music_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_release_alerts_status` ON `release_alerts` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `release_alerts_release` ON `release_alerts` (`artist_release_id`);--> statement-breakpoint
ALTER TABLE `artists` ADD `musicbrainz_artist_id` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `mbid_confidence` text;--> statement-breakpoint
ALTER TABLE `artists` ADD `mbid_resolved_at` integer;--> statement-breakpoint
ALTER TABLE `artists` ADD `follow_state` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `artists` ADD `last_polled_at` integer;--> statement-breakpoint
ALTER TABLE `artists` ADD `next_poll_at` integer;--> statement-breakpoint
ALTER TABLE `artists` ADD `poll_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_artists_next_poll_at` ON `artists` (`next_poll_at`);