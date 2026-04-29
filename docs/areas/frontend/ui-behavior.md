# Capabilities

## Item attributes

Each item carries:

- Title, artist
- Type: one of album, EP, single, track, mix
- Year, label, country, genre, catalogue number
- Notes
- Cover artwork — uploaded file or external URL
- One or more source links from any of: Bandcamp, Spotify, SoundCloud, YouTube, Apple Music, Mixcloud, Discogs, Tidal, Deezer, "physical", or an arbitrary source name; one is designated primary
- Listening status: one of To Listen, Listened
- Star rating in half-star increments from 0.5 to 5, or unrated
- Reminder date, or none
- Membership in zero or more stacks
- An ordinal position per filter-and-stack combination
- MusicBrainz release id, MusicBrainz artist id (when a match exists)

## Item creation sources

Items can originate from any of:

- A URL — with metadata extracted via OG tags, JSON-LD, oEmbed, and source-specific scraping
- A cover photograph — with OCR / vision extracting artist, title, year, label, country, catalogue number
- A microphone recording up to 15 seconds long — with song recognition
- A populated set of fields supplied directly
- An authenticated inbound HTTP webhook

Additional creation behaviours:

- A URL that resolves to several releases can produce one item per release in a single operation.
- Blank metadata fields on a new item are back-filled from MusicBrainz when artist + title are known.
- The primary source is inferred from the URL when not specified.

## Per-item operations

- Modify any metadata field
- Replace artwork (upload or URL)
- Attach or remove source links
- Set listening status
- Set, change, or clear the star rating
- Add or remove stack memberships
- Set or clear the reminder date
- Delete the item

## Stacks

- Create, rename, delete
- Deleting a stack does not delete its items
- Many-to-many between items and stacks
- A stack can contain other stacks
- No nesting depth limit
- A stack can have multiple parent stacks — structure is a DAG
- Cycles are rejected
- Each stack has a stable URL
- Each stack has an RSS feed
- A primary RSS feed exists for the whole catalogue

## Catalogue queries

The catalogue can be narrowed and ordered along these axes, in any combination:

- By listening status
- To items with a future reminder
- By a single stack
- By free-text query across release titles, artists, and stack names
- By date added, date listened, artist, release name, or star rating — ascending or descending
- By a manual order, persisted per filter-and-stack combination

## Reminders

- Any item can carry a future reminder date
- When that date is reached, the item's status reverts to To Listen automatically

## Playback

The application can play content from:

- Bandcamp (album, track)
- YouTube (video, playlist)
- Apple Music
- Mixcloud

## Suggestions

- When an item's status becomes Listened, the application can propose another release by the same artist (via MusicBrainz / Cover Art Archive)
- The proposal can be turned into a new item, or discarded

## Auto-discovery

- For items whose primary source is not directly playable, the application can locate and attach an Apple Music link

## Inbound integrations

- An HTTP webhook authenticated by a shared secret accepts payloads from email-forwarding providers

## Configuration

- The model used for link extraction is independently configurable
- The model used for cover scanning is independently configurable

## Persistence

- Items and all their metadata
- Uploaded artwork files
- Stacks, stack-to-stack nesting, and item-to-stack memberships
- Listening status, ratings, reminders, notes
- Manual ordering per filter-and-stack combination
