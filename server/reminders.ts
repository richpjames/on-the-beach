import { lte, eq, and } from "drizzle-orm";
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
    .set({
      listenStatus: "to-listen",
      // Clear the reminder now that its date has passed: a release whose
      // scheduled date is in the past is no longer "scheduled", so drop it out
      // of the Scheduled filter and let it surface under "To Listen".
      remindAt: null,
      reminderPending: true,
      updatedAt: now,
      addedToListenAt: now,
    })
    .where(and(lte(musicItems.remindAt, now), eq(musicItems.reminderPending, false)));

  console.log(`[reminders] processed ${ids.length} overdue reminder(s): [${ids.join(", ")}]`);
}
