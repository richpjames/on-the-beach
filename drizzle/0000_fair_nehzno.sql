CREATE TABLE `artists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artists_normalized_name_unique` ON `artists` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `music_item_stacks` (
	`music_item_id` integer NOT NULL,
	`stack_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`music_item_id`, `stack_id`),
	FOREIGN KEY (`music_item_id`) REFERENCES `music_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_music_item_stacks_stack_id` ON `music_item_stacks` (`stack_id`);--> statement-breakpoint
CREATE INDEX `idx_music_item_stacks_music_item_id` ON `music_item_stacks` (`music_item_id`);--> statement-breakpoint
CREATE TABLE `music_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`normalized_title` text NOT NULL,
	`item_type` text DEFAULT 'album' NOT NULL,
	`artist_id` integer,
	`listen_status` text DEFAULT 'to-listen' NOT NULL,
	`purchase_intent` text DEFAULT 'no' NOT NULL,
	`price_cents` integer,
	`currency` text DEFAULT 'USD',
	`notes` text,
	`rating` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`listened_at` integer,
	`artwork_url` text,
	`is_physical` integer DEFAULT false NOT NULL,
	`physical_format` text,
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_music_items_listen_status` ON `music_items` (`listen_status`);--> statement-breakpoint
CREATE INDEX `idx_music_items_purchase_intent` ON `music_items` (`purchase_intent`);--> statement-breakpoint
CREATE INDEX `idx_music_items_artist_id` ON `music_items` (`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_music_items_created_at` ON `music_items` (`created_at`);--> statement-breakpoint
CREATE TABLE `music_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`music_item_id` integer NOT NULL,
	`source_id` integer,
	`url` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`music_item_id`) REFERENCES `music_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_music_links_music_item_id` ON `music_links` (`music_item_id`);--> statement-breakpoint
CREATE INDEX `idx_music_links_url` ON `music_links` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `music_links_item_url` ON `music_links` (`music_item_id`,`url`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`url_pattern` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_name_unique` ON `sources` (`name`);--> statement-breakpoint
CREATE TABLE `stacks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stacks_name_unique` ON `stacks` (`name`);