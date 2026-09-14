<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import type {
    ReleaseAlert,
    ReleaseAlertDetailResult,
    ReleaseAlertReason,
  } from "../../../domain/types";

  let { data } = $props();

  // svelte-ignore state_referenced_locally
  let alerts = $state<ReleaseAlert[]>(data.alerts);
  let statusMessage = $state("");
  let busyId = $state<number | null>(null);

  // Only one card is open at a time: the queue is a list to work through, and
  // two open panels push the rest of it off the screen.
  let openId = $state<number | null>(null);
  // Kept per alert so re-opening a card doesn't ask MusicBrainz a second time.
  let details = $state<Record<number, ReleaseAlertDetailResult>>({});
  let loadingDetailId = $state<number | null>(null);

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
  let coverFailed = $state<Record<number, boolean>>({});

  /** MusicBrainz dates are often partial; show exactly what's known. */
  function releaseDateLabel(alert: ReleaseAlert): string {
    return dateLabel(alert.first_release_date) ?? "Date unknown";
  }

  function dateLabel(date: string | null): string | null {
    if (!date) return null;
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

  /** Track durations read as times; a whole record reads as minutes. */
  function trackLength(ms: number | null): string {
    if (ms === null) return "";
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
  }

  function totalLength(ms: number | null): string | null {
    if (ms === null) return null;
    const minutes = Math.round(ms / 60000);
    return `${minutes} min`;
  }

  function spottedLabel(alert: ReleaseAlert): string {
    return new Date(alert.created_at).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  onMount(() => {
    // Visiting the queue is enough to clear the badge — triaging each card is
    // a separate decision.
    if (data.pendingCount > 0) {
      void api.markReleaseAlertsSeen().catch(() => {});
    }
  });

  /**
   * Open a card, fetching the MusicBrainz detail the first time. The queue
   * itself never fetches it: MusicBrainz is paced at roughly one request a
   * second, so a page of cards would be a minute of lookups nobody asked for.
   */
  async function toggleDetails(alert: ReleaseAlert): Promise<void> {
    if (openId === alert.id) {
      openId = null;
      return;
    }

    openId = alert.id;
    if (details[alert.id] || loadingDetailId === alert.id) return;

    loadingDetailId = alert.id;
    try {
      details = { ...details, [alert.id]: await api.getReleaseAlertDetail(alert.id) };
    } catch {
      details = {
        ...details,
        [alert.id]: { detail: null, error: "Couldn't load the details." },
      };
    } finally {
      if (loadingDetailId === alert.id) loadingDetailId = null;
    }
  }

  function removeAlert(id: number): void {
    alerts = alerts.filter((alert) => alert.id !== id);
    if (openId === id) openId = null;
  }

  async function add(alert: ReleaseAlert): Promise<void> {
    busyId = alert.id;
    try {
      const result = await api.addReleaseAlert(alert.id);

      // A release with nowhere to listen to it isn't filed. The card stays in
      // the queue: the streaming services routinely catch up days later.
      if (!result.added) {
        statusMessage = `Not added — ${result.message}`;
        return;
      }

      removeAlert(alert.id);
      const found = result.link ? ` Link from ${result.link.foundBy}.` : "";
      statusMessage = result.remindAt
        ? // Nothing carries a record that isn't out, so a scheduled release is
          // filed unchecked and asked about again on the day.
          `Added “${alert.title}” — scheduled for ${releaseDateLabel(alert)}.${
            found || " Links are checked on release day."
          }`
        : `Added “${alert.title}” to To Listen.${found}`;
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
      const cleared = alerts.filter((row) => row.artist_id === alert.artist_id);
      alerts = alerts.filter((row) => row.artist_id !== alert.artist_id);
      if (openId !== null && cleared.some((row) => row.id === openId)) openId = null;
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

<main class="main main--scroll">
  <div class="alerts">
    <a href="/" class="btn btn--ghost alerts__back">◄ Back</a>

    <section class="alerts__header">
      <h2 class="alerts__heading">📻 New Releases</h2>
      <p class="alerts__hint">
        Records by artists you've listened to that we haven't seen before. Click a card for the
        tracklist and where to hear it. Adding one files it in the New Releases stack, as long as
        there's a link to it; anything not out yet is scheduled and checked again on release day.
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
          {@const open = openId === alert.id}
          {@const result = details[alert.id]}
          <li
            class="alert-card"
            class:alert-card--busy={busyId === alert.id}
            class:alert-card--open={open}
          >
            <button
              type="button"
              class="alert-card__summary"
              data-alert-action="details"
              aria-expanded={open}
              aria-controls="alert-details-{alert.id}"
              onclick={() => toggleDetails(alert)}
            >
              <span class="alert-card__artwork">
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
              </span>

              <span class="alert-card__main">
                <span class="alert-card__artist">{alert.artist_name}</span>
                <span class="alert-card__title">{alert.title}</span>
                <span class="alert-card__meta">
                  <span class="badge badge--reason badge--{alert.reason}">
                    {REASON_LABELS[alert.reason]}
                  </span>
                  <span class="alert-card__type">{typeLabel(alert)}</span>
                  <span class="alert-card__date">{releaseDateLabel(alert)}</span>
                </span>
              </span>

              <span class="alert-card__disclosure" aria-hidden="true">{open ? "▲" : "▼"}</span>
            </button>

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

            {#if open}
              <div class="alert-details" id="alert-details-{alert.id}">
                {#if loadingDetailId === alert.id}
                  <p class="alert-details__note">Looking it up on MusicBrainz…</p>
                {:else if result?.detail}
                  {@const detail = result.detail}
                  <div class="alert-details__top">
                    <div class="alert-details__cover">
                      {#if !coverFailed[alert.id]}
                        <img
                          src={detail.coverArtUrl}
                          alt="Cover of {alert.title}"
                          loading="lazy"
                          onerror={() => (coverFailed = { ...coverFailed, [alert.id]: true })}
                        />
                      {:else}
                        <span class="alert-details__cover-placeholder" aria-hidden="true">♫</span>
                      {/if}
                    </div>

                    <dl class="alert-details__facts">
                      {#if detail.artistCredit && detail.artistCredit !== alert.artist_name}
                        <dt>Credited</dt>
                        <dd>{detail.artistCredit}</dd>
                      {/if}
                      {#if detail.disambiguation}
                        <dt>Which one</dt>
                        <dd>{detail.disambiguation}</dd>
                      {/if}
                      <dt>Type</dt>
                      <dd>
                        {[detail.primaryType, ...detail.secondaryTypes].filter(Boolean).join(" · ")
                          || "Release"}
                      </dd>
                      <dt>Released</dt>
                      <dd>{dateLabel(detail.firstReleaseDate) ?? "Date unknown"}</dd>
                      {#if detail.trackCount !== null}
                        <dt>Length</dt>
                        <dd>
                          {detail.trackCount}
                          {detail.trackCount === 1 ? "track" : "tracks"}{totalLength(
                            detail.totalLengthMs,
                          )
                            ? ` · ${totalLength(detail.totalLengthMs)}`
                            : ""}
                        </dd>
                      {/if}
                      {#if detail.label}
                        <dt>Label</dt>
                        <dd>{detail.label}{detail.country ? ` (${detail.country})` : ""}</dd>
                      {/if}
                      {#if detail.format}
                        <dt>Format</dt>
                        <dd>{detail.format}</dd>
                      {/if}
                      <dt>Spotted</dt>
                      <dd>{spottedLabel(alert)}</dd>
                    </dl>
                  </div>

                  {#if detail.tracks.length > 0}
                    <div class="alert-details__section">
                      <h3 class="alert-details__subheading">
                        Tracklist
                        {#if detail.releaseTitle}
                          <span class="alert-details__edition">
                            — {detail.releaseTitle}{detail.releaseDate
                              ? `, ${dateLabel(detail.releaseDate)}`
                              : ""}
                          </span>
                        {/if}
                      </h3>
                      <ol class="alert-details__tracks">
                        {#each detail.tracks as track, index (index)}
                          <li class="alert-details__track">
                            <span class="alert-details__track-number">{track.number ?? index + 1}</span>
                            <!-- Long titles are truncated to keep the row
                                 readable; the full one is a hover away. -->
                            <span class="alert-details__track-title" title={track.title}
                              >{track.title}</span
                            >
                            <span class="alert-details__track-length">{trackLength(track.lengthMs)}</span>
                          </li>
                        {/each}
                      </ol>
                    </div>
                  {/if}

                  {#if detail.links.length > 0}
                    <div class="alert-details__section">
                      <h3 class="alert-details__subheading">Where to hear it</h3>
                      <ul class="alert-details__links">
                        {#each detail.links as link (link.url)}
                          <li>
                            <a
                              class="alert-details__link"
                              class:alert-details__link--listen={link.listenable}
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer">{link.label}</a
                            >
                          </li>
                        {/each}
                      </ul>
                    </div>
                  {:else}
                    <p class="alert-details__note">
                      No external links on MusicBrainz yet — which is why adding it may be refused
                      until a service carries it.
                    </p>
                  {/if}

                  <p class="alert-details__sources">
                    <a href={detail.musicbrainzUrl} target="_blank" rel="noopener noreferrer"
                      >MusicBrainz release</a
                    >
                    {#if detail.artistMusicbrainzUrl}
                      ·
                      <a
                        href={detail.artistMusicbrainzUrl}
                        target="_blank"
                        rel="noopener noreferrer">MusicBrainz artist</a
                      >
                    {/if}
                  </p>
                {:else}
                  <p class="alert-details__note">
                    {result?.error ?? "Couldn't load the details."}
                  </p>
                  <dl class="alert-details__facts">
                    <dt>Type</dt>
                    <dd>{typeLabel(alert)}</dd>
                    <dt>Released</dt>
                    <dd>{releaseDateLabel(alert)}</dd>
                    <dt>Spotted</dt>
                    <dd>{spottedLabel(alert)}</dd>
                  </dl>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</main>
