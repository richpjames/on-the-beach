# Version Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show the `package.json` semver in a discreet footer so the deployed version at `https://onthebeach.ricojam.es/` can be verified; auto-increment patch on every successful deploy via GitHub Actions.

**Architecture:** Vite's `define` option bakes the version string into the JS bundle at compile time. The footer element is populated by a single line in `App.initialize()`. The deploy workflow bumps `package.json`, commits, pushes, then fires the Coolify webhook — GitHub prevents the GITHUB_TOKEN push from re-triggering workflows, avoiding infinite loops.

**Tech Stack:** Vite (define), TypeScript ambient declarations, Hono/Bun server, GitHub Actions, Playwright (e2e tests)

---

### Task 1: Vite config with version injection

**Files:**

- Create: `vite.config.ts`
- Create: `src/vite-env.d.ts`

**Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import pkg from "./package.json";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
```

Note: `resolveJsonModule` is already enabled in `tsconfig.json` so the JSON import works. Vite picks up `vite.config.ts` automatically (both in `createViteServer` middleware mode and in `vite build`).

**Step 2: Create `src/vite-env.d.ts` to declare the global**

```ts
declare const __APP_VERSION__: string;
```

This tells TypeScript what `__APP_VERSION__` is — Vite replaces it with the literal string at build/serve time.

**Step 3: Verify TypeScript is happy**

```bash
bun run typecheck
```

Expected: no errors.

**Step 4: Commit**

```bash
git add vite.config.ts src/vite-env.d.ts
git commit -m "feat: inject app version via Vite define"
```

---

### Task 2: Add footer element and styles

**Files:**

- Modify: `index.html`
- Modify: `src/styles/main.css`

**Step 1: Add `<footer>` to `index.html`**

In `index.html`, after the closing `</main>` tag (line ~114), add:

```html
<footer class="footer">
  <span id="app-version"></span>
</footer>
```

The full closing structure should look like:

```html
      </main>
    </div>

    <footer class="footer">
      <span id="app-version"></span>
    </footer>
```

Note: place the footer _outside_ `<div id="app">` so it stays fixed regardless of app state.

**Step 2: Add `.footer` CSS to `src/styles/main.css`**

Append to the end of `src/styles/main.css`:

```css
.footer {
  text-align: center;
  padding: 1.5rem 1rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}
```

`--text-muted` is already defined as `#737373` in `:root`.

**Step 3: Commit**

```bash
git add index.html src/styles/main.css
git commit -m "feat: add footer element for version display"
```

---

### Task 3: Wire version into footer (TDD)

**Files:**

- Create: `playwright/version.spec.ts`
- Modify: `src/app.ts`
- Modify: `package.json` (add spec to test:e2e command)

**Step 1: Write the failing Playwright test**

Create `playwright/version.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test("footer shows semver version", async ({ page }) => {
  await page.goto("/");
  const version = page.locator("#app-version");
  await expect(version).toBeVisible();
  await expect(version).toHaveText(/^v\d+\.\d+\.\d+$/);
});
```

**Step 2: Add the new spec to the e2e test command**

In `package.json`, update the `test:e2e` script:

```json
"test:e2e": "playwright test playwright/add-link.spec.ts playwright/bandcamp-link.spec.ts playwright/stacks.spec.ts playwright/version.spec.ts",
```

**Step 3: Run the test to confirm it fails**

```bash
bun run test:e2e 2>&1 | tail -20
```

