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
- `Build Pack`: `Nixpacks`
- `Static Site`: enabled
- `Base Directory`: `/`
- `Publish Directory`: `/dist`
- `Domain`: `https://enlaplaya.example.com`
- `Force HTTPS`: enabled

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

To enable the email-to-music-item webhook, set these environment variables in Coolify:

- `INGEST_API_KEY`: A random secret token used to authenticate webhook requests. Generate one with `openssl rand -base64 32`.
- `INGEST_ENABLED`: Set to `"false"` to disable the endpoint without removing the key. Defaults to enabled.

The webhook endpoint is `POST /api/ingest/email`. Configure your email provider (e.g. SendGrid Inbound Parse, Cloudflare Email Routing) to forward emails to:

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
