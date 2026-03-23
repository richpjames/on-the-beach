#!/usr/bin/env bash
# Regenerate Playwright visual regression baselines on Linux so they match CI.
# Snapshots must be generated on Linux (the same platform CI uses) to avoid
# cross-platform font/antialiasing differences causing false failures.
set -euo pipefail

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.58.2-jammy"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Updating visual baselines inside $PLAYWRIGHT_IMAGE …"

docker run --rm --ipc=host \
  -v "$REPO_ROOT":/work \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -c "
    set -euo pipefail
    apt-get update -q && apt-get install -y unzip curl > /dev/null 2>&1
    curl -fsSL https://bun.sh/install | bash > /dev/null 2>&1
    export PATH=\"\$HOME/.bun/bin:\$PATH\"
    bun install --frozen-lockfile
    bun run test:visual:update
  "

echo ""
echo "Baselines updated. Staged snapshot changes:"
git -C "$REPO_ROOT" diff --name-only -- 'tests/visual/**'
echo ""
echo "Run the following to commit:"
echo "  git add tests/visual/ && git commit -m 'chore: update visual regression baselines'"
