import { Mistral } from "@mistralai/mistralai";

export interface ApiResponse {
  content: string;
  error?: string;
}

export async function callMistral(
  client: Mistral,
  prompt: string,
  imageDataUri: string,
  model: string,
): Promise<ApiResponse> {
  try {
    const res = await client.chat.complete({
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", imageUrl: imageDataUri },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const content = res.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { content: "", error: "Unexpected response shape" };
    }
    return { content };
  } catch (err) {
    return { content: "", error: String(err) };
  }
}

/**
 * Calls any OpenAI-compatible /chat/completions endpoint (Qwen/DashScope,
 * OpenRouter, etc).
 *
 * Note the image payload differs from Mistral's: OpenAI's schema nests the URI
 * under `image_url: { url }`, where the Mistral SDK takes a bare `imageUrl`
 * string. Sending the wrong shape returns a 422 that names the *content* field
 * rather than the image, which is a confusing way to find out.
 */
export async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  prompt: string,
  imageDataUri: string,
  model: string,
): Promise<ApiResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: imageDataUri } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { content: "", error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return { content: "", error: "Unexpected response shape" };
    }
    return { content };
  } catch (err) {
    return { content: "", error: String(err) };
  }
}

/**
 * Calls an Anthropic-protocol /v1/messages endpoint.
 *
 * Z.AI's coding-plan entitlement only applies on its Anthropic gateway — the
 * OpenAI-compatible paas/v4 endpoint answers the same key with "insufficient
 * balance" — so GLM models come through here. Two shape differences from the
 * other callers: the image is a base64 source block rather than a URI, and the
 * reply is an array of typed blocks (thinking/text) whose text blocks must be
 * joined. Thinking is disabled to keep 101 calls fast; without this every
 * response arrives after a chain-of-thought preamble.
 */
export async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  prompt: string,
  imageDataUri: string,
  model: string,
): Promise<ApiResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;
  const imageMatch = /^data:(.+?);base64,(.*)$/s.exec(imageDataUri);
  if (!imageMatch) {
    return { content: "", error: "Could not parse image data URI" };
  }
  const [, mediaType, data] = imageMatch;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4096,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { content: "", error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
    }

    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = (json.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    if (!text) {
      return { content: "", error: "Unexpected response shape" };
    }
    return { content: text };
  } catch (err) {
    return { content: "", error: String(err) };
  }
}
