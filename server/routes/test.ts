import { Hono } from "hono";
import { db } from "../db/index";
import {
  musicItemStacks,
  musicLinks,
  musicItems,
  artists,
  stacks,
  stackParents,
} from "../db/schema";

export const testRoutes = new Hono();

testRoutes.post("/reset", async (c) => {
  // Truncate in dependency order (respect foreign keys)
  await db.delete(musicItemStacks);
  await db.delete(stackParents);
  await db.delete(musicLinks);
  await db.delete(musicItems);
  await db.delete(artists);
  await db.delete(stacks);
  // sources are seeded/static — leave them alone
  return c.json({ success: true });
});
