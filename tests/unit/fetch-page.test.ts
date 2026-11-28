import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// The fetch-time half of the SSRF gate, exercised with a fake resolver and a
// fake transport: a public-looking name that answers with a private address
// must never be connected to, the connection must use exactly the vetted
// addresses (no re-resolution), every redirect hop is checked the same way,
// and a resolver that never answers is bounded by the timeout.

// Held before mock.module so the real modules can be handed back when this
// file is done — bun's mock.module() persists process-wide (see
// resolution-backfill.test.ts), and other files must not inherit the fakes.
import * as realDns from "node:dns/promises";
import * as realHttp from "node:http";
import * as realHttps from "node:https";

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

// The guarded path connects through node:http(s) with a custom lookup that
// pins the vetted addresses. The fake transport records each request (so the
// pinning can be inspected) and answers from a queue of canned responses.
interface CannedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
const transportCalls: { protocol: string; options: any }[] = [];
let responseQueue: CannedResponse[] = [];
let fallbackResponse: CannedResponse | null = null;

function fakeRequest(protocol: "http" | "https") {
  return (options: any, cb: (res: any) => void) => {
    transportCalls.push({ protocol, options });
    const req = new EventEmitter() as any;
    req.end = () => {
      const spec = responseQueue.shift() ??
        fallbackResponse ?? { status: 200, headers: { "content-type": "text/html" }, body: "" };
      const res = Readable.from([Buffer.from(spec.body)]) as any;
      res.statusCode = spec.status;
      res.headers = spec.headers;
      queueMicrotask(() => cb(res));
    };
    req.destroy = (err?: Error) =>
      queueMicrotask(() => req.emit("error", err ?? new Error("destroyed")));
    return req;
  };
}

mock.module("node:http", () => ({ ...realHttp, request: fakeRequest("http") }));
mock.module("node:https", () => ({ ...realHttps, request: fakeRequest("https") }));

const { fetchPageHtml } = await import("../../adapters/web/fetch-page");

afterAll(() => {
  mock.module("node:dns/promises", () => ({ ...realDns, lookup: realLookup }));
  mock.module("node:http", () => ({ ...realHttp, request: realHttp.request }));
  mock.module("node:https", () => ({ ...realHttps, request: realHttps.request }));
});

afterEach(() => {
  answers.clear();
  lookupMock.mockClear();
  transportCalls.length = 0;
  responseQueue = [];
  fallbackResponse = null;
  mock.restore();
});

function html(body: string): CannedResponse {
  return { status: 200, headers: { "content-type": "text/html" }, body };
}
function redirect(location: string): CannedResponse {
  return { status: 302, headers: { location }, body: "" };
}
function guarded(url: string, timeoutMs = 1_000): Promise<string | null> {
  return fetchPageHtml(url, timeoutMs, {
    maxBytes: 10_000,
    stopAt: "</body>",
    publicHostsOnly: true,
  });
}

