export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Ceiling for an image upload's base64 payload, in characters.
 *
 * The binding limit isn't the server's `MAX_IMAGE_BASE64_LENGTH` (2,000,000)
 * but SvelteKit's request body limit — 524,288 bytes by default — which rejects
 * the request with a 413 before any route handler runs. Base64 is ASCII, so one
 * character is one body byte; the rest of the budget is headroom for the JSON
 * envelope around it (notes, list names, a reminder date).
 */
export const MAX_UPLOAD_BASE64_LENGTH = 460_000;

export interface CompressionAttempt {
  maxEdge: number;
  quality: number;
}

/**
 * The ladder of downscale/quality settings to try when encoding an image,
 * starting with the requested settings and stepping down from there.
 *
 * A 1024px JPEG at quality 0.85 is usually well under the body limit, but a
 * busy sleeve (fine grain, lots of text) can still encode past it. Rather than
 * let that request 413, callers walk the ladder until the payload fits — so
 * only the photos that need it lose quality.
 *
 * Mirrored by `compressionAttempts` in native/ShareExtension/ShareViewController.swift.
 */
export function imageCompressionAttempts(maxEdge: number, quality: number): CompressionAttempt[] {
  return [
    { maxEdge, quality },
    { maxEdge, quality: quality * 0.75 },
    { maxEdge: Math.round(maxEdge * 0.75), quality: quality * 0.7 },
    { maxEdge: Math.round(maxEdge * 0.5), quality: quality * 0.6 },
    { maxEdge: Math.round(maxEdge * 0.35), quality: quality * 0.5 },
  ];
}

export function constrainDimensions(width: number, height: number, maxEdge: number): Dimensions {
  const largestEdge = Math.max(width, height);
  if (largestEdge <= maxEdge) {
    return { width, height };
  }

  const scale = maxEdge / largestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
