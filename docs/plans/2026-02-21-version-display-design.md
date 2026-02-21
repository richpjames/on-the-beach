# Version Display Design

**Date:** 2026-02-21
**Status:** Approved

## Goal

Show the current `package.json` semver in a discreet footer so the live site at `https://onthebeach.ricojam.es/` can be verified after each deploy. The version increments automatically on every deploy via GitHub Actions.

## Approach: Vite compile-time injection

The version string is baked into the JS bundle at build time. No runtime overhead, no extra HTTP requests, no async loading.

## Components

### 1. `vite.config.ts` (new file)

Imports `package.json` and uses Vite's `define` option to replace the global constant `__APP_VERSION__` with the version string literal at bundle time.

```ts
import { defineConfig } from "vite";
import pkg from "./package.json";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
```

### 2. TypeScript ambient declaration

Add `declare const __APP_VERSION__: string;` to `src/vite-env.d.ts` (create if absent) so TypeScript recognises the global.

### 3. Footer in `index.html`

Add a `<footer>` element below `<main>`:

```html
<footer class="footer">
  <span id="app-version"></span>
</footer>
```

### 4. `src/app.ts` — populate footer

One line in the existing init code:

```ts
document.getElementById("app-version")!.textContent = `v${__APP_VERSION__}`;
```

### 5. CSS — footer styling

Small, muted text in the existing stylesheet:

```css
.footer {
  text-align: center;
  padding: 1rem;
  font-size: 0.75rem;
  color: var(--color-muted, #888);
}
```

### 6. `.github/workflows/deploy.yml` — version bump

Before triggering the Coolify webhook, the deploy job:

1. Checks out the repo (with a token that has write access).
2. Runs `npm version patch --no-git-tag-version` to bump `package.json`.
3. Commits: `git commit -am "chore: bump version [skip ci]"`.
4. Pushes to main.
5. Triggers the Coolify webhook.

`[skip ci]` in the commit message prevents GitHub from re-running the Test workflow, avoiding an infinite loop.

## Data flow

```
push to main
  → Test workflow passes
  → Deploy workflow:
      checkout → npm version patch → commit [skip ci] → push
      → Coolify webhook
  → Coolify: git pull → bun run build
      → vite reads package.json version → bakes into bundle
  → live site shows new version in footer
```

## Constraints

- The deploy workflow needs a GitHub token with `contents: write` permission to push the version bump commit back to main.
- `npm version patch --no-git-tag-version` modifies only `package.json` (not `bun.lock`), so the lockfile stays untouched.
- `bun.lock` does not encode the `version` field, so no lockfile update is needed.
