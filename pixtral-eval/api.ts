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
