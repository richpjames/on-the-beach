# Stack Routing Design

**Date:** 2026-03-09
**Status:** Approved

## Goal

Give each stack its own URL in the format `/stack/new-releases-5` (slug + ID suffix). The server validates and canonicalises the slug. The client pushes and reads history state.

## URL Structure

- Stack view: `/stack/{slug}-{id}` e.g. `/stack/jazz-2`, `/stack/new-releases-5`
- All view: `/` (unchanged)

Slug = `name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + id`

## Shared Slug Utility

New file `shared/slug.ts`:

```typescript
export function buildStackSlug(name: string, id: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}-${id}`;
}

export function parseStackIdFromSlug(slug: string): number | null {
  const match = slug.match(/-(\d+)$/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return isNaN(id) ? null : id;
}
```

Both functions are used by the server route and the client.

## Server Route

New route `GET /stack/:slug` (alongside the existing main page route):

1. Call `parseStackIdFromSlug(slug)` — if null, return 404
2. Query DB for stack by ID — if not found, return 404
3. Build canonical: `buildStackSlug(stack.name, stack.id)`
4. If `slug !== canonical` — 301 redirect to `/stack/${canonical}`
5. If matches — render the same HTML as `/`, with the selected stack ID embedded in the server state JSON

## Client Changes (`src/app.ts`)

**1. Init from URL**

In `initialize()`, after stacks are loaded, read `window.location.pathname`. If it starts with `/stack/`, call `parseStackIdFromSlug` and dispatch `STACK_SELECTED` with the extracted ID. If the stack ID is not found in the loaded stacks list, fall back to "All" view.

**2. Push state on stack select**

In the stack tab click handler, after dispatching `STACK_SELECTED`, call:
```typescript
history.pushState(null, '', `/stack/${buildStackSlug(stack.name, stack.id)}`);
```
When "All" is selected, push `'/'`.

**3. Popstate handler**

```typescript
window.addEventListener('popstate', () => {
  const id = parseStackIdFromSlug from pathname;
  if (id) dispatch STACK_SELECTED else dispatch STACK_SELECTED_ALL;
  renderStackBar();
  renderMusicList();
});
```

## Files Changed

| File | Change |
|---|---|
| `shared/slug.ts` | New — `buildStackSlug` + `parseStackIdFromSlug` |
| `server/index.ts` or new route file | New route `GET /stack/:slug` with redirect logic |
| `server/routes/main-page.ts` | Extract render function so it can be reused by the stack route |
| `src/app.ts` | Init from URL, push state on select, popstate handler |
| `tests/unit/` | Tests for slug utility functions |
