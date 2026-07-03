import { describe, expect, test } from "bun:test";
import { createCsrfToken, isCsrfRequestAllowed } from "../../server/csrf";

const SITE = "https://otb.example";

function context(overrides: Partial<Parameters<typeof isCsrfRequestAllowed>[0]> = {}) {
  return {
    method: "POST",
    pathname: "/api/music-items",
    requestOrigin: null,
    siteOrigin: SITE,
    cookieToken: null,
    headerToken: null,
    ...overrides,
  };
}

describe("createCsrfToken", () => {
  test("returns unique, url-safe tokens", () => {
    const a = createCsrfToken();
    const b = createCsrfToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("isCsrfRequestAllowed", () => {
  test("always allows safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCsrfRequestAllowed(context({ method }))).toBe(true);
    }
  });

  test("allows unsafe requests from the same origin", () => {
    expect(isCsrfRequestAllowed(context({ requestOrigin: SITE }))).toBe(true);
  });

  test("rejects cross-origin unsafe requests without a token", () => {
    expect(isCsrfRequestAllowed(context({ requestOrigin: "https://evil.example" }))).toBe(false);
  });

  test("rejects unsafe requests with no origin and no token", () => {
    expect(isCsrfRequestAllowed(context())).toBe(false);
  });

  test("allows unsafe requests when the header token matches the cookie", () => {
    const token = createCsrfToken();
    expect(isCsrfRequestAllowed(context({ cookieToken: token, headerToken: token }))).toBe(true);
  });

  test("rejects unsafe requests when the header token mismatches the cookie", () => {
    expect(
      isCsrfRequestAllowed(
        context({ cookieToken: createCsrfToken(), headerToken: createCsrfToken() }),
      ),
    ).toBe(false);
  });

  test("a matching token beats a mismatched origin", () => {
    const token = createCsrfToken();
    expect(
      isCsrfRequestAllowed(
        context({
          requestOrigin: "https://evil.example",
          cookieToken: token,
          headerToken: token,
        }),
      ),
    ).toBe(true);
  });

  test("exempts the ingest webhook", () => {
    expect(
      isCsrfRequestAllowed(
        context({ pathname: "/api/ingest/email", requestOrigin: "https://webhooks.example" }),
      ),
    ).toBe(true);
    expect(isCsrfRequestAllowed(context({ pathname: "/api/ingest/photo" }))).toBe(true);
  });

  test("does not exempt non-ingest api paths", () => {
    expect(isCsrfRequestAllowed(context({ pathname: "/api/stacks" }))).toBe(false);
  });

  test("PUT, PATCH and DELETE are protected", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(isCsrfRequestAllowed(context({ method }))).toBe(false);
    }
  });
});
