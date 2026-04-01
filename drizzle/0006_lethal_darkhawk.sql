ALTER TABLE `music_items` ADD `remind_at` integer;--> statement-breakpoint
ALTER TABLE `music_items` ADD `reminder_pending` integer DEFAULT false NOT NULL;