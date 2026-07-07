import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Apple MusicKit developer token
//
// MusicKit (both the JS SDK in the browser and the Apple Music API on the
// server) authenticates with a *developer token*: a short-ish-lived ES256 JWT
// signed with a MusicKit private key issued from the Apple Developer Program.
// It is deliberately safe to hand to the browser — it grants only catalogue
// access scoped to our team, never a user's library, and expires.
//
// Configuration (all three required to enable Apple Music):
//   APPLE_MUSIC_TEAM_ID      10-char Apple Developer Team ID  (JWT `iss`)
//   APPLE_MUSIC_KEY_ID       10-char MusicKit key identifier  (JWT header `kid`)
//   APPLE_MUSIC_PRIVATE_KEY  contents of the AuthKey_XXXX.p8   (ES256 PKCS#8 PEM)
//
// The private key is a PEM PKCS#8 block. Because env vars can't hold literal
// newlines in most hosting UIs, we accept the key with `\n` escapes and/or with
// the PEM armour stripped, and reconstruct a valid PEM before signing.
// ---------------------------------------------------------------------------

/** Maximum lifetime Apple permits for a developer token is 6 months. */
const MAX_TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 180;
/** We mint tokens that live for ~150 days and refresh a day before expiry. */
const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 150;
const REFRESH_MARGIN_SECONDS = 60 * 60 * 24;

interface CachedToken {
  token: string;
  /** Unix seconds at which the cached token should be considered stale. */
  expiresAt: number;
}

let cache: CachedToken | null = null;

export interface AppleMusicCredentials {
  teamId: string;
  keyId: string;
  privateKey: string;
}

/** Read the three env vars, returning null unless all are present. */
export function readAppleMusicCredentials(): AppleMusicCredentials | null {
  const teamId = process.env.APPLE_MUSIC_TEAM_ID?.trim();
  const keyId = process.env.APPLE_MUSIC_KEY_ID?.trim();
  const privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKey || !privateKey.trim()) {
    return null;
  }

  return { teamId, keyId, privateKey };
}

/** Whether Apple Music (MusicKit) is configured for this deployment. */
export function isAppleMusicConfigured(): boolean {
  return readAppleMusicCredentials() !== null;
}

/** The Apple Music storefront to query (ISO country code). Defaults to `gb`. */
export function getStorefront(): string {
  const raw = process.env.APPLE_MUSIC_STOREFRONT?.trim().toLowerCase();
  return raw && /^[a-z]{2}$/.test(raw) ? raw : "gb";
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Reconstruct a usable PKCS#8 PEM from the configured private key, tolerating
 * `\n`-escaped newlines and a bare (armour-stripped) base64 body.
 */
function normalizePrivateKeyPem(raw: string): string {
  const withNewlines = raw.replace(/\\n/g, "\n").trim();

  if (withNewlines.includes("-----BEGIN")) {
    return withNewlines;
  }

  // Bare base64 body — wrap it in PKCS#8 PEM armour at 64-char lines.
  const body = withNewlines.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Mint a fresh MusicKit developer token. Exported for testing; production code
 * should call {@link getDeveloperToken}, which caches.
 */
export function mintDeveloperToken(
  credentials: AppleMusicCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  lifetimeSeconds: number = TOKEN_LIFETIME_SECONDS,
): string {
  const lifetime = Math.min(lifetimeSeconds, MAX_TOKEN_LIFETIME_SECONDS);

  const header = { alg: "ES256", kid: credentials.keyId, typ: "JWT" };
  const payload = {
    iss: credentials.teamId,
    iat: nowSeconds,
    exp: nowSeconds + lifetime,
  };

  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;

  // ES256 for JWT requires the raw (IEEE P1363) r||s signature, not DER.
  const signature = crypto.sign("SHA256", Buffer.from(signingInput), {
    key: normalizePrivateKeyPem(credentials.privateKey),
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * Return a valid developer token, minting and caching a new one when none is
 * cached or the cached token is within the refresh margin of expiry. Returns
 * null when Apple Music is not configured.
 */
export function getDeveloperToken(): string | null {
  const credentials = readAppleMusicCredentials();
  if (!credentials) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.expiresAt - REFRESH_MARGIN_SECONDS > now) {
    return cache.token;
  }

  try {
    const token = mintDeveloperToken(credentials, now);
    cache = { token, expiresAt: now + TOKEN_LIFETIME_SECONDS };
    return token;
  } catch (err) {
    console.error("[apple-music] failed to mint developer token:", err);
    return null;
  }
}

/** Clear the cached token. Exported for tests. */
export function resetDeveloperTokenCache(): void {
  cache = null;
}
