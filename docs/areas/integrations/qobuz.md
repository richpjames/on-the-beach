# Qobuz integration

Qobuz is a source like Apple Music or Spotify: its links are recognised and
scraped into draft items, and it can be the active lookup service for
secondary listen links and the New Releases link gate.

Unlike those two, Qobuz publishes no documented public API and its store
pages sit behind bot protection — there is nothing to scrape from the HTML.
The adapter talks to the JSON API their own players use
(`www.qobuz.com/api.json/0.2`), which answers catalogue reads with an
`app_id` alone. The id defaulted in `adapters/qobuz/api.ts` is one Qobuz ship
in their public web bundle; this is the same door tools like qobuz-dl use,
and Qobuz may tighten or rotate it without notice.

## Configuration

Nothing is required — catalogue reads work anonymously out of the box.

| Variable               | What it is                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| `QOBUZ_APP_ID`         | Optional app id override, if the default stops answering          |
| `QOBUZ_STOREFRONT`     | Storefront locale returned URLs are rewritten to, default `gb-en` |
| `QOBUZ_EMAIL`          | Optional account email — logs in via `user/login`                 |
| `QOBUZ_PASSWORD`       | Optional account password                                         |
| `QOBUZ_USER_AUTH_TOKEN`| Optional token supplied directly, skipping the login              |

The account credentials are a fallback for the day anonymous reads stop
working, and for installs that would rather ask as a signed-in listener.
When both email and password are set, the adapter logs in once and caches
the returned `user_auth_token`; a 401 on the cached token re-logs in and
retries the request once. Concurrent requests share one in-flight login,
and a failed login is remembered for a minute — a wrong password must not
make every request re-attempt it. A token in `QOBUZ_USER_AUTH_TOKEN` wins
over the login pair.

## Scraping a link

`adapters/registry.ts` recognises both URL forms:

- the store — `www.qobuz.com/{locale}/{album|track|playlist|interpreter}/{slug}/{id}`
  (artist pages are filed under `interpreter`);
- the player — `play.qobuz.com/{album|track|playlist|artist}/{id}`.

The store slug concatenates title and artist (`kind-of-blue-miles-davis`),
too ambiguous to split, so names come from the API rather than the URL —
the same call the Pitchfork scraper makes. `scrapeQobuz` reads the resource
kind and id out of either form and asks the matching endpoint
(`album/get`, `track/get`, `artist/get`, `playlist/get`) for the metadata:
artist, title, cover (upgraded from the sized `_600.jpg` to the original
`_max.jpg`), label, genre, and `release_date_original` — so Qobuz counts as
a source that names a release date, and the ingest link-preview can schedule
an announced record from a Qobuz share.

The album's own `url` from the API becomes the item's canonical URL,
rewritten to the configured storefront — which also converges shares from
different locales onto one item.

## Catalogue lookup

`searchQobuz` satisfies the `ServiceSearch` port: `catalog/search` scoped to
albums, matched with the same two passes as the Apple Music searches (exact
title + artist, then a prefix-compatible title + artist; an artist-only hit
never counts). It is wired into `LOOKUP_SERVICE_CONFIG`, so selecting Qobuz
in Settings → Lookup streaming service routes secondary-link enrichment and
the release link gate through it, with the usual Bandcamp and YouTube
fallbacks when it has nothing.
