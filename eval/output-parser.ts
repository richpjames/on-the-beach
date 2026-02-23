import { parseScanJson } from "../server/scan-parser";
import type { EvalModelKind } from "./types";

interface ParsedOutput {
  customId: string | null;
  actual: { artist: string | null; title: string | null } | null;
}

interface ParsedOcrTextOutput {
  customId: string | null;
  text: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractContentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((chunk): string => {
      const chunkObj = asRecord(chunk);
      if (!chunkObj) return "";
      return chunkObj.type === "text" && typeof chunkObj.text === "string" ? chunkObj.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function parseFromChatResponseBody(
  body: unknown,
): { artist: string | null; title: string | null } | null {
  const bodyObj = asRecord(body);
  if (!bodyObj) return null;

  const choices = bodyObj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const text = extractContentText(message?.content);
  return text ? parseScanJson(text) : null;
}

function parseFromOcrResponseBody(
  body: unknown,
): { artist: string | null; title: string | null } | null {
  const bodyObj = asRecord(body);
  if (!bodyObj) return null;

  const annotation =
    (typeof bodyObj.document_annotation === "string" ? bodyObj.document_annotation : null) ??
    (typeof bodyObj.documentAnnotation === "string" ? bodyObj.documentAnnotation : null);
  if (annotation) return parseScanJson(annotation);

  const pages = bodyObj.pages;
  if (!Array.isArray(pages)) return null;

  for (const page of pages) {
    const pageObj = asRecord(page);
    if (!pageObj || typeof pageObj.markdown !== "string") continue;
    const parsed = parseScanJson(pageObj.markdown);
    if (parsed) return parsed;
  }

  return null;
}

function extractOcrTextFromResponseBody(body: unknown): string | null {
  const bodyObj = asRecord(body);
  if (!bodyObj) return null;

  const pages = bodyObj.pages;
  if (Array.isArray(pages)) {
    const pageText = pages
      .map((page) => {
        const pageObj = asRecord(page);
        if (!pageObj) return "";

        if (typeof pageObj.markdown === "string") return pageObj.markdown.trim();
        if (typeof pageObj.text === "string") return pageObj.text.trim();
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (pageText.length > 0) return pageText;
  }

  if (typeof bodyObj.text === "string" && bodyObj.text.trim().length > 0) {
    return bodyObj.text.trim();
  }

  const annotation =
    (typeof bodyObj.document_annotation === "string" ? bodyObj.document_annotation : null) ??
    (typeof bodyObj.documentAnnotation === "string" ? bodyObj.documentAnnotation : null);
  return annotation?.trim() || null;
}

export function parseBatchOutput(output: unknown, kind: EvalModelKind): ParsedOutput {
  const outputObj = asRecord(output);
  const customId =
    (typeof outputObj?.custom_id === "string" ? outputObj.custom_id : null) ??
    (typeof outputObj?.customId === "string" ? outputObj.customId : null);

  const response = asRecord(outputObj?.response);
  const body = response?.body;

  const actual = kind === "ocr" ? parseFromOcrResponseBody(body) : parseFromChatResponseBody(body);

  return { customId, actual };
}

export function parseOcrTextBatchOutput(output: unknown): ParsedOcrTextOutput {
  const outputObj = asRecord(output);
  const customId =
    (typeof outputObj?.custom_id === "string" ? outputObj.custom_id : null) ??
    (typeof outputObj?.customId === "string" ? outputObj.customId : null);

  const response = asRecord(outputObj?.response);
  const text = extractOcrTextFromResponseBody(response?.body);

  return { customId, text };
}
