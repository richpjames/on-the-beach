<script lang="ts">
  import { goto, pushState } from "$app/navigation";
  import { page } from "$app/state";
  import { onMount, untrack } from "svelte";
  import type { ItemSuggestion, ListenStatus, MusicItemFull, StackWithCount } from "../../types";
  import { buildContextKey, buildMusicItemFilters } from "../../ui/domain/music-list";
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

  // The machine is seeded from the SSR payload once per page instance; from
  // then on machine context is the source of truth (matching the old shell).
  // svelte-ignore state_referenced_locally
  const app = useMachine(appMachine, {
    input: { stacks: data.stacks, currentStack: data.stackId },
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
  function slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function selectStack(stackId: number): void {
    app.send({ type: "STACK_SELECTED", stackId });
    const stack = ctx.stacks.find((s) => s.id === stackId);
    if (stack) {
      pushState(`/s/${stack.id}/${slugify(stack.name)}`, {});
    }
  }

  function selectAllStacks(): void {
    app.send({ type: "STACK_SELECTED_ALL" });
    pushState("/", {});
  }

  // Back/forward across shallow-pushed stack URLs: keep the machine in sync
  // with the address bar.
  $effect(() => {
    const match = page.url.pathname.match(/^\/s\/(\d+)\//);
    const urlStackId = match ? Number(match[1]) : null;
    const currentStack = untrack(() => ctx.currentStack);
    if (urlStackId === currentStack) return;
    if (urlStackId !== null) {
      app.send({ type: "STACK_SELECTED", stackId: urlStackId });
    } else {
      app.send({ type: "STACK_SELECTED_ALL" });
    }
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

  async function pickRandom(): Promise<{ id: number } | null> {
    const filters = buildMusicItemFilters("to-listen", ctx.currentStack);
    const result = await api.listMusicItems(filters);
    if (result.items.length === 0) {
      return null;
    }
    const picked = result.items[Math.floor(Math.random() * result.items.length)];
    await goto(`/r/${picked.id}`);
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
