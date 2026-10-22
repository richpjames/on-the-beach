-- Following an artist is now opt-in. An artist is watched for new releases
-- only while `follow_state` is 'always', which the user sets from the record's
-- page; nothing is inferred from listening any more. Until now any artist on
-- the default 'auto' with a listened item was polled, which made an "artist"
-- out of every handle a link was filed under — a Mixcloud uploader, an NTS
-- show — and watched whichever stranger that name matched on MusicBrainz.
--
-- Everyone still on 'auto' is treated as unfollowed, exactly as if the user
-- had pressed Unfollow (app/artist-follow.ts): the alerts queued for them are
-- dismissed and they leave the poll schedule. Nothing else moves. Their
-- MusicBrainz identity stays — who an artist is has nothing to do with whether
-- they're followed — and so does the release snapshot, so following one later
-- diffs against the baseline already recorded rather than starting over.
-- Artists followed on purpose ('always') and artists muted keep everything.
-- (0018 had already gone further for artists whose every item came from a
-- Mixcloud or NTS link; that stands.)

UPDATE `release_alerts`
SET `status` = 'dismissed',
    `resolved_at` = CAST(strftime('%s', 'now') AS INTEGER)
WHERE `status` IN ('pending', 'seen')
  AND `artist_id` IN (SELECT `id` FROM `artists` WHERE `follow_state` = 'auto');--> statement-breakpoint
UPDATE `artists`
SET `next_poll_at` = NULL
WHERE `follow_state` = 'auto';
