import { describe, test, expect } from "bun:test";
import { isQueryAllowed } from "../../scripts/db-prod";

// Policy: the wrapper only forwards SELECT-shape statements to prod.
// `-readonly` already prevents writes at the engine level; this is
// defense-in-depth so we fail fast with a clear message and avoid
// burning an SSH round-trip on obviously-bad queries.

describe("isQueryAllowed - permitted shapes", () => {
  test("allows a basic SELECT", () => {
    expect(isQueryAllowed("SELECT * FROM items LIMIT 5")).toEqual({ ok: true });
  });

  test("allows lowercase select", () => {
    expect(isQueryAllowed("select 1")).toEqual({ ok: true });
  });

  test("allows leading whitespace and newlines", () => {
    expect(isQueryAllowed("\n  \tSELECT 1")).toEqual({ ok: true });
  });

  test("allows trailing semicolon", () => {
    expect(isQueryAllowed("SELECT 1;")).toEqual({ ok: true });
  });

  test("allows WITH (CTE) queries", () => {
    expect(isQueryAllowed("WITH x AS (SELECT 1 AS n) SELECT * FROM x")).toEqual({ ok: true });
  });

  test("allows EXPLAIN", () => {
    expect(isQueryAllowed("EXPLAIN QUERY PLAN SELECT 1")).toEqual({ ok: true });
  });

  test("allows PRAGMA introspection", () => {
    expect(isQueryAllowed("PRAGMA table_info('items')")).toEqual({ ok: true });
  });
});

describe("isQueryAllowed - rejected shapes", () => {
  test("rejects INSERT", () => {
    const r = isQueryAllowed("INSERT INTO items (id) VALUES (1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/insert/i);
  });

  test("rejects UPDATE", () => {
    const r = isQueryAllowed("UPDATE items SET title = 'x'");
    expect(r.ok).toBe(false);
  });

  test("rejects DELETE", () => {
    const r = isQueryAllowed("DELETE FROM items");
    expect(r.ok).toBe(false);
  });

  test("rejects DROP", () => {
    const r = isQueryAllowed("DROP TABLE items");
    expect(r.ok).toBe(false);
  });

  test("rejects ATTACH (could read arbitrary files)", () => {
    const r = isQueryAllowed("ATTACH DATABASE '/etc/passwd' AS evil");
    expect(r.ok).toBe(false);
  });

  test("rejects multi-statement injection", () => {
    const r = isQueryAllowed("SELECT 1; DROP TABLE items");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/multi|;|statement/i);
  });

  test("rejects empty input", () => {
    const r = isQueryAllowed("");
    expect(r.ok).toBe(false);
  });

  test("rejects whitespace-only input", () => {
    const r = isQueryAllowed("   \n\t  ");
    expect(r.ok).toBe(false);
  });
});