describe("fetchPageHtml — publicHostsOnly", () => {
  test("a name that resolves public is fetched and read", async () => {
    responseQueue = [html("<p>prose</p>")];
    expect(await guarded("https://review.example/album")).toBe("<p>prose</p>");
    expect(transportCalls.length).toBe(1);
    expect(transportCalls[0]?.protocol).toBe("https");
    expect(transportCalls[0]?.options.hostname).toBe("review.example");
    expect(transportCalls[0]?.options.headers["Accept-Encoding"]).toBe("identity");
  });

  test("the connection is pinned to the vetted addresses, never re-resolved", async () => {
    answers.set("pinned.example", ["93.184.216.34", "2606:2800::1"]);
    responseQueue = [html("<p>prose</p>")];
    expect(await guarded("https://pinned.example/")).toBe("<p>prose</p>");
    // The resolver ran once, for the check…
    expect(lookupMock).toHaveBeenCalledTimes(1);
    // …and the socket's lookup hands back exactly those addresses, whatever
    // name it is asked for — a rebinding answer cannot swap the target.
    const pinned = await new Promise<any>((resolve) =>
      transportCalls[0]?.options.lookup("anything.else", {}, (_err: unknown, addrs: any) =>
        resolve(addrs),
      ),
    );
    expect(pinned).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]);
  });

  test("a public-looking name that resolves to loopback is never connected to", async () => {
    // 127.0.0.1.nip.io and localtest.me are the everyday form of this.
    answers.set("loopback.example", ["127.0.0.1"]);
    expect(await guarded("http://loopback.example:3000/api/music-items")).toBeNull();
    expect(transportCalls.length).toBe(0);
  });

  test("one private answer among several is enough to refuse", async () => {
    answers.set("mixed.example", ["93.184.216.34", "10.0.0.5"]);
    expect(await guarded("https://mixed.example/")).toBeNull();
    expect(transportCalls.length).toBe(0);
  });

  test("link-local IPv6 answers and metadata addresses are refused", async () => {
    answers.set("v6.example", ["fe80::1"]);
    answers.set("metadata.example", ["169.254.169.254"]);
    expect(await guarded("https://v6.example/")).toBeNull();
    expect(await guarded("https://metadata.example/latest/meta-data/")).toBeNull();
    expect(transportCalls.length).toBe(0);
  });

  test("an IP literal is classified and refused", async () => {
    expect(await guarded("http://127.0.0.1:3000/")).toBeNull();
    expect(transportCalls.length).toBe(0);
  });

  test("a resolution failure settles as a miss", async () => {
    lookupMock.mockImplementationOnce(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await guarded("https://gone.example/")).toBeNull();
    expect(transportCalls.length).toBe(0);
  });

  test("a resolver that never answers is bounded by the timeout", async () => {
    // getaddrinfo can hang for tens of seconds on a dropped query; the
    // request must not wait past its budget.
    lookupMock.mockImplementationOnce(() => new Promise(() => {}));
    const started = performance.now();
    expect(await guarded("https://slow.example/", 50)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(transportCalls.length).toBe(0);
  });

  test("a redirect into a private-resolving name is not followed", async () => {
    answers.set("internal.example", ["192.168.1.1"]);
    responseQueue = [redirect("https://internal.example/")];
    expect(await guarded("https://public.example/")).toBeNull();
    expect(transportCalls.length).toBe(1);
  });

  test("a redirect to a public name is followed after its own check", async () => {
    responseQueue = [redirect("/moved"), html("<p>moved prose</p>")];
    expect(await guarded("https://public.example/here")).toBe("<p>moved prose</p>");
    expect(transportCalls.length).toBe(2);
    expect(transportCalls[1]?.options.path).toBe("/moved");
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  test("a redirect to a non-http(s) scheme is refused", async () => {
    responseQueue = [redirect("ftp://public.example/file")];
    expect(await guarded("https://public.example/")).toBeNull();
    expect(transportCalls.length).toBe(1);
  });

  test("an endless redirect chain gives up", async () => {
    fallbackResponse = redirect("https://public.example/next");
    expect(await guarded("https://public.example/")).toBeNull();
    expect(transportCalls.length).toBe(6);
  });

  test("a blocked page's non-2xx answer reads as null, not as its error body", async () => {
    // A marketplace's 403 "Error Page" is not the listing — reading it as
    // HTML is how a blocked page came to be judged "not music-related".
    responseQueue = [
      {
        status: 403,
        headers: { "content-type": "text/html" },
        body: "<html><head><title>Error Page</title></head></html>",
      },
    ];
    expect(await guarded("https://marketplace.example/item/1")).toBeNull();
    expect(transportCalls.length).toBe(1);
  });

  test("a 500 answer reads as null too", async () => {
    responseQueue = [
      { status: 500, headers: { "content-type": "text/html" }, body: "<p>boom</p>" },
    ];
    expect(await guarded("https://public.example/")).toBeNull();
  });
});

describe("fetchPageHtml — without the guard", () => {
  test("fetch keeps its default redirect behaviour and no resolver is asked", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const html = await fetchPageHtml("https://example.com/", 1_000, {
      maxBytes: 10_000,
      stopAt: "</body>",
    });
    expect(html).toBe("<p>ok</p>");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(transportCalls.length).toBe(0);
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBeUndefined();
  });

  test("a non-2xx answer reads as null even when it carries HTML", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html><head><title>Error Page</title></head></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    );
    const html = await fetchPageHtml("https://www.ebay.es/itm/800867457219", 1_000, {
      maxBytes: 10_000,
      stopAt: "</head>",
    });
    expect(html).toBeNull();
  });
});
