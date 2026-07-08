import { Hono } from "hono";
import { getDeveloperToken, getStorefront, isAppleMusicConfigured } from "../apple-music-token";

/**
 * Endpoints backing the browser MusicKit integration.
 *
 *   GET /api/apple-music/config → whether MusicKit is available + storefront
 *   GET /api/apple-music/token  → a developer token for MusicKit.configure()
 *
 * The developer token is designed to be handed to the browser: it grants only
 * team-scoped catalogue access and expires. It carries no user authority — the
 * user authorises their own Apple Music account separately, client-side.
 */
export function createAppleMusicRoutes(): Hono {
  const routes = new Hono();

  routes.get("/config", (c) => {
    return c.json({
      configured: isAppleMusicConfigured(),
      storefront: getStorefront(),
    });
  });

  routes.get("/token", (c) => {
    // Distinguish "no credentials set" from "credentials present but the token
    // couldn't be minted" (usually a malformed private key) so the failure is
    // diagnosable from the response alone.
    if (!isAppleMusicConfigured()) {
      return c.json(
        {
          error: "Apple Music is not configured",
          reason: "missing_credentials",
          detail:
            "Set APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID and APPLE_MUSIC_PRIVATE_KEY, then restart the server.",
        },
        503,
      );
    }

    const token = getDeveloperToken();
    if (!token) {
      return c.json(
        {
          error: "Apple Music developer token could not be generated",
          reason: "token_error",
          detail:
            "Credentials are set but signing failed — check that APPLE_MUSIC_PRIVATE_KEY is the full .p8 contents (PKCS#8 PEM).",
        },
        503,
      );
    }

    // Small caches are fine — the token lives for months and is not secret.
    c.header("Cache-Control", "private, max-age=3600");
    return c.json({ token, storefront: getStorefront() });
  });

  return routes;
}

export const appleMusicRoutes = createAppleMusicRoutes();
