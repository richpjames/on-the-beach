# Email Ingest Implementation Plan

**Goal:** Add a webhook endpoint that receives emails, extracts music platform URLs, and creates music items automatically.

**Architecture:** New route (`/api/ingest/email`), an email parser module, and a shared music-item creator extracted from the existing POST handler. Bearer token auth via env var.

**Tech Stack:** Same as existing — TypeScript, Hono, Drizzle/SQLite, Vitest unit tests.

---

### Task 1: Extract shared music-item creation logic

**Files:**

- Create: `server/music-item-creator.ts`
- Modify: `server/routes/music-items.ts`

**Step 1: Create the shared creator module**

Extract the core logic from the `POST /` handler in `music-items.ts` into a reusable function:

```typescript
// server/music-item-creator.ts
import { db } from "./db/index";
import { musicItems, artists, musicLinks, sources } from "./db/schema";
import { parseUrl, isValidUrl, normalize, capitalize } from "./utils";
import { scrapeUrl } from "./scraper";
import { eq } from "drizzle-orm";
import type { MusicItemFull, CreateMusicItemInput } from "../src/types";

// (move getOrCreateArtist, getSourceId, fetchFullItem here from music-items.ts)

export interface CreateResult {
  item: MusicItemFull;
  created: boolean;  // false if URL was a duplicate
}

export async function createMusicItemFromUrl(
  url: string,
  overrides?: Partial<CreateMusicItemInput>,
): Promise<CreateResult> {
  // 1. Validate URL
  // 2. Check for existing music_link with this URL (dedup)
  // 3. Parse URL, scrape metadata
  // 4. Create artist, music item, primary link
  // 5. Return the full item
}
```

**Step 2: Refactor the POST handler to call the shared function**

The `POST /api/music-items` route becomes a thin wrapper that validates input, calls `createMusicItemFromUrl()`, and returns the response.

**Step 3: Verify typecheck and all existing tests pass**

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
```

**Step 4: Commit**

```bash
git add server/music-item-creator.ts server/routes/music-items.ts
git commit -m "refactor: extract shared createMusicItemFromUrl function"
```

---

### Task 2: Email parser — extract music URLs from email content

**Files:**

- Create: `server/email-parser.ts`
- Create: `tests/unit/email-parser.test.ts`

**Step 1: Write the unit tests first**

```typescript
// tests/unit/email-parser.test.ts
import { describe, it, expect } from "vitest";
import { extractMusicUrls } from "../../server/email-parser";

describe("extractMusicUrls", () => {
  it("extracts bandcamp URLs from HTML anchor tags", () => {
    const html = `<a href="https://artist.bandcamp.com/album/cool-album">Listen</a>`;
    expect(extractMusicUrls({ html })).toEqual([
      "https://artist.bandcamp.com/album/cool-album",
    ]);
  });

  it("extracts URLs from plain text", () => {
    const text = "Check out https://open.spotify.com/album/abc123 it's great";
    expect(extractMusicUrls({ text })).toEqual([
      "https://open.spotify.com/album/abc123",
    ]);
  });

  it("ignores non-music URLs", () => {
    const html = `
      <a href="https://www.google.com">Google</a>
      <a href="https://artist.bandcamp.com/album/yes">Music</a>
      <a href="https://unsubscribe.example.com">Unsubscribe</a>
    `;
    expect(extractMusicUrls({ html })).toEqual([
      "https://artist.bandcamp.com/album/yes",
    ]);
  });

  it("deduplicates URLs", () => {
    const html = `
      <a href="https://artist.bandcamp.com/album/dupe">Link 1</a>
      <a href="https://artist.bandcamp.com/album/dupe">Link 2</a>
    `;
    expect(extractMusicUrls({ html })).toEqual([
      "https://artist.bandcamp.com/album/dupe",
    ]);
  });

  it("prefers HTML over text when both are present", () => {
    const html = `<a href="https://artist.bandcamp.com/album/from-html">Link</a>`;
    const text = "https://other.bandcamp.com/album/from-text";
    const result = extractMusicUrls({ html, text });
    expect(result).toContain("https://artist.bandcamp.com/album/from-html");
  });

  it("returns empty array when no music URLs found", () => {
    expect(extractMusicUrls({ text: "Hello, no links here" })).toEqual([]);
    expect(extractMusicUrls({})).toEqual([]);
  });

  it("strips query parameters from extracted URLs", () => {
    const html = `<a href="https://artist.bandcamp.com/album/test?utm_source=email">Link</a>`;
    expect(extractMusicUrls({ html })).toEqual([
      "https://artist.bandcamp.com/album/test",
    ]);
  });
});
```

**Step 2: Implement the email parser**

```typescript
// server/email-parser.ts
import { parseUrl } from "./utils";

export interface EmailContent {
  html?: string;
  text?: string;
}

