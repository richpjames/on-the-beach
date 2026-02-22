import { describe, expect, it } from "bun:test";
import { hydrateItemStacks } from "../../server/hydrate-item-stacks";

const item = (id: number) => ({ id, title: `Item ${id}` });

describe("hydrateItemStacks", () => {
  it("attaches stacks to matching items", () => {
    const items = [item(1), item(2)];
    const stackRows = [
      { musicItemId: 1, id: 10, name: "Chill" },
      { musicItemId: 2, id: 20, name: "Hype" },
    ];
    const result = hydrateItemStacks(items, stackRows);
    expect(result[0].stacks).toEqual([{ id: 10, name: "Chill" }]);
    expect(result[1].stacks).toEqual([{ id: 20, name: "Hype" }]);
  });

  it("gives items with no memberships an empty stacks array", () => {
    const items = [item(1), item(2)];
    const result = hydrateItemStacks(items, [{ musicItemId: 1, id: 10, name: "Chill" }]);
    expect(result[1].stacks).toEqual([]);
  });

  it("collects multiple stacks onto the same item", () => {
    const items = [item(1)];
    const stackRows = [
      { musicItemId: 1, id: 10, name: "A" },
      { musicItemId: 1, id: 11, name: "B" },
      { musicItemId: 1, id: 12, name: "C" },
    ];
    const result = hydrateItemStacks(items, stackRows);
    expect(result[0].stacks).toEqual([
      { id: 10, name: "A" },
      { id: 11, name: "B" },
      { id: 12, name: "C" },
    ]);
  });

  it("returns an empty array when there are no items", () => {
    expect(hydrateItemStacks([], [])).toEqual([]);
  });

  it("handles stack rows for item ids not present in the items list", () => {
    const items = [item(1)];
    const stackRows = [{ musicItemId: 99, id: 10, name: "Ghost" }];
    const result = hydrateItemStacks(items, stackRows);
    expect(result[0].stacks).toEqual([]);
  });

  it("preserves all other item fields unchanged", () => {
    const items = [{ id: 1, title: "Untitled", artist_name: "Someone" }];
    const result = hydrateItemStacks(items, []);
    expect(result[0].title).toBe("Untitled");
    expect(result[0].artist_name).toBe("Someone");
  });
});
