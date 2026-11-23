import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createLinkSourceRoutes } from "../../server/routes/link-sources";

const mockListSources = mock();
const mockSetRank = mock();

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/link-sources", createLinkSourceRoutes(mockListSources, mockSetRank));
  return app;
}

describe("GET /api/link-sources", () => {
  beforeEach(() => {
    mockListSources.mockReset();
    mockSetRank.mockReset();
  });

  test("lists the encountered sources with their rankings", async () => {
    mockListSources.mockResolvedValue([
      {
        host: "wikipedia.org",
        displayName: "Wikipedia",
        rank: 11,
        firstSeenAt: new Date("2026-11-01T00:00:00Z"),
      },
      {
        host: "example.test",
        displayName: "example.test",
        rank: 0,
        firstSeenAt: new Date("2026-11-02T00:00:00Z"),
      },
    ]);
    const app = makeApp();
    const res = await app.request("http://localhost/api/link-sources");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        host: "wikipedia.org",
        displayName: "Wikipedia",
        rank: 11,
        firstSeenAt: "2026-11-01T00:00:00.000Z",
      },
      {
        host: "example.test",
        displayName: "example.test",
        rank: 0,
        firstSeenAt: "2026-11-02T00:00:00.000Z",
      },
    ]);
  });
});

describe("PUT /api/link-sources", () => {
  beforeEach(() => {
    mockListSources.mockReset();
    mockSetRank.mockReset();
  });

  async function put(body: unknown): Promise<Response> {
    const app = makeApp();
    return app.request("http://localhost/api/link-sources", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("re-ranks a known source", async () => {
    mockSetRank.mockResolvedValue(true);
    const res = await put({ host: "pitchfork.com", rank: 20 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ host: "pitchfork.com", rank: 20 });
    expect(mockSetRank).toHaveBeenCalledWith("pitchfork.com", 20);
  });

  test("accepts negative ranks — below the unranked default is a real choice", async () => {
    mockSetRank.mockResolvedValue(true);
    const res = await put({ host: "example.test", rank: -5 });
    expect(res.status).toBe(200);
    expect(mockSetRank).toHaveBeenCalledWith("example.test", -5);
  });

  test("400 for invalid JSON", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/link-sources", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    expect(mockSetRank).not.toHaveBeenCalled();
  });

  test("400 when host is missing", async () => {
    const res = await put({ rank: 5 });
    expect(res.status).toBe(400);
    expect(mockSetRank).not.toHaveBeenCalled();
  });

  test("400 when rank is not an integer", async () => {
    expect((await put({ host: "pitchfork.com", rank: 1.5 })).status).toBe(400);
    expect((await put({ host: "pitchfork.com", rank: "high" })).status).toBe(400);
    expect(mockSetRank).not.toHaveBeenCalled();
  });

  test("404 for a host never encountered", async () => {
    mockSetRank.mockResolvedValue(false);
    const res = await put({ host: "never-met.test", rank: 3 });
    expect(res.status).toBe(404);
  });
});
