import { lte, eq, and } from "drizzle-orm";
import { db } from "./db/index";
import { musicItems } from "./db/schema";

export async function processReminders(): Promise<void> {
  const now = new Date();

  const updated = await db
    .update(musicItems)
    .set({
      listenStatus: "to-listen",
      reminderPending: true,
      updatedAt: now,
      addedToListenAt: now,
    })
    .where(and(lte(musicItems.remindAt, now), eq(musicItems.reminderPending, false)))
    .returning({ id: musicItems.id });

  if (updated.length === 0) return;

  const ids = updated.map((r) => r.id);
  console.log(`[reminders] processed ${ids.length} overdue reminder(s): [${ids.join(", ")}]`);
}
