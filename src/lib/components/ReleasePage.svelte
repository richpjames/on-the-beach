<script lang="ts">
  import { goto, invalidateAll } from "$app/navigation";
  import { onMount } from "svelte";
  import type { PageData } from "../../routes/r/[id]/$types";
  import type { ListenEmbed } from "../../routes/r/[id]/+page.server";
  import type {
    ArtistFollowState,
    ItemOrigin,
    ItemSuggestion,
    ListenStatus,
    SourceName,
  } from "../../../domain/types";
  import { parseAppleMusicCatalogUrl, type AppleMusicResource } from "../../../domain/apple-music";
  import { isAtLeastASentence } from "../../../domain/link-sources";
  import { catalogueMatchUpdates } from "../../ui/logic/catalogue-match";
  import { api, apiFetch } from "../api";
  import { encodeImageFile } from "../encode-image";
  import { player } from "../player.svelte";
  import type { QueueTarget } from "../../ui/state/player-machine";
  import ServiceIcon from "./ServiceIcon.svelte";
  import StarRating from "./StarRating.svelte";
  import SuggestionPickerModal from "./SuggestionPickerModal.svelte";
  import { linkService, sourceDisplayName } from "../../ui/logic/link-service";

  // The page wraps this component in {#key item.id}, so the local state below
  // is (re)initialised per release. `item` itself stays derived from the load
  // data: saving edits re-runs the loads (invalidateAll) and view mode catches
  // up without a full page reload — a reload would reset the whole client and
  // take the now-playing player (module scope, see player.svelte.ts) with it.
  let { data }: { data: PageData } = $props();

  const item = $derived(data.item);

  // ── Status & reminder ──────────────────────────────────────────────────────
  // svelte-ignore state_referenced_locally
  let currentListenStatus = $state<string>(item.listen_status);
  // svelte-ignore state_referenced_locally
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

  // ── Follow artist ──────────────────────────────────────────────────────────
  // Following is the only way an artist joins the new-release watch, and the
  // button beside their name is where it happens. A muted artist reads as not
  // followed here; following them again is how a mute is undone.
  // svelte-ignore state_referenced_locally
  let followState = $state<ArtistFollowState | null>(data.artistFollowState);
  let followBusy = $state(false);
  const following = $derived(followState === "always");

  async function toggleFollow(): Promise<void> {
    if (item.artist_id === null || followBusy) return;
    const next: ArtistFollowState = following ? "auto" : "always";
    followBusy = true;
    try {
      await api.setArtistFollowState(item.artist_id, next);
      followState = next;
    } catch {
      alert(following ? "Failed to unfollow artist." : "Failed to follow artist.");
    } finally {
      followBusy = false;
    }
  }

  // ── Listen here ────────────────────────────────────────────────────────────
  // "listen here" plays the release in the internal player. On touch devices
  // the floating player window doesn't suit the screen, so the button (and the
  // clickable artwork) don't render at all — instead this destination becomes
  // the first of the external links below, which are all a phone gets. Set
  // after mount (not at init) to keep SSR and hydration in sync.
  let coarsePointer = $state(false);
  onMount(() => {
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  });

  function listen(embed: ListenEmbed): void {
    player.load(embed.src, item.title, item.artist_name ?? "", embed.playerType, item.id);
  }

  // "queue" lines the same release up behind whatever is playing, using the
  // same target "listen here" resolved — the two buttons always agree on what
  // would play.
  function enqueueWith(target: QueueTarget): () => void {
    const label = item.artist_name ? `${item.artist_name} — ${item.title}` : item.title;
    return () => player.enqueue({ itemId: item.id, label, target });
  }

  // The one source that wins the "listen here" button, by priority: the lookup
  // streaming service when it can genuinely play in-app (Apple Music full-track
  // via MusicKit — the store's own link first, then the on-view lookup), then
  // the item's full-length embeds, and the 30-second Apple Music preview only
  // when nothing better exists. Nothing playable at all means no button.
  type HereTarget = {
    key: string;
    service: string;
    source: SourceName;
    href?: string;
    src?: string;
    playerType?: "audio" | "video" | "bar";
    amMode?: string;
    play: () => void;
    enqueue: () => void;
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
        source: "apple_music",
        href: appleMusic.href,
        amMode: "musickit",
        play: () => playAppleMusic(resource.kind, resource.id),
        enqueue: enqueueWith({ kind: "appleMusic", amKind: resource.kind, id: resource.id }),
      };
    }
    const lookup = lookupLink;
    if (lookup && lookupIsPlayableAppleMusic) {
      const resource = parseAppleMusicCatalogUrl(lookup.url)!;
      return {
        key: "apple-music-lookup",
        service: "Apple Music",
        source: "apple_music",
        href: lookup.url,
        amMode: "musickit",
        play: () => playAppleMusic(resource.kind, resource.id),
        enqueue: enqueueWith({ kind: "appleMusic", amKind: resource.kind, id: resource.id }),
      };
    }
    const bandcamp = data.bandcampEmbed;
    if (bandcamp) {
      return {
        key: "bandcamp",
        service: "Bandcamp",
        source: "bandcamp",
        href: bandcamp.href ?? undefined,
        src: bandcamp.src,
        playerType: bandcamp.playerType,
        play: () => listen(bandcamp),
        enqueue: enqueueWith({
          kind: "iframe",
          src: bandcamp.src,
          playerType: bandcamp.playerType,
        }),
      };
    }
    const youtube = data.youtubeEmbed;
    if (youtube) {
      return {
        key: "youtube",
        service: "YouTube",
        source: "youtube",
        href: youtube.href ?? undefined,
        src: youtube.src,
        playerType: youtube.playerType,
        play: () => listen(youtube),
        enqueue: enqueueWith({
          kind: "iframe",
          src: youtube.src,
          playerType: youtube.playerType,
        }),
      };
    }
    const soundcloud = data.soundcloudEmbed;
    if (soundcloud) {
      return {
        key: "soundcloud",
        service: "SoundCloud",
        source: "soundcloud",
        href: soundcloud.href ?? undefined,
        src: soundcloud.src,
        playerType: soundcloud.playerType,
        play: () => listen(soundcloud),
        enqueue: enqueueWith({
          kind: "iframe",
          src: soundcloud.src,
          playerType: soundcloud.playerType,
        }),
      };
    }
    const mixcloud = data.mixcloudEmbed;
    if (mixcloud) {
      return {
        key: "mixcloud",
        service: "Mixcloud",
        source: "mixcloud",
        href: mixcloud.href ?? undefined,
        src: mixcloud.src,
        playerType: mixcloud.playerType,
        play: () => listen(mixcloud),
        enqueue: enqueueWith({
          kind: "iframe",
          src: mixcloud.src,
          playerType: mixcloud.playerType,
        }),
      };
    }
    if (appleMusic?.src) {
      return {
        key: "apple-music-preview",
        service: "Apple Music",
        source: "apple_music",
        href: appleMusic.href,
        src: appleMusic.src,
        playerType: "audio",
        amMode: "preview",
        play: () => listen({ src: appleMusic.src!, href: appleMusic.href, playerType: "audio" }),
        enqueue: enqueueWith({ kind: "iframe", src: appleMusic.src!, playerType: "audio" }),
      };
    }
    return null;
  });

  // ── Edit mode ──────────────────────────────────────────────────────────────
  let editMode = $state(false);
  // svelte-ignore state_referenced_locally
  let editTitle = $state(item.title);
  // svelte-ignore state_referenced_locally
  let editArtist = $state(item.artist_name ?? "");
  // svelte-ignore state_referenced_locally
  let editYear = $state(item.year != null ? String(item.year) : "");
  // svelte-ignore state_referenced_locally
  let editLabel = $state(item.label ?? "");
  // svelte-ignore state_referenced_locally
  let editCountry = $state(item.country ?? "");
  // svelte-ignore state_referenced_locally
  let editGenre = $state(item.genre ?? "");
  // svelte-ignore state_referenced_locally
  let editCatalogue = $state(item.catalogue_number ?? "");
  // svelte-ignore state_referenced_locally
  let editDiscogs = $state(item.discogs_release_id != null ? String(item.discogs_release_id) : "");
  // svelte-ignore state_referenced_locally
  let editMbRelease = $state(item.musicbrainz_release_id ?? "");
  // svelte-ignore state_referenced_locally
  let editNotes = $state(item.notes ?? "");
  // svelte-ignore state_referenced_locally
  let editArtworkUrl = $state(item.artwork_url ?? "");

  // ── Inline notes editing ─────────────────────────────────────────────────
  // A dedicated add/edit-notes control that lives with the notes in view mode,
  // so notes can be changed without opening the full edit form.
  // svelte-ignore state_referenced_locally
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

  // The catalogue match is computed by `ui/logic/catalogue-match.ts` —
  // paste to correct, empty both to clear the whole match.
  async function saveChanges(): Promise<void> {
    const matchUpdates = catalogueMatchUpdates(editDiscogs, editMbRelease, catalogueItem);
    if ("error" in matchUpdates) {
      alert(matchUpdates.error);
      return;
    }
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
      ...matchUpdates,
    };
    const res = await apiFetch(`/api/music-items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      // Re-run the loads rather than reloading the window: a full reload
      // resets the client-side player and stops whatever is playing, whatever
      // the source. `item` is derived, so view mode picks up the saved fields.
      await invalidateAll();
      // Nothing is re-initialised on save any more (no reload), so re-seed the
      // notes line and the whole form from the fresh row — otherwise the next
      // save writes the values captured at open back over it. The resolution
      // line layers local state over the row, and the server re-stamps the
      // verdict on a hand-corrected match, so it takes the fresh row's too.
      currentNotes = item.notes ?? null;
      resolved = {
        resolution_status: item.resolution_status,
        musicbrainz_release_id: item.musicbrainz_release_id,
        musicbrainz_release_group_id: item.musicbrainz_release_group_id,
        discogs_release_id: item.discogs_release_id,
        discogs_master_id: item.discogs_master_id,
      };
      editTitle = item.title;
      editArtist = item.artist_name ?? "";
      editYear = item.year != null ? String(item.year) : "";
      editLabel = item.label ?? "";
      editCountry = item.country ?? "";
      editGenre = item.genre ?? "";
      editCatalogue = item.catalogue_number ?? "";
      editDiscogs = item.discogs_release_id != null ? String(item.discogs_release_id) : "";
      editMbRelease = item.musicbrainz_release_id ?? "";
      editNotes = item.notes ?? "";
      editArtworkUrl = item.artwork_url ?? "";
      editMode = false;
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
  // svelte-ignore state_referenced_locally
  let allStacks = $state<Array<{ id: number; name: string }>>([...item.stacks]);
  // svelte-ignore state_referenced_locally
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
  // svelte-ignore state_referenced_locally
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

  // Keyboard support for the source dropdown, so picking a source works the
  // same way as the checkbox list below it: arrows move the highlight, Enter
  // picks, Escape closes. The index is clamped to the matches in case the
  // query narrows the list while it's open.
  let sourceActiveIndex = $state(0);
  // Blur closes the dropdown a beat later so option clicks land first;
  // refocusing inside that window cancels the pending close.
  let sourceBlurTimer: ReturnType<typeof setTimeout> | undefined;
  const sourceActive = $derived(Math.min(sourceActiveIndex, Math.max(0, sourceMatches.length - 1)));
  const sourceDropdownExpanded = $derived(sourceDropdownOpen && sourceMatches.length > 0);

  function pickSource(name: string): void {
    sourceQuery = name;
    sourceDropdownOpen = false;
  }

  function onSourceKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      sourceDropdownOpen = true;
      if (sourceMatches.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = (sourceActive + delta + sourceMatches.length) % sourceMatches.length;
      sourceActiveIndex = next;
    } else if (event.key === "Enter") {
      if (sourceDropdownExpanded) {
        event.preventDefault();
        pickSource(sourceMatches[sourceActive]!.displayName);
      }
    } else if (event.key === "Escape") {
      sourceDropdownOpen = false;
    }
  }

  // Keep the highlighted option inside the dropdown's visible height. This
  // must run as an effect: Svelte flushes the DOM after the keydown handler,
  // so scrolling in the handler would hit a still-hidden list on the arrow
  // press that reopens it (scrollIntoView is a no-op on display:none), and a
  // click reopen would leave a deep highlight out of view, pickable unseen.
  $effect(() => {
    if (sourceDropdownExpanded) {
      document
        .getElementById(`source-option-${sourceActive}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  });

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
      // just linked to, and the same goes for the label. The edit fields were
      // filled in before that happened, so without this saving the form
      // afterwards would write their emptiness back over what the link
      // supplied.
      const { artwork_url: artworkUrl, label, ...link } = await res.json();
      if (artworkUrl && !editArtworkUrl.trim()) editArtworkUrl = artworkUrl;
      if (label && !editLabel.trim()) editLabel = label;
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

  // ── Notes enrichment ───────────────────────────────────────────────────────
  // Opening a release whose notes are empty (or less than a sentence) fetches
  // the first paragraph of its best-ranked MusicBrainz external link. Usually
  // a no-op for new items (the eager hook has already run); this is the
  // on-view fallback for older items. The server enforces all skip rules; we
  // only avoid an obviously redundant request when the notes already read as
  // prose.
  onMount(() => {
    if (currentNotes && isAtLeastASentence(currentNotes)) return;
    apiFetch(`/api/release/notes-lookup/${item.id}`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((result) => {
        if (!result?.notes) return;
        currentNotes = result.notes;
        // Fill the edit form's notes gap-only, as the link form fills artwork
        // and label: an enrichment that lands while the form is open must not
        // be written back over by the form's initial emptiness.
        if (!editNotes) {
          editNotes = result.notes;
        }
      })
      .catch(() => {});
  });

  // ── Catalogue resolution ───────────────────────────────────────────────────
  // What the resolver made of this record, as the page knows it. Starts from
  // the stored row; the on-view lookup below updates it in place when a
  // verdict lands, so the provenance line appears without a reload.
  // svelte-ignore state_referenced_locally
  let resolved = $state({
    resolution_status: item.resolution_status,
    musicbrainz_release_id: item.musicbrainz_release_id,
    musicbrainz_release_group_id: item.musicbrainz_release_group_id,
    discogs_release_id: item.discogs_release_id,
    discogs_master_id: item.discogs_master_id,
  });
  let resolutionPending = $state(false);

  // The item as the page knows it now — the load-time row with any verdict
  // the on-view lookup has landed. The provenance line and the edit form's
  // catalogue-match comparison both read this, so a match found while the
  // page is open is neither invisible nor saved back as emptiness.
  const catalogueItem = $derived({ ...item, ...resolved });

  // Opening a release asks the catalogues what it is when nothing has asked
  // before. The server enforces all skip rules (absent is terminal, a fresh
  // failure is left alone for a cooldown, ids from any path keep their
  // provenance); we only avoid an obviously redundant request, the same
  // courtesy the secondary-link lookup extends.
  const resolutionEligible = $derived(
    !item.musicbrainz_release_id &&
      !item.musicbrainz_release_group_id &&
      !item.discogs_release_id &&
      !item.discogs_master_id &&
      (item.resolution_status === null || item.resolution_status === "failed") &&
      !!item.artist_name,
  );

  onMount(() => {
    if (!resolutionEligible) return;
    resolutionPending = true;
    apiFetch(`/api/release/resolution-lookup/${item.id}`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((verdict) => {
        if (!verdict || verdict.skipped || !verdict.resolutionStatus) return;
        resolved = {
          resolution_status: verdict.resolutionStatus,
          musicbrainz_release_id: verdict.musicbrainzReleaseId ?? null,
          musicbrainz_release_group_id: verdict.musicbrainzReleaseGroupId ?? null,
          discogs_release_id: verdict.discogsReleaseId ?? null,
          discogs_master_id: verdict.discogsMasterId ?? null,
        };
        // Fill the edit form's catalogue fields gap-only, as the link form
        // fills artwork and label: a lookup that lands while the form is open
        // must not be written back over by the form's initial emptiness.
        if (!editDiscogs && verdict.discogsReleaseId) {
          editDiscogs = String(verdict.discogsReleaseId);
        }
        if (!editMbRelease && verdict.musicbrainzReleaseId) {
          editMbRelease = verdict.musicbrainzReleaseId;
        }
      })
      .catch(() => {})
      .finally(() => {
        resolutionPending = false;
      });
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

  // What the catalogue resolver made of this record, in plain terms — the
  // provenance line beside "Added from a photo". The catalogue names link to
  // the entry the resolver verified, so "matched" is checkable at a glance.
  // Hidden while resolution has never run (`resolution_status` null) — but a
  // row that predates the resolver is asked about on open, so the line tends
  // to appear a beat after the page does.
  type ResolutionSegment = { text: string; href?: string };
  const resolutionSegments = $derived.by<ResolutionSegment[] | null>(() => {
    const catalogues: ResolutionSegment[] = [];
    if (catalogueItem.discogs_release_id) {
      catalogues.push({
        text: "Discogs",
        href: `https://www.discogs.com/release/${catalogueItem.discogs_release_id}`,
      });
    }
    if (catalogueItem.musicbrainz_release_id) {
      catalogues.push({
        text: "MusicBrainz",
        href: `https://musicbrainz.org/release/${catalogueItem.musicbrainz_release_id}`,
      });
    }
    const names = catalogues.map((segment) => segment.text);
    switch (catalogueItem.resolution_status) {
      case "matched": {
        if (catalogues.length === 0) return [{ text: "Matched in the catalogues" }];
        const segments: ResolutionSegment[] = [{ text: "Matched in " }];
        catalogues.forEach((segment, index) => {
          if (index > 0) segments.push({ text: " and " });
          segments.push(segment);
        });
        return segments;
      }
      case "partial":
        // Partial means one queried catalogue didn't hold the record — so at
        // most one id came back, and "only" is the honest word for it.
        if (names.length === 1) return [{ text: "Matched in " }, catalogues[0]!, { text: " only" }];
        return [{ text: "Matched in only one catalogue" }];
      case "absent":
        return [{ text: "Not in the Discogs or MusicBrainz catalogues" }];
      case "failed":
        return [{ text: "Catalogue lookup didn't complete" }];
      default:
        return null;
    }
  });

  // The "there" list: every way to reach this release away from the page,
  // named plainly — the source it came from, the streaming-service lookup when
  // it can't play in-app, and each hand-added link. The destination "listen
  // here" is using is left out (it's already playing here) — except on touch
  // devices, where no "listen here" renders, so its destination leads the list
  // instead of vanishing with the button. A URL that shows up twice appears
  // once.
  type ExternalLink = {
    key: string;
    href: string;
    label: string;
    service: SourceName;
  };

  const externalLinks = $derived.by<ExternalLink[]>(() => {
    const links: ExternalLink[] = [];
    const seen = new Set<string>();
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

    if (coarsePointer && hereTarget?.href) {
      push("listen-here", hereTarget.href, hereTarget.service, hereTarget.source);
    } else if (hereTarget?.href) {
      seen.add(hereTarget.href);
    }

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
      <a href={data.backHref} class="btn btn--ghost">◄ Back</a>
    </div>

    <div class="release-page__body">
      {#if data.artworkUrl}
        {#if !coarsePointer && hereTarget}
          <button
            class="release-page__artwork-play"
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
            <div class="release-page__artist-row">
              <p class="release-page__artist">{item.artist_name}</p>
              {#if item.artist_id !== null}
                <button
                  type="button"
                  class="btn release-page__follow-btn"
                  class:release-page__follow-btn--following={following}
                  id="follow-artist-btn"
                  disabled={followBusy}
                  title={following
                    ? "Stop watching for new releases by this artist"
                    : "Watch for new releases by this artist"}
                  onclick={toggleFollow}>{following ? "Following ✓" : "Follow"}</button
                >
              {/if}
            </div>
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
          {#if resolutionPending}
            <p class="release-page__origin release-page__resolution">
              Looking it up in the catalogues…
            </p>
          {:else if resolutionSegments}
            <p class="release-page__origin release-page__resolution">
              {#each resolutionSegments as segment}
                {#if segment.href}
                  <a
                    class="release-page__resolution-link"
                    href={segment.href}
                    target="_blank"
                    rel="noopener noreferrer">{segment.text}</a
                  >
                {:else}{segment.text}{/if}
              {/each}
            </p>
          {/if}
          <div class="release-page__notes-section">
            {#if notesState === "editing" || notesState === "saving"}
              <label class="release-page__micro-label" for="inline-notes">Notes</label>
              <textarea
                class="input release-page__notes-editor"
                id="inline-notes"
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
          {#if data.rating.enabled}
            <StarRating
              itemId={item.id}
              rating={item.rating}
              starCount={data.rating.starCount}
              className="star-rating--large"
              onRate={async (next) => {
                await api.updateMusicItem(item.id, { rating: next });
              }}
            />
          {/if}
          <div class="release-page__actions">
            {#if !coarsePointer && hereTarget}
              <button
                class="btn release-page__listen-btn"
                data-src={hereTarget.src}
                data-title={item.title}
                data-artist={item.artist_name ?? ""}
                data-player-type={hereTarget.playerType}
                data-am-mode={hereTarget.amMode}
                data-href={hereTarget.href}
                title={hereTarget.service}
                aria-label={`Listen on ${hereTarget.service}`}
                onclick={hereTarget.play}>Listen here</button
              >
              <button
                class="btn release-page__queue-btn"
                id="queue-release-btn"
                data-src={hereTarget.src}
                title={`Queue on ${hereTarget.service}`}
                aria-label={`Queue on ${hereTarget.service}`}
                onclick={hereTarget.enqueue}>Queue</button
              >
            {/if}
            {#each externalLinks as link (link.key)}
              <a
                class="btn release-page__link-btn"
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
        </div>

        <div id="edit-mode" hidden={!editMode}>
          <div class="release-page__edit-fields">
            <div class="release-page__field">
              <label class="release-page__micro-label" for="edit-title">Title</label>
              <input class="input" type="text" id="edit-title" bind:value={editTitle} />
            </div>
            <div class="release-page__field">
              <label class="release-page__micro-label" for="edit-artist">Artist</label>
              <input class="input" type="text" id="edit-artist" bind:value={editArtist} />
            </div>
            <div class="release-page__edit-row">
              <div class="release-page__field">
                <label class="release-page__micro-label" for="edit-year">Year</label>
                <input
                  class="input"
                  type="number"
                  id="edit-year"
                  min="1900"
                  max="2099"
                  bind:value={editYear}
                />
              </div>
              <div class="release-page__field">
                <label class="release-page__micro-label" for="edit-label">Label</label>
                <input class="input" type="text" id="edit-label" bind:value={editLabel} />
              </div>
              <div class="release-page__field">
                <label class="release-page__micro-label" for="edit-country">Country</label>
                <input class="input" type="text" id="edit-country" bind:value={editCountry} />
              </div>
            </div>
            <div class="release-page__field">
              <label class="release-page__micro-label" for="edit-genre">Genre</label>
              <input class="input" type="text" id="edit-genre" bind:value={editGenre} />
            </div>
            <div class="release-page__field">
              <label class="release-page__micro-label" for="edit-catalogue">Catalogue number</label>
              <input class="input" type="text" id="edit-catalogue" bind:value={editCatalogue} />
            </div>
            <div class="release-page__edit-row">
              <div class="release-page__field">
                <label class="release-page__micro-label" for="edit-discogs">Discogs</label>
                <input
                  class="input"
                  type="text"
                  id="edit-discogs"
                  placeholder="Link or number"
                  inputmode="url"
                  bind:value={editDiscogs}
                />
              </div>
              <div class="release-page__field">
                <label class="release-page__micro-label" for="edit-mb-release">MusicBrainz</label>
                <input
                  class="input"
                  type="text"
                  id="edit-mb-release"
                  placeholder="Link or id"
                  inputmode="url"
                  bind:value={editMbRelease}
                />
              </div>
            </div>
            <div class="release-page__field">
              <label class="release-page__micro-label" for="edit-notes">Notes</label>
              <textarea class="input" id="edit-notes" bind:value={editNotes}></textarea>
            </div>
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
              <div class="release-page__field release-page__field--grow">
                <label class="release-page__micro-label" for="edit-artwork-url">Artwork URL</label>
                <input class="input" type="text" id="edit-artwork-url" bind:value={editArtworkUrl} />
              </div>
            </div>
            <div class="release-page__edit-links">
              <div class="release-page__panel-header">Links</div>
              <div id="link-list">
                {#each itemLinks as link (link.id)}
                  <div class="release-page__link-row">
                    <span class="stack-chip release-page__link-source"
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
                <div class="release-page__field release-page__source-picker">
                  <label class="release-page__micro-label" for="link-source-input">Source</label>
                  <input
                    class="input"
                    type="text"
                    id="link-source-input"
                    autocomplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={sourceDropdownExpanded}
                    aria-controls="source-dropdown"
                    aria-activedescendant={sourceDropdownExpanded
                      ? `source-option-${sourceActive}`
                      : undefined}
                    bind:value={sourceQuery}
                    oninput={() => {
                      sourceDropdownOpen = true;
                      sourceActiveIndex = 0;
                    }}
                    onfocus={() => {
                      clearTimeout(sourceBlurTimer);
                      sourceDropdownOpen = true;
                    }}
                    onclick={() => (sourceDropdownOpen = true)}
                    onblur={() =>
                      (sourceBlurTimer = setTimeout(() => (sourceDropdownOpen = false), 150))}
                    onkeydown={onSourceKeydown}
                  />
                  <div
                    id="source-dropdown"
                    class="release-page__source-dropdown"
                    role="listbox"
                    aria-label="Source"
                    hidden={!sourceDropdownExpanded}
                  >
                    {#each sourceMatches as source, i (source.displayName)}
                      <div
                        class="release-page__source-dropdown-item"
                        id={`source-option-${i}`}
                        data-value={source.displayName}
                        role="option"
                        aria-selected={i === sourceActive}
                        tabindex="-1"
                        onmousedown={(e) => {
                          e.preventDefault();
                          pickSource(source.displayName);
                        }}
                        onmouseenter={() => (sourceActiveIndex = i)}
                      >
                        {source.displayName}
                      </div>
                    {/each}
                  </div>
                </div>
                <div class="release-page__field release-page__field--grow">
                  <label class="release-page__micro-label" for="link-url-input">URL</label>
                  <input
                    class="input"
                    type="url"
                    id="link-url-input"
                    placeholder="https://…"
                    bind:value={linkUrl}
                  />
                </div>
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

        <div class="release-page__stacks-panel">
          <div class="release-page__panel-header">Stacks</div>
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
          <div id="stack-picker-list" class="release-page__stacks-panel-list">
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
          <div class="release-page__stacks-panel-new">
            <div class="release-page__field">
              <label class="release-page__micro-label" for="new-stack-input">New stack</label>
              <input
                type="text"
                class="input stack-dropdown__new-input"
                id="new-stack-input"
                placeholder="Press Enter to add"
                bind:value={stackQuery}
                onkeydown={onNewStackKeydown}
              />
            </div>
          </div>
        </div>

        <div class="release-page__footer">
          <button type="button" class="btn" id="edit-btn" hidden={editMode} onclick={() => (editMode = true)}
            >Edit</button
          >
          <button
            type="button"
            class="btn btn--danger"
            id="delete-btn"
            hidden={editMode}
            onclick={deleteItem}>Delete</button
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
