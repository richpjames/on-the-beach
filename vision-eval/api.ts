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
