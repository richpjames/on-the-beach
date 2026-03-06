import { Mistral } from "@mistralai/mistralai";
import type { ItemType } from "../src/types";

const DEFAULT_LINK_MODEL = "mistral-small-latest";
const MAX_AI_TEXT_CHARS = 20_000;

const WEB_RELEASE_PROMPT =
  "You are extracting music release data from a web page snippet. " +
  "Respond with JSON only using this shape: " +
  '{"releases":[{"artist":"string|null","title":"string|null","itemType":"album|ep|single|track|mix|compilation|null"}]}. ' +
  "Return every distinct music release clearly described in the snippet. " +
  "If a release is self-titled or has no distinct title, use the artist name as the title. " +
  "Do not invent releases. Return an empty releases array when the snippet is music-related but no concrete release can be extracted.";

interface TextChunkLike {
  type?: unknown;
  text?: unknown;
}

export interface ExtractedReleaseCandidate {
  artist?: string;
  title?: string;
  itemType?: ItemType;
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

  return trimmed;
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

function parseReleaseCandidate(value: unknown): ExtractedReleaseCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const artist = normalizeNullableString(candidate.artist);
  const title = normalizeNullableString(candidate.title) ?? artist;
  const itemType = normalizeItemType(candidate.itemType);

  if (!title) {
    return null;
  }

  return {
    artist,
    title,
    itemType,
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

    for (const release of releases) {
      const candidate = parseReleaseCandidate(release);
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
