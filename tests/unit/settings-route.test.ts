import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createSettingsRoutes } from "../../server/routes/settings";
import { getLookupService, setLookupService } from "../../server/settings";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/settings", createSettingsRoutes());
  return app;
}

describe("settings module", () => {
  beforeEach(async () => {
    await setLookupService("apple_music");
  });

  test("defaults to apple_music and round-trips a change", async () => {
    expect(await getLookupService()).toBe("apple_music");

    const first = await setLookupService("spotify");
    expect(first.changed).toBe(true);
    expect(await getLookupService()).toBe("spotify");

    const again = await setLookupService("spotify");
    expect(again.changed).toBe(false);
  });
});

describe("GET /api/settings", () => {
  beforeEach(async () => {
    await setLookupService("apple_music");
  });

  test("returns the active service and the available services", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lookupService).toBe("apple_music");
    expect(body.lookupServices).toEqual(["apple_music", "spotify"]);
  });
});

describe("PUT /api/settings", () => {
  beforeEach(async () => {
    await setLookupService("apple_music");
  });

  test("sets a valid service and reports the change", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupService: "spotify" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lookupService: "spotify", changed: true });
    expect(await getLookupService()).toBe("spotify");
  });

  test("reports changed=false when set to the current value", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupService: "apple_music" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lookupService: "apple_music", changed: false });
  });

  test("rejects an unknown service", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lookupService: "soundcloud" }),
    });
    expect(res.status).toBe(400);
    expect(await getLookupService()).toBe("apple_music");
  });

  test("rejects invalid JSON", async () => {
    const app = makeApp();
    const res = await app.request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
