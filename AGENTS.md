# AGENTS.md

This project uses Bun, not node.

- All visual elements must be consistent with the retro design, think Encarta, Windows 97, Discworld.
### Before pushing
- Ensure you have run all the tests locally 
### On pushing
- Create a PR
- check the Github checks for the branch have passed. If they fail investigate and fix the error.

- When making visual changes always consider how they will look on smaller screens (mobiles/tablets etc).

## Working preferences

### "Open a PR" means the full loop
When asked to "open a PR" (or raise/create a PR):
1. Create the PR.
2. Watch CI until it passes GREEN (e.g. `gh pr checks --watch` / `gh run watch`) — don't fire-and-forget.
3. Ensure there are no merge conflicts against `main` (`gh pr view --json mergeable,mergeStateStatus`).
If CI fails or conflicts exist, fix or surface them rather than reporting the PR as opened.

### PR hygiene
- Never add a "Generated with Claude Code" footer (or any generated-by line) to PR bodies.
- Always state the full PR URL prominently, on its own line, every time a PR is created or updated.

### Plain terms over jargon
Prefer the word the repo already uses for a concept over the textbook term (e.g. `--config ground-truth`, not `--config oracle`; the repo's word for a provider is "source" / `SourceName`). If a term needs a glossary entry to be understood, it probably needs renaming instead. Applies to identifiers, CLI flags, and prose in reports.

### Hexagonal architecture
As of 2026-08-28 the codebase is split by **role** at the top level (`domain/`, `ports/`, `app/`, `adapters/`, with `src/` and `server/` as the driving adapters) and by **source** (Apple Music, Discogs, MusicBrainz…) only inside `adapters/`. The app stays **one package** — no separate package for the core.

- `domain/` — pure core: types, parsing, date and similarity logic. Imports nothing from outside itself (enforced).
- `ports/` — contracts the layers meet at (e.g. `ServiceSearch`). Types only, imports nothing (enforced).
- `app/` — the use cases: item creation, reminders, suggestions, scraping orchestration, plus `app/queries/`. May import `domain/`, `ports/` and `adapters/`; never `server/` or `src/` (enforced).
- `adapters/` — one folder per outside thing a source lives behind (`apple-music/`, `discogs/`, `musicbrainz/`, …) plus `db/`, `web/` and `mistral/`. May import `domain/`, `ports/` and each other; never `server/`, `src/` or `app/` (enforced).
- `adapters/registry.ts` — where a source is wired in: URL classification, the scrape map, and the release-date capability flag.
- `server/` — the HTTP host (Hono routes, uploads, CSRF) and nothing else.
- `src/` — the SvelteKit app, the other driving adapter.

Boundaries are enforced by `no-restricted-imports` overrides in `.oxlintrc.json`; `tests/unit/layer-boundaries.test.ts` covers the `.svelte` gap oxlint can't parse.

When adding a new music source, it becomes a folder under `adapters/` plus a registry entry — not an edit to a large shared file. Don't reintroduce imports from `server/` into `src/`- or `app/`-owned modules, from `adapters/` into `server/`, `src/` or `app/`, or from `domain/` or `ports/` outward.
