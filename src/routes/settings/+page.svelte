<script lang="ts">
  import { apiFetch } from "$lib/api";
  import type { LookupService } from "../../../server/settings";

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  let activeService = $state(data.activeService);
  let statusMessage = $state("");

  async function onServiceChange(service: LookupService): Promise<void> {
    activeService = service;
    statusMessage = "Saving…";
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lookupService: service }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        statusMessage = err.error || "Failed to save.";
        return;
      }
      const result = await res.json();
      statusMessage = result.changed
        ? "Saved. Existing items will be re-looked-up on next view."
        : "Saved.";
    } catch {
      statusMessage = "Failed to save.";
    }
  }
</script>

<svelte:head>
  <title>Settings — On The Beach</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="main">
  <div class="settings">
    <a href="/" class="btn btn--ghost settings__back">◄ Back</a>

    <section class="settings__section">
      <h2 class="settings__heading">Lookup streaming service</h2>
      <p class="settings__hint">
        Which streaming service to search when adding a secondary listen link. Switching re-runs
        lookups against the new service on next view.
      </p>
      <form id="lookup-service-form" class="settings__options">
        {#each data.services as service (service.value)}
          <label class="settings__option">
            <input
              type="radio"
              name="lookup-service"
              value={service.value}
              checked={service.value === activeService}
              onchange={() => onServiceChange(service.value)}
            />
            <span>
              {service.displayName}{service.value === "spotify" ? " (search not yet active)" : ""}
            </span>
          </label>
        {/each}
      </form>
      <p id="settings-status" class="settings__status" role="status" aria-live="polite">
        {statusMessage}
      </p>
    </section>
  </div>
</main>
