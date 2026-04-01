import { describe, expect, mock, test } from "bun:test";
import { processReminders } from "../../server/reminders";

const mockDb = {
  select: mock(),
  update: mock(),
};

describe("processReminders", () => {
  test("is a function that accepts a db argument", () => {
    expect(typeof processReminders).toBe("function");
  });
});
