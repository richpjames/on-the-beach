<script lang="ts">
  import { onMount } from "svelte";
  import { apiFetch } from "$lib/api";
  import {
    musickit,
    authorize,
    unauthorize,
    reauthorize,
    ensureConfigured,
  } from "$lib/musickit.svelte";
  import { api } from "$lib/api";
  import StarRating from "$lib/components/StarRating.svelte";
  import type { LookupService, ReleaseLengthPreference } from "../../../server/settings";
  import type { ArtistFollowState, MbArtistCandidateView, TrackedArtist } from "../../types";

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

  let appleMusicStatusMessage = $state("");
  let appleMusicBusy = $state(false);

  async function signInAppleMusic(): Promise<void> {
    appleMusicBusy = true;
    appleMusicStatusMessage = "Opening Apple Music sign-in…";
    try {
      const ok = await authorize();
      appleMusicStatusMessage = ok ? "Signed in to Apple Music." : "Sign-in didn't complete.";
    } finally {
      appleMusicBusy = false;
    }
  }

  async function signOutAppleMusic(): Promise<void> {
    appleMusicBusy = true;
    try {
      await unauthorize();
      appleMusicStatusMessage = "Signed out of Apple Music.";
    } finally {
      appleMusicBusy = false;
    }
  }

  /**
   * Sign out and straight back in. A user token Apple has expired or revoked
   * still reads as signed in, so playback fails with nothing here to fix it
   * short of starting the sign-in over.
   */
  async function reauthoriseAppleMusic(): Promise<void> {
    appleMusicBusy = true;
    appleMusicStatusMessage = "Reauthorising…";
    try {
      const ok = await reauthorize();
      appleMusicStatusMessage = ok
        ? "Reauthorised with Apple Music."
        : "Signed out, but the new sign-in didn't finish — use Sign in to Apple Music below.";
    } finally {
      appleMusicBusy = false;
    }
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

  // ── Artist watch ────────────────────────────────────────────────────────────
  // svelte-ignore state_referenced_locally
  let watch = $state({ ...data.artistWatch });
  let watchStatusMessage = $state("");

  // The stars can't paint 0 — the control's own "off" is null — so the bar's
  // value is spelled out beside them. It also carries the only cue for how to
  // get back to off, which is the same gesture as clearing a record's rating.
  const minArtistRatingLabel = $derived(
    watch.minArtistRating > 0
      ? `${watch.minArtistRating} star${watch.minArtistRating === 1 ? "" : "s"} (click again to clear)`
      : "no bar — any artist you've listened to"
  );

  async function saveWatch(update: Record<string, unknown>): Promise<void> {
    watchStatusMessage = "Saving…";
    try {
      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        watchStatusMessage = err.error || "Failed to save.";
        return;
      }
      const result = await res.json();
      watch = { ...result.artistWatch };
      watchStatusMessage = "Saved.";
    } catch {
      watchStatusMessage = "Failed to save.";
    }
  }

  // ── Tracked artists ─────────────────────────────────────────────────────────
  // svelte-ignore state_referenced_locally
  let trackedArtists = $state<TrackedArtist[]>(data.trackedArtists as TrackedArtist[]);
  let artistStatusMessage = $state("");
  let candidatesFor = $state<number | null>(null);
  let candidates = $state<MbArtistCandidateView[]>([]);
  let candidatesLoading = $state(false);

  const CONFIDENCE_LABELS: Record<string, string> = {
    confirmed: "Confirmed",
    probable: "Probable",
    unresolved: "Unidentified",
  };

  function lastPolledLabel(artist: TrackedArtist): string {
    if (!artist.last_polled_at) return "never polled";
    return `polled ${new Date(artist.last_polled_at).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    })}`;
  }

  async function setFollowState(
    artist: TrackedArtist,
    followState: ArtistFollowState,
  ): Promise<void> {
    artistStatusMessage = "Saving…";
    try {
      await api.setArtistFollowState(artist.id, followState);
      if (followState === "muted") {
        // Muted artists drop out of the tracked list entirely.
        trackedArtists = trackedArtists.filter((row) => row.id !== artist.id);
        artistStatusMessage = `Muted ${artist.name}.`;
        return;
      }
      trackedArtists = trackedArtists.map((row) =>
        row.id === artist.id ? { ...row, follow_state: followState } : row,
      );
      artistStatusMessage = "Saved.";
    } catch {
      artistStatusMessage = "Failed to save.";
    }
  }

  /**
   * An unidentified artist is one the resolver refused to guess at, so the
   * candidates go to the only person who can tell them apart.
   */
  async function showCandidates(artist: TrackedArtist): Promise<void> {
    if (candidatesFor === artist.id) {
      candidatesFor = null;
      return;
    }
    candidatesFor = artist.id;
    candidates = [];
    candidatesLoading = true;
    try {
      candidates = await api.getArtistMbidCandidates(artist.id);
    } catch {
      artistStatusMessage = "Couldn't reach MusicBrainz.";
      candidatesFor = null;
    } finally {
      candidatesLoading = false;
    }
  }

  async function confirmMbid(artist: TrackedArtist, mbid: string): Promise<void> {
    try {
      await api.setArtistMbid(artist.id, mbid);
      trackedArtists = trackedArtists.map((row) =>
        row.id === artist.id
          ? { ...row, musicbrainz_artist_id: mbid, mbid_confidence: "confirmed" }
          : row,
      );
      candidatesFor = null;
      artistStatusMessage = `${artist.name} identified. They'll be polled on the next sweep.`;
    } catch {
      artistStatusMessage = "Failed to save.";
    }
  }

  async function checkNow(artist: TrackedArtist): Promise<void> {
    artistStatusMessage = `Checking ${artist.name}…`;
    try {
      const outcome = await api.pollArtistNow(artist.id);
      artistStatusMessage =
        outcome.status === "polled"
          ? `Checked ${artist.name}: ${outcome.alertsRaised} new alert(s).`
          : `Couldn't check ${artist.name} (${outcome.status}).`;
      trackedArtists = await api.listTrackedArtists();
    } catch {
      artistStatusMessage = "Check failed.";
    }
  }

  function candidateSummary(candidate: MbArtistCandidateView): string {
    const parts = [candidate.disambiguation, candidate.country, candidate.type].filter(Boolean);
    const span = [candidate.lifeSpanBegin, candidate.lifeSpanEnd].filter(Boolean).join("–");
    if (span) parts.push(span);
    return parts.join(" · ");
  }
