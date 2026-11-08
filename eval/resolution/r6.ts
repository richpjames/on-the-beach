import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Mistral } from "@mistralai/mistralai";
import type { ResolutionStrategy } from "./strategies";
import type { MbReleaseCandidate, DiscogsReleaseCandidate } from "../../adapters";

// ---------------------------------------------------------------------------
// R6: LLM adjudication of the candidate set
//
// The model sees the same five candidates each provider returned, plus the
// query string, and picks the right one or abstains. The eval harness replays
// vision output, so this is a new strategy in strategies.ts plus this prompt.
// ---------------------------------------------------------------------------

const HERE = dirname(import.meta.path);
const PROMPT_PATH = resolve(HERE, "r6-prompt.md");
const PROMPT = readFileSync(PROMPT_PATH, "utf-8");

/**
 * The model's answer, parsed from its response. A well-formed answer is one of
 * the ten candidates' provider+index, or "abstain". Anything else is a refusal.
 */
export interface R6Answer {
  provider: "discogs" | "musicbrainz" | null;
  index: number | null;
}

/**
 * Parse the model's answer. A well-formed answer is one of the ten candidates'
 * provider+index, or "abstain". Anything else is a refusal.
 */
export function parseR6Answer(answer: string): R6Answer {
  const trimmed = answer.trim();
  if (trimmed === "abstain") return { provider: null, index: null };

  const match = trimmed.match(/^(discogs|musicbrainz):(\d+)$/i);
  if (!match) return { provider: null, index: null };

  const index = Number(match[2]);
  return {
    provider: match[1]!.toLowerCase() as "discogs" | "musicbrainz",
    index: Number.isInteger(index) && index >= 0 && index <= 4 ? index : null,
  };
}

/**
 * Ask the model to adjudicate the candidate set. Returns the picked candidate
 * or null for abstain/refusal.
 */
export type ProviderCandidate =
  | { kind: "discogs"; value: DiscogsReleaseCandidate }
  | { kind: "mb"; value: MbReleaseCandidate };

export async function adjudicateR6(
  apiKey: string,
  artist: string,
  title: string,
  discogs: DiscogsReleaseCandidate[],
  musicbrainz: MbReleaseCandidate[],
): Promise<ProviderCandidate | null> {
  const client = new Mistral({ apiKey });
  const prompt = PROMPT.replace("{{artist}}", artist)
    .replace("{{title}}", title)
    .replace("{{discogs}}", JSON.stringify(discogs, null, 2))
    .replace("{{musicbrainz}}", JSON.stringify(musicbrainz, null, 2))
    .replace("{{answer}}", "");

  const response = await client.chat.complete({
    model: "mistral-large-2412",
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const answer = parseR6Answer(response.choices[0]?.message.content ?? "");
  if (answer.provider === null || answer.index === null) return null;

  const candidates = answer.provider === "discogs" ? discogs : musicbrainz;
  return candidates[answer.index] ?? null;
}

/**
 * The R6 strategy: both providers queried, five candidates each, LLM adjudication.
 */
export const r6Strategy: ResolutionStrategy = {
  id: "R6",
  name: "LLM adjudication",
  rationale: "Both databases queried, five candidates each, LLM adjudication.",
  options: { candidateLimit: 5 },
};
