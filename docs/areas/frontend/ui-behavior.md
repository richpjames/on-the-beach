# Capabilities

What the application makes possible. No description of screens, controls, layout, or interactions.

## The data model

Every tracked release carries:

- Title, artist
- Release type — one of: album, EP, single, track, mix
- Year, label, country, genre, catalogue number
- Free-text notes
- Cover artwork (uploaded file or external URL)
- One or more source links from any of: Bandcamp, Spotify, SoundCloud, YouTube, Apple Music, Mixcloud, Discogs, Tidal, Deezer, "physical", or an arbitrary source name. One link is designated primary.
- A listening status — one of: To Listen, Listened
- A star rating in half-star increments from 0.5 to 5, or unrated
- A reminder date, or none
- Membership in any number of stacks
- A position within each filter-and-stack combination it appears in
- MusicBrainz release id and artist id when matched

## Creating items

Items can come from any of:

- A pasted URL — title, artist, artwork, and other metadata extracted via OG tags, JSON-LD, oEmbed, and source-specific scraping.
- A cover photograph — artist, title, year, label, country, and catalogue number extracted via OCR / vision.
- A microphone recording up to 15 seconds long — the matched track is identified and added.
- Direct entry of any subset of fields.
- An authenticated inbound HTTP webhook (e.g. an email forwarder).

In addition:

- A single URL that resolves to several releases can produce one item per chosen release in one operation.
- Any blank metadata fields on a new item are back-filled from MusicBrainz when artist + title are known.
- The primary source is inferred from a URL when not specified.

## Mutating items

For an existing item the application can:

- Change any metadata field.
- Replace artwork by upload or URL.
- Attach further source links and remove existing ones.
- Set the listening status.
- Set, change, or clear the star rating.
- Add or remove stack memberships.
- Set or clear the reminder date.
- Delete the item.

## Stacks

Stacks are named groupings of items.

- Stacks can be created, renamed, and deleted. Deleting a stack does not delete its items.
- An item can belong to any number of stacks at once.
- Stacks can contain other stacks; nesting has no depth limit.
- A stack can have several parent stacks at once — the structure is a DAG, not a tree. Cycles are rejected.
- Each stack has a stable, shareable URL.
- Each stack publishes an RSS feed. A primary feed exists for the whole catalogue.

## Filtering, sorting, ordering

The catalogue can be narrowed and ordered along these axes, used independently or together:

- By listening status, including a "scheduled" view of items with a future reminder.
- By a single stack.
- By free-text query against release titles, artists, and stack names.
- By date added, date listened, artist, release name, or star rating — ascending or descending.
- By manual order. Manual order is stored per filter-plus-stack combination and is used when sorting by date added descending with no active query.

## Reminders

- Any item can carry a future reminder date.
- When a reminder's date is reached the item is automatically returned to "To Listen".
- Items with a future reminder can be selected as a group.

## Ratings

- Items can be rated in half-star increments from 0.5 to 5.
- A rating can be cleared back to unrated.
- Ratings are usable as a sort key.

## Listening

The application can play back content from Bandcamp, YouTube (videos and playlists), Apple Music, and Mixcloud. Playback persists across changes of context. On touch devices, playback opens in the source's own application instead of being embedded.

For releases whose primary source is not directly playable, the application can discover and attach an Apple Music link automatically.

## Suggestions

When an item is marked Listened the application can propose another release by the same artist (sourced from MusicBrainz / Cover Art Archive). The proposal can be accepted as a new item or dismissed.

## Sharing and feeds

- Each stack is reachable at a stable URL.
- Each stack publishes an RSS feed; a primary feed covers the whole catalogue.

## External integrations

- An HTTP webhook authenticated by a shared secret accepts inbound payloads from email-forwarding providers.
- The model used for both link extraction and cover scanning is independently configurable.

## What persists

- Items and all their metadata.
- Uploaded artwork files.
- Stacks, stack-to-stack nesting, and item-to-stack memberships.
- Listening status, ratings, reminders, notes.
- Manual ordering per filter-and-stack combination.
