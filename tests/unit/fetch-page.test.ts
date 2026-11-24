import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

// The fetch-time half of the SSRF gate, exercised with a fake resolver and
// a stubbed fetch: a public-looking name that answers with a private address
// must never be connected to, and every redirect hop is checked the same way.

// Held before mock.module so the real resolver can be handed back when this
// file is done — bun's mock.module() persists process-wide (see
// resolution-backfill.test.ts), and other files must not inherit the fake.
import * as realDns from "node:dns/promises";

const realLookup = realDns.lookup;

// Names answer from this map; anything unlisted resolves to a public address
// (or to itself when it is an IP literal, as the real resolver does).
const answers = new Map<string, string[]>();
const lookupMock = mock(async (hostname: string) => {
  const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  const list = answers.get(hostname) ?? (isLiteral ? [hostname] : ["93.184.216.34"]);
  return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
});

mock.module("node:dns/promises", () => ({
  ...realDns,
  lookup: (hostname: string, options: unknown) => lookupMock(hostname, options),
}));

const { fetchPageHtml } = await import("../../adapters/web/fetch-page");

afterAll(() => {
  mock.module("node:dns/promises", () => ({ ...realDns, lookup: realLookup }));
});

afterEach(() => {
  answers.clear();
  lookupMock.mockClear();
  mock.restore();
});

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function guarded(url: string): Promise<string | null> {
  return fetchPageHtml(url, 1_000, { maxBytes: 10_000, stopAt: "</body>", publicHostsOnly: true });
}

describe("fetchPageHtml — publicHostsOnly", () => {
  test("a name that resolves public is fetched and read", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse("<p>prose</p>"));
    expect(await guarded("https://review.example/album")).toBe("<p>prose</p>");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  test("a public-looking name that resolves to loopback is never connected to", async () => {
    // 127.0.0.1.nip.io and localtest.me are the everyday form of this.
    answers.set("loopback.example", ["127.0.0.1"]);
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await guarded("http://loopback.example:3000/api/music-items")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("one private answer among several is enough to refuse", async () => {
    answers.set("mixed.example", ["93.184.216.34", "10.0.0.5"]);
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await guarded("https://mixed.example/")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("link-local IPv6 answers and metadata addresses are refused", async () => {
    answers.set("v6.example", ["fe80::1"]);
    answers.set("metadata.example", ["169.254.169.254"]);
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await guarded("https://v6.example/")).toBeNull();
    expect(await guarded("https://metadata.example/latest/meta-data/")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an IP literal is classified without a DNS query", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await guarded("http://127.0.0.1:3000/")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a resolution failure settles as a miss", async () => {
    lookupMock.mockImplementationOnce(async () => {
      throw new Error("ENOTFOUND");
    });
    const fetchSpy = spyOn(globalThis, "fetch");
    expect(await guarded("https://gone.example/")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a redirect into a private-resolving name is not followed", async () => {
    answers.set("internal.example", ["192.168.1.1"]);
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      redirect("https://internal.example/"),
    );
    expect(await guarded("https://public.example/")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("a redirect to a public name is followed after its own check", async () => {
    const fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(redirect("/moved"))
      .mockResolvedValueOnce(htmlResponse("<p>moved prose</p>"));
    expect(await guarded("https://public.example/here")).toBe("<p>moved prose</p>");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://public.example/moved");
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  test("a redirect to a non-http(s) scheme is refused", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      redirect("ftp://public.example/file"),
    );
    expect(await guarded("https://public.example/")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("an endless redirect chain gives up", async () => {
    let n = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async () =>
      redirect(`https://public.example/${++n}`),
    );
    expect(await guarded("https://public.example/")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(6);
  });
});

describe("fetchPageHtml — without the guard", () => {
  test("fetch keeps its default redirect behaviour and no resolver is asked", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(htmlResponse("<p>ok</p>"));
    const html = await fetchPageHtml("https://example.com/", 1_000, {
      maxBytes: 10_000,
      stopAt: "</body>",
    });
    expect(html).toBe("<p>ok</p>");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBeUndefined();
  });
});
