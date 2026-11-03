-- Ratings used to be stored as star values out of 5 (half steps); they are
-- now stored out of 100 so the number of stars on screen can change without
-- losing accuracy. MIN guards against any value above 5 ever having been
-- written (preview seeds once used an out-of-10 scale): it pins to 100.
UPDATE music_items
SET rating = MIN(ROUND(rating * 20, 2), 100)
WHERE rating IS NOT NULL;
