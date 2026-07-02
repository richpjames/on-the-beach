import { eq, inArray, count, asc, desc, and, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { musicItems, musicItemStacks, stacks, musicItemOrder, stackParents } from "../db/schema";
import { fullItemSelect } from "./full-item-select";
import { hydrateItemStacks } from "../hydrate-item-stacks";
import { collectDescendantStackIds } from "../routes/music-items";
import { applyOrder, buildContextKey } from "../../shared/music-list-context";
import type { FilterSelection } from "../../src/ui/domain/music-list";
import type { MusicItemFull, StackWithCount } from "../../src/types";

export const DEFAULT_FILTER = "to-listen" as const;
export const STACK_DEFAULT_FILTER: FilterSelection = "all";

export async function fetchInitialStacks(): Promise<StackWithCount[]> {
  const rows = await db
    .select({
      id: stacks.id,
      name: stacks.name,
      created_at: stacks.createdAt,
      item_count: count(musicItemStacks.musicItemId),
    })
    .from(stacks)
    .leftJoin(musicItemStacks, eq(stacks.id, musicItemStacks.stackId))
    .groupBy(stacks.id)
    .orderBy(asc(stacks.name));

  const parentRows = await db
    .select({
      parent_stack_id: stackParents.parentStackId,
      child_stack_id: stackParents.childStackId,
    })
    .from(stackParents);

  const parentsByChild = new Map<number, number[]>();
  for (const r of parentRows) {
    const existing = parentsByChild.get(r.child_stack_id) ?? [];
    existing.push(r.parent_stack_id);
    parentsByChild.set(r.child_stack_id, existing);
  }

  return rows.map((row) => ({
    ...row,
    // Match the JSON shape of /api/stacks (dates serialise to ISO strings).
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    parent_stack_ids: parentsByChild.get(row.id) ?? [],
  }));
}

/**
 * Fetch the items to render in the SSR'd music list.
 *
 * Mirrors what the client-side music list does after hydration:
 * - On `/`, the default filter is "to-listen" and there is no stack scope, so
 *   we filter strictly by `listen_status = 'to-listen'`. Listed items must
 *   never appear in this view.
 * - On `/s/:id/:name`, the app machine forces `currentFilter` to "all" and
 *   scopes by `stackId`, so the SSR mirrors that: items are restricted to the
 *   stack (and its descendants) regardless of listen status.
 */
export async function fetchInitialItems(stackId: number | null): Promise<MusicItemFull[]> {
  const filter: FilterSelection = stackId === null ? DEFAULT_FILTER : STACK_DEFAULT_FILTER;

  let baseQuery = fullItemSelect().$dynamic();

  // Apply listen-status filter only when we're not scoping by stack. On stack
  // pages the client view shows all statuses, so the SSR must too — otherwise
  // the first paint shows global to-listen items that get replaced with the
  // real (mixed-status) stack contents a moment later.
  //
  // Scheduled items (remind_at IS NOT NULL) are owned by the "Scheduled"
  // filter — exclude them here so they don't double up under "To Listen" with
  // a label the release page then contradicts.
  if (filter !== "all") {
    baseQuery = baseQuery.where(
      and(eq(musicItems.listenStatus, filter), isNull(musicItems.remindAt)),
    );
  }

  if (stackId !== null) {
    const stackIds = await collectDescendantStackIds(stackId);
    const memberships = await db
      .select({ musicItemId: musicItemStacks.musicItemId })
      .from(musicItemStacks)
      .where(inArray(musicItemStacks.stackId, stackIds));
    const itemIds = [...new Set(memberships.map((m) => m.musicItemId))];

    if (itemIds.length === 0) return [];

    baseQuery = baseQuery.where(inArray(musicItems.id, itemIds));
  }

  const items = await baseQuery.orderBy(desc(musicItems.addedToListenAt), desc(musicItems.id));

  if (items.length === 0) return [];

  const stackRows = await db
    .select({
      musicItemId: musicItemStacks.musicItemId,
      id: stacks.id,
      name: stacks.name,
    })
    .from(musicItemStacks)
    .innerJoin(stacks, eq(stacks.id, musicItemStacks.stackId))
    .where(
      inArray(
        musicItemStacks.musicItemId,
        items.map((i) => i.id),
      ),
    );

  const enriched = hydrateItemStacks(items, stackRows);

  const contextKey = buildContextKey(filter, stackId);
  const orderRow = await db
    .select()
    .from(musicItemOrder)
    .where(eq(musicItemOrder.contextKey, contextKey))
    .get();

  if (orderRow) {
    const parsed = JSON.parse(orderRow.itemIds);
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === "number") {
        return applyOrder(enriched, parsed as number[]) as unknown as MusicItemFull[];
      }
      const itemIds = (parsed as string[])
        .filter((e: string) => e.startsWith("i:"))
        .map((e: string) => Number(e.slice(2)));
      return applyOrder(enriched, itemIds) as unknown as MusicItemFull[];
    }
  }

  return enriched as unknown as MusicItemFull[];
}
