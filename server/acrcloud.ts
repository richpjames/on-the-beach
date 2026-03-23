import { createHmac } from "node:crypto";

export interface AcrCloudConfig {
  host: string;
  accessKey: string;
  accessSecret: string;
}

export interface AcrCloudResult {
  artist: string;
  title: string;
  album?: string;
  year?: string;
}

function getConfig(): AcrCloudConfig | null {
  const host = process.env.ACRCLOUD_HOST;
  const accessKey = process.env.ACRCLOUD_ACCESS_KEY;
  const accessSecret = process.env.ACRCLOUD_ACCESS_SECRET;

  if (!host || !accessKey || !accessSecret) {
    return null;
  }

  return { host, accessKey, accessSecret };
}

function buildSignature(accessKey: string, accessSecret: string, timestamp: number): string {
  const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`;
  return createHmac("sha1", accessSecret).update(stringToSign).digest("base64");
}

export async function recognizeAudio(
  audioBase64: string,
  mimeType = "audio/webm",
): Promise<AcrCloudResult | null> {
  const config = getConfig();
  if (!config) {
    throw new Error("ACRCloud is not configured");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildSignature(config.accessKey, config.accessSecret, timestamp);

  const audioBuffer = Buffer.from(audioBase64, "base64");

  const formData = new FormData();
  formData.append("access_key", config.accessKey);
  formData.append("sample", new Blob([audioBuffer], { type: mimeType }), "sample.webm");
  formData.append("sample_bytes", String(audioBuffer.length));
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("data_type", "audio");
  formData.append("signature_version", "1");

  const response = await fetch(`https://${config.host}/v1/identify`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`ACRCloud request failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    status?: { code?: number; msg?: string };
    metadata?: {
      music?: Array<{
        title?: string;
        artists?: Array<{ name?: string }>;
        album?: { name?: string };
        release_date?: string;
      }>;
    };
  };

  if (data.status?.code !== 0) {
    // code 1001 = no result
    return null;
  }

  const music = data.metadata?.music?.[0];
  if (!music) return null;

  const artist = music.artists?.[0]?.name;
  const title = music.title;

  if (!artist || !title) return null;

  const year = music.release_date ? music.release_date.substring(0, 4) : undefined;

  return {
    artist,
    title,
    album: music.album?.name,
    year,
  };
}

export function isAcrCloudConfigured(): boolean {
  return getConfig() !== null;
}
