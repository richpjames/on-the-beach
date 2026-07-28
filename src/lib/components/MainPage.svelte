<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import type { ItemSuggestion, ListenStatus, MusicItemFull, StackWithCount } from "../../types";
  import { buildContextKey, buildMusicItemFilters } from "../../ui/domain/music-list";
  import {
    buildListHref,
    buildReleaseHref,
    buildStackPath,
    isDefaultListViewState,
    parseListViewState,
    stackIdFromListPath,
    type ListViewState,
  } from "../../ui/domain/list-url";
  import { normalizeStarRating } from "../../ui/components/star-rating";
  import { addFormMachine } from "../../ui/state/add-form-machine";
  import { appMachine } from "../../ui/state/app-machine";
  import {
    buildPrimaryFeedHref,
    buildPrimaryFeedTitle,
    buildStackFeedHref,
    buildStackFeedTitle,
    PRIMARY_FEEDS,
  } from "../../../shared/rss";
  import { api } from "../api";
  import { useMachine } from "../use-machine.svelte";
  import AddForm from "./AddForm.svelte";
  import AddLoadingOverlay from "./AddLoadingOverlay.svelte";
  import BrowseControls from "./BrowseControls.svelte";
  import LinkPickerModal from "./LinkPickerModal.svelte";
  import MusicList from "./MusicList.svelte";
  import StackBar from "./StackBar.svelte";
  import StackManagePanel from "./StackManagePanel.svelte";
  import SuggestionPickerModal from "./SuggestionPickerModal.svelte";

  let {
    data,
  }: {
    data: { items: MusicItemFull[]; stacks: StackWithCount[]; stackId: number | null };
  } = $props();

  // The machine is seeded from the URL once per page instance; from then on
  // machine context is the source of truth and the URL follows it (see the sync
  // effects below). The URL is read in full — scope *and* browsing state — so
  // that arriving from anywhere (a back button, a shared link, a cold load)
  // reproduces the same view.
  // svelte-ignore state_referenced_locally
  const initialStackId = stackIdFromListPath(page.url.pathname);
  // svelte-ignore state_referenced_locally
  const initialView = parseListViewState(page.url.searchParams, initialStackId);

  // svelte-ignore state_referenced_locally
  const app = useMachine(appMachine, {
    input: {
      stacks: data.stacks,
      currentStack: initialStackId,
      currentFilter: initialView.filter,
      searchQuery: initialView.search,
      currentSort: initialView.sort,
      currentSortDirection: initialView.sortDirection,
      // The payload only covers the default view of the scope it was loaded
      // for, so anything else needs a refetch as soon as we hydrate.
      needsListRefresh:
        initialStackId !== data.stackId || !isDefaultListViewState(initialView, initialStackId),
    },
  });
  const form = useMachine(addFormMachine, { input: { api } });

  const ctx = $derived(app.snapshot.context);

  // svelte-ignore state_referenced_locally
  let items = $state(data.items);
  let childStacks = $state<Array<{ id: number; name: string; item_count: number }>>([]);

  let suggestion = $state<ItemSuggestion | null>(null);
  let suggestionSourceId = $state<number | null>(null);

  let addFormComponent: AddForm | undefined = $state();

  const breadcrumbs = $derived(
    ctx.currentStack !== null ? buildBreadcrumbTrail(ctx.currentStack, ctx.stacks) : [],
  );

  const orderLocked = $derived(
    ctx.searchQuery.trim().length > 0 ||
      ctx.currentSort !== "date-added" ||
      ctx.currentSortDirection !== "desc",
  );

  onMount(() => {
    app.send({ type: "APP_READY" });

    if (ctx.currentStack !== null) {
      void refreshChildStacks();
    }

    // Check for items that were moved back to to-listen by the reminder cron
    api
      .getPendingReminders()
      .then((reminderItems) => {
        if (reminderItems.length > 0) {
          app.send({ type: "REMINDERS_READY", itemIds: reminderItems.map((i) => i.id) });
        }
      })
      .catch(() => {
        // Non-critical — ignore failures silently
      });

    return () => {
      app.stop();
      form.stop();
    };
  });

  // ── List rendering (mirrors the old renderMusicListView) ──────────────────
  let renderedListVersion = 0;
  $effect(() => {
    const version = ctx.listVersion;
    if (version === renderedListVersion) return;
    renderedListVersion = version;
    void refreshList();
  });

  async function refreshList(): Promise<void> {
    const filters = buildMusicItemFilters(
      ctx.currentFilter,
      ctx.currentStack,
      ctx.searchQuery,
      ctx.currentSort,
      ctx.currentSortDirection,
    );
    const [result] = await Promise.all([api.listMusicItems(filters), refreshChildStacks()]);
    items = result.items;
  }

  async function refreshChildStacks(): Promise<void> {
    childStacks = ctx.currentStack !== null ? await api.getStackChildren(ctx.currentStack) : [];
  }

  // ── Stack bar refresh ──────────────────────────────────────────────────────
  let renderedStackBarVersion = 0;
  $effect(() => {
    const version = ctx.stackBarVersion;
    if (version === renderedStackBarVersion) return;
    renderedStackBarVersion = version;
    void refreshStacks();
  });

  async function refreshStacks(): Promise<void> {
    const stacks = await api.listStacks();
    app.send({ type: "STACKS_LOADED", stacks });
  }

  // ── Stack selection & URL sync ─────────────────────────────────────────────
  //
  // The full browsing view (stack, filter, search, sort) lives in the URL so it
  // survives a trip to a release page and back. `syncedHref` is the last href
  // this component wrote; it tells the two effects below which side moved —
  // it is deliberately a plain `let` so writing it can't retrigger them.
  let syncedHref = page.url.pathname + page.url.search;

  const currentView = $derived<ListViewState>({
    filter: ctx.currentFilter,
    search: ctx.searchQuery,
    sort: ctx.currentSort,
    sortDirection: ctx.currentSortDirection,
  });

  /** The list path for the machine's stack scope, or null if we can't name it yet. */
  function listPathFor(stackId: number | null): string | null {
    if (stackId === null) return "/";
    const stack = ctx.stacks.find((s) => s.id === stackId);
    if (stack) return buildStackPath(stack.id, stack.name);
    // Stacks haven't loaded yet — only reuse the address bar if it already
    // points at this stack, otherwise we'd invent a wrong slug.
    return stackIdFromListPath(page.url.pathname) === stackId ? page.url.pathname : null;
  }

  const listPath = $derived(listPathFor(ctx.currentStack));

  /** The current view as a URL — what the release page links back to. */
  const listHref = $derived(
    listPath === null ? null : buildListHref(listPath, currentView, ctx.currentStack),
  );

  /**
   * Point the address bar at `href`.
   *
   * These are real navigations rather than shallow routing (`pushState`/
   * `replaceState`): a shallow entry comes back from a release page carrying the
   * *old* URL and payload, which is exactly how back used to land on the home
   * list. Neither list load reads the query string, so SvelteKit skips re-running
   * it when only the browsing state changes — a filter or keystroke costs no
   * server round trip.
   */
  function navigateTo(href: string, options: { replace: boolean }): void {
    syncedHref = href;
    void goto(href, { replaceState: options.replace, noScroll: true, keepFocus: true });
  }

  /** Move to another stack scope — a real move between views, so back can undo it. */
  function navigateToScope(): void {
    if (listHref === null) return;
    navigateTo(listHref, { replace: false });
  }

  function selectStack(stackId: number): void {
    // Send first: the machine's post-event context is the view we navigate to.
    app.send({ type: "STACK_SELECTED", stackId });
    navigateToScope();
  }

  function selectAllStacks(): void {
    app.send({ type: "STACK_SELECTED_ALL" });
    navigateToScope();
  }

  // Machine → URL: keep the address bar describing the current view. Filter,
  // search and sort changes replace the history entry so back doesn't have to
  // step through every keystroke.
  $effect(() => {
    const href = listHref;
    if (href === null || href === syncedHref) return;
    navigateTo(href, { replace: true });
  });

  // URL → machine: the address bar moved without us (browser back/forward, or a
  // link into another list view), so adopt whatever view it now describes.
  $effect(() => {
    const href = page.url.pathname + page.url.search;
    if (href === syncedHref) return;
    syncedHref = href;

    const stackId = stackIdFromListPath(page.url.pathname);
    const view = parseListViewState(page.url.searchParams, stackId);
    app.send({
      type: "VIEW_RESTORED",
      stackId,
      filter: view.filter,
      searchQuery: view.search,
      sort: view.sort,
      sortDirection: view.sortDirection,
    });
  });

  function buildBreadcrumbTrail(
    stackId: number,
    stacks: StackWithCount[],
  ): Array<{ id: number; name: string }> {
    const trail: Array<{ id: number; name: string }> = [];
    let current = stackId;
    const visited = new Set<number>();

    while (true) {
      const stack = stacks.find((s) => s.id === current);
      if (!stack || visited.has(current)) break;
      visited.add(current);
      trail.unshift({ id: stack.id, name: stack.name });
      if (stack.parent_stack_ids.length === 0) break;
      current = stack.parent_stack_ids[0];
    }

    return trail;
  }

  // ── Item actions ───────────────────────────────────────────────────────────
  async function onStatusChanged(itemId: number, status: ListenStatus): Promise<void> {
    const result = await api.updateListenStatus(itemId, status);
    app.send({ type: "LIST_REFRESH" });

    if (status === "listened" && result?.suggestion) {
      suggestion = result.suggestion;
      suggestionSourceId = itemId;
    }
  }

  async function onDelete(itemId: number): Promise<void> {
    items = items.filter((item) => item.id !== itemId);
    await api.deleteMusicItem(itemId);
  }

  async function onReorder(entries: string[]): Promise<void> {
    const contextKey = buildContextKey(ctx.currentFilter, ctx.currentStack);
    try {
      await api.saveOrderEntries(contextKey, entries);
    } catch (error) {
      console.error("Failed to persist reordered items:", error);
      app.send({ type: "LIST_REFRESH" });
      alert("Failed to save the new order. Please try again.");
    }
  }

  async function deleteStackById(stackId: number): Promise<void> {
    const stack = ctx.stacks.find((candidate) => candidate.id === stackId);
    const stackName = stack?.name ?? "this stack";
    if (!confirm(`Delete "${stackName}"? Links won't be deleted, just untagged.`)) {
      return;
    }

    await api.deleteStack(stackId);
    app.send({ type: "STACK_DELETED", stackId });
  }

  /**
   * Slot-machine sweep across the visible cards before Pick One settles on the
   * winner. Skipped for reduced motion, tiny lists, or when the picked item
   * isn't rendered in the current view.
   */
  async function rouletteToCard(targetId: number): Promise<void> {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const cards = [...document.querySelectorAll<HTMLElement>(".music-card")];
    const target = document.querySelector<HTMLElement>(`.music-card[data-item-id="${targetId}"]`);
    if (cards.length < 2 || !target) {
      return;
    }

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const clear = () => {
      for (const card of cards) card.classList.remove("music-card--roulette");
    };

    const steps = Math.min(8, cards.length + 3);
    for (let i = 0; i < steps; i++) {
      clear();
      const card = cards[Math.floor(Math.random() * cards.length)];
      card.classList.add("music-card--roulette");
      card.scrollIntoView({ block: "nearest" });
      await wait(55 + i * 16);
    }

    clear();
    target.classList.add("music-card--roulette");
    target.scrollIntoView({ block: "nearest" });
    await wait(320);
    target.classList.remove("music-card--roulette");
  }

  async function pickRandom(rating: number | null = null): Promise<{ id: number } | null> {
    const filters = buildMusicItemFilters("to-listen", ctx.currentStack);
    const result = await api.listMusicItems(filters);
    const pool =
      rating === null
        ? result.items
        : result.items.filter((item) => normalizeStarRating(item.rating) === rating);
    if (pool.length === 0) {
      return null;
    }
    const picked = pool[Math.floor(Math.random() * pool.length)];
    await rouletteToCard(picked.id);
    await goto(buildReleaseHref(picked.id, listHref));
    return picked;
  }
