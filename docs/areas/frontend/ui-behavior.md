# UI Capabilities

A flat catalogue of what the application makes possible. Grouped by subject, not by screen — order does not imply priority.

## What an item is

Every tracked release is a single item with these attributes, all optional except a title:

- Title, artist
- Release type: album, EP, single, track, or mix
- Year, label, country, genre, catalogue number
- Free-text notes
- Cover artwork (uploaded image or external URL)
- One or more source links (Bandcamp, Spotify, SoundCloud, YouTube, Apple Music, Mixcloud, Discogs, Tidal, Deezer, "physical", or a free-form source name); one link is designated primary
- A listening status: To Listen or Listened
- A star rating from 0.5 to 5 in half-star steps, or unrated
- A reminder date
- Membership in zero or more stacks
- A position within each browsing context where it appears
- Provenance metadata from MusicBrainz when matched (release id, artist id)

## Adding items

The app supports five distinct ways of bringing items in:

- From a pasted URL, with title, artist, artwork, and other metadata extracted via OG tags, JSON-LD, oEmbed, and source-specific scraping.
- From a photograph of a release cover, with artist, title, year, label, country, and catalogue number extracted via OCR / vision.
- From a microphone recording of music currently playing (up to 15 seconds), with the matched track auto-created.
- By manual entry of any subset of fields.
- By inbound HTTP webhook (e.g. an email forwarding service) authenticated with a shared secret.

Additional behaviours when adding:

- A single link that the source resolves to several releases can be expanded into one item per chosen release in one operation.
- Newly created items have any blank metadata fields back-filled from MusicBrainz when artist + title are known.
- An item's primary source is detected from the URL when not specified.

## Editing items

Every attribute on an existing item can be changed:

- All metadata fields (title, artist, year, label, country, genre, catalogue number, notes, artwork URL).
- Artwork can be replaced by uploading a new image or pointing at a new URL.
- Additional source links can be attached; existing links can be removed.
- Listening status can be set to To Listen or Listened.
- Star rating can be set, changed, or cleared.
- Stack memberships can be added or removed.
- A reminder date can be set or cleared.
- The item can be deleted outright.

## Stacks (collections)

Stacks are user-defined groupings of items.

- Stacks can be created, renamed, and deleted. Deleting a stack does not delete its items.
- An item can belong to any number of stacks simultaneously.
- A stack can contain other stacks. Nesting has no depth limit.
- A stack can be nested under several parent stacks at once (the structure is a DAG, not a tree). Cycles are rejected.
- Each stack has a stable, shareable URL.
- Each stack publishes an RSS feed.
- The contents of a stack appear together with any nested child stacks when it is browsed.
- The order of items inside a given browsing context is preserved across sessions.

## Browsing

The library can be narrowed and ordered along several axes simultaneously:

- Status filter: all items, To Listen, Listened, or Scheduled (items with a future reminder).
- Stack filter: any one stack, or no stack filter.
- Free-text search across release titles, artists, and stack names.
- Sort by: date added, date listened (when viewing Listened), artist, release name, or star rating.
- Sort direction: ascending or descending.
- Manual reordering within the current context (filter + stack), saved per context. Manual order applies when sorted by date added descending with no active search.

When a stack is open, the browse view shows breadcrumbs back through that stack's parents and lists nested child stacks alongside its items.

## Listening

The app provides inline playback for these sources:

- Bandcamp (albums and individual tracks)
- YouTube (videos and playlists)
- Apple Music
- Mixcloud

Playback continues uninterrupted while navigating between the library and individual release pages. On touch devices, playable releases open in the source's own app or tab instead of embedding.

For releases whose primary source is not directly playable, the app attempts to find and attach an Apple Music link automatically.

## Suggestions

When an item is marked Listened, the app can offer another release by the same artist (sourced from MusicBrainz / Cover Art Archive). The suggestion can be added to the library as a new item or dismissed.

## Reminders

- Any item can carry a reminder date.
- When a reminder's date is reached, the item is automatically moved back to "To Listen".
- Items with a future reminder can be browsed as a group.

## Ratings

- Items can be rated in half-star increments from 0.5 to 5 stars.
- A rating can be cleared back to unrated.
- Ratings can be used to sort the library.

## Sharing and feeds

- Every stack has a shareable URL that opens the library scoped to that stack.
- Every stack is also exposed as an RSS feed.
- A primary feed for the whole library is also published.

## Inbound integrations

- A configured email-forwarding webhook can create items from forwarded messages.
- The application can be configured against custom Mistral models for both link extraction and cover scanning.

## What persists per user

- All items and their metadata.
- Uploaded artwork files.
- Stack definitions, stack nesting, and item-to-stack memberships.
- Listening status, ratings, reminders, and notes.
- Manual ordering per browsing context.
