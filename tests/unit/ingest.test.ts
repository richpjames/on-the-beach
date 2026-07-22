import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
// Imported before mock.module so the real exports can be passed through below.
import * as realCreator from "../../server/music-item-creator";

const mockCreateMany = mock();
const mockCreateDirect = mock();
const mockSaveImage = mock();
const mockScan = mock();
const mockListStacks = mock();
const mockResolveOrCreateStack = mock();
const mockAttachItemToStack = mock();
const mockSetItemReminder = mock();
const mockCountToListen = mock();

// Mock the music-item-creator module before importing any route, overriding
// only the functions the ingest routes call. bun's mock.module() persists
// process-wide for the rest of the test run, and `fullItemSelect` is a
// re-export from server/queries/full-item-select — replacing it with a bare
// mock() can clobber the origin module's binding for every later importer
// (this broke the main-page SSR tests on CI, where this file runs first).
// Passing the real values through keeps other test files working regardless
// of file execution order.
mock.module("../../server/music-item-creator", () => ({
  ...realCreator,
  createMusicItemsFromUrl: mockCreateMany,
  createMusicItemDirect: mockCreateDirect,
}));

// Import after mocks are set up
const { createIngestRoutes } = await import("../../server/routes/ingest");

function makeApp() {
  const app = new Hono();
  app.route(
    "/api/ingest",
    createIngestRoutes({
      scanPhoto: mockScan,
      savePhoto: mockSaveImage,
      listStacks: mockListStacks,
      resolveOrCreateStack: mockResolveOrCreateStack,
      attachItemToStack: mockAttachItemToStack,
      setItemReminder: mockSetItemReminder,
      countToListen: mockCountToListen,
    }),
  );
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

function makeLinkRequest(app: Hono, body: Record<string, unknown>, opts?: { apiKey?: string }) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  return app.request("http://localhost/api/ingest/link", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/ingest/link", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCreateMany.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 when INGEST_API_KEY is not set", async () => {
    delete process.env.INGEST_API_KEY;
    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url: "https://artist.bandcamp.com/album/test" },
      { apiKey: "anything" },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Ingest not configured");
  });

  it("returns 503 when INGEST_ENABLED is false", async () => {
    process.env.INGEST_ENABLED = "false";
    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url: "https://artist.bandcamp.com/album/test" },
      { apiKey: "test-secret" },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Ingest disabled");
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const app = makeApp();
    const res = await makeLinkRequest(app, { url: "https://artist.bandcamp.com/album/test" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong API key is provided", async () => {
    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url: "https://artist.bandcamp.com/album/test" },
      { apiKey: "wrong-key" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when url is missing", async () => {
    const app = makeApp();
    const res = await makeLinkRequest(app, {}, { apiKey: "test-secret" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("url");
  });

  it("returns 400 when url is invalid", async () => {
    const app = makeApp();
    const res = await makeLinkRequest(app, { url: "not-a-url" }, { apiKey: "test-secret" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("url");
  });

  it("creates an item from a valid URL", async () => {
    const url = "https://artist.bandcamp.com/album/cool-album";
    mockCreateMany.mockResolvedValue([
      {
        item: { id: 1, title: "Cool Album", primary_url: url } as any,
        created: true,
      },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(app, { url }, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.items_created).toBe(1);
    expect(body.items_skipped).toBe(0);
    expect(body.items[0].title).toBe("Cool Album");
    expect(mockCreateMany).toHaveBeenCalledWith(url);
  });

  it("reports duplicate when URL already exists", async () => {
    const url = "https://artist.bandcamp.com/album/cool-album";
    mockCreateMany.mockResolvedValue([
      {
        item: { id: 1, title: "Cool Album" } as any,
        created: false,
      },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(app, { url }, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(0);
    expect(body.items_skipped).toBe(1);
    expect(body.skipped[0].reason).toBe("duplicate");
  });

  it("returns 422 when item creation fails", async () => {
    mockCreateMany.mockRejectedValue(new Error("Scrape failed"));

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url: "https://artist.bandcamp.com/album/cool-album" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("POST /api/ingest/link with list and notes", () => {
  const originalEnv = { ...process.env };
  const url = "https://artist.bandcamp.com/album/cool-album";

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCreateMany.mockReset();
    mockResolveOrCreateStack.mockReset();
    mockAttachItemToStack.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("passes notes through to the item creator", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 1, title: "Cool Album", primary_url: url } as any, created: true },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, notes: "saw this live" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    expect(mockCreateMany).toHaveBeenCalledWith(url, { notes: "saw this live" });
  });

  it("resolves the list by name and attaches the created item to it", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 7, title: "Cool Album", primary_url: url } as any, created: true },
    ]);
    mockResolveOrCreateStack.mockResolvedValue({ id: 3, name: "Jazz finds" });

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, listName: "Jazz finds" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolveOrCreateStack).toHaveBeenCalledWith("Jazz finds");
    expect(mockAttachItemToStack).toHaveBeenCalledWith(7, 3);
    expect(body.lists).toEqual([{ id: 3, name: "Jazz finds" }]);
  });

  it("resolves several lists and files the item into each of them", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 7, title: "Cool Album", primary_url: url } as any, created: true },
    ]);
    mockResolveOrCreateStack.mockImplementation(
      async (name: string) => ({ "Jazz finds": { id: 3, name }, Wishlist: { id: 5, name } })[name],
    );

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, listNames: ["Jazz finds", "Wishlist"] },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolveOrCreateStack).toHaveBeenCalledWith("Jazz finds");
    expect(mockResolveOrCreateStack).toHaveBeenCalledWith("Wishlist");
    expect(mockAttachItemToStack).toHaveBeenCalledWith(7, 3);
    expect(mockAttachItemToStack).toHaveBeenCalledWith(7, 5);
    expect(body.lists).toEqual([
      { id: 3, name: "Jazz finds" },
      { id: 5, name: "Wishlist" },
    ]);
  });

  it("de-dupes list names across listNames and the legacy listName", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 7, title: "Cool Album", primary_url: url } as any, created: true },
    ]);
    mockResolveOrCreateStack.mockResolvedValue({ id: 3, name: "Jazz finds" });

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, listNames: ["Jazz finds", "  Jazz finds  "], listName: "Jazz finds" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    expect(mockResolveOrCreateStack).toHaveBeenCalledTimes(1);
    expect(mockAttachItemToStack).toHaveBeenCalledTimes(1);
  });

  it("does not touch lists when no list is given", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 1, title: "Cool Album", primary_url: url } as any, created: true },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(app, { url }, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolveOrCreateStack).not.toHaveBeenCalled();
    expect(mockAttachItemToStack).not.toHaveBeenCalled();
    expect(body.lists).toEqual([]);
  });

  it("still files a duplicate item into the chosen list", async () => {
    // The creator returns the pre-existing item (created: false) and leaves its
    // note untouched, so re-sharing to file it into a list is safe.
    mockCreateMany.mockResolvedValue([
      { item: { id: 9, title: "Cool Album" } as any, created: false },
    ]);
    mockResolveOrCreateStack.mockResolvedValue({ id: 3, name: "Jazz finds" });

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, listName: "Jazz finds" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockAttachItemToStack).toHaveBeenCalledWith(9, 3);
    expect(body.items_skipped).toBe(1);
    expect(body.lists).toEqual([{ id: 3, name: "Jazz finds" }]);
  });

  it("ignores blank list names", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 1, title: "Cool Album", primary_url: url } as any, created: true },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, listName: "   ", listNames: ["", "  "] },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolveOrCreateStack).not.toHaveBeenCalled();
    expect(body.lists).toEqual([]);
  });
});

