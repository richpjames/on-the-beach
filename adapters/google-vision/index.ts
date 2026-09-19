const GOOGLE_VISION_API_URL = "https://vision.googleapis.com/v1/images:annotate";

interface WebEntity {
  entityId?: string;
  score?: number;
  description?: string;
}

interface WebPage {
  url?: string;
  score?: number;
  pageTitle?: string;
}

interface BestGuessLabel {
  label?: string;
  languageCode?: string;
}

interface WebDetection {
  bestGuessLabels?: BestGuessLabel[];
  webEntities?: WebEntity[];
  pagesWithMatchingImages?: WebPage[];
}

interface AnnotateImageResponse {
  webDetection?: WebDetection;
}

interface VisionApiResponse {
  responses?: AnnotateImageResponse[];
}

export async function getWebContext(base64Image: string): Promise<string | null> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) {
    return null;
  }

  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: "WEB_DETECTION", maxResults: 10 }],
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(`${GOOGLE_VISION_API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[google-vision] Network error:", err);
    return null;
  }

  if (!response.ok) {
    console.error("[google-vision] API error:", response.status, response.statusText);
    return null;
  }

  let data: VisionApiResponse;
  try {
    data = (await response.json()) as VisionApiResponse;
  } catch (err) {
    console.error("[google-vision] Failed to parse response:", err);
    return null;
  }

  const webDetection = data.responses?.[0]?.webDetection;
  if (!webDetection) {
    return null;
  }

  const parts: string[] = [];

  const labels = webDetection.bestGuessLabels ?? [];
  if (labels.length > 0) {
    const labelTexts = labels
      .map((l) => l.label)
      .filter(Boolean)
      .join(", ");
    parts.push(`Best guess labels: ${labelTexts}`);
  }

  const entities = webDetection.webEntities ?? [];
  const topEntities = entities
    .filter((e) => e.description && (e.score ?? 0) > 0.3)
    .slice(0, 5)
    .map((e) => e.description as string);
  if (topEntities.length > 0) {
    parts.push(`Web entities: ${topEntities.join(", ")}`);
  }

  const pages = webDetection.pagesWithMatchingImages ?? [];
  const pageTitles = pages
    .slice(0, 3)
    .map((p) => p.pageTitle)
    .filter(Boolean) as string[];
  if (pageTitles.length > 0) {
    parts.push(`Matching page titles: ${pageTitles.join("; ")}`);
  }

  const summary = parts.join("\n");
  console.log("[google-vision] Web context summary:", summary);
  return summary.length > 0 ? summary : null;
}