</script>

<svelte:head>
  <title>On The Beach</title>
  {#each PRIMARY_FEEDS as feed (feed.key)}
    <link
      rel="alternate"
      type="application/rss+xml"
      title={buildPrimaryFeedTitle(feed.key)}
      href={buildPrimaryFeedHref(feed.key)}
    />
  {/each}
  {#each ctx.stacks as stack (stack.id)}
    <link
      rel="alternate"
      type="application/rss+xml"
      title={buildStackFeedTitle(stack.name)}
      href={buildStackFeedHref(stack.id)}
      data-rss-feed-link={stack.id}
      data-rss-active-feed={ctx.currentStack === stack.id ? "true" : undefined}
    />
  {/each}
</svelte:head>

<main id="main" class="main">
  <AddForm
    bind:this={addFormComponent}
    {form}
    stacks={ctx.stacks}
    appReady={ctx.isReady}
    onStackCreated={refreshStacks}
    onItemCreated={() => app.send({ type: "ITEM_CREATED" })}
    onSearch={(query) => app.send({ type: "SEARCH_UPDATED", query })}
  />

  <section class="stack-section">
    <StackBar
      stacks={ctx.stacks}
      currentStack={ctx.currentStack}
      searchQuery={ctx.searchQuery}
      manageOpen={ctx.stackManageOpen}
      onSelectAll={selectAllStacks}
      onSelectStack={selectStack}
      onDeleteStack={deleteStackById}
      onToggleManage={() => app.send({ type: "STACK_MANAGE_TOGGLED" })}
    />
    <StackManagePanel
      open={ctx.stackManageOpen}
      stacks={ctx.stacks}
      searchQuery={ctx.searchQuery}
      onStacksChanged={refreshStacks}
      onDeleteStack={deleteStackById}
    />
  </section>

  <BrowseControls {app} onPickRandom={pickRandom} />

  <MusicList
    {items}
    {childStacks}
    {breadcrumbs}
    stacks={ctx.stacks}
    currentStack={ctx.currentStack}
    currentFilter={ctx.currentFilter}
    searchQuery={ctx.searchQuery}
    backHref={listHref}
    {orderLocked}
    onSelectStack={selectStack}
    onRefreshList={() => app.send({ type: "LIST_REFRESH" })}
    onStacksChanged={refreshStacks}
    {onStatusChanged}
    {onDelete}
    {onReorder}
  />
</main>

<LinkPickerModal
  {form}
  onEnterManually={(candidate) => {
    if (candidate) addFormComponent?.populateFromCandidate(candidate);
  }}
/>

<SuggestionPickerModal
  {suggestion}
  sourceItemId={suggestionSourceId}
  onAccepted={() => app.send({ type: "LIST_REFRESH" })}
  onClosed={() => {
    suggestion = null;
    suggestionSourceId = null;
  }}
/>

<AddLoadingOverlay {form} />
