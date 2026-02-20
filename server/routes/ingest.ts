import { Hono } from "hono";
import { extractMusicUrls } from "../email-parser";
import { createMusicItemFromUrl } from "../music-item-creator";

interface EmailEnvelope {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

type ProviderAdapter = (body: Record<string, unknown>) => EmailEnvelope;

const providers: Record<string, ProviderAdapter> = {
  generic: (body) => body as unknown as EmailEnvelope,
  sendgrid: (body) => ({
    from: String(body.from ?? ""),
    to: String(body.to ?? ""),
    subject: String(body.subject ?? ""),
    html: body.html ? String(body.html) : undefined,
    text: body.text ? String(body.text) : undefined,
  }),
};

export const ingestRoutes = new Hono();

ingestRoutes.post("/email", async (c) => {
  // Check if ingest is configured
  const apiKey = process.env.INGEST_API_KEY;
  if (!apiKey) {
    return c.json({ error: "Ingest not configured" }, 503);
  }

  // Check if ingest is enabled
  if (process.env.INGEST_ENABLED === "false") {
    return c.json({ error: "Ingest disabled" }, 503);
  }

  // Authenticate
  const auth = c.req.header("Authorization");
  if (auth !== `Bearer ${apiKey}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Select provider adapter
  const provider = c.req.query("provider") || "generic";
  const adapter = providers[provider];
  if (!adapter) {
    return c.json({ error: `Unknown provider: ${provider}` }, 400);
  }

  // Parse body into envelope
  const body = await c.req.json();
  const envelope = adapter(body);

  // Extract music URLs from email content
  const urls = extractMusicUrls({ html: envelope.html, text: envelope.text });

  // Create items for each URL
  const items: Array<{ id: number; title: string; url: string }> = [];
  const skipped: Array<{ url: string; reason: string }> = [];

  for (const url of urls) {
    try {
      const result = await createMusicItemFromUrl(url, {
        notes: `Via email from ${envelope.from}`,
      });

      if (result.created) {
        items.push({
          id: result.item.id,
          title: result.item.title,
          url: result.item.primary_url || url,
        });
      } else {
        skipped.push({ url, reason: "duplicate" });
      }
    } catch {
      skipped.push({ url, reason: "creation_failed" });
    }
  }

  return c.json({
    received: true,
    items_created: items.length,
    items_skipped: skipped.length,
    items,
    skipped,
  });
});
