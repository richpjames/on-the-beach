#!/usr/bin/env bash
# Compute the merge-queue order from pull-request comments.
#
# Comments are the source of truth (the merge-queue label is only a mirror, so
# it can always be re-derived): on each open, non-draft PR targeting main, the
# latest *authoritative* state-change comment decides membership —
#   - /queue or /dequeue from someone with real write access (OWNER/MEMBER
#     associations are trusted; anything else is checked against
#     collaborators/<user>/permission, failing closed), or
#   - a "Merge queue: removed —" comment from github-actions[bot], which is how
#     the queue kicks an entry out (matched on author *and* prefix, like the
#     Pi-review matching in pi-fix.yml, so it can't be forged).
# A command from someone without write access is simply void: an older
# authoritative command still stands. /queue-status is a read-only command and
# never counts. The join timestamp of the winning /queue comment gives the FIFO
# order; commenting /queue again re-joins at the back.
#
# Output: "<pr-number>\t<joined-at>" lines, oldest first. Needs GH_TOKEN and
# GH_REPO in the environment; runs in CI (Linux) alongside merge-queue.yml.
set -euo pipefail

GH_REPO=${GH_REPO:?GH_REPO must be set}
: "${GH_TOKEN:?GH_TOKEN must be set}"

PERM_CACHE=$(mktemp)
trap 'rm -f "$PERM_CACHE"' EXIT

has_write() { # <login> <author_association>
  login=$1
  assoc=$2
  case "$assoc" in
    OWNER | MEMBER) return 0 ;;
  esac
  # COLLABORATOR includes read- and triage-only collaborators, so look up the
  # real permission. A failed lookup counts as none — fail closed.
  cached=$(awk -v login="$login" '$1 == login {print $2}' "$PERM_CACHE")
  if [ -n "$cached" ]; then
    [ "$cached" = write ] || [ "$cached" = admin ]
    return
  fi
  perm=$(gh api "repos/$GH_REPO/collaborators/$login/permission" --jq .permission 2>/dev/null || echo none)
  printf '%s %s\n' "$login" "$perm" >>"$PERM_CACHE"
  [ "$perm" = write ] || [ "$perm" = admin ]
}

# Print the join timestamp if the PR is queued, nothing if not. $1 = PR number.
queued_at() {
  pr=$1
  # Candidate state-change comments, oldest first: created_at, kind, login, assoc.
  candidates=$(gh api --paginate "repos/$GH_REPO/issues/$pr/comments?per_page=100" | jq -r -s '
    add // [] | .[] |
    select(
      (.body | test("^/queue([[:space:]]|$)")) or
      (.body | test("^/dequeue([[:space:]]|$)")) or
      ((.author.login == "github-actions[bot]" or .author.login == "github-actions") and
        (.body | startswith("Merge queue: removed")))
    ) |
    [.created_at,
     (if (.body | test("^/dequeue([[:space:]]|$)")) then "dequeue"
      elif (.body | test("^/queue([[:space:]]|$)")) then "queue"
      else "bot-removed" end),
     .author.login, .author_association] | @tsv')
  [ -n "$candidates" ] || return 1
  # Newest authoritative comment wins, so walk the list backwards.
  mapfile -t lines <<<"$candidates"
  for ((i = ${#lines[@]} - 1; i >= 0; i--)); do
    IFS=$'\t' read -r created kind login assoc <<<"${lines[$i]}"
    case "$kind" in
      bot-removed) return 1 ;;
      queue) if has_write "$login" "$assoc"; then printf '%s' "$created"; return 0; fi ;;
      dequeue) if has_write "$login" "$assoc"; then return 1; fi ;;
    esac
  done
  return 1
}

# An if, not `[ -n "$ts" ] && printf …`: the loop's exit status is the last
# body command's, and under `set -o pipefail` a failing test on the final
# not-queued PR would fail the whole scan pipeline — and every caller runs the
# scan under `bash -e`.
for pr in $(gh pr list --repo "$GH_REPO" --state open --base main --limit 100 \
  --json number,isDraft --jq '.[] | select(.isDraft | not) | .number'); do
  ts=$(queued_at "$pr" || true)
  if [ -n "$ts" ]; then
    printf '%s\t%s\n' "$pr" "$ts"
  fi
done | sort -t$'\t' -k2,2
