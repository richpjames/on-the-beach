import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { createTransport } from "nodemailer";
import type { SMTPServer } from "smtp-server";

const mockCreate = mock();

// Mock createMusicItemFromUrl before importing
mock.module("../../server/music-item-creator", () => ({
  createMusicItemFromUrl: mockCreate,
  fetchFullItem: mock(),
}));

const { startSmtpIngest } = await import("../../server/smtp-ingest");

let server: SMTPServer;
let smtpPort: number;

// Use a random high port for tests
beforeEach(() => {
  mockCreate.mockReset();
  smtpPort = 10025 + Math.floor(Math.random() * 50000);
  process.env.SMTP_PORT = String(smtpPort);
  delete process.env.SMTP_ALLOWED_FROM;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(resolve));
  }
});

function sendMail(opts: {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}) {
  const transport = createTransport({
    host: "127.0.0.1",
    port: smtpPort,
    secure: false,
    tls: { rejectUnauthorized: false },
  });

  return transport.sendMail(opts);
}

// Give mailparser time to process
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SMTP ingest server", () => {
  it("receives an email and creates a music item from a bandcamp URL", async () => {
    mockCreate.mockResolvedValue({
      item: {
        id: 1,
        title: "Test Album",
        primary_url: "https://artist.bandcamp.com/album/test",
      } as any,
      created: true,
    });

    server = startSmtpIngest();
    await wait(200);

    await sendMail({
      from: "noreply@bandcamp.com",
      to: "music@example.com",
      subject: "New release from Artist",
      html: '<p>Check it out: <a href="https://artist.bandcamp.com/album/test">Listen</a></p>',
    });

    await wait(500);

    expect(mockCreate).toHaveBeenCalledWith("https://artist.bandcamp.com/album/test", {
      notes: "Via email from noreply@bandcamp.com",
    });
  });

  it("ignores emails with no music URLs", async () => {
    server = startSmtpIngest();
    await wait(200);

    await sendMail({
      from: "someone@example.com",
      to: "music@example.com",
      subject: "Hello",
      text: "Just a normal email, no music links.",
    });

    await wait(500);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("filters senders when SMTP_ALLOWED_FROM is set", async () => {
    process.env.SMTP_ALLOWED_FROM = "noreply@bandcamp.com";

    mockCreate.mockResolvedValue({
      item: { id: 1, title: "Album" } as any,
      created: true,
    });

    server = startSmtpIngest();
    await wait(200);

    // This sender is NOT in the allow list
    await sendMail({
      from: "spam@evil.com",
      to: "music@example.com",
      subject: "Buy this",
      html: '<a href="https://artist.bandcamp.com/album/spam">Listen</a>',
    });

    await wait(500);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("accepts emails from allowed senders", async () => {
    process.env.SMTP_ALLOWED_FROM = "noreply@bandcamp.com,alerts@spotify.com";

    mockCreate.mockResolvedValue({
      item: { id: 2, title: "Allowed Album" } as any,
      created: true,
    });

    server = startSmtpIngest();
    await wait(200);

    await sendMail({
      from: "noreply@bandcamp.com",
      to: "music@example.com",
      subject: "New release",
      html: '<a href="https://artist.bandcamp.com/album/allowed">Listen</a>',
    });

    await wait(500);

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