describe("POST /api/ingest/link with a scheduled date", () => {
  const originalEnv = { ...process.env };
  const url = "https://artist.bandcamp.com/album/cool-album";

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCreateMany.mockReset();
    mockSetItemReminder.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sets the reminder on the created item", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 7, title: "Cool Album", primary_url: url } as any, created: true },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, remindAt: "2026-08-01" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    expect(mockSetItemReminder).toHaveBeenCalledTimes(1);
    const [itemId, date] = mockSetItemReminder.mock.calls[0];
    expect(itemId).toBe(7);
    expect(date).toBeInstanceOf(Date);
    expect((date as Date).toISOString()).toBe(new Date("2026-08-01").toISOString());
  });

  it("also schedules a duplicate item, so re-sharing to set a date works", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 9, title: "Cool Album" } as any, created: false },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, remindAt: "2026-08-01" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    expect(mockSetItemReminder).toHaveBeenCalledWith(9, expect.any(Date));
  });

  it("leaves the item unscheduled when no date is given", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 1, title: "Cool Album", primary_url: url } as any, created: true },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(app, { url }, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    expect(mockSetItemReminder).not.toHaveBeenCalled();
  });

  it("ignores a blank date", async () => {
    mockCreateMany.mockResolvedValue([
      { item: { id: 1, title: "Cool Album", primary_url: url } as any, created: true },
    ]);

    const app = makeApp();
    const res = await makeLinkRequest(app, { url, remindAt: "" }, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    expect(mockSetItemReminder).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid date and creates nothing", async () => {
    const app = makeApp();
    const res = await makeLinkRequest(
      app,
      { url, remindAt: "not-a-date" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("remindAt");
    expect(mockCreateMany).not.toHaveBeenCalled();
    expect(mockSetItemReminder).not.toHaveBeenCalled();
  });
});

describe("GET /api/ingest/stacks", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockListStacks.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function getStacks(app: Hono, opts?: { apiKey?: string }) {
    const headers: Record<string, string> = {};
    if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    return app.request("http://localhost/api/ingest/stacks", { headers });
  }

  it("returns 401 when no Authorization header is provided", async () => {
    const app = makeApp();
    const res = await getStacks(app);
    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong API key is provided", async () => {
    const app = makeApp();
    const res = await getStacks(app, { apiKey: "wrong-key" });
    expect(res.status).toBe(401);
  });

  it("returns the lists for the picker", async () => {
    mockListStacks.mockResolvedValue([
      { id: 1, name: "Jazz finds" },
      { id: 2, name: "To buy" },
    ]);

    const app = makeApp();
    const res = await getStacks(app, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stacks).toEqual([
      { id: 1, name: "Jazz finds" },
      { id: 2, name: "To buy" },
    ]);
  });
});

