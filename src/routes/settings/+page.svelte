<script lang="ts">
  import { apiFetch } from "$lib/api";
  import { musickit, authorize, unauthorize, ensureConfigured } from "$lib/musickit.svelte";
  import type { LookupService } from "../../../server/settings";

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  let activeService = $state(data.activeService);
  let statusMessage = $state("");

  // ── Apple Music account authorisation ──────────────────────────────────────
  // The developer token enables catalogue access; playing full tracks needs the
  // listener to authorise their own Apple Music subscription once, here or from
  // the player.
  function connectAppleMusic(): void {
    if (data.appleMusicConfigured) void ensureConfigured();
  }

  async function signInAppleMusic(): Promise<void> {
    await authorize();
  }

  async function signOutAppleMusic(): Promise<void> {
    await unauthorize();
  }

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

    <section class="settings__section" id="apple-music-settings">
      <h2 class="settings__heading">Apple Music</h2>
      {#if data.appleMusicConfigured}
        <p class="settings__hint">
          MusicKit is configured (storefront: {data.appleMusicStorefront.toUpperCase()}). Sign in to
          your Apple Music subscription to play full tracks in the player instead of 30-second
          previews.
        </p>
        <div class="settings__options">
          {#if musickit.authorized}
            <p class="settings__status" role="status">Signed in to Apple Music.</p>
            <button type="button" class="btn" id="apple-music-signout" onclick={signOutAppleMusic}
              >Sign out</button
            >
          {:else}
            <button
              type="button"
              class="btn btn--primary"
              id="apple-music-connect"
              onclick={signInAppleMusic}
              onmouseenter={connectAppleMusic}>Sign in to Apple Music</button
            >
          {/if}
        </div>
      {:else}
        <p class="settings__hint">
          MusicKit is not configured. Set <code>APPLE_MUSIC_TEAM_ID</code>,
          <code>APPLE_MUSIC_KEY_ID</code>, and <code>APPLE_MUSIC_PRIVATE_KEY</code> to enable
          full-track Apple Music playback. Until then, Apple Music links play 30-second previews.
        </p>
      {/if}
    </section>
  </div>
</main>
