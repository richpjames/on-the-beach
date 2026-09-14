# Auth — Design for a Self-Hosted Identity Service That E2E Can Live With

**Goal:** replace edge Basic Auth with real sessions and a real user identity, backed by an
identity provider we run ourselves, **without** making the Playwright suite depend on that
provider being up.

**Decided shape:** the **app owns sessions; the IdP owns identity**. The seam between them is
the OIDC callback. Everything downstream of the callback — the session cookie, `locals.user`,
route guards — is our code and knows nothing about OIDC, which is exactly what makes the e2e
suite cheap.

---

## What "auth" means in this repo today

Worth writing down, because three different mechanisms are already in play and the design has
to keep two of them:

| Surface | Mechanism | Where |
| --- | --- | --- |
| The web app | Traefik Basic Auth at the Coolify edge | `docs/deployment/coolify-alpha.md` §3 |
| Email ingest webhook | `Authorization: Bearer $INGEST_API_KEY` | `server/routes/ingest.ts` |
| iOS Shortcut, native Share Extension | the same `INGEST_API_KEY` bearer | `docs/ios-shortcut.md` |
| RSS feeds (`/feed/*`) | nothing | `server/routes/rss.ts` |
| Unsafe-method requests | double-submit CSRF cookie | `server/csrf.ts`, `src/hooks.server.ts` |

There is no `users` table (`server/db/schema.ts` has no user concept) and no session. The app
is single-user by construction: Basic Auth gates the whole origin, and whoever gets through
sees the one database.

`docs/sync-rollout-plan.md` Phase 3 already commits to "OAuth PKCE login and rotating refresh
token flow" plus a client-side `AuthService`. This design is the concrete version of that
line, pulled forward so it isn't blocked on sync.

---

## The two constraints that actually decide the design

Everything below falls out of these. Neither is about which vendor we pick.

### 1. Half the clients can't do a browser redirect

The app is not only a browser app. The iOS Shortcut, the native Share Extension
(`native/ShareExtension/ShareViewController.swift`), the email webhook and RSS readers all
speak HTTP without a human present. An RSS reader in particular will **never** complete an
OIDC handshake — it fetches a URL and parses XML.

So interactive login can never be the only way in. There must be a second, non-interactive
credential path, and it must not be an afterthought bolted on once the login wall breaks the
Shortcut.

### 2. E2E boots a fresh server on a random port, 25 spec files deep

`playwright/fixtures/parallel-test.ts` gives every worker its own `build/index.js` on a port
from `getAvailablePort()`, its own seeded SQLite file, and `NODE_ENV=test`. All 25 spec files
— `playwright/*.spec.ts` **and** `tests/visual/ui.spec.ts` — import that one fixture.

That cuts both ways:

- **Bad for a real IdP.** An OIDC client registration pins exact redirect URIs. Our redirect
  URI is `http://127.0.0.1:<random>/auth/callback`, different per worker, per run. Wildcard
  redirect URIs are the workaround and they are the single most footgunned setting in every
  IdP — not something to rely on in CI. Add container boot time (and for most providers, a
  Postgres to boot first) inside the `mcr.microsoft.com/playwright` job container, and a
  login page whose selectors we don't own and that changes between provider releases.
- **Very good for us.** One fixture is the *entire* blast radius. If the fixture hands every
  context an authenticated `storageState`, all 25 spec files keep passing unchanged. Auth
  becomes a one-file change to the test suite.

---

## The shape

```
                 ┌─────────────────────────────────────────┐
  browser  ──►   │ /auth/login  → redirect to IdP          │
                 │ /auth/callback ← code + PKCE            │  ← the seam
                 │     verify ID token, upsert users row,  │
                 │     mint otb_session cookie             │
                 └──────────────────┬──────────────────────┘
                                    │  everything below knows
                                    ▼  only about sessions
                 ┌─────────────────────────────────────────┐
  Shortcut ──►   │ hooks.server.ts guard → locals.user      │
  webhook  ──►   │   session cookie  OR  bearer api_token   │
  RSS      ──►   │   OR feed token in the URL               │
                 └─────────────────────────────────────────┘
```

Three credential kinds, one resolved identity:

1. **`otb_session`** — httpOnly, `SameSite=Lax`, random opaque id, row in a `sessions` table
   with `expires_at` and rolling refresh. Issued only by `/auth/callback`. This is what the
   browser and the Capacitor WKWebView use.
2. **`api_tokens`** — hashed (Argon2id or bcrypt) rows, one per machine client, sent as
   `Authorization: Bearer`. `INGEST_API_KEY` migrates into this table as a legacy row so the
   Shortcut and Share Extension keep working with no user action; new tokens are issued from
   the settings page and shown once.
