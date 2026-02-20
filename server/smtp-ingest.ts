import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { extractMusicUrls } from "./email-parser";
import { createMusicItemFromUrl } from "./music-item-creator";

/**
 * Start an embedded SMTP server that receives emails, extracts music URLs,
 * and creates music items.
 *
 * Configure via env vars:
 *   SMTP_PORT          – port to listen on (default 2525)
 *   SMTP_ALLOWED_FROM  – comma-separated sender patterns to accept (e.g. "noreply@bandcamp.com")
 *                         If unset, all senders are accepted.
 */
export function startSmtpIngest(): SMTPServer {
  const port = Number(process.env.SMTP_PORT) || 2525;
  const allowedFrom = process.env.SMTP_ALLOWED_FROM
    ? process.env.SMTP_ALLOWED_FROM.split(",").map((s) => s.trim().toLowerCase())
    : null;

  const server = new SMTPServer({
    disabledCommands: ["AUTH", "STARTTLS"],
    logger: false,
    size: 5 * 1024 * 1024, // 5 MB max

    onData(stream, session, callback) {
      processEmail(stream, session, allowedFrom)
        .then(() => callback())
        .catch((err) => {
          console.error("[smtp-ingest] Error processing email:", err);
          callback();
        });
    },
  });

  server.on("error", (err) => {
    console.error("[smtp-ingest] Server error:", err);
  });

  server.listen(port, () => {
    console.log(`SMTP ingest listening on port ${port}`);
  });

  return server;
}

async function processEmail(
  stream: NodeJS.ReadableStream,
  session: { envelope: { mailFrom: { address: string } | false; rcptTo: { address: string }[] } },
  allowedFrom: string[] | null,
): Promise<void> {
  const parsed = await simpleParser(stream);

  const from = session.envelope.mailFrom
    ? session.envelope.mailFrom.address
    : (parsed.from?.value?.[0]?.address ?? "unknown");

  // Filter by allowed senders
  if (allowedFrom && !allowedFrom.includes(from.toLowerCase())) {
    console.log(`[smtp-ingest] Rejected email from ${from} (not in SMTP_ALLOWED_FROM)`);
    return;
  }

  const urls = extractMusicUrls({
    html: parsed.html || undefined,
    text: parsed.text || undefined,
  });

  if (urls.length === 0) {
    console.log(`[smtp-ingest] No music URLs found in email from ${from}: "${parsed.subject}"`);
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const url of urls) {
    try {
      const result = await createMusicItemFromUrl(url, {
        notes: `Via email from ${from}`,
      });
      if (result.created) {
        created++;
        console.log(`[smtp-ingest] Created: ${result.item.title} (${url})`);
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[smtp-ingest] Failed to create item for ${url}:`, err);
    }
  }

  console.log(
    `[smtp-ingest] Processed email from ${from}: "${parsed.subject}" — ${created} created, ${skipped} skipped`,
  );
}
