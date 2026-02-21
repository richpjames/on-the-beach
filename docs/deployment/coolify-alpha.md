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

## 5. Email Ingest (Optional)

The app can receive emails directly via an embedded SMTP server and/or an HTTP webhook. Both extract music URLs from the email body and create music items automatically.

### Option A: Embedded SMTP server (recommended for self-hosting)

Set these environment variables in Coolify:

- `SMTP_ENABLED`: Set to `"true"` to start the embedded SMTP server alongside the web app.
- `SMTP_PORT`: Port to listen on (default `2525`). Use `25` if receiving mail directly.
- `SMTP_ALLOWED_FROM`: Comma-separated sender addresses to accept (e.g. `noreply@bandcamp.com`). If unset, all senders are accepted.

**DNS setup** — add an MX record pointing to your server:

```
MX  enlaplaya.example.com  ->  enlaplaya.example.com  (priority 10)
```

**Coolify port** — expose the SMTP port alongside the web port. In your Coolify app settings, add:

```
Ports: 3000:3000, 2525:2525
```

**Firewall** — ensure the SMTP port is open on your server:

```bash
ufw allow 2525/tcp
```

Test with swaks or a manual SMTP send:

```bash
swaks --to music@enlaplaya.example.com \
      --from noreply@bandcamp.com \
      --server enlaplaya.example.com:2525 \
      --header "Subject: New release" \
      --body '<a href="https://artist.bandcamp.com/album/test">Listen</a>' \
      --h-Content-Type "text/html"
```

### Option B: HTTP webhook

Set these environment variables in Coolify:

- `INGEST_API_KEY`: A random secret token. Generate one with `openssl rand -base64 32`.
- `INGEST_ENABLED`: Set to `"false"` to disable the endpoint without removing the key. Defaults to enabled.

The endpoint is `POST /api/ingest/email`. Point your email provider's webhook to:

```
https://enlaplaya.example.com/api/ingest/email
```

with the header `Authorization: Bearer <your-INGEST_API_KEY>`.

For SendGrid, append `?provider=sendgrid` to the URL.

Test with curl:

```bash
curl -X POST https://enlaplaya.example.com/api/ingest/email \
  -H "Authorization: Bearer <your-INGEST_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@bandcamp.com",
    "to": "music@enlaplaya.example.com",
    "subject": "New release",
    "html": "<a href=\"https://artist.bandcamp.com/album/test\">Listen</a>"
  }'
```

## 6. GitHub Secrets for Deploy Hook

Add repository secrets:

- `COOLIFY_WEBHOOK`: Coolify deploy webhook URL
- `COOLIFY_TOKEN`: Coolify API token for the webhook

The workflow at `.github/workflows/playwright.yml` deploys only when:

1. push target is `main`
2. Playwright test job passes
3. both secrets are configured

## 7. Verification Checklist

1. Push a commit to `main`.
2. Confirm `Playwright E2E / test` passes in GitHub Actions.
3. Confirm `Playwright E2E / Deploy to Coolify` runs.
4. Confirm Coolify starts a deployment and serves latest commit.
5. Open `https://enlaplaya.example.com` in incognito and verify Basic Auth challenge.
6. Log in and confirm app still saves/reloads local data in same browser profile.