3. **Feed tokens** — an unguessable per-feed token in the path (`/feed/t/<token>/to-listen`),
   because readers can't send headers. Revocable, separate from `api_tokens`, read-only by
   construction.

The guard lives in `src/hooks.server.ts`, next to the CSRF check that's already there — one
place, one allowlist (`/auth/*`, `/health`, static assets).

### Why the session is ours and not the IdP's

Tempting alternative: skip our own session, keep the IdP's access token in a cookie and
validate the JWT on every request. Don't. It makes every request depend on the IdP's JWKS
being reachable, it makes logout a distributed problem, and — the point here — it drags OIDC
into the part of the system the e2e suite exercises. Exchanging the handshake for *our own*
session at the callback is what confines OIDC to one route pair.

---

## Which service to self-host

All of these are OIDC providers you run yourself. The column that matters for us is what it
drags along at runtime, because this is a one-user app on a single Coolify box.

| | Runtime footprint | Users | Fit here |
| --- | --- | --- | --- |
| **Pocket ID** | single Go binary + SQLite | passkey-only | Smallest thing that is a real OIDC provider. Matches "one person, one box" exactly. Passkey-only means no password reset to own. |
| **Authelia** | single Go binary, file/SQLite backend | password + TOTP/WebAuthn | Also does Traefik ForwardAuth, so it can *keep* the edge gate we already have **and** be the OIDC provider for the app. Best fit if we don't want to give up defence-in-depth at the proxy. |
| **Dex** | single Go binary, users in config, no DB | static passwords | Not a good daily driver (no self-service, no UI to speak of), but it boots in under a second from a config file — the obvious choice for the *real-IdP contract job* in CI. |
| **Zitadel** | Go + **Postgres** | full-featured | Real multi-tenant IdP. More machine than this app needs today, but the one to grow into if sync ever means more than one person. |
| **Keycloak** | JVM + **Postgres** | full-featured | Heaviest. Only if enterprise-shaped requirements appear. |
| **Authentik** | Python + **Postgres + Redis** | full-featured | Same, with more moving parts. |
| **Ory Kratos/Hydra** | Go + **Postgres**, you build the login UI | full-featured | Powerful, but "you build the UI" is a project, not a step. |

**Recommendation: Authelia**, with **Dex** as the CI stand-in. Authelia is the only row that
lets us add in-app identity *without* giving up the edge protection we already rely on —
during rollout the proxy can keep gating the origin while the app learns about sessions
underneath, which makes this a reversible change rather than a cutover. Pocket ID is the
right answer instead if passkeys-only is acceptable and we're happy to drop the edge gate;
it's meaningfully less to operate.

Check current releases before committing — this table is architecture-level and these
projects move.

### The honest counter-option