export function extractMusicUrls(email: EmailContent): string[] {
  const rawUrls: string[] = [];

  // Extract from HTML <a href="..."> tags
  if (email.html) {
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(email.html)) !== null) {
      rawUrls.push(match[1]);
    }
  }

  // Fallback: extract bare URLs from plain text
  if (rawUrls.length === 0 && email.text) {
    const urlRegex = /https?:\/\/[^\s<>"']+/gi;
    let match;
    while ((match = urlRegex.exec(email.text)) !== null) {
      rawUrls.push(match[0]);
    }
  }

  // Filter to known music platform URLs and deduplicate
  const seen = new Set<string>();
  const musicUrls: string[] = [];

  for (const url of rawUrls) {
    const parsed = parseUrl(url);
    if (parsed.source === "unknown") continue;

    const normalized = parsed.normalizedUrl;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    musicUrls.push(normalized);
  }

  return musicUrls;
}
```

**Step 3: Run unit tests**

```bash
npm run test:unit
```

**Step 4: Commit**

```bash
git add server/email-parser.ts tests/unit/email-parser.test.ts
git commit -m "feat: add email parser for extracting music URLs"
```

---

### Task 3: Ingest webhook route

**Files:**

- Create: `server/routes/ingest.ts`
- Modify: `server/index.ts`

**Step 1: Implement the route with auth and provider adapters**

```typescript
// server/routes/ingest.ts
import { Hono } from "hono";
import { extractMusicUrls } from "../email-parser";
import { createMusicItemFromUrl } from "../music-item-creator";

interface EmailEnvelope {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

// Provider adapters normalise provider-specific payloads
// into the internal EmailEnvelope shape.
const providers: Record<string, (body: any) => EmailEnvelope> = {
  generic: (body) => body as EmailEnvelope,
  sendgrid: (body) => ({
    from: body.from,
    to: body.to,
    subject: body.subject,
    html: body.html,
    text: body.text,
  }),
};

export const ingestRoutes = new Hono();

ingestRoutes.post("/email", async (c) => {
  // Auth check
  const apiKey = process.env.INGEST_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Ingest not configured" }, 503);
  }

  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${apiKey}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Enabled check
  if (process.env.INGEST_ENABLED === "false") {
    return c.json({ error: "Ingest disabled" }, 503);
  }

  // Parse body using provider adapter
  const provider = c.req.query("provider") || "generic";
  const adapter = providers[provider];
  if (!adapter) {
    return c.json({ error: `Unknown provider: ${provider}` }, 400);
  }

  const body = await c.req.json();
  const envelope = adapter(body);

  // Extract music URLs from email
  const urls = extractMusicUrls({ html: envelope.html, text: envelope.text });

  // Create items for each URL
  const items: Array<{ id: number; title: string; url: string }> = [];
  const skipped: Array<{ url: string; reason: string }> = [];

  for (const url of urls) {
    const result = await createMusicItemFromUrl(url, {
      notes: `Via email from ${envelope.from}`,
    });

    if (result.created) {
      items.push({
        id: result.item.id,
        title: result.item.title,
        url: result.item.primary_url || url,
      });
    } else {
      skipped.push({ url, reason: "duplicate" });
    }
  }

  return c.json({
    received: true,
    items_created: items.length,
    items_skipped: skipped.length,
    items,
    skipped,
  });
});
```

**Step 2: Mount the route in server/index.ts**

Add after the existing route mounts:

```typescript
import { ingestRoutes } from "./routes/ingest";
app.route("/api/ingest", ingestRoutes);
```

**Step 3: Verify typecheck passes**

```bash
npm run typecheck
```

**Step 4: Commit**

```bash
git add server/routes/ingest.ts server/index.ts
git commit -m "feat: add email ingest webhook endpoint"
```

---

### Task 4: Unit tests for the ingest route

**Files:**

- Create: `tests/unit/ingest.test.ts`

**Step 1: Write tests for auth, parsing, and item creation**

Key test cases:
- Returns 401 when no Authorization header
- Returns 401 when wrong API key
- Returns 503 when INGEST_API_KEY not set
- Returns 503 when INGEST_ENABLED is "false"
- Returns 400 for unknown provider
- Extracts URLs from generic envelope and creates items
- Skips duplicate URLs (already in music_links)
- Handles emails with no music URLs gracefully (returns 200, items_created: 0)

**Step 2: Run all tests**

```bash
npm run test:unit
npm run test:e2e
```

**Step 3: Commit**

```bash
git add tests/unit/ingest.test.ts
git commit -m "test: add unit tests for email ingest endpoint"
```

---

### Task 5: Deployment config and documentation

**Files:**

- Modify: `docs/deployment/coolify-alpha.md`

**Step 1: Add environment variable documentation**

Add a section to the deployment doc explaining how to set `INGEST_API_KEY` and optionally `INGEST_ENABLED` in Coolify.

**Step 2: Commit**

```bash
git add docs/deployment/coolify-alpha.md
git commit -m "docs: add email ingest env vars to deployment guide"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
```

**Step 2: Manual smoke test**

```bash
# Start dev server
npm run dev

# Test with curl
curl -X POST http://localhost:3000/api/ingest/email \
  -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@bandcamp.com",
    "to": "music@example.com",
    "subject": "New release",
    "html": "<a href=\"https://seekersinternational.bandcamp.com/album/test\">Listen</a>"
  }'
```

Verify the music item appears in the UI.
