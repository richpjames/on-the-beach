import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_UPLOADS_DIR = "uploads";
const UPLOADS_ROUTE_PREFIX = "/uploads";
const MAX_IMAGE_BASE64_LENGTH = 2_000_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function getUploadsDir(): string {
  const configuredDir = process.env.UPLOADS_DIR?.trim();

  if (!configuredDir) {
    return path.resolve(process.cwd(), DEFAULT_UPLOADS_DIR);
  }

  return path.isAbsolute(configuredDir)
    ? configuredDir
    : path.resolve(process.cwd(), configuredDir);
}

export function toUploadsPublicPath(filename: string): string {
  return `${UPLOADS_ROUTE_PREFIX}/${filename}`;
}

export function rewriteUploadsRequestPath(requestPath: string): string {
  if (!requestPath.startsWith(UPLOADS_ROUTE_PREFIX)) {
    return requestPath;
  }

  return requestPath.slice(UPLOADS_ROUTE_PREFIX.length) || "/";
}

export type ValidateImageBase64Result = { ok: true; value: string } | { ok: false; error: string };

export function validateImageBase64(value: unknown): ValidateImageBase64Result {
  if (typeof value !== "string") {
    return { ok: false, error: "imageBase64 must be a string" };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "imageBase64 is required" };
  }

  if (trimmed.length > MAX_IMAGE_BASE64_LENGTH) {
    return { ok: false, error: "imageBase64 is too large" };
  }

  if (!BASE64_PATTERN.test(trimmed)) {
    return { ok: false, error: "imageBase64 must be valid base64" };
  }

  return { ok: true, value: trimmed };
}

export async function saveImageFromBase64(base64Image: string): Promise<string> {
  const uploadsDir = getUploadsDir();
  await mkdir(uploadsDir, { recursive: true });

  const filename = `${crypto.randomUUID()}.jpg`;
  const filePath = path.join(uploadsDir, filename);
  const imageBytes = Buffer.from(base64Image, "base64");
  await writeFile(filePath, imageBytes);

  return toUploadsPublicPath(filename);
}