If "a service I can self host" just means "not Auth0/Clerk/WorkOS", then the *simplest*
answer is no second service at all: an in-app auth library (Better Auth, or hand-rolled —
it's a `users` table, a `sessions` table and Argon2id) running on the SQLite database we
already have. It self-hosts by definition, it needs no container, no redirect URIs, and the
e2e story gets even easier because there's no handshake to fake.

The reason to prefer a separate IdP anyway is if any of these are true, and they may not be:

- we want SSO across other things on the same box (the usual reason people self-host an IdP),
- we want passkeys/TOTP without owning that code,
- sync Phase 3 is expected to serve people other than us.

If none of those hold, take the library and save the container. Worth deciding explicitly
rather than by default — it's the difference between one deployable and two.

---

## The e2e strategy: three layers, and only one of them is slow

The mistake to avoid is testing the handshake 25 times. Split by what each layer actually
de-risks.

### Layer 1 — Every existing spec: mint a session **without an HTTP endpoint**

The obvious move is a test-only route (`POST /api/__test__/session`) next to the `/reset`
route, mounted only under `NODE_ENV=test`. **Don't.** An endpoint whose whole job is "issue a
valid session for any user" is the one piece of code where a gate failure is not a bug but a
total auth bypass, and it would be reachable by anyone who guesses the path.

Mint it out of band instead. The worker fixture already shells out to a Bun script against
the worker's own database file before the server boots:

```ts
// playwright/fixtures/parallel-test.ts:39 — this already exists
await runCommand(["server/db/seed.ts"], env);
```

So add a sibling script that inserts a `users` row and a `sessions` row directly and prints
the cookie value:

```ts
await runCommand(["server/db/seed.ts"], env);
const cookie = await runCommand(["scripts/mint-test-session.ts"], env);  // stdout
const storageState = { cookies: [{ name: SESSION_COOKIE_NAME, value: cookie, ... }] };
```

Then pass `storageState` through the `contextOptions` override the fixture already has. All
25 spec files — `playwright/*.spec.ts` and `tests/visual/ui.spec.ts` — pass unedited.

**The privilege is filesystem access to the SQLite file, not knowledge of a URL.** There is
no route to discover, nothing to guess, and no gate to fail open. An attacker who can already
write to `DATABASE_PATH` does not need a session-minting endpoint; they have the data.

This also removes the need for a `NODE_ENV` check on the auth path entirely — the script is
in `scripts/`, never imported by `server/app.ts`, so it cannot be reached over HTTP by any
configuration mistake.

#### Second choice: log in for real

If a session row ever gets complicated enough that writing one by hand duplicates production
logic, drive the real login instead: point the fixture at the layer-2 fake IdP, hit
`/auth/login`, let it auto-approve, and let the real `/auth/callback` set the real cookie.
Strictly better fidelity — it exercises the production code path — at the cost of a redirect
chain per worker and wiring the fake provider into every project rather than one spec.

Still no test-only endpoint either way. That is the property worth protecting.

Two follow-ups this implies:

- The seeded user belongs in `server/db/seed.ts`, so `bun run dev` and the test workers agree
  on who is logged in and the dev experience doesn't diverge.
- The `request` fixture needs the session cookie too — it already sets `extraHTTPHeaders` for
  the CSRF `Origin`, so it's the same edit.

### Layer 2 — One spec: the real handshake against a fake IdP

Session-minting deliberately skips `/auth/login` and `/auth/callback`, so those need their
own coverage — state, nonce, PKCE verifier and ID-token signature checks are exactly where
auth bugs live.

Run a **fake OIDC provider in the worker**: ~100 lines serving
`/.well-known/openid-configuration`, `/authorize` (auto-approve, redirect straight back with
a code), `/token` and `/jwks.json`, signing with a generated key. Point `OIDC_ISSUER` at it
for that project/spec.

This kills constraint #2 dead: because we serve the discovery document, the redirect URI is
whatever the worker's random port happens to be. No registration, no wildcards, no container.
And the code under test is the real adapter — we're faking the provider, not the client.

Specs that test the login journey itself opt out of layer 1 with
`test.use({ storageState: undefined })`.

### Layer 3 — Nightly: the real IdP, as a contract test

The fake provider can drift from the real one (claim names, `at_hash`, discovery quirks). Pin
that with a slow job that runs against a real Dex — or the real Authelia — and does exactly
one thing: log in, assert a session.

This repo already has the pattern to copy: `.github/workflows/ingest-e2e.yml` runs a
prod-touching check nightly and on demand, deliberately out of the PR path. An
`auth-e2e.yml` alongside it, on a schedule, keeps PR feedback fast while still catching
provider drift within a day.

---

## The test-route boundary we already have, and why it needs hardening anyway

Avoiding a session-minting endpoint is necessary but not sufficient, because **the repo
already ships a test-only route to production**. This is measured, not assumed —
`bun run build` on `main` produces:

```
$ grep -rl "__test__" build/
build/server/chunks/chunks/app.js-_BcF2hrg.js

$ sed -n '1801,1804p' build/server/chunks/chunks/app.js-_BcF2hrg.js
if (process.env["NODE_ENV"] === "test") {
  const { testRoutes } = await import('./test.js-B8Gs8BMa.js');
  apiApp.route("/api/__test__", testRoutes);
}

$ grep -n "delete(" build/server/chunks/chunks/test.js-B8Gs8BMa.js
12:  await db.delete(musicItemStacks);
...            # all ten tables, in the shipped artifact
```

The dynamic import sits behind a runtime `process.env` read, so Rollup cannot eliminate it:
`test.js-B8Gs8BMa.js` is emitted as a real chunk and deployed. The only thing between a
production `POST /api/__test__/reset` and `DELETE` on every table is **one string comparison
at `server/app.ts:36`**, evaluated once at module load.

That gate is currently holding — `NODE_ENV=production` is set in both `Dockerfile:16` and
`docker-compose.yml:11`, and Coolify preview deploys use the same Dockerfile. But it is a
single point of failure guarding total data loss, and adding auth raises what's behind it
from "the data" to "the data and the identity system".

Two fixes, both cheap, and worth doing **whether or not** we ever add auth:

1. **Make it a build-time exclusion, not a runtime branch.** Set `NODE_ENV` via Vite's
   `define` so the condition folds to `false` and the chunk is never emitted, or swap
   `server/routes/test.ts` for a stub module in production builds. Code that isn't in the
   artifact cannot be reached by any misconfiguration.
2. **Assert it in CI.** One step in `test.yml` after the build:

   ```sh
   ! grep -rq "__test__" build/ || { echo "test routes leaked into the production build"; exit 1; }
   ```

   This is the regression test for the trust boundary itself, and it's three lines.

Fix 2 alone converts "we're pretty sure the env var is right everywhere" into "CI fails if it
ever isn't", which is the property actually worth having.

---
## Concrete change list

Ordered so each step is shippable and nothing is load-bearing until the last one.

1. **Schema** (`server/db/schema.ts` + `drizzle/`): `users`, `sessions`, `api_tokens`,
   `feed_tokens`. No foreign keys onto existing music tables yet — single-tenant stays
   single-tenant until sync needs otherwise.
2. **`ports/auth.ts`**: name the port before writing an adapter, per
   `docs/plans/2026-08-30-hexagonal-architecture.md` Task 6. Two shapes:
   `IdentityProvider` (start a login, verify a callback → `{ subject, email }`) and
   `SessionStore` (create, read, revoke). Add the `overrides` entry to `.oxlintrc.json` so
   the boundary is enforced, not just documented.
3. **Adapters**: `adapters/auth/oidc.ts` (real), `adapters/auth/fake-oidc.ts` (test-only,
   layer 2), `adapters/auth/session-sqlite.ts`.
4. **Routes**: `/auth/login`, `/auth/callback`, `/auth/logout` as SvelteKit routes — they set
   cookies and redirect, which is SvelteKit's job, not Hono's.
5. **Guard** in `src/hooks.server.ts`: resolve session-cookie → bearer → feed-token in that
   order, set `event.locals.user` (declare it in `src/app.d.ts`), 401/redirect otherwise.
   Allowlist `/auth/*`, `/health`, static assets.
6. **CSRF interaction** (`server/csrf.ts`): bearer-authenticated requests carry no ambient
   cookie authority, so they should be CSRF-exempt by *mechanism* rather than by the current
   hardcoded `EXEMPT_PATH_PREFIXES = ["/api/ingest"]`. That list becomes "requests
   authenticated by bearer token", which is both stricter and less brittle.
7. **Session minting for tests** (layer 1): `scripts/mint-test-session.ts` plus the
   `parallel-test.ts` fixture edit — the step that keeps the suite green. No route, no
   `NODE_ENV` gate on the auth path.
7a. **Harden the existing boundary**: strip `server/routes/test.ts` from production builds and
   add the `grep -rq "__test__" build/` assertion to `test.yml`. Independent of everything
   else here and worth landing first — it protects `/reset` today.
8. **Migrate machine clients**: `INGEST_API_KEY` → an `api_tokens` row at startup if absent,
   so the Shortcut, Share Extension and webhook are untouched. Feed URLs gain tokens, with
   the old unauthenticated paths kept behind a deprecation window since existing readers are
   already subscribed to them.
9. **Then** remove Traefik Basic Auth — or keep it, if we went with Authelia and want both.

---

## Risks

- **Locking ourselves out.** A guard bug on a self-hosted single-user app is a real outage
  with no support desk. Ship steps 1–7 with the guard in log-only mode behind
  `AUTH_ENFORCE=0`, and keep edge Basic Auth on until the enforced mode has run for a while.
- **The visual suite is in the blast radius.** `tests/visual/ui.spec.ts` imports the same
  fixture, so an auth redirect that lands before first paint rewrites every committed
  baseline in `tests/visual/ui.spec.ts-snapshots/`. Layer 1 avoids this by construction —
  but it's the thing to check first if baselines start churning.
- **A test-only endpoint would be an auth bypass, not a bug.** This is why layer 1 mints
  sessions through the filesystem rather than over HTTP. The rule to hold: nothing that
  issues credentials is ever reachable by URL, in any environment. The existing
  `/api/__test__/reset` shows how easily a runtime-gated route reaches the production
  artifact — see the section above.
- **Fake-provider drift.** Layer 2 is only as good as its fidelity. Layer 3 exists precisely
  for this; skipping it means the fake becomes the spec.
- **RSS tokens leak by design.** A token in a URL ends up in reader logs and sync services.
  Read-only scope and easy revocation are the mitigation; there isn't a better option for
  RSS.
- **Two deployables instead of one.** Today `docker-compose.yml` is one service and the
  Dockerfile is self-contained. An IdP adds a container, a second set of secrets, its own
  backup story, and a startup-order dependency. That cost is the strongest argument for the
  counter-option above.

## Deliberately out of scope

Multi-user data partitioning (no `user_id` on music tables — that's sync Phase 4's problem),
refresh-token rotation for native clients (sync Phase 3), and the Safari extension token flow
(sync Phase 5).
