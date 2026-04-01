import { lte, eq, and, inArray } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems } from "./db/schema";

export async function processReminders(): Promise<void> {
  const now = new Date();

  const overdue = await db
    .select({ id: musicItems.id })
    .from(musicItems)
    .where(and(lte(musicItems.remindAt, now), eq(musicItems.reminderPending, false)));

  if (overdue.length === 0) return;

  const ids = overdue.map((r) => r.id);
  await db
    .update(musicItems)
    .set({ listenStatus: "to-listen", reminderPending: true, updatedAt: new Date() })
    .where(and(lte(musicItems.remindAt, now), eq(musicItems.reminderPending, false)));

  console.log(`[reminders] processed ${ids.length} overdue reminder(s): [${ids.join(", ")}]`);
}
