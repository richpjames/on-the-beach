# Coolify Alpha Deployment

This runbook hosts the current app as a static site on Coolify with:

- CI-gated deployment from `main`
- custom domain `enlaplaya.example.com`
- Basic Auth for single-user alpha
- no-index search hardening

## 1. DNS

Create this DNS record:

- `A enlaplaya.example.com -> <your_coolify_server_public_ip>`

Verify propagation:

```bash
dig enlaplaya.example.com +short
```

## 2. Coolify Application Setup

Create a new Coolify application from `richpjames/on-the-beach`:

- `Branch`: `main`
- `Build Pack`: `Dockerfile`
- `Base Directory`: `/`
- `Port`: `3000`
- `Domain`: `https://enlaplaya.example.com`
- `Force HTTPS`: enabled

> **Important**: Do NOT use Static Site mode. The app requires a running backend server
> (Hono + SQLite) to handle `/api/*` routes. The Dockerfile builds the frontend and
> starts the Bun server in a single container.

Add an environment variable in Coolify:

- `DATABASE_PATH`: `/app/data/on_the_beach.db`

Add a persistent volume in Coolify:

- Source: a named volume (e.g. `on-the-beach-data`)
- Destination: `/app/data`

Run one manual deploy to confirm baseline.

## 3. Basic Auth (Traefik labels)

Generate bcrypt credentials:

```bash
# Option A: local htpasswd
htpasswd -nbB alpha '<strong-password>'

# Option B: if htpasswd is unavailable
docker run --rm httpd:2.4-alpine htpasswd -nbB alpha '<strong-password>'
```

In Coolify application labels, add:

```text
traefik.http.middlewares.otb-auth.basicauth.users=alpha:<bcrypt-hash>
```

Then update the existing router middleware label for the app so it includes `otb-auth`.
If it currently has `gzip`, make it:

```text
traefik.http.routers.<your-router-name>.middlewares=gzip,otb-auth
```

Redeploy and verify a browser auth prompt appears.

## 4. No-Index Hardening

This repo sets:

- HTML robots meta tag in `index.html`

Optional edge header (Traefik middleware label):

```text
traefik.http.middlewares.otb-noindex.headers.customresponseheaders.X-Robots-Tag=noindex, nofollow
```

If you add it, append `otb-noindex` to the same router middleware label:

```text
traefik.http.routers.<your-router-name>.middlewares=gzip,otb-auth,otb-noindex
```

## 5. GitHub Secrets for Deploy Hook

Add repository secrets:

- `COOLIFY_WEBHOOK`: Coolify deploy webhook URL
- `COOLIFY_TOKEN`: Coolify API token for the webhook

The workflow at `.github/workflows/playwright.yml` deploys only when:

1. push target is `main`
2. Playwright test job passes
3. both secrets are configured

## 6. Verification Checklist

1. Push a commit to `main`.
2. Confirm `Playwright E2E / test` passes in GitHub Actions.
3. Confirm `Playwright E2E / Deploy to Coolify` runs.
4. Confirm Coolify starts a deployment and serves latest commit.
5. Open `https://enlaplaya.example.com` in incognito and verify Basic Auth challenge.
6. Log in and confirm app still saves/reloads local data in same browser profile.
