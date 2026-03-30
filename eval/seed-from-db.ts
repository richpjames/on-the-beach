#!/usr/bin/env bun
// Usage: bun eval/seed-from-db.ts

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../server/db/index";
import { musicItems, artists } from "../server/db/schema";
import type { EvalManifest } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingCase {
  id: string;
  image: string;
  artist: string;
  title: string;
  dbId: number;
  flag?: "missing-artist" | "generic-artist" | "generic-title" | "no-musicbrainz";
}

interface PendingManifest {
  generatedAt: string;
  cases: PendingCase[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function makeSlug(artist: string, title: string): string {
  const a = slugify(artist);
  const t = slugify(title);
  if (a && t) return `${a}-${t}`;
  if (t) return t;
  if (a) return a;
  return "unknown";
}

const GENERIC_ARTIST_PATTERNS = /^(unknown|unknown artist|various artists?|va|various)$/i;

function isGenericArtist(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  if (trimmed.startsWith("[")) return true;
  if (GENERIC_ARTIST_PATTERNS.test(trimmed)) return true;
  return false;
}

const GENERIC_TITLE_PATTERNS = /^(untitled|unknown)$/i;

function isGenericTitle(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  if (trimmed.startsWith("[")) return true;
  if (GENERIC_TITLE_PATTERNS.test(trimmed)) return true;
  return false;
}

function loadExistingIds(manifestPath: string): Set<string> {
  if (!existsSync(manifestPath)) return new Set();
  const manifest: EvalManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  return new Set(manifest.cases.map((c) => c.id));
}

async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`  [warn] HTTP ${response.status} for ${url}`);
      return false;
    }
    const buffer = await response.arrayBuffer();
    writeFileSync(destPath, Buffer.from(buffer));
    return true;
  } catch (err) {
    console.warn(`  [warn] Failed to download ${url}: ${err}`);
    return false;
  }
}

function guessExtFromUrl(url: string): string {
  const clean = url.split("?")[0];
  const ext = extname(clean);
  return ext || ".jpg";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const repoRoot = resolve(import.meta.dir, "..");
  const manifestPath = resolve(repoRoot, "eval/fixtures/manifest.json");
  const imagesDir = resolve(repoRoot, "eval/fixtures/images");
  const pendingPath = resolve(repoRoot, "eval/fixtures/pending-review.json");
  const uploadsDir = resolve(repoRoot, "uploads");

  // Ensure images directory exists
  mkdirSync(imagesDir, { recursive: true });

  // Load existing IDs to skip
  const existingIds = loadExistingIds(manifestPath);
  console.log(`Existing manifest entries: ${existingIds.size}`);

  // Query all music items with artwork, joined to artists
  const rows = await db
    .select({
      id: musicItems.id,
      title: musicItems.title,
      artworkUrl: musicItems.artworkUrl,
      musicbrainzReleaseId: musicItems.musicbrainzReleaseId,
      artistName: artists.name,
    })
    .from(musicItems)
    .leftJoin(artists, eq(musicItems.artistId, artists.id))
    .where(isNotNull(musicItems.artworkUrl));

  console.log(`Music items with artwork: ${rows.length}`);

  const pending: PendingCase[] = [];
  let skipped = 0;
  let downloaded = 0;
  let copied = 0;
  let failed = 0;

  for (const row of rows) {
    const artistName = row.artistName ?? "";
    const title = row.title;
    const artworkUrl = row.artworkUrl!;
    const slug = makeSlug(artistName || "unknown", title);

    // Skip if already in manifest
    if (existingIds.has(slug)) {
      skipped++;
      continue;
    }

    // Determine file extension and destination filename
    const ext = guessExtFromUrl(artworkUrl);
    const destFilename = `db-${row.id}${ext}`;
    const destPath = resolve(imagesDir, destFilename);

    // Download or copy the image
    let imageOk = false;
    if (artworkUrl.startsWith("http://") || artworkUrl.startsWith("https://")) {
      // Already have it? Skip download.
      if (existsSync(destPath)) {
        imageOk = true;
      } else {
        process.stdout.write(`  Downloading ${artworkUrl} ...`);
        imageOk = await downloadImage(artworkUrl, destPath);
        if (imageOk) {
          process.stdout.write(" ok\n");
          downloaded++;
        } else {
          process.stdout.write(" FAILED\n");
          failed++;
        }
      }
    } else {
      // Local file — artworkUrl is like /uploads/filename.jpg
      const localRelative = artworkUrl.startsWith("/") ? artworkUrl.slice(1) : artworkUrl;
      const sourcePath = resolve(repoRoot, localRelative);
      if (existsSync(sourcePath)) {
        if (!existsSync(destPath)) {
          copyFileSync(sourcePath, destPath);
          copied++;
        }
        imageOk = true;
      } else {
        // Try uploads dir directly with just the basename
        const fallbackPath = resolve(uploadsDir, basename(artworkUrl));
        if (existsSync(fallbackPath)) {
          if (!existsSync(destPath)) {
            copyFileSync(fallbackPath, destPath);
            copied++;
          }
          imageOk = true;
        } else {
          console.warn(`  [warn] Local file not found: ${artworkUrl}`);
          failed++;
        }
      }
    }

    if (!imageOk) continue;

    // Determine flag
    let flag: PendingCase["flag"];
    if (!artistName) {
      flag = "missing-artist";
    } else if (isGenericArtist(artistName)) {
      flag = "generic-artist";
    } else if (isGenericTitle(title)) {
      flag = "generic-title";
    } else if (!row.musicbrainzReleaseId) {
      flag = "no-musicbrainz";
    }

    const entry: PendingCase = {
      id: slug,
      image: `images/${destFilename}`,
      artist: artistName,
      title,
      dbId: row.id,
      ...(flag ? { flag } : {}),
    };

    pending.push(entry);
  }

  // Write pending-review.json
  const output: PendingManifest = {
    generatedAt: new Date().toISOString(),
    cases: pending,
  };
  writeFileSync(pendingPath, JSON.stringify(output, null, 2) + "\n");

  // Summary
  const flagged = pending.filter((c) => c.flag);
  const unflagged = pending.filter((c) => !c.flag);
  const flagCounts = pending.reduce<Record<string, number>>((acc, c) => {
    if (c.flag) acc[c.flag] = (acc[c.flag] ?? 0) + 1;
    return acc;
  }, {});

  console.log("\n=== Summary ===");
  console.log(`Total rows queried:       ${rows.length}`);
  console.log(`Skipped (in manifest):    ${skipped}`);
  console.log(`Failed (image error):     ${failed}`);
  console.log(`Downloaded (remote):      ${downloaded}`);
  console.log(`Copied (local):           ${copied}`);
  console.log(`Written to pending:       ${pending.length}`);
  console.log(`  - unflagged (clean):    ${unflagged.length}`);
  console.log(`  - flagged (review):     ${flagged.length}`);
  for (const [flag, count] of Object.entries(flagCounts)) {
    console.log(`    • ${flag}: ${count}`);
  }
  console.log(`\nOutput: ${pendingPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
