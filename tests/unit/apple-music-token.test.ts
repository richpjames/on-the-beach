import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  getDeveloperToken,
  getStorefront,
  isAppleMusicConfigured,
  mintDeveloperToken,
  readAppleMusicCredentials,
  resetDeveloperTokenCache,
  type AppleMusicCredentials,
} from "../../server/apple-music-token";

// A throwaway EC P-256 key pair for signing/verifying test tokens.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

const TEAM_ID = "TEAM123456";
const KEY_ID = "KEY7654321";

const credentials: AppleMusicCredentials = {
  teamId: TEAM_ID,
  keyId: KEY_ID,
  privateKey: privatePem,
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function verify(token: string): boolean {
  const [header, payload, signature] = token.split(".");
  return crypto.verify(
    "SHA256",
    Buffer.from(`${header}.${payload}`),
    { key: publicPem, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

const ENV_KEYS = [
  "APPLE_MUSIC_TEAM_ID",
  "APPLE_MUSIC_KEY_ID",
  "APPLE_MUSIC_PRIVATE_KEY",
  "APPLE_MUSIC_STOREFRONT",
];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("mintDeveloperToken", () => {
  test("produces a verifiable ES256 JWT with the expected claims", () => {
    const now = 1_700_000_000;
    const token = mintDeveloperToken(credentials, now);

    const [headerB64, payloadB64] = token.split(".");
    expect(token.split(".")).toHaveLength(3);

    const header = decodeSegment(headerB64);
    expect(header).toMatchObject({ alg: "ES256", kid: KEY_ID, typ: "JWT" });

    const payload = decodeSegment(payloadB64);
    expect(payload.iss).toBe(TEAM_ID);
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBeGreaterThan(now);

    expect(verify(token)).toBe(true);
  });

  test("caps the token lifetime at Apple's 6-month maximum", () => {
    const now = 1_700_000_000;
    const token = mintDeveloperToken(credentials, now, 60 * 60 * 24 * 400);
    const payload = decodeSegment(token.split(".")[1]);
    expect((payload.exp as number) - now).toBeLessThanOrEqual(60 * 60 * 24 * 180);
  });

  test("accepts a private key with escaped newlines and stripped armour", () => {
    const bareBody = privatePem
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s+/g, "");
    const escaped = privatePem.replace(/\n/g, "\\n");

    expect(verify(mintDeveloperToken({ ...credentials, privateKey: bareBody }))).toBe(true);
    expect(verify(mintDeveloperToken({ ...credentials, privateKey: escaped }))).toBe(true);
  });

  test("accepts a key whose newlines were collapsed (armour glued to body)", () => {
    // What a host does when a multi-line PEM is pasted into a single-line field:
    // all newlines vanish, gluing the header/footer onto the base64 body.
    const glued = privatePem.replace(/\n/g, "");
    expect(glued).toMatch(/-----BEGIN PRIVATE KEY-----[A-Za-z0-9+/=]+-----END PRIVATE KEY-----/);
    expect(verify(mintDeveloperToken({ ...credentials, privateKey: glued }))).toBe(true);
  });

  test("accepts a key with real newlines and surrounding whitespace", () => {
    const padded = `\n  ${privatePem}\n\n`;
    expect(verify(mintDeveloperToken({ ...credentials, privateKey: padded }))).toBe(true);
  });
});

describe("credentials and configuration", () => {
  beforeEach(() => {
    clearEnv();
    resetDeveloperTokenCache();
  });
  afterEach(clearEnv);

  test("isAppleMusicConfigured requires all three vars", () => {
    expect(isAppleMusicConfigured()).toBe(false);
    process.env.APPLE_MUSIC_TEAM_ID = TEAM_ID;
    process.env.APPLE_MUSIC_KEY_ID = KEY_ID;
    expect(isAppleMusicConfigured()).toBe(false);
    process.env.APPLE_MUSIC_PRIVATE_KEY = privatePem;
    expect(isAppleMusicConfigured()).toBe(true);
    expect(readAppleMusicCredentials()).not.toBeNull();
  });

  test("getStorefront defaults to gb and honours a valid override", () => {
    expect(getStorefront()).toBe("gb");
    process.env.APPLE_MUSIC_STOREFRONT = "US";
    expect(getStorefront()).toBe("us");
    process.env.APPLE_MUSIC_STOREFRONT = "invalid";
    expect(getStorefront()).toBe("gb");
  });

  test("getDeveloperToken returns null when unconfigured and a token when configured", () => {
    expect(getDeveloperToken()).toBeNull();

    process.env.APPLE_MUSIC_TEAM_ID = TEAM_ID;
    process.env.APPLE_MUSIC_KEY_ID = KEY_ID;
    process.env.APPLE_MUSIC_PRIVATE_KEY = privatePem;

    const token = getDeveloperToken();
    expect(token).not.toBeNull();
    expect(verify(token as string)).toBe(true);
    // Cached: a second call returns the same token instance.
    expect(getDeveloperToken()).toBe(token);
  });
});
