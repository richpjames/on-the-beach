import { constrainDimensions } from "../ui/domain/scan";

const DEFAULT_MAX_EDGE = 1024;
const DEFAULT_QUALITY = 0.85;

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read image file"));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image file"));
    };
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = dataUrl;
  });
}

/**
 * Read an image file, downscale it so its longest edge is at most `maxEdge`,
 * and re-encode it as a JPEG. Returns the base64 payload (no data-URL prefix).
 *
 * Downscaling keeps the upload comfortably under the server's size limit
 * (see `MAX_IMAGE_BASE64_LENGTH` in server/uploads.ts); full-resolution phone
 * photos would otherwise be rejected.
 */
export async function encodeImageFile(
  file: Blob,
  maxEdge: number = DEFAULT_MAX_EDGE,
  quality: number = DEFAULT_QUALITY,
): Promise<string> {
  const imageDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(imageDataUrl);
  const { width, height } = constrainDimensions(image.width, image.height, maxEdge);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context unavailable");
  }

  context.drawImage(image, 0, 0, width, height);
  const encoded = canvas.toDataURL("image/jpeg", quality);
  const parts = encoded.split(",", 2);
  if (parts.length !== 2 || !parts[1]) {
    throw new Error("Failed to encode image");
  }

  return parts[1];
}
