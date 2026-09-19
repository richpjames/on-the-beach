# Layers

How the top-level folders relate, and which way the dependencies point. The
rules are enforced — see `.oxlintrc.json` (`no-restricted-imports` overrides)
and `tests/unit/layer-boundaries.test.ts` for the `.svelte` gap.

## The layout

```
domain/   pure core: types, URL/date parsing, similarity, list context
ports/    contracts the layers meet at (ServiceSearch); types only
app/      use cases: item creation, reminders, suggestions, scrape orchestration,
          plus app/queries/ for the read models
adapters/ one folder per outside thing: apple-music/, discogs/, musicbrainz/,
          soundcloud/, mixcloud/, youtube/, nts/, pitchfork/, bandcamp/,
          spotify/, acrcloud/, google-vision/, mistral/, web/, db/
          adapters/registry.ts wires a source's URLs and scrape in
server/   the HTTP host: Hono route groups, uploads, CSRF, preview seeding
src/      the SvelteKit app (the other driving adapter)
```

## The direction

`domain/` and `ports/` import nothing outside themselves. `app/` orchestrates
`domain/` and `adapters/` but never the hosts (`server/`, `src/`). `adapters/`
adapt outsiders to `domain/` and `ports/` and may lean on each other (a source
that reads pages uses the web adapter's fetcher), but never reach up into
`app/`, `server/` or `src/`. The hosts — `server/` and `src/` — drive `app/`
from outside; that direction is deliberately unrestricted, apart from
`server/` not importing `src/`.

## Adding a music source

A new source is a folder under `adapters/` plus an entry in
`adapters/registry.ts` — the URL patterns that recognise its links, the scrape
that reads its pages, and whether those pages state a release date. Sources
without a bespoke scrape fall back to the web adapter's OG-tag pass. It is
never an edit to a large shared file.
