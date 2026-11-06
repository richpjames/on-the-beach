# Merge queue: GitHub's behaviour, hand-rolled for rebase-only merges

**Date:** 2026-11-04
**Status:** implemented

## Problem

Several pull requests are often open at once, and each is green against *its
own* base — but merging them one by one lands combinations no check ever saw
(two PRs both touching a visual baseline, a refactor plus a consumer of the old
shape). GitHub's native merge queue solves exactly this, but it can't be used
here: it only supports merge-commit and squash merges, and this repo is
**rebase-only** by design (linear history via rebased commits). It also gates
on required status checks, and `main` has none configured. So the behaviour is
cloned in the repo's own Actions.

## Approach

A FIFO queue driven by PR comments, in the house style of `/fix`:

- `/queue` joins (write-access users only), `/dequeue` leaves,
  `/queue-status` reports. **Comments are the source of truth**; the
  `merge-queue` label is a self-healed mirror. Order is the `/queue`
  comment's timestamp — commenting `/queue` again moves an entry to the back.
- One entry at a time, the processor **rebases the PR branch onto the current
  `main` and force-pushes it** with `--force-with-lease`. The push fires a
  normal `pull_request: synchronize` event, so the PR's *own* Test, Visual
  Regression (and iOS Build, when paths match) runs execute on main + PR
  combined — which is, by construction, exactly the tree a rebase merge lands.
- Green → `gh pr merge --rebase --delete-branch`. Conflicts, red combined
  checks, or a branch that moved mid-flight → the entry is **kicked out** with
  a comment the scan itself treats as a removal; the queue carries on.

Two earlier shapes were rejected after an independent agent review:

1. **Temp-branch builds** (build `merge-queue/<pr>-<sha>` = `git merge` of
   main + PR, dispatch CI onto it, merge on green). Rejected because the
   tested tree (a merge) is not the landed tree (a rebase): a clean merge can
   still rebase-conflict, and the two can resolve differently. Also carried
   `strict: true` "branch must be up to date" risk on the merge itself.
2. **Mergify** (free for public repos, supports rebase). Rejected as an app
   install + external service for what ~300 lines of CI shell does — the repo
   self-hosts its agent tooling (Pi review/fix) and keeps the loop ownable.
   The honest trade: a service would own the edge cases we now own ourselves.

### Why a PAT is load-bearing

`MERGE_QUEUE_TOKEN` (a fine-grained PAT: Contents, Pull requests and Issues,
read and write, this repo only — the `PI_FIX_TOKEN` shape) performs both the
rebase push and the merge. Pushes and merges made with `github.token` **do not
trigger other workflows**, so deploys (Test → Deploy) and TestFlight uploads
would silently stop for every queue-merged PR. The `/queue` command and the
processor both fail loudly when the secret is missing rather than fall back.

## Components

### `scripts/merge-queue.sh`

Read-only scan that computes the queue: for each open, non-draft PR targeting
`main`, the latest *authoritative* state-change comment decides membership —
`/queue`/`/dequeue` from a user with real write access (association plus
`collaborators/<user>/permission`, failing closed; OWNER/MEMBER trusted), or a
`Merge queue: removed —` comment from `github-actions[bot]` (matched on author
*and* prefix, like the Pi-review matching in `pi-fix.yml`, so it can't be
forged). Commands from non-write users are void; an older authoritative
command still stands. Output: `pr\tjoined-at` lines, oldest first.

### `.github/workflows/merge-queue.yml`

- **`command` job** (`issue_comment`): parses the command, checks real write
  access, gates the PR state (open, targeting `main`, non-draft, not a fork,
  token present), mirrors the label, comments the position, and wakes the
  processor. Per-PR concurrency with the event name in the key, so commands on
  one PR supersede each other but nothing else can land in those groups.
- **`process` job** (`workflow_dispatch` + half-hourly `schedule` watchdog):
  single concurrency lane (`merge-queue`, no cancelling). Per entry: validate
  → kick if own checks already red → fetch + rebase onto `main`
  (conflicts → kick) → PAT force-push with lease → poll `gh pr checks` until
  green (75-minute budget; exit codes 0 green / 8 pending / 1 failing, and
  "no checks reported yet" counts as pending — right after the force-push the
  runs for the new head have not registered) →
  **re-validate immediately before merging** (head sha, base main sha, PR
  state, no newer dequeue — the queue is re-scanned and the entry must still
  be its head) → PAT rebase merge → comment. Stops after 3 merges or 2.5 h and
  re-dispatches itself if entries remain, respecting the 6-hour job cap.

## Failure modes

- **Conflict with main** — kick, re-queue by hand after rebasing.
- **Red combined checks** — kick with a link to the checks.
- **Branch or main moves mid-flight** — force-with-lease refuses; pre-merge
  re-validation catches the rest. Non-destructive: the entry either retries
  against the new main or is kicked with instructions.
- **Processor dies** (runner failure, cancel, incident) — nothing is half-
  merged (the only state-changing step is the final merge); the half-hourly
  watchdog pass re-drives the queue. A failed run comments on the entry it
  was working.
- **Fork PRs** — rejected at `/queue`; the queue pushes branches itself, which
  it can only do same-repo.
- **Repeated retries** — a persistent merge failure retried by the watchdog
  costs one CI cycle per half hour until someone `/dequeue`s; accepted (the
  alternative, auto-kicking on infra flake, would wrongly evict entries).

## Non-goals (YAGNI)

- **Batching** (GitHub's queue merges batches through one CI run). Batch size
  1 is correct at this repo's scale and keeps every entry's verification
  exact.
- **Enforcement.** The queue is advisory — `main` stays unprotected against
  manual merges by design.
- **iOS Build as a queue gate** — it runs per-PR via its path filter, and the
  rebased push triggers it exactly like a hand rebase; nothing extra needed.

## Trust note

Same-repository pull requests carry their own workflow files, so a PR could
weaken the very checks that gate its merge. Unchanged from the manual flow
(the PR's own runs use its own files today too), accepted for a personal
repo, and the queue's push/merge identity is the PAT regardless.

## Verification

`bash -n` and `actionlint` on the changed shell and workflow; the repo's lint
and unit suite (nothing in the app changes); then the live dogfood — this PR
merges normally (`issue_comment`/`schedule` workflows only run from the
default branch), the `MERGE_QUEUE_TOKEN` secret is set, and the next real PR
is `/queue`d.

## Setup (one time)

1. Fine-grained PAT on `richpjames/on-the-beach`: Contents, Pull requests,
   Issues — read and write. No expiry shorter than you're willing to renew.
2. Add it as the `MERGE_QUEUE_TOKEN` repository secret.
3. Merge this PR; `/queue` something.
