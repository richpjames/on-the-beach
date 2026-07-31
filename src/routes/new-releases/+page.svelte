<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import type { ReleaseAlert, ReleaseAlertReason } from "../../types";

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  let alerts = $state<ReleaseAlert[]>(data.alerts);
  let statusMessage = $state("");
  let busyId = $state<number | null>(null);

  const REASON_LABELS: Record<ReleaseAlertReason, string> = {
    announced: "Announced",
    "new-release": "New release",
    "catalogue-addition": "Added to MusicBrainz",
  };

  // Cover Art Archive keys artwork by release-group MBID, the same wiring the
  // suggestion prompt already uses.
  function artworkUrl(alert: ReleaseAlert): string {
    return `https://coverartarchive.org/release-group/${encodeURIComponent(alert.mb_release_group_id)}/front-250`;
  }

  let artworkFailed = $state<Record<number, boolean>>({});

  /** MusicBrainz dates are often partial; show exactly what's known. */
  function releaseDateLabel(alert: ReleaseAlert): string {
    const date = alert.first_release_date;
    if (!date) return "Date unknown";
    if (date.length === 4) return date;
    if (date.length === 7) {
      const [year, month] = date.split("-");
      return `${monthName(Number(month))} ${year}`;
    }
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }

  function monthName(month: number): string {
    return [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ][month - 1] ?? "";
  }

  function typeLabel(alert: ReleaseAlert): string {
    return [alert.primary_type, ...alert.secondary_types].filter(Boolean).join(" · ") || "Release";
  }

  onMount(() => {
    // Visiting the queue is enough to clear the badge — triaging each card is
    // a separate decision.
    if (data.pendingCount > 0) {
      void api.markReleaseAlertsSeen().catch(() => {});
    }
  });

  function removeAlert(id: number): void {
    alerts = alerts.filter((alert) => alert.id !== id);
  }

  async function add(alert: ReleaseAlert): Promise<void> {
    busyId = alert.id;
    try {
      const result = await api.addReleaseAlert(alert.id);
      removeAlert(alert.id);
      statusMessage = result.remindAt
        ? `Added “${alert.title}” — scheduled for ${releaseDateLabel(alert)}.`
        : `Added “${alert.title}” to To Listen.`;
    } catch {
      statusMessage = "Couldn't add that release.";
    } finally {
      busyId = null;
    }
  }

  async function dismiss(alert: ReleaseAlert): Promise<void> {
    busyId = alert.id;
    try {
      await api.dismissReleaseAlert(alert.id);
      removeAlert(alert.id);
      statusMessage = `Dismissed “${alert.title}”.`;
    } catch {
      statusMessage = "Couldn't dismiss that release.";
    } finally {
      busyId = null;
    }
  }

  async function mute(alert: ReleaseAlert): Promise<void> {
    busyId = alert.id;
    try {
      await api.setArtistFollowState(alert.artist_id, "muted");
      // Muting clears every queued alert for that artist, not just this card.
      alerts = alerts.filter((row) => row.artist_id !== alert.artist_id);
      statusMessage = `Muted ${alert.artist_name}. No more alerts for them.`;
    } catch {
      statusMessage = "Couldn't mute that artist.";
    } finally {
      busyId = null;
    }
  }
</script>

<svelte:head>
  <title>New Releases — On The Beach</title>
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="main">
  <div class="alerts">
    <a href="/" class="btn btn--ghost alerts__back">◄ Back</a>

    <section class="alerts__header">
      <h2 class="alerts__heading">📻 New Releases</h2>
      <p class="alerts__hint">
        Records by artists you've listened to that we haven't seen before. Adding one files it in
        the New Releases stack; anything not out yet is scheduled to arrive in To Listen on release
        day.
      </p>
      <a class="alerts__feed-link" href="/feed/new-releases.rss">📡 Subscribe by RSS</a>
    </section>

    <p id="alerts-status" class="settings__status" role="status" aria-live="polite">
      {statusMessage}
    </p>

    {#if alerts.length === 0}
      <div class="alerts__empty" id="alerts-empty">
        <p>Nothing new right now.</p>
        <p class="alerts__hint">
          The watcher checks MusicBrainz daily. Artists are tracked once you've marked something of
          theirs as listened.
        </p>
      </div>
    {:else}
      <ul class="alerts__list" id="alerts-list">
        {#each alerts as alert (alert.id)}
          <li class="alert-card" class:alert-card--busy={busyId === alert.id}>
            <div class="alert-card__artwork">
              {#if !artworkFailed[alert.id]}
                <img
                  src={artworkUrl(alert)}
                  alt=""
                  loading="lazy"
                  onerror={() => (artworkFailed = { ...artworkFailed, [alert.id]: true })}
                />
              {:else}
                <span class="alert-card__artwork-placeholder" aria-hidden="true">♫</span>
              {/if}
            </div>

            <div class="alert-card__main">
              <span class="alert-card__artist">{alert.artist_name}</span>
              <span class="alert-card__title">{alert.title}</span>
              <span class="alert-card__meta">
                <span class="badge badge--reason badge--{alert.reason}">
                  {REASON_LABELS[alert.reason]}
                </span>
                <span class="alert-card__type">{typeLabel(alert)}</span>
                <span class="alert-card__date">{releaseDateLabel(alert)}</span>
              </span>
            </div>

            <div class="alert-card__actions">
              <button
                type="button"
                class="btn btn--primary"
                data-alert-action="add"
                disabled={busyId === alert.id}
                onclick={() => add(alert)}>Add</button
              >
              <button
                type="button"
                class="btn"
                data-alert-action="dismiss"
                disabled={busyId === alert.id}
                onclick={() => dismiss(alert)}>Dismiss</button
              >
              <button
                type="button"
                class="btn btn--ghost"
                data-alert-action="mute"
                disabled={busyId === alert.id}
                onclick={() => mute(alert)}>Mute artist</button
              >
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</main>