describe("GET /api/ingest/stats", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCountToListen.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function getStats(app: Hono, opts?: { apiKey?: string }) {
    const headers: Record<string, string> = {};
    if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    return app.request("http://localhost/api/ingest/stats", { headers });
  }

  it("returns 503 when INGEST_API_KEY is not set", async () => {
    delete process.env.INGEST_API_KEY;
    const app = makeApp();
    const res = await getStats(app, { apiKey: "anything" });
    expect(res.status).toBe(503);
  });

  it("returns 503 when INGEST_ENABLED is false", async () => {
    process.env.INGEST_ENABLED = "false";
    const app = makeApp();
    const res = await getStats(app, { apiKey: "test-secret" });
    expect(res.status).toBe(503);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const app = makeApp();
    const res = await getStats(app);
    expect(res.status).toBe(401);
    expect(mockCountToListen).not.toHaveBeenCalled();
  });

  it("returns 401 when wrong API key is provided", async () => {
    const app = makeApp();
    const res = await getStats(app, { apiKey: "wrong-key" });
    expect(res.status).toBe(401);
    expect(mockCountToListen).not.toHaveBeenCalled();
  });

  it("returns the to-listen count", async () => {
    mockCountToListen.mockResolvedValue(42);

    const app = makeApp();
    const res = await getStats(app, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ to_listen: 42 });
  });
});

