import { Hono } from "hono";
import {
  acceptAlert,
  countPendingAlerts,
  dismissAlert,
  listReleaseAlerts,
  markAlertsSeen,
  type AlertStatus,
} from "../release-alerts";
import { fetchFullItem } from "../music-item-store";

const ALERT_STATUSES: readonly AlertStatus[] = ["pending", "seen", "added", "dismissed"];

function parseStatuses(raw: string | undefined): AlertStatus[] | null {
  if (!raw) return ["pending"];
  const parsed = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (parsed.length === 0) return ["pending"];
  if (
    !parsed.every((value): value is AlertStatus => ALERT_STATUSES.includes(value as AlertStatus))
  ) {
    return null;
  }
  return parsed as AlertStatus[];
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createReleaseAlertRoutes(): Hono {
  const routes = new Hono();

  // GET / — the alert queue, artist and release joined in.
  routes.get("/", async (c) => {
    const statuses = parseStatuses(c.req.query("status"));
    if (!statuses) {
      return c.json({ error: `status must be one of: ${ALERT_STATUSES.join(", ")}` }, 400);
    }

    const alerts = await listReleaseAlerts(statuses);
    return c.json({ alerts, pendingCount: await countPendingAlerts() });
  });

  // POST /mark-seen — bulk pending → seen, clearing the taskbar badge without
  // forcing a decision on each card.
  routes.post("/mark-seen", async (c) => {
    const seen = await markAlertsSeen();
    return c.json({ seen });
  });

  // POST /:id/add — create the item, file it in New Releases, schedule it if
  // the record is still announced-only.
  routes.post("/:id/add", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid ID" }, 400);

    const result = await acceptAlert(id);
    if (!result) return c.json({ error: "Alert not found or already added" }, 404);

    const item = await fetchFullItem(result.itemId);
    return c.json({ item, remindAt: result.remindAt?.toISOString() ?? null }, 201);
  });

  // POST /:id/dismiss — never re-fires (unique index on the release).
  routes.post("/:id/dismiss", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "Invalid ID" }, 400);

    const dismissed = await dismissAlert(id);
    if (!dismissed) return c.json({ error: "Alert not found" }, 404);
    return c.json({ success: true });
  });

  return routes;
}

export const releaseAlertRoutes = createReleaseAlertRoutes();
