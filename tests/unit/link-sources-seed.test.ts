import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../adapters/db/index";
import { externalLinkSources } from "../../adapters/db/schema";
import { testRoutes } from "../../server/routes/test";

// The admin-rankings e2e spec seeds encountered hosts through this route;
// it must be as honest about its payload as the production PUT it stands in
// for, and first sight must win exactly as recordLinkSource promises.

afterEach(async () => {
  await db.delete(externalLinkSources);
});

function post(body: string): Promise<Response> {
  return testRoutes.request("http://localhost/link-sources", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("the link-sources test seed", () => {
  test("seeds a host with its rank", async () => {
    const res = await post(JSON.stringify({ host: "theguardian.com", rank: 5 }));
    expect(res.status).toBe(201);
    const row = (await res.json()) as { host: string; rank: number };
    expect(row.host).toBe("theguardian.com");
    expect(row.rank).toBe(5);
  });

  test("first sight wins: a re-seed keeps the rank the user gave", async () => {
    await post(JSON.stringify({ host: "nme.com", rank: 7 }));
    const res = await post(JSON.stringify({ host: "nme.com" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { rank: number }).rank).toBe(7);
  });

  test("a malformed or hostless body is a 400, not a 500", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({}))).status).toBe(400);
    expect((await post(JSON.stringify({ host: "   " }))).status).toBe(400);
  });

  test("a non-integer rank is refused and nothing is written", async () => {
    expect((await post(JSON.stringify({ host: "nme.com", rank: 2.5 }))).status).toBe(400);
    expect((await post(JSON.stringify({ host: "nme.com", rank: "5" }))).status).toBe(400);
    const rows = await db
      .select()
      .from(externalLinkSources)
      .where(eq(externalLinkSources.host, "nme.com"));
    expect(rows.length).toBe(0);
  });
});
