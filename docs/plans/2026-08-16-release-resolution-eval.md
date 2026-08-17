# Release Resolution Eval — Plan

**Goal:** Measure whether the app can turn a photo of a record into a MusicBrainz and/or Discogs identifier. Spelling, accents, credit clauses and subtitle variants are explicitly *not* graded — the only question is whether the correct release was identified, when it exists in either database.

**Why a new eval:** the existing vision eval (`vision-eval/`) scores exact string equality between the model's `artist`/`title` and hand-typed ground truth. That measures transcription, not identification. It penalises `Cesária Évora` for being spelled correctly, and it cannot tell a lookup failure apart from a vision failure. Both databases were shown to hold the canonical accented spellings, so the current scorer is measuring the wrong thing for this purpose.

**Tech stack:** Bun, TypeScript, existing `eval/fixtures/manifest.json`, MusicBrainz WS/2, Discogs `/database/search`.

---

## Part 0 — What the ground truth has to become

The manifest carries identifiers established during exploratory lookups, now complete for both databases across all 101 fixtures:

| | Resolved |
| --- | --- |
| `musicbrainzReleaseId` | 54 / 101 |
| `discogsReleaseId` | 94 / 101 |
| Either | 94 / 101 |
| In MusicBrainz but not Discogs | 0 |

Discogs is a **strict superset** of MusicBrainz here. That is a load-bearing fact for the eval: a resolver that queries only MusicBrainz has a hard ceiling of 53% on this set, and no amount of prompt or query tuning moves it.

Two problems remain before this is usable as an eval key.

### 0.1 The grain is wrong

A fixture is a photograph of one *pressing*. A resolver given `Machito & His Afro-Cubans — Tanga` cannot know which of a dozen pressings the photo shows, and shouldn't have to. Correctness must be judged at the work level:

- **Discogs:** `master_id`. Where a release has no master (`master_id: 0`), the release id itself is the key.
- **MusicBrainz:** `release-group` id. Not currently captured at all.

A returned release id counts as correct if it belongs to the expected master / release-group.

### 0.2 `resolvable` must be recorded per database

The eval needs to distinguish *"the resolver failed"* from *"the record is not in the database"*. Seven fixtures are confirmed absent from both:

```
discotex-records-6am-wanna-be-down          legends-of-the-dark-ground-cabra
hugo-jara-estado-de-animo                   various-campeones-xvii-concurso-cancion-asturiana
tipico-santa-rosa-tipico-santa-rosa         antonio-carlos-e-jocafi-o-primeiro-amor
beth-carvalho-feliz
```

For these, **returning nothing is the correct answer** and must score as a pass.

### Task 0.A — Ground-truth enrichment pass

One script, `eval/enrich-fixture-ids.ts`, run once, writing back to `manifest.json`:

1. For each fixture with a `musicbrainzReleaseId`, fetch `inc=release-groups` and store `musicbrainzReleaseGroupId`. **Not yet done — this is the remaining gap.**
2. Write a per-database `resolvable` flag.

Discogs ids are already complete: 94 `discogsReleaseId`, of which 76 carry a `discogsMasterId`. The remaining 18 have `master_id: 0`, meaning Discogs has no master for them — there the release id *is* the work-level key, and the scorer must treat it as such rather than reading the absent master as a gap.

Resulting shape per case:

```jsonc
{
  "id": "orquesta-el-macabeo-salsa-bestial",
  "image": "images/IMG_2406.jpeg",
  "artist": "Orquesta El Macabeo",
  "title": "Salsa Bestial",
  "expected": {
    // Arrays, not scalars: a split release credits two artists and requires
    // both ids to score a hit. Single-artist releases just hold one element.
    "mb":      { "resolvable": false, "releaseGroupIds": [] },
    "discogs": { "resolvable": true,  "masterIds": [706722], "releaseIds": [4419535] }
  }
}
```

`masterIds` is empty when Discogs returns `master_id: 0` — 18 fixtures have no master, and there `releaseIds` is the identity. The scorer must read `masterIds.length ? masterIds : releaseIds`, never treat an absent master as unresolvable.

### Task 0.B — Human verification against the photographs

**This is a blocker for trusting any number the eval produces.** Every identifier in the manifest was derived from the fixture's hand-typed `artist`/`title`, never from the image. Three fixtures show the signature of a transcription error — a well-catalogued artist with a title that exists nowhere:

| Fixture | Signal |
| --- | --- |
| `beth-carvalho-feliz` | 8 Discogs hits, all `Coração Feliz` |
| `antonio-carlos-e-jocafi-o-primeiro-amor` | 141 releases by the duo, no such title |
| `tipico-santa-rosa-tipico-santa-rosa` | 27 releases, no self-titled |

There is also a genuine duplicate: `dorival-caymmi-caymmi` and `dorival-caymmi-caymmi-odeon` are different photographs with identical `artist`/`title`, both resolving to the same MBID. Either they are two pressings — in which case the manifest should say so via distinct release ids — or one should be dropped.

Deliverable: a reviewer opens each of the ~30 non-trivial fixtures alongside its resolved release page and confirms or corrects it.

---

## Part 1 — What the eval measures

### 1.1 The system under test is a two-stage pipeline

```
  photo ──[A: vision]──> {artist, title} ──[B: resolver]──> {mbId, discogsId} | abstain
```

The eval must run **three configurations**, because the end-to-end number alone cannot tell you where to invest:

| Config | Input to stage B | Measures |
| --- | --- | --- |
| **B-oracle** | ground-truth `artist`/`title` | The resolver's ceiling, with vision error removed |
| **End-to-end** | vision model output | The number that matters in production |
| **Delta** | — | End-to-end minus B-oracle = loss attributable to vision |

