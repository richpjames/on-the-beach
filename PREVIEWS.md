# Preview deployments

Each UI experiment lives on its own `preview/*` branch with a matching draft
PR, so every experiment can be deployed and judged independently before
deciding what to merge.

## How the preview links work (Coolify)

The production app deploys to Coolify from `main`. Coolify can deploy every
open PR to its own ephemeral URL — one-time setup in the dashboard:

1. Open the application in Coolify → **Preview Deployments** → enable.
2. Optionally set the preview URL template (defaults to
   `{{pr_id}}.<your-domain>`).
3. Add `PREVIEW_SEED=1` to the application's **Preview** environment
   variables so each preview boots with demo data (10 releases across all
   statuses, ratings, stacks, and one overdue + one upcoming reminder).

After that, every open PR — including the `preview/*` drafts — gets built
from its branch with the same Dockerfile and published on its own link;
pushing to the branch updates the preview, closing the PR tears it down.

Preview containers use ephemeral storage (no volume mounts), so the SQLite
database starts fresh per deploy and previews can never touch production
data. `PREVIEW_SEED` only seeds when the database is empty.

## The experiment branches

| Branch | Experiment |
| --- | --- |
| `preview/mobile-dock` | Filters/search/sort docked above the taskbar on phones |
| `preview/start-menu` | Functional Win95 Start menu (add, pick, search, stacks, RSS) |
| `preview/clock-reminders` | Taskbar clock opens an upcoming-reminders popup |
| `preview/browse-panel` | Desktop stack tabs + filter row fused into one panel |
| `preview/empty-states` | Mascot, blinking cursor, and actionable hints on empty states |
| `preview/pick-one-roulette` | Pick One sweeps the list before landing on the winner |
| `preview/release-reorder` | Status + reminder above the stacks list on release pages |

Each branch is `main` + that one experiment (plus two shared, runtime-neutral
commits: a reorder-spec stability fix and this preview tooling). Merging an
experiment is just merging its PR; the shared commits dedupe across merges.

## Local previews

Any branch can be previewed locally without Coolify:

```sh
git checkout preview/<name>
PREVIEW_SEED=1 DATABASE_PATH=/tmp/preview.db bun run dev
```
