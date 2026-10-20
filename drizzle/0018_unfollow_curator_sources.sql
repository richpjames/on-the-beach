-- Mixcloud and NTS file a link under a show or an uploader's handle where
-- other sources name an act, so "following" one meant resolving that handle
-- on MusicBrainz and watching a stranger's discography. The tracking rule now
-- discounts items whose primary link is on such a source (NON_ARTIST_SOURCES
-- in adapters/registry.ts); this unwinds what those items already dragged in.
--
-- Only artists whose every item came from those sources and whose follow state
-- is still 'auto' are touched — an artist with any real evidence keeps
-- everything, and so does one followed on purpose. Releases accepted off the
-- back of a bogus alert keep their music items: only the watch's bookkeeping
-- goes. Deleting the recorded discography cascades the alerts with it.

DELETE FROM `artist_releases`
WHERE `artist_id` IN (
  SELECT `artists`.`id`
  FROM `artists`
  WHERE `artists`.`follow_state` = 'auto'
    AND EXISTS (
      SELECT 1 FROM `music_items` WHERE `music_items`.`artist_id` = `artists`.`id`
    )
    AND NOT EXISTS (
      -- Any item that didn't come from a curator source is real evidence:
      -- no primary link (hand-typed, emailed, scanned), a link to somewhere
      -- unmodelled, or a link on a source that names acts.
      SELECT 1
      FROM `music_items`
      LEFT JOIN `music_links`
        ON `music_links`.`music_item_id` = `music_items`.`id`
       AND `music_links`.`is_primary` = 1
      LEFT JOIN `sources` ON `sources`.`id` = `music_links`.`source_id`
      WHERE `music_items`.`artist_id` = `artists`.`id`
        AND (
          `music_links`.`id` IS NULL
          OR `sources`.`name` IS NULL
          OR `sources`.`name` NOT IN ('mixcloud', 'nts')
        )
    )
);--> statement-breakpoint
UPDATE `artists`
SET `musicbrainz_artist_id` = NULL,
    `mbid_confidence` = NULL,
    `mbid_resolved_at` = NULL,
    `last_polled_at` = NULL,
    `next_poll_at` = NULL,
    `poll_failure_count` = 0
WHERE `follow_state` = 'auto'
  AND EXISTS (
    SELECT 1 FROM `music_items` WHERE `music_items`.`artist_id` = `artists`.`id`
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `music_items`
    LEFT JOIN `music_links`
      ON `music_links`.`music_item_id` = `music_items`.`id`
     AND `music_links`.`is_primary` = 1
    LEFT JOIN `sources` ON `sources`.`id` = `music_links`.`source_id`
    WHERE `music_items`.`artist_id` = `artists`.`id`
      AND (
        `music_links`.`id` IS NULL
        OR `sources`.`name` IS NULL
        OR `sources`.`name` NOT IN ('mixcloud', 'nts')
      )
  );
