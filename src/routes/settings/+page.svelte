<script lang="ts">
  import { onMount } from "svelte";
  import { apiFetch } from "$lib/api";
  import { musickit, authorize, unauthorize, ensureConfigured } from "$lib/musickit.svelte";
  import type { LookupService, ReleaseLengthPreference } from "../../../server/settings";

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  let activeService = $state(data.activeService);
  let statusMessage = $state("");

  // svelte-ignore state_referenced_locally
  let lengthPreference = $state(data.releaseLengthPreference);
  let lengthStatusMessage = $state("");

  const LENGTH_PREFERENCE_LABELS: Record<ReleaseLengthPreference, string> = {
    longer: "Longer releases — albums before EPs and singles (default)",
    shorter: "Shorter releases — EPs and singles before albums",
  };

  // ── Apple Music configuration status ────────────────────────────────────────
  // Probe the token endpoint so the page reflects the *live* server state,
  // including the case where the credentials are set but the developer token
  // can't be minted (usually a malformed private key) — which the SSR
  // `configured` flag alone can't distinguish.
  type AmState = "checking" | "ready" | "missing_credentials" | "token_error";
  let amState = $state<AmState>("checking");
  let amDetail = $state("");

  const amReady = $derived(amState === "ready");

  onMount(() => {
    void refreshAppleMusicStatus();
  });

  async function refreshAppleMusicStatus(): Promise<void> {
    amState = "checking";
    try {
      const res = await fetch("/api/apple-music/token");
      if (res.ok) {
        amState = "ready";
        amDetail = "";
        void ensureConfigured();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { reason?: string; detail?: string };
      amState = body.reason === "token_error" ? "token_error" : "missing_credentials";
      amDetail = body.detail ?? "";
    } catch {
      amState = "missing_credentials";
      amDetail = "Couldn't reach the server to check Apple Music status.";
    }
  }

  // ── Apple Music account authorisation ──────────────────────────────────────
  // The developer token enables catalogue access; playing full tracks needs the
  // listener to authorise their own Apple Music subscription once, here or from
  // the player.
  function connectAppleMusic(): void {
    if (amReady) void ensureConfigured();
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

  async function onLengthPreferenceChange(preference: ReleaseLengthPreference): Promise<void> {
    lengthPreference = preference;
    lengthStatusMessage = "Saving…";
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseLengthPreference: preference }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        lengthStatusMessage = err.error || "Failed to save.";
        return;
      }
      const result = await res.json();
      lengthStatusMessage = result.changed
        ? "Saved. Queued suggestions will be re-picked with this preference."
        : "Saved.";
    } catch {
      lengthStatusMessage = "Failed to save.";
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

    <section class="settings__section" id="release-length-settings">
      <h2 class="settings__heading">Suggested release length</h2>
      <p class="settings__hint">
        When suggesting another release by an artist you've listened to, which length to favour.
        Changing this re-picks any queued suggestions.
      </p>
      <form id="release-length-form" class="settings__options">
        {#each data.releaseLengthPreferences as preference (preference)}
          <label class="settings__option">
            <input
              type="radio"
              name="release-length-preference"
              value={preference}
              checked={preference === lengthPreference}
              onchange={() => onLengthPreferenceChange(preference)}
            />
            <span>{LENGTH_PREFERENCE_LABELS[preference]}</span>
          </label>
        {/each}
      </form>
      <p
        id="release-length-status"
        class="settings__status"
        role="status"
        aria-live="polite"
      >
        {lengthStatusMessage}
      </p>
    </section>

    <section class="settings__section" id="apple-music-settings">
      <h2 class="settings__heading">
        Apple Music
        <span
          class="settings__badge"
          class:settings__badge--ok={amReady}
          class:settings__badge--warn={amState === "token_error"}
          class:settings__badge--off={amState === "missing_credentials"}
          id="apple-music-status-badge"
        >
          {#if amState === "checking"}
            Checking…
          {:else if amReady}
            Configured ✓
          {:else if amState === "token_error"}
            Key error
          {:else}
            Not configured
          {/if}
        </span>
      </h2>

      {#if amReady}
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
            {#if musickit.error}
              <p class="settings__status" role="status">{musickit.error}</p>
            {/if}
          {/if}
        </div>
      {:else if amState === "checking"}
        <p class="settings__hint">Checking Apple Music configuration…</p>
      {:else if amState === "token_error"}
        <p class="settings__hint">
          Apple Music credentials are set, but the developer token couldn't be generated.
          {amDetail || "Check that APPLE_MUSIC_PRIVATE_KEY is the full .p8 contents (PKCS#8 PEM)."}
        </p>
      {:else}
        <p class="settings__hint">
          MusicKit is not configured. Set <code>APPLE_MUSIC_TEAM_ID</code>,
          <code>APPLE_MUSIC_KEY_ID</code>, and <code>APPLE_MUSIC_PRIVATE_KEY</code> on the server
          (then restart it) to enable full-track Apple Music playback. Until then, Apple Music links
          play 30-second previews.
        </p>
      {/if}
    </section>
  </div>
</main>