</script>

<svelte:head>
  <title>Settings — On The Beach</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="main main--scroll">
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

    <section class="settings__section" id="artist-watch-settings">
      <h2 class="settings__heading">New release alerts</h2>
      <p class="settings__hint">
        Watch MusicBrainz for records by artists you've listened to. <a href="/new-releases"
          >Open the queue</a
        >
        or subscribe to <a href="/feed/new-releases.rss">the RSS feed</a>.
      </p>
      <form id="artist-watch-form" class="settings__options">
        <label class="settings__option">
          <input
            type="checkbox"
            name="artist-watch-enabled"
            checked={watch.enabled}
            onchange={(event) =>
              saveWatch({ artistWatchEnabled: event.currentTarget.checked })}
          />
          <span>Check MusicBrainz daily for new releases</span>
        </label>
        <label class="settings__option">
          <input
            type="checkbox"
            name="schedule-announced"
            checked={watch.scheduleAnnouncedReleases}
            onchange={(event) =>
              saveWatch({ scheduleAnnouncedReleases: event.currentTarget.checked })}
          />
          <span>Schedule unreleased records to arrive in To Listen on release day</span>
        </label>
        <label class="settings__option">
          <input
            type="checkbox"
            name="catalogue-additions"
            checked={watch.alertOnCatalogueAdditions}
            onchange={(event) =>
              saveWatch({ alertOnCatalogueAdditions: event.currentTarget.checked })}
          />
          <span>Also alert on older records newly added to MusicBrainz</span>
        </label>
        <label class="settings__option settings__option--field">
          <span>Alert on releases from the last</span>
          <input
            type="number"
            class="settings__number"
            name="freshness-months"
            min="0"
            max="120"
            value={watch.freshnessMonths}
            onchange={(event) =>
              saveWatch({ alertFreshnessMonths: Number(event.currentTarget.value) })}
          />
          <span>months</span>
        </label>
        <div class="settings__option settings__option--field settings__option--stars">
          <span>Only watch artists with a release rated at least</span>
          <StarRating
            rating={watch.minArtistRating > 0 ? watch.minArtistRating : null}
            label="Minimum artist rating"
            onRate={(next) => saveWatch({ alertMinArtistRating: next ?? 0 })}
          />
          <span class="settings__value" data-min-artist-rating={watch.minArtistRating}>
            {minArtistRatingLabel}
          </span>
        </div>
      </form>
      <p id="artist-watch-status" class="settings__status" role="status" aria-live="polite">
        {watchStatusMessage}
      </p>
    </section>

    <section class="settings__section" id="tracked-artists-settings">
      <h2 class="settings__heading">Tracked artists</h2>
      <p class="settings__hint">
        Artists you've listened to, and whose releases are watched. Muting one stops its alerts for
        good. An artist marked <em>Unidentified</em> is one MusicBrainz couldn't pin down without
        guessing — pick the right one and it starts being polled.
      </p>

      {#if trackedArtists.length === 0}
        <p class="settings__hint">
          Nothing tracked yet. Mark a record as listened and its artist joins the list.
        </p>
      {:else}
        <ul class="artist-list" id="tracked-artists-list">
          {#each trackedArtists as artist (artist.id)}
            <li class="artist-list__row">
              <div class="artist-list__main">
                <span class="artist-list__name">{artist.name}</span>
                <span class="artist-list__meta">
                  <span
                    class="settings__badge"
                    class:settings__badge--ok={artist.mbid_confidence === "confirmed"}
                    class:settings__badge--warn={artist.mbid_confidence === "probable"}
                    class:settings__badge--off={artist.mbid_confidence === "unresolved"}
                  >
                    {CONFIDENCE_LABELS[artist.mbid_confidence]}
                  </span>
                  <span class="artist-list__polled">{lastPolledLabel(artist)}</span>
                </span>
              </div>
              <div class="artist-list__actions">
                {#if artist.mbid_confidence === "unresolved"}
                  <button
                    type="button"
                    class="btn"
                    data-artist-action="identify"
                    onclick={() => showCandidates(artist)}>Identify…</button
                  >
                {:else}
                  <button
                    type="button"
                    class="btn"
                    data-artist-action="check"
                    onclick={() => checkNow(artist)}>Check now</button
                  >
                {/if}
                <button
                  type="button"
                  class="btn btn--ghost"
                  data-artist-action="mute"
                  onclick={() => setFollowState(artist, "muted")}>Mute</button
                >
              </div>

              {#if candidatesFor === artist.id}
                <div class="artist-list__candidates">
                  {#if candidatesLoading}
                    <p class="settings__hint">Asking MusicBrainz…</p>
                  {:else if candidates.length === 0}
                    <p class="settings__hint">No candidates found.</p>
                  {:else}
                    {#each candidates as candidate (candidate.id)}
                      <button
                        type="button"
                        class="artist-list__candidate"
                        onclick={() => confirmMbid(artist, candidate.id)}
                      >
                        <span class="artist-list__candidate-name">{candidate.name}</span>
                        <span class="artist-list__candidate-detail">
                          {candidateSummary(candidate) || "no further detail"}
                        </span>
                      </button>
                    {/each}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      <p id="tracked-artists-status" class="settings__status" role="status" aria-live="polite">
        {artistStatusMessage}
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
            <p class="settings__hint">
              Signed in to Apple Music. If playback has started failing, reauthorise to replace an
              expired sign-in.
            </p>
            <div class="settings__buttons">
              <button
                type="button"
                class="btn"
                id="apple-music-reauthorise"
                disabled={appleMusicBusy}
                onclick={reauthoriseAppleMusic}>Reauthorise</button
              >
              <button
                type="button"
                class="btn"
                id="apple-music-signout"
                disabled={appleMusicBusy}
                onclick={signOutAppleMusic}>Sign out</button
              >
            </div>
          {:else}
            <div class="settings__buttons">
              <button
                type="button"
                class="btn btn--primary"
                id="apple-music-connect"
                disabled={appleMusicBusy}
                onclick={signInAppleMusic}
                onmouseenter={connectAppleMusic}>Sign in to Apple Music</button
              >
            </div>
            {#if musickit.error}
              <p class="settings__status" role="status">{musickit.error}</p>
            {/if}
          {/if}
          <p id="apple-music-status" class="settings__status" role="status" aria-live="polite">
            {appleMusicStatusMessage}
          </p>
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
