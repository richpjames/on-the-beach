import { Hono } from "hono";
import { getPageAssets } from "../page-assets";
import { getLookupService, LOOKUP_SERVICES, type LookupService } from "../settings";
import { LOOKUP_SERVICE_CONFIG } from "../secondary-link-enrichment";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function renderServiceOption(service: LookupService, active: LookupService): string {
  const cfg = LOOKUP_SERVICE_CONFIG[service];
  const checked = service === active ? " checked" : "";
  const note = service === "spotify" ? " (search not yet active)" : "";
  return `
        <label class="settings__option">
          <input type="radio" name="lookup-service" value="${escapeHtml(service)}"${checked} />
          <span>${escapeHtml(cfg.displayName)}${note}</span>
        </label>`;
}

function renderSettingsPage(active: LookupService, cssHref: string): string {
  const options = LOOKUP_SERVICES.map((s) => renderServiceOption(s, active)).join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Settings — On The Beach</title>
    <link rel="preconnect" href="https://fonts.coollabs.io" />
    <link href="https://fonts.coollabs.io/css2?family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="${escapeHtml(cssHref)}" />
  </head>
  <body>
    <header class="header">
      <h1>On The Beach</h1>
      <p class="header__subtitle">Settings</p>
    </header>
    <main class="main">
      <div class="settings">
        <a href="/" class="btn btn--ghost settings__back">◄ Back</a>

        <section class="settings__section">
          <h2 class="settings__heading">Lookup streaming service</h2>
          <p class="settings__hint">
            Which streaming service to search when adding a secondary listen link.
            Switching re-runs lookups against the new service on next view.
          </p>
          <form id="lookup-service-form" class="settings__options">${options}
          </form>
          <p id="settings-status" class="settings__status" role="status" aria-live="polite"></p>
        </section>
      </div>
    </main>

    <script type="module">
      const form = document.getElementById('lookup-service-form');
      const status = document.getElementById('settings-status');

      form?.addEventListener('change', async (e) => {
        const target = e.target;
        if (!target || target.name !== 'lookup-service' || !target.checked) return;
        const lookupService = target.value;
        status.textContent = 'Saving…';
        try {
          const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lookupService }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            status.textContent = err.error || 'Failed to save.';
            return;
          }
          const data = await res.json();
          status.textContent = data.changed
            ? 'Saved. Existing items will be re-looked-up on next view.'
            : 'Saved.';
        } catch {
          status.textContent = 'Failed to save.';
        }
      });
    </script>
  </body>
</html>`;
}

export function createSettingsPageRoutes(
  fetchActiveService: () => Promise<LookupService> = getLookupService,
): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const active = await fetchActiveService();
    const { cssHref } = await getPageAssets();
    return c.html(renderSettingsPage(active, cssHref));
  });

  return routes;
}

export const settingsPageRoutes = createSettingsPageRoutes();
