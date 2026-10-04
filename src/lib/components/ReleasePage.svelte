<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { onMount } from "svelte";
  import type { PageData } from "../../routes/r/[id]/$types";
  import type { ListenEmbed } from "../../routes/r/[id]/+page.server";
  import type { ItemOrigin, ItemSuggestion, ListenStatus, SourceName } from "../../../domain/types";
  import { parseAppleMusicCatalogUrl, type AppleMusicResource } from "../../../domain/apple-music";
  import { api, apiFetch } from "../api";
  import { encodeImageFile } from "../encode-image";
  import { player } from "../player.svelte";
  import ServiceIcon from "./ServiceIcon.svelte";
  import StarRating from "./StarRating.svelte";
  import SuggestionPickerModal from "./SuggestionPickerModal.svelte";
  import { linkService, sourceDisplayName } from "../../ui/logic/link-service";

  // The page wraps this component in {#key item.id}, so all state below is
  // (re)initialised per release — the same lifecycle as the old full-page SSR.
  let { data }: { data: PageData } = $props();

  // svelte-ignore state_referenced_locally
  const item = data.item;

  // ── Status & reminder ──────────────────────────────────────────────────────
  let currentListenStatus = $state<string>(item.listen_status);
  let currentRemindAt = $state<string | null>(
    item.remind_at ? new Date(item.remind_at as unknown as string).toISOString() : null,
  );

  const displayedStatus = $derived(currentRemindAt ? "scheduled" : currentListenStatus);

  function defaultReminderDate(): string {
    if (item.remind_at) {
      return new Date(item.remind_at as unknown as string).toISOString().slice(0, 10);
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyy = tomorrow.getFullYear();
    const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const dd = String(tomorrow.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  let remindAtValue = $state(defaultReminderDate());
  let reminderSaved = $state(false);

  async function setReminder(): Promise<void> {
    if (!remindAtValue) return;
    try {
      await api.setReminder(item.id, remindAtValue);
    } catch {
      alert("Failed to set reminder");
      return;
    }
    currentRemindAt = new Date(remindAtValue).toISOString();
    reminderSaved = true;
    setTimeout(() => {
      reminderSaved = false;
    }, 2000);
  }

  async function clearReminder(): Promise<void> {
    try {
      await api.clearReminder(item.id);
    } catch {
      alert("Failed to clear reminder");
      return;
    }
    currentRemindAt = null;
    remindAtValue = "";
  }

  // ── Suggestion picker ──────────────────────────────────────────────────────
  let suggestions = $state<ItemSuggestion[]>([]);
  let suggestionSourceId = $state<number | null>(null);

  async function onStatusChange(event: Event): Promise<void> {
    const newStatus = (event.currentTarget as HTMLSelectElement).value;
    if (newStatus === "scheduled") return;
    const wasScheduled = currentRemindAt !== null;
    let result: Awaited<ReturnType<typeof api.updateListenStatus>>;
    try {
      result = await api.updateListenStatus(item.id, newStatus as ListenStatus);
    } catch {
      alert("Failed to update status.");
      return;
    }
    currentListenStatus = newStatus;
    if (wasScheduled) {
      await clearReminder();
    }
    if (newStatus === "listened" && result?.suggestions.length) {
      suggestions = result.suggestions;
      suggestionSourceId = item.id;
    }
  }

  // ── Listen here ────────────────────────────────────────────────────────────
  // "listen here" plays the release in the internal player. On touch devices
  // the floating player window doesn't suit the screen, so the button (and the
  // clickable artwork) don't render at all — the external links below are all
  // a phone gets. Set after mount (not at init) to keep SSR and hydration in
  // sync.
  let coarsePointer = $state(false);
  onMount(() => {
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  });

  function listen(embed: ListenEmbed): void {
    player.load(embed.src, item.title, item.artist_name ?? "", embed.playerType, item.id);
  }

  // The one source that wins the "listen here" button, by priority: the lookup
  // streaming service when it can genuinely play in-app (Apple Music full-track
  // via MusicKit — the store's own link first, then the on-view lookup), then
  // the item's full-length embeds, and the 30-second Apple Music preview only
  // when nothing better exists. Nothing playable at all means no button.
  type HereTarget = {
    key: string;
    service: string;
    href?: string;
    src?: string;
    playerType?: "audio" | "video";
    amMode?: string;
    play: () => void;
  };

  const hereTarget = $derived.by<HereTarget | null>(() => {
    const playAppleMusic = (kind: AppleMusicResource["kind"], id: string): void => {
      player.loadAppleMusic(kind, id, item.title, item.artist_name ?? "", item.id);
    };

    const appleMusic = data.appleMusicListen;
    if (appleMusic && appleMusic.mode === "musickit" && appleMusic.resource) {
      const resource = appleMusic.resource;
      return {
        key: "apple-music",
        service: "Apple Music",
        href: appleMusic.href,
        amMode: "musickit",
        play: () => playAppleMusic(resource.kind, resource.id),
      };
    }
    const lookup = lookupLink;
    if (lookup && lookupIsPlayableAppleMusic) {
      const resource = parseAppleMusicCatalogUrl(lookup.url)!;
      return {
        key: "apple-music-lookup",
        service: "Apple Music",
        href: lookup.url,
        amMode: "musickit",
        play: () => playAppleMusic(resource.kind, resource.id),
      };
    }
    const bandcamp = data.bandcampEmbed;
    if (bandcamp) {
      return {
        key: "bandcamp",
        service: "Bandcamp",
        href: bandcamp.href ?? undefined,
        src: bandcamp.src,
        playerType: bandcamp.playerType,
        play: () => listen(bandcamp),
      };
    }
    const youtube = data.youtubeEmbed;
    if (youtube) {
      return {
        key: "youtube",
        service: "YouTube",
        href: youtube.href ?? undefined,
        src: youtube.src,
        playerType: youtube.playerType,
        play: () => listen(youtube),
      };
    }
    const soundcloud = data.soundcloudEmbed;
    if (soundcloud) {
      return {
        key: "soundcloud",
        service: "SoundCloud",
        href: soundcloud.href ?? undefined,
        src: soundcloud.src,
        playerType: soundcloud.playerType,
        play: () => listen(soundcloud),
      };
    }
    if (appleMusic?.src) {
      return {
        key: "apple-music-preview",
        service: "Apple Music",
        href: appleMusic.href,
        src: appleMusic.src,
        playerType: "audio",
        amMode: "preview",
        play: () => listen({ src: appleMusic.src!, href: appleMusic.href, playerType: "audio" }),
      };
    }
    return null;
  });

  // ── Edit mode ──────────────────────────────────────────────────────────────
  let editMode = $state(false);
  let editTitle = $state(item.title);
  let editArtist = $state(item.artist_name ?? "");
  let editYear = $state(item.year != null ? String(item.year) : "");
  let editLabel = $state(item.label ?? "");
  let editCountry = $state(item.country ?? "");
  let editGenre = $state(item.genre ?? "");
  let editCatalogue = $state(item.catalogue_number ?? "");
  let editNotes = $state(item.notes ?? "");
  let editArtworkUrl = $state(item.artwork_url ?? "");

  // ── Inline notes editing ─────────────────────────────────────────────────
  // A dedicated add/edit-notes control that lives with the notes in view mode,
  // so notes can be changed without opening the full edit form.
  let currentNotes = $state<string | null>(item.notes ?? null);
  let notesState = $state<"idle" | "editing" | "saving">("idle");
  let notesDraft = $state("");

  function startEditNotes(): void {
    notesDraft = currentNotes ?? "";
    notesState = "editing";
  }

  function cancelEditNotes(): void {
    notesState = "idle";
  }

  async function saveNotes(): Promise<void> {
    const trimmed = notesDraft.trim();
    notesState = "saving";
    const res = await apiFetch(`/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: trimmed || null }),
    });
    if (!res.ok) {
      alert("Failed to save notes.");
      notesState = "editing";
      return;
    }
    currentNotes = trimmed || null;
    // Keep the full edit form in sync in case it's opened afterwards.
    editNotes = trimmed;
    notesState = "idle";
  }

  async function saveChanges(): Promise<void> {
    const body = {
      title: editTitle.trim() || undefined,
      artistName: editArtist.trim() || undefined,
      year: editYear ? Number(editYear) : null,
      label: editLabel.trim() || null,
      country: editCountry.trim() || null,
      genre: editGenre.trim() || null,
      catalogueNumber: editCatalogue.trim() || null,
      notes: editNotes.trim() || null,
      artworkUrl: editArtworkUrl.trim() || null,
    };
    const res = await apiFetch(`/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      window.location.reload();
    } else {
      alert("Failed to save changes.");
    }
  }

  async function deleteItem(): Promise<void> {
    if (!confirm("Delete this release?")) return;
    const ok = await api.deleteMusicItem(item.id).catch(() => false);
    if (ok) await goto(data.backHref);
  }

  // ── Artwork upload ─────────────────────────────────────────────────────────
  let artworkFileInput: HTMLInputElement | undefined = $state();
  let artworkUploading = $state(false);

  async function onArtworkFileChange(): Promise<void> {
    const file = artworkFileInput?.files?.[0];
    if (!file || !artworkFileInput) return;

    artworkUploading = true;
    const previousUrl = editArtworkUrl;

    try {
      const base64 = await encodeImageFile(file);
      const { artworkUrl } = await api.uploadReleaseImage(base64);
      editArtworkUrl = artworkUrl;
    } catch (err) {
      editArtworkUrl = previousUrl;
      alert("Failed to upload image.");
      console.error(err);
    } finally {
      artworkUploading = false;
      artworkFileInput.value = "";
    }
  }

  // ── Stacks ─────────────────────────────────────────────────────────────────
  let allStacks = $state<Array<{ id: number; name: string }>>([...item.stacks]);
  let assignedIds = $state<Set<number>>(new Set(item.stacks.map((s) => s.id)));
  let stackQuery = $state("");

  const assignedStacks = $derived(allStacks.filter((s) => assignedIds.has(s.id)));
  const visibleStacks = $derived(
    stackQuery.trim()
      ? allStacks.filter((s) => s.name.toLowerCase().includes(stackQuery.trim().toLowerCase()))
      : allStacks,
  );

  function sortStacks<T extends { name: string }>(stacks: T[]): T[] {
    return stacks.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function toggleStack(stackId: number, add: boolean): Promise<void> {
    try {
      if (add) {
        await api.addItemToStack(item.id, stackId);
        assignedIds = new Set([...assignedIds, stackId]);
      } else {
        await api.removeItemFromStack(item.id, stackId);
        const next = new Set(assignedIds);
        next.delete(stackId);
        assignedIds = next;
      }
    } catch {
      // leave state unchanged on failure
    }
  }

  async function onNewStackKeydown(event: KeyboardEvent): Promise<void> {
    if (event.key !== "Enter") return;
    const name = stackQuery.trim();
    if (!name) return;
    const stack = await api.createStack(name);
    stackQuery = "";
    allStacks = sortStacks([...allStacks, stack]);
    await toggleStack(stack.id, true);
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  let itemLinks = $state([...item.links]);
  let allSources = $state<Array<{ displayName: string }>>([]);
  let sourceQuery = $state("");
  let sourceDropdownOpen = $state(false);
  let linkUrl = $state("");

  const sourceMatches = $derived(
    sourceQuery.trim()
      ? allSources.filter((s) =>
          s.displayName.toLowerCase().includes(sourceQuery.trim().toLowerCase()),
        )
      : allSources,
  );

  // The play buttons and the source link are built server-side from the
  // *primary* link, so editing the link list has to re-run the page load for
  // view mode to catch up. Re-running it (rather than reloading the window)
  // keeps whatever else is half-typed in the edit fields.
  async function refreshListenOptions(): Promise<void> {
    await invalidateAll();
  }

  async function removeLink(linkId: number): Promise<void> {
    const res = await apiFetch(`/api/music-items/${item.id}/links/${linkId}`, { method: "DELETE" });
    if (res.ok) {
      itemLinks = itemLinks.filter((l) => l.id !== linkId);
      await refreshListenOptions();
    }
  }

  async function addLink(): Promise<void> {
    const sourceName = sourceQuery.trim();
    const url = linkUrl.trim();
    if (!sourceName || !url) return;
    const res = await apiFetch(`/api/music-items/${item.id}/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceName, url }),
    });
    if (res.ok) {
      // A release with no picture of its own takes one from the page it was
      // just linked to. The edit field was filled in before that happened, so
      // without this saving the form afterwards would write its emptiness back
      // over the cover the link supplied.
      const { artwork_url: artworkUrl, ...link } = await res.json();
      if (artworkUrl && !editArtworkUrl.trim()) editArtworkUrl = artworkUrl;
      itemLinks = [...itemLinks, link];
      sourceQuery = "";
      linkUrl = "";
      await refreshListenOptions();
    } else {
      const err = await res.json().catch(() => ({}) as { error?: string });
      alert(err.error || "Failed to add link");
    }
  }

  const secondaryLinks = $derived(itemLinks.filter((l) => !l.is_primary));

  // ── Streaming-service secondary link lookup ────────────────────────────────
  // Any item not already on the active streaming service is eligible for a
  // secondary link on it. Usually a no-op for new items (the eager hook has
  // already populated it); this is the on-view fallback for older items.
  // The server enforces all skip rules; we only avoid an obviously redundant
  // request when the active service's link is already shown.
  let lookupLink = $state<{ url: string; label: string } | null>(null);

  const lookupIsPlayableAppleMusic = $derived(
    !!lookupLink && data.appleMusicConfigured && parseAppleMusicCatalogUrl(lookupLink.url) !== null,
  );

  onMount(() => {
    api
      .listStacks()
      .then((stacks) => {
        allStacks = sortStacks([...stacks]);
      })
      .catch(() => {});
    fetch("/api/release/sources")
      .then((res) => (res.ok ? res.json() : []))
      .then((sources) => {
        allSources = sources;
      })
      .catch(() => {});

    const hasActiveServiceSecondary = item.links.some(
      (l) => l.source_name === data.lookupService && !l.is_primary,
    );
    if (!hasActiveServiceSecondary) {
      apiFetch(`/api/release/secondary-link-lookup/${item.id}`, { method: "POST" })
        .then((r) => (r.ok ? r.json() : null))
        .then((lookup) => {
          if (lookup?.url) {
            lookupLink = { url: lookup.url, label: lookup.serviceDisplayName || "Listen" };
          }
        })
        .catch(() => {});
    }
  });

  const metaFields = $derived(
    [item.year ? String(item.year) : null, item.country, item.genre].filter(Boolean).join(" · "),
  );

  // The record label belongs with the catalogue number, not folded into the
  // run-on above: "Bronze" sandwiched between a year and a country reads as
  // neither, whereas "Bronze · BRON 511" reads as the imprint and the number
  // printed on the sleeve. The RSS feed (server/routes/rss.ts) already emits
  // the pair as one line for the same reason.
  const labelLine = $derived([item.label, item.catalogue_number].filter(Boolean).join(" · "));

  // How the release entered the list, stamped by the server on the way in.
  // Shown as a line of provenance under the label; hidden for `unknown` — the
  // default on rows that predate the stamp — because "added somehow" says
  // nothing worth a line.
  const originLabels: Record<ItemOrigin, string> = {
    manual: "Added by hand",
    link: "Added from a link",
    email: "Added via email",
    photo: "Added from a photo",
    alert: "From a new-release alert",
    suggestion: "From a suggestion",
    seed: "Demo data",
    unknown: "",
  };
  const originLine = $derived(originLabels[item.origin] || null);

  // The "there" list: every way to reach this release away from the page,
  // named plainly — the source it came from, the streaming-service lookup when
  // it can't play in-app, and each hand-added link. The destination "listen
  // here" is using is left out (it's already playing here), and a URL that
  // shows up twice appears once.
  type ExternalLink = {
    key: string;
    href: string;
    label: string;
    service: SourceName;
  };

  const externalLinks = $derived.by<ExternalLink[]>(() => {
    const links: ExternalLink[] = [];
    const seen = new Set(hereTarget?.href ? [hereTarget.href] : []);
    const push = (
      key: string,
      href: string | null | undefined,
      label: string,
      service: SourceName,
    ): void => {
      if (!href || seen.has(href)) return;
      seen.add(href);
      links.push({ key, href, label, service });
    };

    if (data.sourceLink) {
      push("primary", data.sourceLink.href, data.sourceLink.label, data.sourceLink.source);
    }
    if (lookupLink && !lookupIsPlayableAppleMusic) {
      push("lookup", lookupLink.url, lookupLink.label, linkService(lookupLink.url));
    }
    for (const link of secondaryLinks) {
      const service = linkService(link.url, link.source_name);
      push(`link-${link.id}`, link.url, link.display_name || sourceDisplayName(service), service);
    }
    return links;
  });
</script>

<svelte:head>
  <title>{item.title} — On The Beach</title>
</svelte:head>

<main class="main">
  <div class="release-page">
    <div class="release-page__nav">
      <a href={data.backHref} class="btn">◄</a>
    </div>

    <div class="release-page__body">
      {#if data.artworkUrl}
        {#if !coarsePointer && hereTarget}
          <button
            class="release-page__artwork-play release-page__listen-btn"
            title={hereTarget.service}
            aria-label={`Listen on ${hereTarget.service}`}
            onclick={hereTarget.play}
          >
            <img class="release-page__artwork" src={data.artworkUrl} alt="Artwork for {item.title}" />
          </button>
        {:else}
          <img class="release-page__artwork" src={data.artworkUrl} alt="Artwork for {item.title}" />
        {/if}
      {/if}

      <div class="release-page__content">
        <div id="view-mode" hidden={editMode}>
          <h2 class="release-page__title">{item.title}</h2>
          {#if item.artist_name}
            <p class="release-page__artist">{item.artist_name}</p>
          {/if}
          {#if metaFields}
            <p class="release-page__meta">{metaFields}</p>
          {/if}
          {#if labelLine}
            <p class="release-page__label">{labelLine}</p>
          {/if}
          {#if originLine}
            <p class="release-page__origin">{originLine}</p>
          {/if}
          <div class="release-page__notes-section">
            {#if notesState === "editing" || notesState === "saving"}
              <textarea
                class="input release-page__notes-editor"
                id="inline-notes"
                placeholder="Notes"
                bind:value={notesDraft}
              ></textarea>
              <div class="release-page__notes-actions">
                <button
                  type="button"
                  class="btn btn--primary"
                  id="save-notes-btn"
                  disabled={notesState === "saving"}
                  onclick={saveNotes}
                  >{notesState === "saving" ? "Saving…" : "Save notes"}</button
                >
                <button type="button" class="btn" id="cancel-notes-btn" onclick={cancelEditNotes}
                  >Cancel</button
                >
              </div>
            {:else}
              {#if currentNotes}
                <p class="release-page__notes">{currentNotes}</p>
              {/if}
              <button
                type="button"
                class="btn release-page__notes-btn"
                id="edit-notes-btn"
                onclick={startEditNotes}>{currentNotes ? "Edit notes" : "Add notes"}</button
              >
            {/if}
          </div>
          <StarRating
            itemId={item.id}
            rating={item.rating}
            className="star-rating--large"
            onRate={async (next) => {
              await api.updateMusicItem(item.id, { rating: next });
            }}
          />
          <div class="release-page__actions">
            {#if !coarsePointer && hereTarget}
              <button
                class="release-page__listen-btn"
                data-src={hereTarget.src}
                data-title={item.title}
                data-artist={item.artist_name ?? ""}
                data-player-type={hereTarget.playerType}
                data-am-mode={hereTarget.amMode}
                data-href={hereTarget.href}
                title={hereTarget.service}
                aria-label={`Listen on ${hereTarget.service}`}
                onclick={hereTarget.play}>listen here</button
              >
            {/if}
            {#each externalLinks as link (link.key)}
              <a
                class="release-page__link-btn"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                title={link.label}
                aria-label={link.label}
              >
                <ServiceIcon service={link.service} />
                {link.label}
              </a>
            {/each}
          </div>
          {#if data.mixcloudWidgetSrc}
            <iframe
              class="release-page__mixcloud-embed"
              src={data.mixcloudWidgetSrc}
              style="border:0;width:100%;height:60px;"
              title="Mixcloud player"
              allow="autoplay"
            ></iframe>
          {/if}
        </div>

        <div id="edit-mode" hidden={!editMode}>
          <div class="release-page__edit-fields">
            <input class="input" type="text" id="edit-title" placeholder="Title" bind:value={editTitle} />
            <input class="input" type="text" id="edit-artist" placeholder="Artist" bind:value={editArtist} />
            <div class="release-page__edit-row">
              <input
                class="input"
                type="number"
                id="edit-year"
                placeholder="Year"
                min="1900"
                max="2099"
                bind:value={editYear}
              />
              <input class="input" type="text" id="edit-label" placeholder="Label" bind:value={editLabel} />
              <input
                class="input"
                type="text"
                id="edit-country"
                placeholder="Country"
                bind:value={editCountry}
              />
            </div>
            <input class="input" type="text" id="edit-genre" placeholder="Genre" bind:value={editGenre} />
            <input
              class="input"
              type="text"
              id="edit-catalogue"
              placeholder="Catalogue number"
              bind:value={editCatalogue}
            />
            <textarea class="input" id="edit-notes" placeholder="Notes" bind:value={editNotes}></textarea>
            <div class="release-page__edit-artwork">
              <input
                type="file"
                id="artwork-file-input"
                accept="image/*"
                style="display:none"
                bind:this={artworkFileInput}
                onchange={onArtworkFileChange}
              />
              <button
                type="button"
                class="btn"
                id="artwork-upload-btn"
                disabled={artworkUploading}
                onclick={() => artworkFileInput?.click()}
                >{artworkUploading ? "Uploading…" : "Replace image"}</button
              >
              <input
                class="input"
                type="text"
                id="edit-artwork-url"
                placeholder="Artwork URL"
                bind:value={editArtworkUrl}
              />
            </div>
            <div class="release-page__edit-links">
              <div class="release-page__edit-stacks-header">Links</div>
              <div id="link-list">
                {#each itemLinks as link (link.id)}
                  <div class="release-page__link-row">
                    <span class="release-page__link-source"
                      >{link.display_name || link.source_name || "Link"}</span
                    >
                    <a
                      class="release-page__link-url"
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer">{link.url}</a
                    >
                    <button
                      type="button"
                      class="btn release-page__link-remove"
                      data-lid={link.id}
                      title="Remove"
                      onclick={() => removeLink(link.id)}>×</button
                    >
                  </div>
                {/each}
              </div>
              <div class="release-page__edit-link-add">
                <div class="release-page__source-picker">
                  <input
                    class="input"
                    type="text"
                    id="link-source-input"
                    placeholder="Source"
                    autocomplete="off"
                    bind:value={sourceQuery}
                    oninput={() => (sourceDropdownOpen = true)}
                    onfocus={() => (sourceDropdownOpen = true)}
                    onblur={() => setTimeout(() => (sourceDropdownOpen = false), 150)}
                  />
                  <div
                    id="source-dropdown"
                    class="release-page__source-dropdown"
                    hidden={!sourceDropdownOpen || sourceMatches.length === 0}
                  >
                    {#each sourceMatches as source (source.displayName)}
                      <div
                        class="release-page__source-dropdown-item"
                        data-value={source.displayName}
                        role="option"
                        aria-selected="false"
                        tabindex="-1"
                        onmousedown={(e) => {
                          e.preventDefault();
                          sourceQuery = source.displayName;
                          sourceDropdownOpen = false;
                        }}
                      >
                        {source.displayName}
                      </div>
                    {/each}
                  </div>
                </div>
                <input class="input" type="url" id="link-url-input" placeholder="URL" bind:value={linkUrl} />
                <button type="button" class="btn" id="add-link-btn" onclick={addLink}>Add</button>
              </div>
            </div>
            <div class="release-page__edit-actions">
              <button type="button" class="btn btn--primary" id="save-btn" onclick={saveChanges}
                >Save changes</button
              >
              <button type="button" class="btn" id="cancel-btn" onclick={() => (editMode = false)}
                >Cancel</button
              >
            </div>
          </div>
        </div>

        <div class="release-page__status">
          <label for="status-select">Status</label>
          <select id="status-select" class="status-select" value={displayedStatus} onchange={onStatusChange}>
            <option value="to-listen">To Listen</option>
            <option value="listened">Listened</option>
            {#if currentRemindAt}
              <option value="scheduled" disabled>Scheduled</option>
            {/if}
          </select>
        </div>

        <div class="release-page__reminder">
          <label for="remind-at">Remind me on</label>
          <input class="input" type="date" id="remind-at" bind:value={remindAtValue} />
          <button
            type="button"
            class="btn btn--primary"
            class:btn--saved={reminderSaved}
            id="set-reminder-btn"
            onclick={setReminder}>{reminderSaved ? "Saved!" : "Set reminder"}</button
          >
          {#if currentRemindAt}
            <button type="button" class="btn" id="clear-reminder-btn" onclick={clearReminder}
              >Clear</button
            >
          {/if}
        </div>

        <div class="release-page__edit-stacks">
          <div class="release-page__edit-stacks-header">Stacks</div>
          <div id="stack-chips" class="release-page__stacks release-page__stacks--inline">
            {#each assignedStacks as stack (stack.id)}
              <span class="stack-chip"
                >{stack.name}<button
                  type="button"
                  class="stack-chip__remove"
                  data-sid={stack.id}
                  title="Remove"
                  onclick={() => toggleStack(stack.id, false)}>×</button
                ></span
              >
            {/each}
          </div>
          <div id="stack-picker-list" class="release-page__edit-stacks-list">
            {#each visibleStacks as stack (stack.id)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <label
                class="stack-dropdown__item"
                onclick={(event) => {
                  // Toggle explicitly so clicking the name text works as
                  // reliably as clicking the box — native <label>→checkbox
                  // click forwarding dropped text clicks in some browsers.
                  event.preventDefault();
                  toggleStack(stack.id, !assignedIds.has(stack.id));
                }}
              >
                <input
                  type="checkbox"
                  class="stack-dropdown__checkbox"
                  data-sid={stack.id}
                  checked={assignedIds.has(stack.id)}
                />
                {stack.name}
              </label>
            {/each}
          </div>
          <div class="release-page__edit-stacks-new">
            <input
              type="text"
              class="input stack-dropdown__new-input"
              id="new-stack-input"
              placeholder="New stack…"
              bind:value={stackQuery}
              onkeydown={onNewStackKeydown}
            />
          </div>
        </div>

        <div class="release-page__footer">
          <button type="button" class="btn" id="edit-btn" hidden={editMode} onclick={() => (editMode = true)}
            >Edit</button
          >
          <button type="button" class="btn" id="delete-btn" hidden={editMode} onclick={deleteItem}
            >Delete</button
          >
        </div>
      </div>
    </div>
  </div>
</main>

<SuggestionPickerModal
  {suggestions}
  sourceItemId={suggestionSourceId}
  onAccepted={() => {}}
  onClosed={() => {
    suggestions = [];
    suggestionSourceId = null;
  }}
/>