Expected: FAIL — `#app-version` exists but has empty text (or the locator isn't visible yet).

**Step 4: Populate the version in `src/app.ts`**

In `src/app.ts`, find the `initialize()` method (around line 32):

```ts
async initialize(): Promise<void> {
  this.setupAddForm();
  this.isReady = true;
  this.initializeUI();
}
```

Add one line to set the version:

```ts
async initialize(): Promise<void> {
  this.setupAddForm();
  this.isReady = true;
  this.initializeUI();
  const versionEl = document.getElementById("app-version");
  if (versionEl) versionEl.textContent = `v${__APP_VERSION__}`;
}
```

**Step 5: Run the test to confirm it passes**

```bash
bun run test:e2e 2>&1 | tail -20
```

Expected: all tests pass including `version.spec.ts`.

**Step 6: Commit**

```bash
git add playwright/version.spec.ts src/app.ts package.json
git commit -m "feat: display version in footer"
```

---

### Task 4: Auto-bump version in GitHub Actions deploy workflow

**Files:**

- Modify: `.github/workflows/deploy.yml`

**Step 1: Update `deploy.yml`**

The deploy job currently has no checkout step. Add the version bump before the Coolify webhook trigger.

Replace the entire `deploy.yml` content with:

```yaml
name: Deploy

on:
  workflow_run:
    workflows: ["Test"]
    types: [completed]
  workflow_dispatch:

concurrency:
  group: deploy-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  deploy:
    name: Deploy to Coolify
    runs-on: ubuntu-latest
    permissions:
      contents: write
    if: |
      github.event_name == 'workflow_dispatch' ||
      (
        github.event_name == 'workflow_run' &&
        github.event.workflow_run.conclusion == 'success' &&
        github.event.workflow_run.event == 'push' &&
        github.event.workflow_run.head_branch == 'main'
      )
    timeout-minutes: 5
    steps:
      - name: Validate deployment secrets
        env:
          COOLIFY_WEBHOOK: ${{ secrets.COOLIFY_WEBHOOK }}
          COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}
        run: |
          if [ -z "$COOLIFY_WEBHOOK" ] || [ -z "$COOLIFY_TOKEN" ]; then
            echo "Missing COOLIFY_WEBHOOK or COOLIFY_TOKEN GitHub Actions secret."
            exit 1
          fi

      - name: Checkout
        uses: actions/checkout@v4
        with:
          ref: main
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Bump patch version
        run: npm version patch --no-git-tag-version

      - name: Commit and push version bump
        run: |
          git add package.json
          git commit -m "chore: bump version"
          git push

      - name: Trigger Coolify deployment
        env:
          COOLIFY_WEBHOOK: ${{ secrets.COOLIFY_WEBHOOK }}
          COOLIFY_TOKEN: ${{ secrets.COOLIFY_TOKEN }}
        run: |
          curl --fail --show-error --silent \
            --request GET "$COOLIFY_WEBHOOK" \
            --header "Authorization: Bearer $COOLIFY_TOKEN"
```

Key changes:

- `permissions: contents: write` — allows the job to push to the repo.
- Checkout with `ref: main` — ensures we're on the right branch (workflow_run can check out detached HEAD).
- Bun setup — needed to run npm (Bun includes npm).
- `npm version patch --no-git-tag-version` — bumps only the patch field in `package.json`, no git tag.
- The push uses `GITHUB_TOKEN`. GitHub specifically prevents `GITHUB_TOKEN`-authenticated pushes from triggering new workflow runs, so the Test workflow will NOT re-run — no infinite loop.
- The Coolify webhook fires after the push, so Coolify pulls the bumped commit.

**Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: auto-bump patch version on deploy"
```

**Step 3: Verify (manual)**

Push the branch to main (via PR or direct push). Watch the GitHub Actions run:

1. Test workflow runs and passes.
2. Deploy workflow triggers, bumps `package.json`, pushes commit, fires Coolify webhook.
3. Check `https://onthebeach.ricojam.es/` — footer should show the new version.
4. Verify no second Test run was triggered by the version bump push.

---

### Task 5: Build and run all tests locally

**Step 1: Rebuild the dist**

```bash
bun run build
```

Expected: `dist/` updated, bundle contains the version string.

**Step 2: Run unit tests**

```bash
bun run test:unit
```

Expected: all pass.

**Step 3: Run e2e tests**

```bash
bun run test:e2e
```

Expected: all pass including `version.spec.ts`.

**Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address any issues from local test run"
```
