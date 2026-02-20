import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// Mock createMusicItemFromUrl before importing the route
vi.mock("../../server/music-item-creator", () => ({
  createMusicItemFromUrl: vi.fn(),
}));

// Import after mock is set up
const { ingestRoutes } = await import("../../server/routes/ingest");
const { createMusicItemFromUrl } = await import("../../server/music-item-creator");

const mockCreate = vi.mocked(createMusicItemFromUrl);

function makeApp() {
  const app = new Hono();
  app.route("/api/ingest", ingestRoutes);
  return app;
}

function makeRequest(
  app: Hono,
  body: Record<string, unknown>,
  opts?: { apiKey?: string; provider?: string },
) {
  const url = opts?.provider
    ? `http://localhost/api/ingest/email?provider=${opts.provider}`
    : "http://localhost/api/ingest/email";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  return app.request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const sampleEnvelope = {
  from: "noreply@bandcamp.com",
  to: "music@example.com",
  subject: "New release",
  html: '<a href="https://artist.bandcamp.com/album/cool-album">Listen</a>',
};

describe("POST /api/ingest/email", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCreate.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 when INGEST_API_KEY is not set", async () => {
    delete process.env.INGEST_API_KEY;
    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "anything" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Ingest not configured");
  });

  it("returns 503 when INGEST_ENABLED is false", async () => {
    process.env.INGEST_ENABLED = "false";
    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "test-secret" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Ingest disabled");
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope);
    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong API key is provided", async () => {
    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "wrong-key" });
    expect(res.status).toBe(401);
  });

  it("returns 400 for unknown provider", async () => {
    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, {
      apiKey: "test-secret",
      provider: "nonexistent",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown provider");
  });

  it("creates items from email with music URLs", async () => {
    mockCreate.mockResolvedValue({
      item: {
        id: 1,
        title: "Cool Album",
        primary_url: "https://artist.bandcamp.com/album/cool-album",
      } as any,
      created: true,
    });

    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.items_created).toBe(1);
    expect(body.items_skipped).toBe(0);
    expect(body.items[0].title).toBe("Cool Album");
    expect(mockCreate).toHaveBeenCalledWith("https://artist.bandcamp.com/album/cool-album", {
      notes: "Via email from noreply@bandcamp.com",
    });
  });

  it("reports duplicates when URL already exists", async () => {
    mockCreate.mockResolvedValue({
      item: { id: 1, title: "Existing" } as any,
      created: false,
    });

    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(0);
    expect(body.items_skipped).toBe(1);
    expect(body.skipped[0].reason).toBe("duplicate");
  });

  it("handles emails with no music URLs gracefully", async () => {
    const app = makeApp();
    const res = await makeRequest(
      app,
      {
        from: "someone@example.com",
        to: "music@example.com",
        subject: "Hello",
        text: "No music links in this email.",
      },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(0);
    expect(body.items_skipped).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("works with sendgrid provider adapter", async () => {
    mockCreate.mockResolvedValue({
      item: {
        id: 2,
        title: "SG Album",
        primary_url: "https://artist.bandcamp.com/album/sg-test",
      } as any,
      created: true,
    });

    const app = makeApp();
    const res = await makeRequest(
      app,
      {
        from: "noreply@bandcamp.com",
        to: "music@example.com",
        subject: "New release",
        html: '<a href="https://artist.bandcamp.com/album/sg-test">Listen</a>',
      },
      { apiKey: "test-secret", provider: "sendgrid" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(1);
  });

  it("handles creation failures gracefully", async () => {
    mockCreate.mockRejectedValue(new Error("DB error"));

    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(0);
    expect(body.items_skipped).toBe(1);
    expect(body.skipped[0].reason).toBe("creation_failed");
  });
});
