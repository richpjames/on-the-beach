import type { CreateMusicItemInput, ItemType } from "../../types";

export interface AddFormValues {
  url: string;
  title: string;
  artist: string;
  itemType: string;
  label: string;
  year: string;
  country: string;
  genre: string;
  catalogueNumber: string;
  notes: string;
  artworkUrl: string;
}

export function hasAnyNonEmptyField(values: readonly string[]): boolean {
  return values.some((value) => value.trim() !== "");
}

export function buildCreateMusicItemInputFromValues(values: AddFormValues): CreateMusicItemInput {
  const yearRaw = values.year.trim();

  return {
    url: normalizeUrlWithProtocol(values.url),
    title: toOptionalString(values.title),
    artistName: toOptionalString(values.artist),
    itemType: (toOptionalString(values.itemType) as ItemType | undefined) ?? "album",
    label: toOptionalString(values.label),
    year: yearRaw ? Number(yearRaw) : undefined,
    country: toOptionalString(values.country),
    genre: toOptionalString(values.genre),
    catalogueNumber: toOptionalString(values.catalogueNumber),
    notes: toOptionalString(values.notes),
    artworkUrl: normalizeArtworkUrl(values.artworkUrl),
  };
}

export function getCoverScanErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("uploadReleaseImage")) {
    return "Couldn't save the image. Enter details manually.";
  }

  if (error instanceof Error && error.message.includes("503")) {
    return "Scan unavailable. Enter details manually.";
  }

  return "Couldn't read the cover. Enter details manually.";
}

function toOptionalString(value: string): string | undefined {
  return value || undefined;
}

function normalizeUrlWithProtocol(value: string): string | undefined {
  const url = value.trim();
  if (!url) {
    return undefined;
  }

  if (!/^https?:\/\//i.test(url)) {
    return `https://${url}`;
  }

  return url;
}

function normalizeArtworkUrl(value: string): string | undefined {
  const artworkUrl = value.trim();
  if (!artworkUrl) {
    return undefined;
  }

  if (!/^https?:\/\//i.test(artworkUrl) && !artworkUrl.startsWith("/uploads/")) {
    return `https://${artworkUrl}`;
  }

  return artworkUrl;
}
