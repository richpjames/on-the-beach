import { Mistral } from "@mistralai/mistralai";
import type { ScanResult } from "../src/types";
import { parseScanJson } from "./scan-parser";

const DEFAULT_SCAN_MODEL = "mistral-ocr-latest";

const SCAN_PROMPT =
  "You are reading a photo of a music release cover. Respond with JSON only using keys artist and title. " +
  'If uncertain, use null values. Example: {"artist":"Radiohead","title":"OK Computer"}';

const OCR_SCHEMA = {
  name: "music_release_scan",
  strict: true,
  schemaDefinition: {
    type: "object",
    additionalProperties: false,
    properties: {
      artist: { type: ["string", "null"] },
      title: { type: ["string", "null"] },
    },
    required: ["artist", "title"],
  },
} as const;

interface TextChunkLike {
  type?: unknown;
  text?: unknown;
}

interface OcrPageLike {
  markdown?: unknown;
}

interface OcrResponseLike {
  documentAnnotation?: unknown;
  pages?: unknown;
}

function getScanModel(): string {
  const configuredModel = process.env.MISTRAL_SCAN_MODEL?.trim();
  return configuredModel && configuredModel.length > 0 ? configuredModel : DEFAULT_SCAN_MODEL;
}

function isOcrModel(model: string): boolean {
  return model.toLowerCase().includes("-ocr-");
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

function parseOcrResponse(response: unknown): ScanResult | null {
  if (!response || typeof response !== "object") return null;
  const ocrResponse = response as OcrResponseLike;

  if (typeof ocrResponse.documentAnnotation === "string") {
    const parsedFromAnnotation = parseScanJson(ocrResponse.documentAnnotation);
    if (parsedFromAnnotation) return parsedFromAnnotation;
  }

  if (!Array.isArray(ocrResponse.pages)) {
    return null;
  }

  for (const page of ocrResponse.pages) {
    if (!page || typeof page !== "object") continue;
    const pageLike = page as OcrPageLike;
    if (typeof pageLike.markdown !== "string") continue;
    const parsedFromPage = parseScanJson(pageLike.markdown);
    if (parsedFromPage) return parsedFromPage;
  }

  return null;
}

async function extractWithChat(
  client: Mistral,
  model: string,
  base64Image: string,
): Promise<ScanResult | null> {
  const response = await client.chat.complete({
    model,
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
    console.error("[vision] Mistral chat returned no text content");
    return null;
  }

  return parseScanJson(textContent);
}

async function extractWithOcr(
  client: Mistral,
  model: string,
  base64Image: string,
): Promise<ScanResult | null> {
  const response = await client.ocr.process({
    model,
    document: {
      type: "image_url",
      imageUrl: `data:image/jpeg;base64,${base64Image}`,
    },
    documentAnnotationFormat: {
      type: "json_schema",
      jsonSchema: OCR_SCHEMA,
    },
    documentAnnotationPrompt: SCAN_PROMPT,
  });

  return parseOcrResponse(response);
}

export async function extractAlbumInfo(base64Image: string): Promise<ScanResult | null> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = getScanModel();
  const client = new Mistral({ apiKey });

  try {
    const result = isOcrModel(model)
      ? await extractWithOcr(client, model, base64Image)
      : await extractWithChat(client, model, base64Image);

    console.log("[vision] Mistral scan result:", result);
    return result;
  } catch (err) {
    console.error("[vision] Mistral API error:", err);
    return null;
  }
}
