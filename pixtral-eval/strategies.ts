export interface Strategy {
  id: string;
  name: string;
  prompt: string;
  parseResponse: (raw: string) => { artist: string; title: string; parseError?: boolean };
}

function parseProseSummary(raw: string): { artist: string; title: string; parseError?: boolean } {
  const lineMatch = raw.match(/Artist:\s*(.+?)\s*\|\s*Title:\s*(.+)/i);
  if (lineMatch) {
    return { artist: lineMatch[1].trim(), title: lineMatch[2].trim() };
  }

  const artistMatch = raw.match(/(?:^|\n)Artist[:\s]+(.+)/im);
  const titleMatch = raw.match(/(?:^|\n)(?:Title|Album)[:\s]+(.+)/im);
  if (artistMatch || titleMatch) {
    return {
      artist: artistMatch?.[1]?.trim() ?? "",
      title: titleMatch?.[1]?.trim() ?? "",
    };
  }

  return { artist: "", title: "", parseError: true };
}

function parseJsonResponse(raw: string): { artist: string; title: string; parseError?: boolean } {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found");
    const parsed = JSON.parse(jsonMatch[0]) as { artist?: string; title?: string };
    return {
      artist: parsed.artist?.trim() ?? "",
      title: parsed.title?.trim() ?? "",
    };
  } catch {
    return { artist: "", title: "", parseError: true };
  }
}

const PROSE_SUFFIX =
  "\n\nFinish your response with a single line in exactly this format:\nArtist: <artist name> | Title: <release title>";

export const strategies: Strategy[] = [
  {
    id: "A",
    name: "Baseline",
    prompt:
      "Identify the music release shown in this photo. State the artist name and release title." +
      PROSE_SUFFIX,
    parseResponse: parseProseSummary,
  },
  {
    id: "B",
    name: "OCR first",
    prompt:
      "First, transcribe all visible text on this cover exactly as it appears. Then, using that text and the visual design, identify the artist and release title." +
      PROSE_SUFFIX,
    parseResponse: parseProseSummary,
  },
  {
    id: "C",
    name: "Structured output",
    prompt:
      "Identify the music release shown in this photo. Respond ONLY with a JSON object — no prose, no markdown — with these fields:\n" +
      '{"artist": "...", "title": "...", "visible_text": "...", "confidence": 0.0}',
    parseResponse: parseJsonResponse,
  },
  {
    id: "D",
    name: "Chain of thought",
    prompt:
      "Identify the release in this photo by thinking step by step:\n" +
      "1. Describe the cover art (colours, imagery, style)\n" +
      "2. Read and list any text visible on the cover\n" +
      "3. Consider genre and era signifiers\n" +
      "4. State your conclusion\n" +
      PROSE_SUFFIX,
    parseResponse: parseProseSummary,
  },
  {
    id: "E",
    name: "Combined",
    prompt:
      "First, transcribe all visible text on this cover. Then identify the release. " +
      "Respond ONLY with a JSON object — no prose, no markdown — with these fields:\n" +
      '{"artist": "...", "title": "...", "visible_text": "...", "confidence": 0.0}',
    parseResponse: parseJsonResponse,
  },
];
