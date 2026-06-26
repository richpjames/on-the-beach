import { Hono } from "hono";
import { getLookupService, setLookupService, isLookupService, LOOKUP_SERVICES } from "../settings";

export function createSettingsRoutes(): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const lookupService = await getLookupService();
    return c.json({ lookupService, lookupServices: LOOKUP_SERVICES });
  });

  routes.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid JSON payload" }, 400);
    }

    const { lookupService } = body as Record<string, unknown>;
    if (!isLookupService(lookupService)) {
      return c.json({ error: "lookupService must be one of: " + LOOKUP_SERVICES.join(", ") }, 400);
    }

    const { changed } = await setLookupService(lookupService);
    return c.json({ lookupService, changed }, 200);
  });

  return routes;
}

export const settingsRoutes = createSettingsRoutes();
