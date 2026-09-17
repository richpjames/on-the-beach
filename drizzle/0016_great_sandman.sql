ALTER TABLE `sources` ADD `can_play` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `can_buy` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `is_editorial` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Classify the sources that already exist. The ADD COLUMN default is false, so
-- without this every install that has already migrated would report that
-- nothing anywhere can be played. Keyed by `name` (unique) and written as
-- plain UPDATEs so re-running is harmless; rows absent from an install are
-- simply not touched.
--
-- can_play    : you can hear the recording there
-- can_buy     : you can acquire a copy there
-- is_editorial: it writes about the record rather than carrying it
UPDATE `sources` SET `can_play` = true WHERE `name` IN (
  'bandcamp', 'spotify', 'soundcloud', 'youtube', 'apple_music',
  'tidal', 'deezer', 'mixcloud', 'nts'
);--> statement-breakpoint
UPDATE `sources` SET `can_buy` = true WHERE `name` IN ('bandcamp', 'discogs');--> statement-breakpoint
UPDATE `sources` SET `is_editorial` = true WHERE `name` = 'pitchfork';
