# Release Resolver — App Integration Plan

**Goal:** Replace the app's MusicBrainz-only, top-hit-wins lookup with a resolver that queries **both** MusicBrainz and Discogs, verifies candidates before accepting them, abstains when unsure, and records the resulting identifiers.

**Companion:** `2026-08-16-release-resolution-eval.md`. Build the eval first — it is the only way to know whether a resolver change helps, and the false-ID rate it reports is the safety gate for rollout.

---

## Current state

```
routes/ingest.ts:196 ─┐
                      ├─> createScanEnricher(extract, lookupRelease, …)
routes/release.ts ────┘             │
                                    └─> scan-enricher.ts: enrichWithMusicBrainz()
                                              └─> musicbrainz.ts:494 lookupRelease()
```

`createScanEnricher` already takes the lookup as an injected `LookupFn`, so swapping the implementation is a one-line change at each call site. That is the seam this plan uses.

### Three defects in `lookupRelease` (`server/musicbrainz.ts:494`)

Each was demonstrated during the fixture lookup work:

1. **Unquoted Lucene query.** `artist:${artist} AND release:${title}` tokenises, so MusicBrainz ORs the loose terms together until something matches. `Kamac Pacha Inti — Mi Raza` returns J Balvin's *Mi gente*. The quoted phrase form returns nothing instead — the two fail in opposite directions, which is why a cascade is needed rather than a choice.
2. **`limit: "1"` with no threshold.** The top hit is returned regardless of relevance. MusicBrainz's `score` is *not* a confidence signal — every false-ID observed scored 100. Verification has to happen locally, against the candidate's own artist/title strings.
3. **`catch { return null }` at line 556.** A 503, a timeout and "no such record" all become `null`. This silently converted three fixtures into false "not found" verdicts during the exploratory run. `findSuggestedRelease` in the same file already gets this right and documents why (line 236) — `lookupRelease` should match it.

### What is missing for Discogs

- `server/discogs.ts` can fetch a **known** release/master/listing by URL. There is no search.
- There is **no rate gate**. `server/musicbrainz.ts:46` has a well-designed shared serialising gate (`mbFetch`); Discogs has nothing equivalent. Discogs allows 60 req/min authenticated, 25 unauthenticated.
- ~~`DISCOGS_TOKEN` is not set~~ — **done.** `server/discogs.ts` now reads `DISCOGS_PAT ?? DISCOGS_TOKEN`, and a PAT is present in `.env`, so requests authenticate at 60 req/min.

### Schema

`musicItems` (`server/db/schema.ts:78-79`) has `musicbrainz_release_id` and `musicbrainz_artist_id`. There are **no Discogs columns**, and no record of *why* an id is absent — so an absent id is indistinguishable from a never-attempted one, and background sweeps will retry permanently-absent records forever.

---

## Target architecture

```
              ┌─────────────────────────────────────────┐
scan/import ──> server/release-resolver.ts               │
              │   ├─ musicbrainz.ts  searchReleases()    │ ← cascade + verify
              │   └─ discogs.ts      searchReleases()    │ ← cascade + verify
              │   merge → verify → confidence → abstain? │
              └─────────────────┬───────────────────────┘
                                v
                       ResolvedIds | null
```

### Task 1 — Add a Discogs rate gate and search

**Files:** `server/discogs.ts`

Port the `mbFetch` gate pattern from `server/musicbrainz.ts:39-62` verbatim in shape — a module-level `gateTail` promise chain, a configurable minimum gap, a fetch timeout, and failures that do not wedge the queue. Gap: 1,000 ms with a token, 2,500 ms without.

Add `searchReleases(query): Promise<DiscogsCandidate[]>` returning parsed candidates with `id`, `masterId`, `artist`, `title`, `year`, `country`, `label`, `catno`.

Discogs packs `"Artist - Title"` into a single `title` field and appends a disambiguation suffix (`Bana (2)`). `parseArtistName` at line 39 already strips that suffix — reuse it rather than writing a second stripper.

Non-2xx and 429 must throw, not return null (defect 3 above).

### Task 2 — Fix the MusicBrainz search path

**Files:** `server/musicbrainz.ts`

Add `searchReleaseCandidates(artist, title, opts)` alongside the existing `lookupRelease`:

- Lucene-escape and **quote** phrases.
- `limit: 5`, not 1.
- Return candidates with their release-group id (`inc=release-groups`), because the release-group is the identity that matters.
- Throw `MusicBrainzHttpError` on non-2xx, matching `fetchArtistReleaseGroups`.

Leave `lookupRelease` in place initially so `artist-identity.ts:176` keeps working; migrate it in Task 6.

### Task 3 — `server/release-resolver.ts`

The core. Public surface:

```ts
export interface ResolvedIds {
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
  musicbrainzArtistId: string | null;
  discogsReleaseId: number | null;
  discogsMasterId: number | null;
  year: number | null;
  label: string | null;
  country: string | null;
  catalogueNumber: string | null;
  confidence: number;
}

export async function resolveRelease(input: {
  artist: string;
  title: string;
  year?: number | null;
}): Promise<ResolvedIds | null>;
```

**Query cascade**, stopping as soon as a candidate verifies:

1. Quoted `artist` + `title`.
2. Credit-stripped artist (`Celia Cruz y La Sonora Matancera` → `Celia Cruz`). This was the highest-value single normalisation observed — the dominant difference between shop-written artist strings and catalogue credits.
3. Free-text / unquoted.

**Verification** — never trust the provider's ranking. For each candidate compute artist and title similarity after a normalisation that strips diacritics, punctuation, credit clauses and subtitles, then accept only above threshold. Both databases return confidently wrong records at maximum relevance score; local verification is the only defence.

