import { Mistral } from "@mistralai/mistralai";
import type { ItemType, LinkReleaseCandidate } from "../src/types";
import { decodeHtmlEntities } from "./scraper";

const DEFAULT_LINK_MODEL = "mistral-small-latest";
const MAX_AI_TEXT_CHARS = 20_000;

const WEB_RELEASE_PROMPT =
  "You are extracting music release data from a web page snippet. " +
  "Respond with JSON only using this shape: " +
  '{"releases":[{"artist":"string|null","title":"string|null","itemType":"album|ep|single|track|mix|compilation|null","confidence":"number|null","evidence":"string|null","isPrimary":"boolean|null"}]}. ' +
  "Return every distinct music release clearly described in the snippet. " +
  "Mark isPrimary true only when the page is mainly about that one release, such as a product page or dedicated release page. " +
  "Use evidence for a short reason like 'product title', 'headline', or 'release section'. " +
  "If a release is self-titled or has no distinct title, use the artist name as the title. " +
  "Do not invent releases. Return an empty releases array when the snippet is music-related but no concrete release can be extracted.";

interface TextChunkLike {
  type?: unknown;
  text?: unknown;
}

export interface ExtractedReleaseCandidate {
  candidateId: string;
  artist?: string;
  title?: string;
  itemType?: ItemType;
  confidence?: number;
  evidence?: string;
  isPrimary?: boolean;
}

function slugifySegment(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildCandidateId(artist: string | undefined, title: string, index: number): string {
  const artistPart = slugifySegment(artist) || "unknown-artist";
  const titlePart = slugifySegment(title) || "unknown-title";
  return `cand-${index + 1}-${artistPart}-${titlePart}`;
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((chunk): string => {
      if (!chunk || typeof chunk !== "object") return "";
      const textChunk = chunk as TextChunkLike;
      if (textChunk.type !== "text" || typeof textChunk.text !== "string") {
        return "";
      }
      return textChunk.text;
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function normalizeNullableString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return undefined;
  }

  return decodeHtmlEntities(trimmed);
}

function normalizeItemType(value: unknown): ItemType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "album":
      return "album";
    case "ep":
      return "ep";
    case "single":
      return "single";
    case "track":
      return "track";
    case "mix":
    case "mixtape":
      return "mix";
    case "compilation":
      return "compilation";
    default:
      return undefined;
  }
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, value));
}

function parseReleaseCandidate(value: unknown, index: number): ExtractedReleaseCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const artist = normalizeNullableString(candidate.artist);
  const title = normalizeNullableString(candidate.title) ?? artist;
  const itemType = normalizeItemType(candidate.itemType);
  const evidence = normalizeNullableString(candidate.evidence);
  const confidence = normalizeConfidence(candidate.confidence);
  const isPrimary = typeof candidate.isPrimary === "boolean" ? candidate.isPrimary : undefined;

  if (!title) {
    return null;
  }

  return {
    candidateId: buildCandidateId(artist, title, index),
    ...(artist ? { artist } : {}),
    title,
    ...(itemType ? { itemType } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(evidence ? { evidence } : {}),
    ...(isPrimary !== undefined ? { isPrimary } : {}),
  };
}

export function parseReleaseCandidatesJson(rawContent: string): ExtractedReleaseCandidate[] {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as unknown;
    const root =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;

    if (!root) {
      return [];
    }

    const releases = Array.isArray(root.releases) ? root.releases : [];
    const seen = new Set<string>();
    const normalized: ExtractedReleaseCandidate[] = [];

    for (const [index, release] of releases.entries()) {
      const candidate = parseReleaseCandidate(release, index);
      if (!candidate) {
        continue;
      }

      const dedupeKey = `${candidate.artist?.toLowerCase() ?? ""}::${candidate.title.toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      normalized.push(candidate);
    }

    return normalized;
  } catch {
    return [];
  }
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreUrlMatch(urlText: string, candidate: LinkReleaseCandidate): number {
  let score = 0;
  const title = normalizeSearchText(candidate.title);
  const artist = normalizeSearchText(candidate.artist ?? "");

  if (title && urlText.includes(title)) {
    score += 2.5;
  }

  if (artist && urlText.includes(artist)) {
    score += 1.5;
  }

  const titleWords = title.split(" ").filter((word) => word.length >= 4);
  const matchingTitleWords = titleWords.filter((word) => urlText.includes(word));
  score += Math.min(matchingTitleWords.length * 0.35, 1.4);

  return score;
}

export function pickPrimaryReleaseCandidate(
  url: string,
  candidates: LinkReleaseCandidate[],
): LinkReleaseCandidate | null {
  if (candidates.length === 1) {
    return candidates[0];
  }

  let urlText = "";
  try {
    const parsed = new URL(url);
    urlText = normalizeSearchText(`${parsed.hostname} ${parsed.pathname}`);
  } catch {
    urlText = normalizeSearchText(url);
  }

  const scored = candidates
    .map((candidate) => {
      let score = scoreUrlMatch(urlText, candidate);
      if (candidate.isPrimary) {
        score += 3;
      }
      if (candidate.confidence !== undefined) {
        score += candidate.confidence;
      }
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best) {
    return null;
  }

  const scoreGap = second ? best.score - second.score : best.score;
  const hasStrongUrlSignal = scoreUrlMatch(urlText, best.candidate) >= 2.5;
  const hasExplicitPrimarySignal = best.candidate.isPrimary === true;

  if ((hasStrongUrlSignal || hasExplicitPrimarySignal) && scoreGap >= 1.25) {
    return best.candidate;
  }

  return null;
}

export async function extractReleaseCandidatesFromWebText(
  url: string,
  pageText: string,
): Promise<ExtractedReleaseCandidate[] | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    return null;
  }

  const snippet = pageText.trim().slice(0, MAX_AI_TEXT_CHARS);
  if (!snippet) {
    return [];
  }

  const client = new Mistral({ apiKey });
  const model = process.env.MISTRAL_LINK_MODEL?.trim() || DEFAULT_LINK_MODEL;

  try {
    const response = await client.chat.complete({
      model,
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${WEB_RELEASE_PROMPT}\n\nURL: ${url}\n\nSnippet:\n${snippet}`,
            },
          ],
        },
      ],
    });

    const message = response.choices[0]?.message?.content;
    const textContent = contentToText(message);
    if (!textContent) {
      console.error("[scraper] Mistral link extraction returned no text content");
      return [];
    }

    return parseReleaseCandidatesJson(textContent);
  } catch (err) {
    console.error("[scraper] Mistral link extraction failed:", err);
    return [];
  }
}
