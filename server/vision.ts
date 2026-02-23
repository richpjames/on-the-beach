import { Mistral } from "@mistralai/mistralai";
import type { ScanResult } from "../src/types";

const SCAN_MODEL = "mistral-small-latest";

const SCAN_PROMPT =
  "You are reading a photo of a music release cover. Respond with JSON only using keys artist and title. " +
  'If uncertain, use null values. Example: {"artist":"Radiohead","title":"OK Computer"}';

interface TextChunkLike {
  type?: unknown;
  text?: unknown;
}

function parseScanJson(rawContent: string): ScanResult | null {
  const trimmed = rawContent.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const artist = typeof parsed.artist === "string" ? parsed.artist.trim() || null : null;
    const title = typeof parsed.title === "string" ? parsed.title.trim() || null : null;

    if (
      parsed.artist !== null &&
      parsed.artist !== undefined &&
      typeof parsed.artist !== "string"
    ) {
      return null;
    }

    if (parsed.title !== null && parsed.title !== undefined && typeof parsed.title !== "string") {
      return null;
    }

    return { artist, title };
  } catch {
    return null;
  }
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

export async function extractAlbumInfo(base64Image: string): Promise<ScanResult | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    return null;
  }

  const client = new Mistral({ apiKey });

  try {
    const response = await client.chat.complete({
      model: SCAN_MODEL,
      temperature: 0,
      responseFormat: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: SCAN_PROMPT },
            { type: "image_url", imageUrl: `data:image/jpeg;base64,${base64Image}` },
          ],
        },
      ],
    });

    const message = response.choices[0]?.message?.content;
    const textContent = contentToText(message);
    if (!textContent) {
      console.error("[vision] Mistral returned no text content");
      return null;
    }

    const result = parseScanJson(textContent);
    console.log("[vision] Mistral scan result:", result);
    return result;
  } catch (err) {
    console.error("[vision] Mistral API error:", err);
    return null;
  }
}