**Abstention** is a first-class outcome. Returning `null` is correct and expected — roughly 7% of the fixture set exists in neither database.

**Both databases are queried, always — but not for the reason you would guess.**

Measured over all 101 fixtures:

| | Resolved |
| --- | --- |
| MusicBrainz | 54 / 101 |
| Discogs | **94 / 101** |
| In MusicBrainz but not Discogs | **0** |

Discogs is a **strict superset** of MusicBrainz on this catalogue. It resolved every record MusicBrainz did, plus 40 more — overwhelmingly regional Latin American and Iberian pressings. The seven it missed are missing from both.

So Discogs is not a fallback; it is the higher-recall source and should be queried first. MusicBrainz is still queried every time, because the identifier — not the recall — is what downstream features need: Cover Art Archive artwork, artist-watch baselines (`fetchArtistReleaseGroups`) and release alerts are all keyed on MusicBrainz ids and cannot consume a Discogs id.

Treat them as answering two different questions: *"which record is this?"* (Discogs, better odds) and *"does this record have an id the rest of the app can use?"* (MusicBrainz).

### Recovering a MusicBrainz artist id from a Discogs-only release

When Discogs resolves a release that MusicBrainz has no record of, do **not** give up on MusicBrainz. Take the artist name off the Discogs release and search MB for the *artist*:

```
discogs release ──> canonical artist name ──> MB artist search ──> musicbrainzArtistId
```

This matters because the MusicBrainz-keyed features are mostly **artist**-keyed, not release-keyed. Artist-watch baselines (`fetchArtistReleaseGroups`) and release alerts both work from an artist MBID, so they keep functioning for a Discogs-only row. Only Cover Art Archive genuinely needs a release-level MBID — and Discogs already returns image URLs for those rows, so artwork has a source either way.

This removes the need for any Discogs-backed reimplementation of those features.

**Verify the artist match locally, exactly as for releases.** MB artist search returns confident nonsense at the same rate: it matched `Pacho` to a German rapper at score 100 when the record was by Pacho Alonso. `searchArtistCandidates` (musicbrainz.ts:454) already returns `disambiguation`, `country` and `lifeSpan` — use them, and abstain rather than store a plausible stranger.

### Task 4 — Schema migration

**Files:** `server/db/schema.ts`, new Drizzle migration

Add to `musicItems`:

```ts
discogsReleaseId: integer("discogs_release_id"),
discogsMasterId: integer("discogs_master_id"),
musicbrainzReleaseGroupId: text("musicbrainz_release_group_id"),
// "matched" | "partial" | "absent" | "failed" | null (never attempted)
resolutionStatus: text("resolution_status"),
resolutionAttemptedAt: integer("resolution_attempted_at", { mode: "timestamp" }),
```

`resolutionStatus` is what stops a background sweep from re-querying permanently-absent records forever. `absent` is a terminal state; `failed` is retryable. This mirrors the reasoning already applied to `lookupAttemptedAt` (schema.ts:86-91), which is set on both hit and miss for exactly this reason.

Note `releaseSuggestions` (schema.ts:194-195) already stores a release-group id — reuse the column naming for consistency.

### Task 5 — Wire it in

**Files:** `src/types/index.ts`, `server/scan-enricher.ts`, `server/routes/ingest.ts`, `server/routes/release.ts`

1. Extend `ScanResult` (types/index.ts:162) and `LookupReleaseResult` with the Discogs and release-group fields.
2. `enrichWithMusicBrainz` becomes `enrichWithReleaseIds`; its `LookupFn` type widens to return `ResolvedIds`.
3. Swap `lookupRelease` for `resolveRelease` at `ingest.ts:198` and in `release.ts`.

The existing `catch { return result }` in `enrichWithMusicBrainz` (scan-enricher.ts:21) should stay — enrichment failure must not fail a scan — but it should now log, and set `resolutionStatus: "failed"` so the row is retryable.

### Task 6 — Migrate `artist-identity.ts`

`artist-identity.ts:176` calls `lookupRelease` for artist MBID resolution. Point it at the resolver and delete `lookupRelease`.

Worth noting: artist name search has the same failure mode as release search. MusicBrainz returned a **German rapper** for `Pacho` at score 100, where the record was by Pacho Alonso. Whatever verification the resolver applies to releases should apply here too — MB's `disambiguation` field is the signal, and `searchArtistCandidates` (musicbrainz.ts:454) already surfaces it.

---

## Rollout

1. **Shadow mode.** Run `resolveRelease` alongside the existing lookup on live ingests, write nothing, log both. Compare against the eval's predicted rates on real traffic.
2. **Enable writes behind a flag**, once the shadow false-ID rate matches the eval.
3. **Backfill** existing `musicItems` rows with a rate-gated sweep. Both gates serialise process-wide, so a backfill and a live scan compete for the same budget — the MusicBrainz gate comment (musicbrainz.ts:22-28) already documents this hazard from two prior sweeps.

## Risks

| Risk | Mitigation |
| --- | --- |
| Wrong id written to a row, silently corrupting artwork / alerts | Local verification + abstention; false-ID rate gates rollout |
| Discogs unauthenticated rate limit throttles ingest | Set `DISCOGS_TOKEN`; gate falls back to 2.5 s without one |
| Backfill starves live scans | Shared gate, off-peak scheduling, `resolutionStatus` prevents re-work |
| Two ids disagree (different records) | Store both, mark `partial`, prefer MusicBrainz; surface for review |
