const CAA_BASE = "https://coverartarchive.org/release";

type SaveImageFn = (base64Image: string) => Promise<string>;

export async function fetchAndSaveCoverArt(
  releaseId: string,
  saveImage: SaveImageFn,
): Promise<string | null> {
  const url = `${CAA_BASE}/${releaseId}/front-500`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return await saveImage(base64);
  } catch {
    return null;
  }
}
