import { Hono } from "hono";
import { extractAlbumInfo } from "../vision";
import type { ScanResult } from "../../src/types";

const MAX_IMAGE_BASE64_LENGTH = 2_000_000;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface ScanRequestBody {
  imageBase64?: unknown;
}

function validateImageBase64(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
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

export type ExtractAlbumInfoFn = (base64Image: string) => Promise<ScanResult | null>;

export function createReleaseRoutes(scanReleaseCover: ExtractAlbumInfoFn = extractAlbumInfo): Hono {
  const routes = new Hono();

  routes.post("/scan", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      console.error("[api] POST /api/release/scan invalid JSON:", err);
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const validation = validateImageBase64((body as ScanRequestBody).imageBase64);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }

    const scanResult = await scanReleaseCover(validation.value);
    if (!scanResult) {
      return c.json({ error: "Scan unavailable" }, 503);
    }

    return c.json(scanResult, 200);
  });

  return routes;
}

export const releaseRoutes = createReleaseRoutes();