This split is the single most important part of the design. Exploratory work showed that with *perfect* input strings, MusicBrainz alone resolved only 54/101, and reaching 94/101 required a second database plus hand-verification. **The resolver, not the vision model, is likely the dominant loss** — and the current eval structure cannot show that.

### 1.2 Outcomes, not a score

Per fixture, per database, the resolver produces exactly one of:

| Outcome | Resolvable fixture | Unresolvable fixture |
| --- | --- | --- |
| Correct id returned | ✅ `hit` | — (impossible) |
| Wrong id returned | ❌ `false-id` | ❌ `false-id` |
| Nothing returned | ⚠️ `miss` | ✅ `correct-abstain` |

Headline metrics:

- **Resolution rate** = `hit / resolvable` — the thing being optimised.
- **False-ID rate** = `false-id / total` — the thing that must stay near zero.

**These are not symmetric.** A wrong identifier is written into `music_items` and silently poisons artwork, artist-watch baselines and release alerts downstream. A miss leaves a row that can be retried. The eval should refuse to celebrate a resolution-rate gain that comes with a false-ID increase.

The exploratory work produced a stock of concrete false-IDs to use as regression cases — every one scored 100 on the provider's own relevance metric:

```
Kamac Pacha Inti — Mi Raza    → MB returned J Balvin — "Mi gente"
Baden Powell — Face au Public → MB returned John Powell — "Face/Off"
Grupo Guaco — Guaco 76        → MB returned Grupo Guaco — "Guaco 77"
Pacho — Via Libre Llego       → MB artist search returned a German rapper
```

`Guaco 76` vs `Guaco 77` is the important one: maximally similar as strings, entirely different as records. No character-level threshold separates them, so the eval must contain cases that punish a resolver tuned purely on string distance.

### 1.3 Strategies

Mirror the existing `vision-eval/strategies.ts` pattern — a strategy is a **resolver configuration**, and the harness runs each over all fixtures:

| Id | Strategy | Rationale |
| --- | --- | --- |
| R1 | MB quoted phrase only | Baseline; high precision, poor recall |
| R2 | MB cascade: quoted → credit-stripped → unquoted | Recall from the cascade, verified per candidate |
| R3 | Discogs cascade: `artist`+`release_title` → free-text → `release_title` | The cascade that found 40/47 MB missed |
| R4 | R2 + R3, MB preferred when both answer | Candidate production behaviour |
| R5 | R4 + abstention threshold tuning | Trades resolution rate against false-ID rate |

Every strategy fetches **5 candidates and verifies them locally**. Taking the provider's top hit on faith is what produces the false-IDs above.

---

## Part 2 — Implementation

### Task 2.1 — `eval/resolution/types.ts`

```ts
export type ResolutionOutcome = "hit" | "false-id" | "miss" | "correct-abstain";

export interface ResolvedIds {
  musicbrainzReleaseId: string | null;
  musicbrainzReleaseGroupId: string | null;
  discogsReleaseId: number | null;
  discogsMasterId: number | null;
  /** 0–1. Below the strategy's threshold the resolver must abstain. */
  confidence: number;
}
```

### Task 2.2 — `eval/resolution/score.ts`

Scores a `ResolvedIds` against a fixture's `expected` block. Correctness is **set membership at work level**, never string comparison:

- MB hit ⟺ returned release's release-group == `expected.mb.releaseGroupId`.
- Discogs hit ⟺ returned release's master == `expected.discogs.masterId`, or release id matches where no master exists.

Resolving a returned release id to its group/master costs one extra API call. Cache it — the same handful of ids recur across strategies and runs.

### Task 2.3 — `eval/resolution/run.ts`

Harness mirroring `vision-eval/index.ts`: CLI flags for `--strategy`, `--limit`, `--config oracle|e2e`, timestamped JSON output under `eval/resolution/results/`.

Reuses the vision model output already captured in `vision-eval/results/*.json` for the end-to-end config, so a resolver change is measurable **without re-spending vision API calls**.

### Task 2.4 — Report

Per strategy, per database, and for the union:

```
strategy R4          MB      Discogs   Either
  resolvable          54        ~85      ~94
  hit                 —         —        —
  false-id            —         —        —
  miss                —         —        —
  correct-abstain     —         —        —
  resolution rate     —         —        —
  false-ID rate       —         —        —
```

Plus a segmented view by `expected.*.resolvable`, which finally separates *"the model is weak"* from *"the catalogue does not have it"* — the split the current single blended score hides.

---

## Reporting: per database, not a blended verdict

"Found in Discogs" and "found in MusicBrainz" are two separate facts, and the eval reports them as such. There is no combined pass/fail — a Discogs-only result is not a lesser outcome, it is simply where that record lives. The `Either` column exists only to describe total coverage, never to paper over which database answered.

This has a direct consequence for the app: `musicItems` can currently only record a MusicBrainz id, so a Discogs-only resolution has nowhere to go. The schema change is a prerequisite, not a follow-up — see **Task 4** of the integration plan.

## Settled decisions

- **Split releases carry two ids.** `Lucho Gatica / Antonio Machin` is one artefact crediting two artists. `expected` holds an array, and a hit requires **both** ids — returning one side is a miss, not a partial. This is why the schema below uses arrays throughout rather than scalars.
- **Work level only.** Any pressing of the right record counts. Never score on a specific release id where a master / release-group exists.
- **No pass mark.** The report gives the score with the resolver and without it, side by side. Whether that is good enough is a judgement call made on the numbers, not a threshold baked into the harness.

## Open questions

1. **Does year help?** `lookupRelease` already accepts an optional `year`, and the sleeve photos often show one. Worth a strategy variant.
