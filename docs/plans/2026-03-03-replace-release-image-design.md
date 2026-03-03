# Replace Release Image — Design

**Date:** 2026-03-03

## Problem

Users can set a release's artwork when first adding it (via scan or URL), but there is no way to replace the artwork on an existing release.

## Solution

Add an "Artwork" section to the release detail page's edit mode. It provides two paths:

1. **File upload** — "Replace image" button opens a file picker, encodes the image to base64, uploads to `POST /api/release/image`, and updates the URL field with the returned path.
2. **URL input** — a text field pre-filled with the current `artwork_url` that the user can edit directly.

Both paths feed into the existing Save flow (`PATCH /api/music-items/:id`), which already supports `artworkUrl`.

## Architecture

No new API endpoints are required. The existing infrastructure handles everything:

- `POST /api/release/image` — accepts `{ imageBase64 }`, saves the file, returns `{ artworkUrl }`
- `PATCH /api/music-items/:id` — already accepts `artworkUrl` in the update body

## Changes

| File | Change |
|------|--------|
| `server/routes/release-page.ts` | Add artwork section HTML (file input, upload button, URL field) and client JS |

## UX Flow

1. User opens the release detail page and clicks **Edit**.
2. Edit mode reveals an "Artwork" section with:
   - A "Replace image" button (triggers hidden file input)
   - A text field showing the current artwork URL
3. User picks a file or pastes a URL.
   - File upload: uploads to `/api/release/image`, populates the URL field on success, shows loading state during upload.
   - URL input: user edits directly.
4. User clicks **Save changes** — the `artworkUrl` field is included in the PATCH body.
5. Page reloads; new artwork is displayed.

## Out of Scope

- Re-scanning metadata from the new image (can be a follow-up)
- Deleting artwork without a replacement