describe("POST /api/ingest/email", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCreateMany.mockReset();
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
    mockCreateMany.mockResolvedValue([
      {
        item: {
          id: 1,
          title: "Cool Release",
          primary_url: "https://artist.bandcamp.com/album/cool-album",
        } as any,
        created: true,
      },
    ]);

    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.items_created).toBe(1);
    expect(body.items_skipped).toBe(0);
    expect(body.items[0].title).toBe("Cool Release");
    expect(mockCreateMany).toHaveBeenCalledWith("https://artist.bandcamp.com/album/cool-album", {
      notes: "Via email from noreply@bandcamp.com",
    });
  });

  it("reports duplicates when URL already exists", async () => {
    mockCreateMany.mockResolvedValue([
      {
        item: { id: 1, title: "Existing" } as any,
        created: false,
      },
    ]);

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
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it("works with sendgrid provider adapter", async () => {
    mockCreateMany.mockResolvedValue([
      {
        item: {
          id: 2,
          title: "SG Release",
          primary_url: "https://artist.bandcamp.com/album/sg-test",
        } as any,
        created: true,
      },
    ]);

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
    mockCreateMany.mockRejectedValue(new Error("DB error"));

    const app = makeApp();
    const res = await makeRequest(app, sampleEnvelope, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(0);
    expect(body.items_skipped).toBe(1);
    expect(body.skipped[0].reason).toBe("creation_failed");
  });

  it("creates multiple items when one unsupported link resolves to several releases", async () => {
    mockCreateMany.mockResolvedValue([
      {
        item: {
          id: 10,
          title: "First Release",
          primary_url: "https://obscuremusic.example/releases",
        } as any,
        created: true,
      },
      {
        item: {
          id: 11,
          title: "Second Release",
          primary_url: "https://obscuremusic.example/releases",
        } as any,
        created: true,
      },
    ]);

    const app = makeApp();
    const res = await makeRequest(
      app,
      {
        from: "noreply@example.com",
        to: "music@example.com",
        subject: "Roundup",
        html: '<a href="https://obscuremusic.example/releases">Read more</a>',
      },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(2);
    expect(body.items).toHaveLength(2);
  });
});

function makePhotoRequest(
  app: Hono,
  body: Record<string, unknown>,
  opts?: { apiKey?: string; raw?: string },
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  return app.request("http://localhost/api/ingest/photo", {
    method: "POST",
    headers,
    body: opts?.raw ?? JSON.stringify(body),
  });
}

describe("POST /api/ingest/photo", () => {
  const originalEnv = { ...process.env };
  const validBase64 = "YWJjZA==";

  beforeEach(() => {
    process.env.INGEST_API_KEY = "test-secret";
    delete process.env.INGEST_ENABLED;
    mockCreateDirect.mockReset();
    mockSaveImage.mockReset();
    mockSaveImage.mockResolvedValue("/uploads/abc.jpg");
    mockScan.mockReset();
    mockScan.mockResolvedValue(null);
    mockResolveOrCreateStack.mockReset();
    mockAttachItemToStack.mockReset();
    mockSetItemReminder.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 503 when INGEST_API_KEY is not set", async () => {
    delete process.env.INGEST_API_KEY;
    const app = makeApp();
    const res = await makePhotoRequest(app, { imageBase64: validBase64 }, { apiKey: "anything" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Ingest not configured");
  });

  it("returns 503 when INGEST_ENABLED is false", async () => {
    process.env.INGEST_ENABLED = "false";
    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64 },
      { apiKey: "test-secret" },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("Ingest disabled");
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const app = makeApp();
    const res = await makePhotoRequest(app, { imageBase64: validBase64 });
    expect(res.status).toBe(401);
  });

  it("returns 401 when wrong API key is provided", async () => {
    const app = makeApp();
    const res = await makePhotoRequest(app, { imageBase64: validBase64 }, { apiKey: "wrong-key" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when imageBase64 is missing", async () => {
    const app = makeApp();
    const res = await makePhotoRequest(app, {}, { apiKey: "test-secret" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("imageBase64");
    expect(mockSaveImage).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid base64", async () => {
    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: "not!!base64" },
      { apiKey: "test-secret" },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("base64");
    expect(mockSaveImage).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON body", async () => {
    const app = makeApp();
    const res = await makePhotoRequest(app, {}, { apiKey: "test-secret", raw: "{not-json" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON payload");
  });

  it("creates an item using scanned metadata when scan succeeds", async () => {
    mockScan.mockResolvedValue({
      artist: "Boards of Canada",
      title: "Geogaddi",
      artistConfidence: 0.95,
      titleConfidence: 0.92,
      year: 2002,
      label: "Warp",
      country: "GB",
      catalogueNumber: "WARP101",
    });
    mockCreateDirect.mockResolvedValue({
      item: { id: 42, title: "Geogaddi" },
      created: true,
    });

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64 },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(body.items_created).toBe(1);
    expect(body.items[0]).toEqual({
      id: 42,
      title: "Geogaddi",
      artworkUrl: "/uploads/abc.jpg",
    });
    expect(body.scan).toEqual({
      artist: "Boards of Canada",
      title: "Geogaddi",
      artistConfidence: 0.95,
      titleConfidence: 0.92,
    });

    expect(mockSaveImage).toHaveBeenCalledWith(validBase64);
    expect(mockScan).toHaveBeenCalledWith(validBase64);
    expect(mockCreateDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Geogaddi",
        artistName: "Boards of Canada",
        artworkUrl: "/uploads/abc.jpg",
        year: 2002,
        label: "Warp",
        country: "GB",
        catalogueNumber: "WARP101",
      }),
    );
  });

  it("creates an item even when scan returns null", async () => {
    mockScan.mockResolvedValue(null);
    mockCreateDirect.mockResolvedValue({
      item: { id: 7, title: "Untitled" },
      created: true,
    });

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64 },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(1);
    expect(body.items[0].id).toBe(7);
    expect(body.scan).toBeNull();
    expect(mockCreateDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        artworkUrl: "/uploads/abc.jpg",
      }),
    );
  });

  it("still creates an item when scan throws", async () => {
    mockScan.mockRejectedValue(new Error("vision API down"));
    mockCreateDirect.mockResolvedValue({
      item: { id: 9, title: "Untitled" },
      created: true,
    });

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64 },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(1);
    expect(body.scan).toBeNull();
  });

  it("includes notes and from in the created item's notes", async () => {
    mockScan.mockResolvedValue(null);
    mockCreateDirect.mockResolvedValue({
      item: { id: 1, title: "Untitled" },
      created: true,
    });

    const app = makeApp();
    await makePhotoRequest(
      app,
      { imageBase64: validBase64, notes: "Record shop find", from: "phone" },
      { apiKey: "test-secret" },
    );

    expect(mockCreateDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: "Record shop find — Via photo from phone",
      }),
    );
  });

  it("returns 500 when image save fails", async () => {
    mockSaveImage.mockRejectedValue(new Error("disk full"));

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64 },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to save image");
    expect(mockCreateDirect).not.toHaveBeenCalled();
  });

  it("returns 422 when item creation fails", async () => {
    mockScan.mockResolvedValue(null);
    mockCreateDirect.mockRejectedValue(new Error("DB error"));

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64 },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Failed to create item");
    expect(body.artworkUrl).toBe("/uploads/abc.jpg");
  });

  it("accepts multipart/form-data with a photo file", async () => {
    mockScan.mockResolvedValue({
      artist: "Aphex Twin",
      title: "Selected Ambient Works 85-92",
      artistConfidence: 0.99,
      titleConfidence: 0.97,
    });
    mockCreateDirect.mockResolvedValue({
      item: { id: 5, title: "Selected Ambient Works 85-92" },
      created: true,
    });

    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const expectedBase64 = Buffer.from(imageBytes).toString("base64");

    const form = new FormData();
    form.append("photo", new File([imageBytes], "cover.jpg", { type: "image/jpeg" }));
    form.append("notes", "Record shop find");
    form.append("from", "iphone");

    const app = makeApp();
    const res = await app.request("http://localhost/api/ingest/photo", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items_created).toBe(1);
    expect(body.items[0].id).toBe(5);
    expect(mockSaveImage).toHaveBeenCalledWith(expectedBase64);
    expect(mockScan).toHaveBeenCalledWith(expectedBase64);
    expect(mockCreateDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Selected Ambient Works 85-92",
        artistName: "Aphex Twin",
        notes: "Record shop find — Via photo from iphone",
      }),
    );
  });

  it("returns 400 when multipart upload has no photo file", async () => {
    const form = new FormData();
    form.append("notes", "missing the file");

    const app = makeApp();
    const res = await app.request("http://localhost/api/ingest/photo", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: form,
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("photo");
    expect(mockSaveImage).not.toHaveBeenCalled();
  });

  it("files the created item into the chosen lists", async () => {
    mockCreateDirect.mockResolvedValue({ item: { id: 42, title: "Untitled" }, created: true });
    mockResolveOrCreateStack.mockImplementation(
      async (name: string) => ({ "Jazz finds": { id: 3, name }, Wishlist: { id: 5, name } })[name],
    );

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64, listNames: ["Jazz finds", "Wishlist"] },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolveOrCreateStack).toHaveBeenCalledWith("Jazz finds");
    expect(mockResolveOrCreateStack).toHaveBeenCalledWith("Wishlist");
    expect(mockAttachItemToStack).toHaveBeenCalledWith(42, 3);
    expect(mockAttachItemToStack).toHaveBeenCalledWith(42, 5);
    expect(body.lists).toEqual([
      { id: 3, name: "Jazz finds" },
      { id: 5, name: "Wishlist" },
    ]);
  });

  it("accepts the legacy single listName", async () => {
    mockCreateDirect.mockResolvedValue({ item: { id: 7, title: "Untitled" }, created: true });
    mockResolveOrCreateStack.mockResolvedValue({ id: 3, name: "Jazz finds" });

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64, listName: "Jazz finds" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockAttachItemToStack).toHaveBeenCalledWith(7, 3);
    expect(body.lists).toEqual([{ id: 3, name: "Jazz finds" }]);
  });

  it("does not touch lists when none are given", async () => {
    mockCreateDirect.mockResolvedValue({ item: { id: 1, title: "Untitled" }, created: true });

    const app = makeApp();
    const res = await makePhotoRequest(app, { imageBase64: validBase64 }, { apiKey: "test-secret" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockResolveOrCreateStack).not.toHaveBeenCalled();
    expect(mockAttachItemToStack).not.toHaveBeenCalled();
    expect(body.lists).toEqual([]);
  });

  it("sets a reminder on the created item", async () => {
    mockCreateDirect.mockResolvedValue({ item: { id: 8, title: "Untitled" }, created: true });

    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64, remindAt: "2026-08-01" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(200);
    expect(mockSetItemReminder).toHaveBeenCalledTimes(1);
    const [itemId, date] = mockSetItemReminder.mock.calls[0];
    expect(itemId).toBe(8);
    expect((date as Date).toISOString()).toBe(new Date("2026-08-01").toISOString());
  });

  it("returns 400 for an invalid reminder date and saves nothing", async () => {
    const app = makeApp();
    const res = await makePhotoRequest(
      app,
      { imageBase64: validBase64, remindAt: "not-a-date" },
      { apiKey: "test-secret" },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("remindAt");
    expect(mockSaveImage).not.toHaveBeenCalled();
    expect(mockCreateDirect).not.toHaveBeenCalled();
  });

  it("files a multipart upload into lists and sets a reminder", async () => {
    mockCreateDirect.mockResolvedValue({ item: { id: 5, title: "Untitled" }, created: true });
    mockResolveOrCreateStack.mockImplementation(
      async (name: string) => ({ "Jazz finds": { id: 3, name }, Wishlist: { id: 5, name } })[name],
    );

    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const form = new FormData();
    form.append("photo", new File([imageBytes], "cover.jpg", { type: "image/jpeg" }));
    form.append("listNames", "Jazz finds");
    form.append("listNames", "Wishlist");
    form.append("remindAt", "2026-08-01");

    const app = makeApp();
    const res = await app.request("http://localhost/api/ingest/photo", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret" },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockAttachItemToStack).toHaveBeenCalledWith(5, 3);
    expect(mockAttachItemToStack).toHaveBeenCalledWith(5, 5);
    expect(mockSetItemReminder).toHaveBeenCalledWith(5, expect.any(Date));
    expect(body.lists).toEqual([
      { id: 3, name: "Jazz finds" },
      { id: 5, name: "Wishlist" },
    ]);
  });
});
