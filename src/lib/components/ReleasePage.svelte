<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import type { PageData } from "../../routes/r/[id]/$types";
  import type { AppleMusicListen, ListenEmbed } from "../../routes/r/[id]/+page.server";
  import type { ItemSuggestion, ListenStatus } from "../../types";
  import { parseAppleMusicCatalogUrl } from "../../../shared/apple-music";
  import { api, apiFetch } from "../api";
  import { player } from "../player.svelte";
  import StarRating from "./StarRating.svelte";
  import SuggestionPickerModal from "./SuggestionPickerModal.svelte";

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
  let suggestion = $state<ItemSuggestion | null>(null);
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
    if (newStatus === "listened" && result?.suggestion) {
      suggestion = result.suggestion;
      suggestionSourceId = item.id;
    }
  }

  // ── Listen buttons ─────────────────────────────────────────────────────────
  function listen(embed: ListenEmbed): void {
    if (window.matchMedia("(pointer: coarse)").matches && embed.href) {
      window.open(embed.href, "_blank", "noopener,noreferrer");
    } else {
      player.load(embed.src, item.title, item.artist_name ?? "", embed.playerType);
    }
  }

  // Full-track Apple Music playback (MusicKit) when configured, else the preview
  // iframe. On touch devices, hand off to the native Apple Music app/site — the
  // same behaviour the other listen buttons use for coarse pointers.
  function listenAppleMusic(listenTarget: AppleMusicListen): void {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (listenTarget.mode === "musickit" && listenTarget.resource && !coarse) {
      player.loadAppleMusic(
        listenTarget.resource.kind,
        listenTarget.resource.id,
        item.title,
        item.artist_name ?? "",
      );
      return;
    }
    if (coarse) {
      window.open(listenTarget.href, "_blank", "noopener,noreferrer");
      return;
    }
    // Unconfigured (preview) fallback.
    if (listenTarget.src) {
      player.load(listenTarget.src, item.title, item.artist_name ?? "", "audio");
    } else {
      window.open(listenTarget.href, "_blank", "noopener,noreferrer");
    }
  }

  // Play a client-discovered Apple Music secondary link (the on-view lookup)
  // through MusicKit when it resolves to a playable catalogue resource.
  function listenLookupAppleMusic(url: string): void {
    const resource = parseAppleMusicCatalogUrl(url);
    if (resource && !window.matchMedia("(pointer: coarse)").matches) {
      player.loadAppleMusic(resource.kind, resource.id, item.title, item.artist_name ?? "");
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

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
    if (ok) await goto("/");
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
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1];
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

  async function removeLink(linkId: number): Promise<void> {
    const res = await apiFetch(`/api/music-items/${item.id}/links/${linkId}`, { method: "DELETE" });
    if (res.ok) {
      itemLinks = itemLinks.filter((l) => l.id !== linkId);
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
      const link = await res.json();
      itemLinks = [...itemLinks, link];
      sourceQuery = "";
      linkUrl = "";
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
    [item.year ? String(item.year) : null, item.label, item.country, item.genre]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<svelte:head>
  <title>{item.title} — On The Beach</title>
</svelte:head>

<main class="main">
  <div class="release-page">
    <div class="release-page__nav">
      <a href="/" class="btn">◄</a>
    </div>

    <div class="release-page__body">
      {#if data.artworkUrl}
        {#if data.youtubeEmbed}
          <button
            class="release-page__artwork-play release-page__listen-btn"
            data-src={data.youtubeEmbed.src}
            data-title={item.title}
            data-artist={item.artist_name ?? ""}
            data-player-type="video"
            data-href={data.youtubeEmbed.href}
            onclick={() => listen(data.youtubeEmbed!)}
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
          {#if item.catalogue_number}
            <p class="release-page__catalogue">{item.catalogue_number}</p>
          {/if}
          {#if item.notes}
            <p class="release-page__notes">{item.notes}</p>
          {/if}
          <StarRating
            itemId={item.id}
            rating={item.rating}
            className="star-rating--large"
            onRate={async (next) => {
              await api.updateMusicItem(item.id, { rating: next });
            }}
          />
          {#if data.sourceLink}
            <a
              class="release-page__source-link"
              href={data.sourceLink.href}
              target="_blank"
              rel="noopener noreferrer">{data.sourceLink.label}</a
            >
          {/if}
          {#if data.bandcampEmbed}
            <button
              class="release-page__listen-btn"
              data-src={data.bandcampEmbed.src}
              data-title={item.title}
              data-artist={item.artist_name ?? ""}
              data-href={data.bandcampEmbed.href}
              onclick={() => listen(data.bandcampEmbed!)}>▶ Listen</button
            >
          {/if}
          {#if data.youtubeEmbed}
            <button
              class="release-page__listen-btn"
              data-src={data.youtubeEmbed.src}
              data-title={item.title}
              data-artist={item.artist_name ?? ""}
              data-player-type="video"
              data-href={data.youtubeEmbed.href}
              onclick={() => listen(data.youtubeEmbed!)}>▶ Watch</button
            >
          {/if}
          {#if data.appleMusicListen}
            <button
              class="release-page__listen-btn release-page__listen-btn--apple"
              data-am-mode={data.appleMusicListen.mode}
              data-title={item.title}
              data-artist={item.artist_name ?? ""}
              data-href={data.appleMusicListen.href}
              onclick={() => listenAppleMusic(data.appleMusicListen!)}
              >▶ Listen on Apple Music</button
            >
          {/if}
          {#if data.mixcloudWidgetSrc}
            <iframe
              class="release-page__mixcloud-embed"
              src={data.mixcloudWidgetSrc}
              style="border:0;width:100%;height:60px;"
              title="Mixcloud player"
              allow="autoplay"
            ></iframe>
          {/if}
          <div id="secondary-links">
            {#if lookupLink && lookupIsPlayableAppleMusic}
              <button
                class="release-page__listen-btn release-page__listen-btn--apple"
                data-am-mode="musickit"
                onclick={() => listenLookupAppleMusic(lookupLink!.url)}
                >▶ Listen on Apple Music</button
              >
            {:else if lookupLink}
              <a
                class="release-page__source-link"
                href={lookupLink.url}
                target="_blank"
                rel="noopener noreferrer">{lookupLink.label}</a
              >
            {/if}
          </div>
          {#each secondaryLinks as link (link.id)}
            <a
              class="release-page__source-link"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer">{link.display_name ?? link.source_name ?? "Link"}</a
            >
          {/each}
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
              <label class="stack-dropdown__item">
                <input
                  type="checkbox"
                  class="stack-dropdown__checkbox"
                  data-sid={stack.id}
                  checked={assignedIds.has(stack.id)}
                  onchange={(e) => toggleStack(stack.id, e.currentTarget.checked)}
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
  {suggestion}
  sourceItemId={suggestionSourceId}
  onAccepted={() => {}}
  onClosed={() => {
    suggestion = null;
    suggestionSourceId = null;
  }}
/>
