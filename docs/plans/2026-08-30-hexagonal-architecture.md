# Hexagonal Architecture — Folder Reorganisation Plan

**Goal:** Split the codebase by **role** at the top level (`domain/`, `ports/`, `app/`, `adapters/`, with `src/` as a driving adapter) and by **source** — Apple Music, Discogs, MusicBrainz — only inside the adapters ring.

**Decided:** the app stays a **single package**. Module resolution therefore cannot enforce the direction, so `.oxlintrc.json` does it instead.

---

## Why not "by source" or "by behavior" alone

The two largest modules resist the two candidate layouts in opposite ways, and that disagreement is the whole argument:

- `server/scraper.ts` fuses several sources into one file — Bandcamp, SoundCloud, Apple Music, NTS and Pitchfork parsers, plus Apple, iTunes and Spotify search. Organising purely by behavior leaves it exactly as it is: it *is* one behavior.
- `server/release-resolver.ts` (757 lines) deliberately fuses Discogs **and** MusicBrainz to score a match. Organising purely by source has nowhere to put it — it is not Discogs code or MusicBrainz code, it is a use case that consumes both.

One needs splitting by source, the other by behavior. Hence both axes, at different depths.

---

## Current state

```
domain/          types + pure helpers, zero imports        ← both sides depend on this
  ├─ src/        routes, components, ui state              ← driving adapter
  └─ server/     entrypoints, orchestration, adapters      ← everything else, flat
```

`server/` is still flat: use cases, source adapters and generic helpers sit side by side.

Three ports already exist in the code without being named as such:

- `ServiceSearchResult` (`server/apple-music-catalog.ts`, re-exported at `server/scraper.ts:31`) — satisfied by `searchAppleMusic`, `searchSpotify`, `searchYouTube` and `searchAppleMusicCatalog`.
- `SOURCE_PARSERS: Partial<Record<SourceName, OgParser>>` (`server/scraper.ts:593`) — an adapter registry keyed by source.
- `SecondaryLookupDeps` (`server/secondary-link-enrichment.ts:179`) — eight function-shaped dependencies injected into a use case, alongside `LOOKUP_SERVICE_CONFIG` at line 35.

### Extraction already in progress

`server/scraper.ts` is down from 1362 to **985 lines**, because two modules were split out by hand ahead of this plan:

- `server/html-metadata.ts` (187 lines) — generic Open Graph and JSON-LD parsing, plus the shared `OgData` / `ScrapedMetadata` vocabulary.
- `server/mixcloud.ts` (294 lines) — one source, in its own module, importing from `html-metadata`.

**`mixcloud.ts` is the template for every remaining source.** It exports `parseMixcloudOg`, `parseMixcloudJsonLd`, `fetchMixcloudOEmbed` and its own merge/completeness helpers, and depends only on `html-metadata`. The tasks below finish that pattern rather than introduce a new one.

---

## Target architecture

```
domain/        types, scoring rules, title similarity — zero I/O
ports/         ServiceSearch, MetadataScraper, ReleaseLookup, ItemStore
app/           use cases: resolve-release, enrich-links, ingest-scan
adapters/
  musicbrainz/  discogs/  apple-music/  spotify/  youtube/
  scrape/       bandcamp · soundcloud · mixcloud · nts · pitchfork
  db/  vision/  acrcloud/
src/           routes, components, ui state — the driving adapter
```

### Task 1 — One domain layer ✅ done

Shipped in [#310](https://github.com/richpjames/on-the-beach/pull/310). `shared/` became `domain/`, `src/types/index.ts` moved in as `domain/types.ts`, `FilterSelection` moved out of the UI, and the `src/repository/utils.ts` re-export shim was deleted. `server/` imports from `src/` in zero files, down from fifteen.

Boundaries are enforced by `no-restricted-imports` with per-directory `overrides` in `.oxlintrc.json`, backed by `tests/unit/layer-boundaries.test.ts` for `.svelte` files, which oxlint does not parse. `test.yml` runs `bun run lint` so the rules gate CI rather than only the pre-commit hook.

### Task 2 — Rename `src/ui/domain/` ✅ done

Shipped in [#314](https://github.com/richpjames/on-the-beach/pull/314). `src/ui/domain/` became `src/ui/logic/`: 7 files, 21 import sites across components, a route loader, `add-form-machine.ts` and the unit tests. "Domain" now means one thing.

A fourth `overrides` entry fences the folder — frameworks (`svelte`, `xstate`, `$app`) to keep it testable in plain bun, siblings (`../state`, `../components`) to keep the direction right. Unlike the `src/ui/**` rule it is leaf-scoped, so renaming `logic/` again would silently stop it applying.

The estimate of fourteen importers was low, and instructively so: a string search for `ui/domain` misses `src/ui/state/add-form-machine.ts`, which reaches its sibling as `../domain/add-form`. Same resolved-vs-literal gap this plan flags for `no-restricted-imports` below.

### Task 3 — Extract Apple Music

The largest single source in `scraper.ts` (~250 lines): OG parsing, oEmbed, the iTunes lookup fallback, and `searchAppleMusic`. Follow `mixcloud.ts`.

Do this one **first** among the sources, because it is also where `ServiceSearchResult` stops being an incidental export of `apple-music-catalog.ts` and becomes a named port — Task 6 partly falls out of it. Extracting 15-line sources first is motion without progress.

### Task 4 — Extract the remaining sources

Pitchfork (~80 lines, OG + JSON-LD), Bandcamp (~60, OG + embed metadata), YouTube oEmbed (~35), Spotify search (~20), NTS (~15), SoundCloud (~15).

What stays in `scraper.ts` is roughly 300 lines of orchestration: `scrapeUrl`, the `SOURCE_PARSERS` registry, `detectMusicRelatedHtml`, `scrapeOgImage`. At that point it is a use case, not a scraper — which is what makes Task 5 a move rather than a rewrite.

### Task 5 — Lift the orchestrators into `app/`

`release-resolver.ts` and `secondary-link-enrichment.ts` become use cases taking ports as arguments. The second already does exactly this via `SecondaryLookupDeps`, so it is close to a straight move.

### Task 6 — Name the ports

Give `ServiceSearchResult` and the parser registry explicit homes in `ports/`, so adding a source is a folder plus one registry entry rather than an edit to a large shared file.

---

## Rollout

Tasks 2 through 6 are independent commits and can land separately. Nothing here changes runtime behaviour: every task is a move plus an import rewrite, verified by `bun run lint`, `bun run typecheck` and `bun run test:unit`.

The boundary rules in `.oxlintrc.json` should be extended as folders appear — an `adapters/` rule forbidding imports from `app/`, and an `app/` rule forbidding direct imports of adapter internals.

---

## Risks

- **Merge conflicts.** `scraper.ts` is being refactored by hand in parallel; #310 already needed four conflicts resolved in this area. Extraction work should be coordinated, or done in small commits that land quickly.
- **Silent breakage across a rename.** A file added on main importing a path this work deletes produces no merge conflict — `server/html-metadata.ts` did exactly that during #310. The lint rules catch it as a boundary violation rather than a missing module, which is the point of having them.
- **`no-restricted-imports` matches specifier strings, not resolved paths.** The `domain/` rule assumes that folder stays flat. If it gains subdirectories, the rule must name the outward folders instead.
- **`typecheck` is still absent from CI** — the same gap `lint` had until #310. Worth closing before the extraction tasks, since they are exactly the kind of change typecheck catches.
