import { ApiClient } from "./services/api-client";
import Sortable from "sortablejs";
import type { AddFormValues as AddFormValuesInput } from "./ui/domain/add-form";
import type {
  LinkReleaseCandidate,
  ListenStatus,
  MusicItemFull,
  MusicItemSort,
  MusicItemSortDirection,
  StackWithCount,
} from "./types";
import { getCoverScanErrorMessage } from "./ui/domain/add-form";
import { buildContextKey, buildMusicItemFilters } from "./ui/domain/music-list";
import { constrainDimensions } from "./ui/domain/scan";
import {
  clearStarRatingPreview,
  resolveStarRatingHover,
  resolveStarRatingInteraction,
  setStarRatingPending,
  setStarRatingPreview,
  setStarRatingValue,
} from "./ui/components/star-rating";
import { createActor } from "xstate";
import { addFormMachine, RECORD_DURATION_MS } from "./ui/state/add-form-machine";
import { appMachine } from "./ui/state/app-machine";
import {
  escapeHtml,
  renderAddFormStackChips,
  renderAmbiguousLinkCandidates,
  renderBreadcrumbs,
  renderChildStackPicker,
  renderFolderRow,
  renderMusicList,
  renderStackDropdownContent,
  renderStackManageList,
  renderStackRenameEditor,
} from "./ui/view/templates";
import { buildStackFeedHref, buildStackFeedTitle } from "../shared/rss";

interface ItemContext {
  card: HTMLElement;
  itemId: number;
}

interface StackDropdownOptions {
  container: HTMLElement;
  selectedStackIds: Set<number>;
  onToggle: (stackId: number, checked: boolean) => Promise<void> | void;
  onCreate: (name: string) => Promise<void>;
  onClose?: () => void;
  shouldIgnoreOutsideClick?: (target: HTMLElement) => boolean;
}

// Module-level actors and state
const api = new ApiClient();
const appActor = createActor(appMachine).start();
const addFormActor = createActor(addFormMachine, { input: { api } }).start();

let musicListEl: HTMLElement | null = null;
let musicListScrollbarEl: HTMLElement | null = null;
let musicListTrackEl: HTMLElement | null = null;
let musicListThumbEl: HTMLElement | null = null;
let linkPickerListEl: HTMLElement | null = null;
let linkPickerScrollbarEl: HTMLElement | null = null;
let linkPickerTrackEl: HTMLElement | null = null;
let linkPickerThumbEl: HTMLElement | null = null;
let linkPickerThumbDrag: { startY: number; startTop: number } | null = null;
let stackBarEl: HTMLElement | null = null;
let stackBarScrollbarEl: HTMLElement | null = null;
let stackBarTrackEl: HTMLElement | null = null;
let stackBarThumbEl: HTMLElement | null = null;
let activeStarRatingPreviewEl: HTMLElement | null = null;
let listThumbDrag: { startY: number; startTop: number } | null = null;
let stackThumbDrag: { startX: number; startLeft: number } | null = null;
let activeItemActionMenuCleanup: (() => void) | null = null;
let activeStackDropdownCleanup: ((skipOnClose?: boolean) => void) | null = null;
let musicListSortable: Sortable | null = null;
let musicListReorderMediaQuery: MediaQueryList | null = null;
let isReordering = false;

const handleMusicListReorderMediaChange = (): void => {
  syncMusicListReorderMode();
};

function appCtx() {
  return appActor.getSnapshot().context;
}

function formCtx() {
  return addFormActor.getSnapshot().context;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildStackPath(stack: { id: number; name: string }): string {
  return `/s/${stack.id}/${slugify(stack.name)}`;
}

function selectStack(stackId: number): void {
  appActor.send({ type: "STACK_SELECTED", stackId });
  const stack = appCtx().stacks.find((s) => s.id === stackId);
  if (stack) {
    history.pushState({}, "", buildStackPath(stack));
  }
}

function selectAllStacks(): void {
  appActor.send({ type: "STACK_SELECTED_ALL" });
  history.pushState({}, "", "/");
}

export async function initialize(): Promise<void> {
  setupAddForm();
  appActor.send({ type: "APP_READY" });

  // Check for items that were moved back to to-listen by the reminder cron
  api
    .getPendingReminders()
    .then((items) => {
      if (items.length > 0) {
        appActor.send({ type: "REMINDERS_READY", itemIds: items.map((i) => i.id) });
      }
    })
    .catch(() => {
      // Non-critical — ignore failures silently
    });

  document.addEventListener("navigated-to-main", () => {
    appActor.send({ type: "LIST_REFRESH" });
  });

  document.addEventListener("navigate-to-stack", (event) => {
    const { stackId } = (event as CustomEvent<{ stackId: number | null }>).detail;
    if (stackId !== null) {
      appActor.send({ type: "STACK_SELECTED", stackId });
    } else {
      appActor.send({ type: "STACK_SELECTED_ALL" });
    }
  });

  const serverState = readServerState();
  if (serverState) {
    appActor.send({
      type: "STACKS_LOADED",
      stacks: serverState.stacks,
    });
  }

  initializeUI(serverState !== null);

  // Initialize stack selection from URL on page load — must run after initializeUI()
  // sets up the XState subscription, as XState v5 does not emit to new subscribers
  // retroactively.
  const stackMatch = location.pathname.match(/^\/s\/(\d+)\//);
  if (stackMatch) {
    appActor.send({ type: "STACK_SELECTED", stackId: Number(stackMatch[1]) });
  }

  const versionEl = document.getElementById("app-version");
  if (versionEl) {
    versionEl.textContent = `v${__APP_VERSION__}`;
  }
}

function readServerState(): { stacks: StackWithCount[] } | null {
  const el = document.getElementById("__initial_state__");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as { stacks: StackWithCount[] };
  } catch {
    return null;
  }
}

function initializeUI(hasServerData: boolean): void {
  setupFilterBar();
  setupBrowseControls();
  setupStackBar();
  setupStackManagePanel();

  setupLinkPicker();
  setupEventDelegation();
  setupMusicListReorder();
  setupCustomListScrollbar();
  setupCustomStackScrollbar();
  setupCustomLinkPickerScrollbar();

  // Folder row click → navigate into child stack
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    // Navigate into folder
    const folderRow = target.closest(".folder-row");
    if (
      folderRow instanceof HTMLElement &&
      folderRow.dataset.childStackId &&
      !target.closest("button")
    ) {
      const stackId = Number(folderRow.dataset.childStackId);
      if (Number.isInteger(stackId) && stackId > 0) {
        selectStack(stackId);
      }
      return;
    }

    // Breadcrumb click
    const breadcrumbBtn = target.closest("[data-breadcrumb-stack]");
    if (breadcrumbBtn instanceof HTMLElement && breadcrumbBtn.dataset.breadcrumbStack) {
      const stackId = Number(breadcrumbBtn.dataset.breadcrumbStack);
      if (Number.isInteger(stackId) && stackId > 0) {
        selectStack(stackId);
      }
      return;
    }
  });

  // Remove child stack from parent
  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const removeBtn = target.closest("[data-remove-child-stack]");
    if (!(removeBtn instanceof HTMLElement)) return;

    const childStackId = Number(removeBtn.dataset.removeChildStack);
    const currentStack = appCtx().currentStack;
    if (!Number.isInteger(childStackId) || currentStack === null) return;

    try {
      await api.removeStackParent(childStackId, currentStack);
      await renderMusicListView();
    } catch (error) {
      console.error("Failed to remove child stack:", error);
    }
  });

  // Add-list button click → show picker
  document.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;

    if (target.closest("#add-child-stack-btn")) {
      const currentStack = appCtx().currentStack;
      if (currentStack === null) return;

      // Toggle picker
      const existingPicker = document.querySelector(".child-stack-picker");
      if (existingPicker) {
        existingPicker.remove();
        return;
      }

      const existingChildren = await api.getStackChildren(currentStack);
      const existingChildIds = new Set(existingChildren.map((c) => c.id));

      const candidates = appCtx().stacks.filter(
        (s) => s.id !== currentStack && !existingChildIds.has(s.id),
      );

      const picker = document.createElement("div");
      picker.className = "child-stack-picker";
      picker.innerHTML = renderChildStackPicker(candidates);
      const btn = document.getElementById("add-child-stack-btn");
      if (btn) btn.after(picker);
      return;
    }

    // Picker item click → add child stack
    const pickerItem = target.closest("[data-picker-stack-id]");
    if (pickerItem instanceof HTMLElement) {
      const childStackId = Number(pickerItem.dataset.pickerStackId);
      const currentStack = appCtx().currentStack;
      if (!Number.isInteger(childStackId) || currentStack === null) return;

      try {
        await api.addStackParent(childStackId, currentStack);
        document.querySelector(".child-stack-picker")?.remove();
        await renderMusicListView();
      } catch (error) {
        console.error("Failed to add child stack:", error);
        alert("Failed to add list. It may create a cycle.");
      }
      return;
    }
  });

  // Close picker on Escape
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelector(".child-stack-picker")?.remove();
    }
  });

  if (hasServerData) {
    syncStackFeedLinks();
    requestAnimationFrame(() => {
      syncCustomListScrollbar();
      syncCustomStackScrollbar();
    });
  }

  // If server data exists, skip initial render by pretending versions already matched
  let prevListVersion = hasServerData ? 0 : -1;
  let prevStackBarVersion = hasServerData ? 0 : -1;

  appActor.subscribe((snapshot) => {
    const ctx = snapshot.context;

    // Browse panels
    const searchPanel = document.getElementById("browse-search-panel");
    const sortPanel = document.getElementById("browse-sort-panel");
    const searchToggle = document.getElementById("browse-search-toggle");
    const sortToggle = document.getElementById("browse-sort-toggle");
    searchPanel?.classList.toggle("is-open", ctx.searchPanelOpen);
    sortPanel?.classList.toggle("is-open", ctx.sortPanelOpen);
    searchToggle?.setAttribute("aria-expanded", String(ctx.searchPanelOpen));
    sortToggle?.setAttribute("aria-expanded", String(ctx.sortPanelOpen));

    // Filter bar active state
    const filterBar = document.getElementById("filter-bar");
    if (filterBar) {
      filterBar.querySelectorAll(".filter-btn").forEach((btn) => {
        const btnFilter = (btn as HTMLElement).dataset.filter;
        btn.classList.toggle("active", btnFilter === ctx.currentFilter);
      });
    }

    // Re-render when versions increment
    if (ctx.listVersion !== prevListVersion) {
      prevListVersion = ctx.listVersion;
      void renderMusicListView();
    }
    if (ctx.stackBarVersion !== prevStackBarVersion) {
      prevStackBarVersion = ctx.stackBarVersion;
      void renderStackBar();
    }
  });
}

export function setupAddForm(): void {
  addFormActor.send({ type: "INITIALIZED" });

  const form = document.getElementById("add-form");
  const submitButton = document.getElementById("add-form-submit");
  if (!(form instanceof HTMLFormElement) || !(submitButton instanceof HTMLButtonElement)) {
    return;
  }

  const scanButton = document.getElementById("add-form-scan-btn");
  const scanInput = document.getElementById("scan-file-input");

  submitButton.disabled = false;

  if (scanButton instanceof HTMLButtonElement && scanInput instanceof HTMLInputElement) {
    scanButton.addEventListener("click", () => {
      if (formCtx().scanState === "scanning") {
        return;
      }
      scanInput.click();
    });
  }

  const recognizeButton = document.getElementById("add-form-recognize-btn");
  if (recognizeButton instanceof HTMLButtonElement) {
    recognizeButton.addEventListener("click", () => {
      const ctx = formCtx();
      if (ctx.recognizeState === "recording") {
        addFormActor.send({ type: "STOP_RECORDING" });
      } else {
        addFormActor.send({ type: "RECOGNIZE_CLICKED" });
      }
    });
  }

  if (scanInput instanceof HTMLInputElement) {
    scanInput.addEventListener("change", async () => {
      const file = scanInput.files?.[0];
      if (!file) return;
      const imageBase64 = await encodeScanImage(file);
      addFormActor.send({ type: "SCAN_FILE_SELECTED", imageBase64 });
      scanInput.value = "";
    });
  }

  document.getElementById("add-form-stack-btn")?.addEventListener("click", () => {
    void showAddFormStackDropdown();
  });

  document.getElementById("add-form-stack-chips")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target.dataset.removeStack) {
      return;
    }

    addFormActor.send({
      type: "STACK_REMOVED",
      stackId: Number(target.dataset.removeStack),
    });
    renderAddFormStackChipsView();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const urlInput = form.querySelector<HTMLInputElement>('input[name="url"]');
    const url = urlInput?.value.trim() ?? "";

    if (!appCtx().isReady) {
      alert("App is still loading. Please try again in a moment.");
      return;
    }
    addFormActor.send({
      type: "SUBMIT_CLICKED",
      url,
      pendingValues: readAddFormValues(new FormData(form)),
    });
  });

  let countdownInterval: ReturnType<typeof setInterval> | null = null;
  let prevRecognizeState = "idle";

  addFormActor.subscribe((snapshot) => {
    const ctx = snapshot.context;
    const formEl = document.getElementById("add-form") as HTMLFormElement | null;
    if (!formEl) return;

    // Secondary fields
    const secondary = formEl.querySelector<HTMLElement>(".add-form__secondary");
    if (secondary) secondary.hidden = !ctx.showSecondaryFields;

    // Submit button
    const submitBtn = document.getElementById("add-form-submit") as HTMLButtonElement | null;
    if (submitBtn) {
      submitBtn.disabled = ctx.submitState === "submitting";
      submitBtn.textContent = ctx.submitState === "submitting" ? "Adding..." : "Add";
    }

    // Scan button
    const scanBtn = document.getElementById("add-form-scan-btn") as HTMLButtonElement | null;
    if (scanBtn) {
      scanBtn.disabled = ctx.scanState === "scanning";
    }

    // Recognize button
    const recognizeBtn = document.getElementById(
      "add-form-recognize-btn",
    ) as HTMLButtonElement | null;
    if (recognizeBtn) {
      const isActive = ctx.recognizeState !== "idle";
      recognizeBtn.disabled = ctx.submitState === "submitting";
      recognizeBtn.classList.toggle("is-recording", ctx.recognizeState === "recording");
      recognizeBtn.classList.toggle("is-recognizing", ctx.recognizeState === "recognizing");

      if (ctx.recognizeState === "recording" && prevRecognizeState !== "recording") {
        let secondsLeft = Math.round(RECORD_DURATION_MS / 1000);
        recognizeBtn.textContent = `${secondsLeft}s`;
        countdownInterval = setInterval(() => {
          secondsLeft -= 1;
          if (secondsLeft > 0) recognizeBtn.textContent = `${secondsLeft}s`;
        }, 1000);
      } else if (ctx.recognizeState !== "recording" && prevRecognizeState === "recording") {
        if (countdownInterval) {
          clearInterval(countdownInterval);
          countdownInterval = null;
        }
        recognizeBtn.textContent = "Listen";
      }
    }
    prevRecognizeState = ctx.recognizeState;

    // Loading overlay
    const overlay = document.getElementById("add-loading-overlay");
    const showOverlay =
      ctx.submitState === "submitting" ||
      ctx.scanState === "scanning" ||
      ctx.recognizeState === "recognizing";
    overlay?.classList.toggle("is-visible", showOverlay);
    overlay?.setAttribute("aria-hidden", showOverlay ? "false" : "true");
    const statusEl = document.getElementById("add-loading-status");
    if (statusEl) {
      if (ctx.scanState === "scanning") {
        statusEl.textContent = "Scanning cover...";
      } else if (ctx.recognizeState === "recognizing") {
        statusEl.textContent = "Identifying song...";
      } else {
        statusEl.textContent = "Adding to collection...";
      }
    }

    // Scan results — populate form fields when available
    if (ctx.scanResult) {
      const artistInput = formEl.querySelector<HTMLInputElement>('input[name="artist"]');
      const titleInput = formEl.querySelector<HTMLInputElement>('input[name="title"]');
      const artworkInput = formEl.querySelector<HTMLInputElement>('input[name="artworkUrl"]');
      const detailsEl = formEl.querySelector<HTMLDetailsElement>(".add-form__details");
      if (artistInput && ctx.scanResult.artist) {
        artistInput.value = ctx.scanResult.artist;
        artistInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (titleInput && ctx.scanResult.title) {
        titleInput.value = ctx.scanResult.title;
        titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (artworkInput && ctx.scanResult.artworkUrl) {
        artworkInput.value = ctx.scanResult.artworkUrl;
      }
      if (detailsEl && (ctx.scanResult.artist || ctx.scanResult.title)) detailsEl.open = true;
      // Consume the result
      addFormActor.send({ type: "SCAN_RESULT_CONSUMED" });
    }

    // Scan error
    if (ctx.scanError) {
      alert(getCoverScanErrorMessage(new Error(ctx.scanError)));
      addFormActor.send({ type: "SCAN_RESULT_CONSUMED" });
    }

    // Recognize error
    if (ctx.recognizeError) {
      alert(ctx.recognizeError);
      addFormActor.send({ type: "RECOGNIZE_ERROR_CONSUMED" });
    }

    // Link picker
    const modal = document.getElementById("link-picker-modal");
    if (modal instanceof HTMLElement) {
      if (snapshot.matches("linkPickerOpen") && ctx.linkPicker) {
        renderLinkPickerFromContext(ctx.linkPicker);
      } else {
        modal.hidden = true;
      }
    }

    // On success: createdItemId is set — reset form and notify appMachine
    if (ctx.createdItemId != null) {
      formEl.reset();
      const sec = formEl.querySelector<HTMLElement>(".add-form__secondary");
      if (sec) sec.hidden = true;
      renderAddFormStackChipsView();
      appActor.send({ type: "ITEM_CREATED" });
      addFormActor.send({ type: "CLEAR_CREATED_ITEM" });
    }
  });
}

function readAddFormValues(formData: FormData): AddFormValuesInput {
  return {
    url: readStringField(formData, "url"),
    title: readStringField(formData, "title"),
    artist: readStringField(formData, "artist"),
    itemType: readStringField(formData, "itemType") || "album",
    label: readStringField(formData, "label"),
    year: readStringField(formData, "year"),
    country: readStringField(formData, "country"),
    genre: readStringField(formData, "genre"),
    catalogueNumber: readStringField(formData, "catalogueNumber"),
    notes: readStringField(formData, "notes"),
    artworkUrl: readStringField(formData, "artworkUrl"),
  };
}

function readStringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function setupLinkPicker(): void {
  const modal = document.getElementById("link-picker-modal");
  const list = document.getElementById("link-picker-list");
  const submit = document.getElementById("link-picker-submit");
  const manual = document.getElementById("link-picker-manual");
  const cancel = document.getElementById("link-picker-cancel");
  const selectAll = document.getElementById("link-picker-select-all");

  if (
    !(modal instanceof HTMLElement) ||
    !(list instanceof HTMLElement) ||
    !(submit instanceof HTMLButtonElement) ||
    !(manual instanceof HTMLButtonElement) ||
    !(cancel instanceof HTMLButtonElement) ||
    !(selectAll instanceof HTMLButtonElement)
  ) {
    return;
  }

  selectAll.addEventListener("click", () => {
    addFormActor.send({ type: "ALL_CANDIDATES_SELECTED" });
  });

  list.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest(
      "[data-candidate-id]",
    ) as HTMLElement | null;
    if (!target) return;
    addFormActor.send({
      type: "CANDIDATE_TOGGLED",
      candidateId: target.dataset.candidateId ?? "",
    });
  });

  submit.addEventListener("click", () => {
    addFormActor.send({ type: "CANDIDATE_SUBMITTED" });
  });

  manual.addEventListener("click", () => {
    const lp = formCtx().linkPicker;
    const firstId = lp?.selectedCandidateIds[0];
    const candidate = firstId ? lp?.candidates.find((c) => c.candidateId === firstId) : undefined;
    if (candidate) populateAddFormFromCandidate(candidate);
    addFormActor.send({ type: "ENTER_MANUALLY" });
    const form = document.getElementById("add-form") as HTMLFormElement | null;
    form?.querySelector<HTMLInputElement>('input[name="artist"]')?.focus();
  });

  cancel.addEventListener("click", () => {
    addFormActor.send({ type: "LINK_PICKER_CANCELLED" });
  });

  modal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.dataset.linkPickerClose === "true") {
      addFormActor.send({ type: "LINK_PICKER_CANCELLED" });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && formCtx().linkPicker) {
      addFormActor.send({ type: "LINK_PICKER_CANCELLED" });
    }
  });
}

function renderLinkPickerFromContext(linkPicker: {
  url: string;
  message: string;
  candidates: LinkReleaseCandidate[];
  selectedCandidateIds: string[];
  pendingValues: AddFormValuesInput;
}): void {
  const modal = document.getElementById("link-picker-modal");
  const list = document.getElementById("link-picker-list");
  const url = document.getElementById("link-picker-url");
  const message = document.getElementById("link-picker-message");
  const submit = document.getElementById("link-picker-submit");

  if (
    !(modal instanceof HTMLElement) ||
    !(list instanceof HTMLElement) ||
    !(url instanceof HTMLElement) ||
    !(message instanceof HTMLElement) ||
    !(submit instanceof HTMLButtonElement)
  )
    return;

  modal.hidden = false;
  url.textContent = linkPicker.url;
  message.textContent = linkPicker.message;
  list.innerHTML = renderAmbiguousLinkCandidates(
    linkPicker.candidates,
    linkPicker.selectedCandidateIds,
  );
  submit.disabled = linkPicker.selectedCandidateIds.length === 0;
  if (linkPickerListEl) {
    linkPickerListEl.scrollTop = 0;
  }
  syncCustomLinkPickerScrollbar();
}

function populateAddFormFromCandidate(candidate: LinkReleaseCandidate): void {
  const artistInput = document.querySelector<HTMLInputElement>('#add-form input[name="artist"]');
  const titleInput = document.querySelector<HTMLInputElement>('#add-form input[name="title"]');
  const itemTypeInput = document.querySelector<HTMLSelectElement>(
    '#add-form select[name="itemType"]',
  );

  if (artistInput && candidate.artist) {
    artistInput.value = candidate.artist;
  }

  if (titleInput) {
    titleInput.value = candidate.title;
  }

  if (itemTypeInput && candidate.itemType) {
    itemTypeInput.value = candidate.itemType;
  }
}

async function encodeScanImage(file: File): Promise<string> {
  const imageDataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(imageDataUrl);
  const { width, height } = constrainDimensions(image.width, image.height, 1024);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context unavailable");
  }

  context.drawImage(image, 0, 0, width, height);
  const encoded = canvas.toDataURL("image/jpeg", 0.85);
  const parts = encoded.split(",", 2);
  if (parts.length !== 2 || !parts[1]) {
    throw new Error("Failed to encode scan image");
  }

  return parts[1];
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Failed to read image file"));
        return;
      }

      resolve(reader.result);
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read image file"));
    };

    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image"));
    image.src = dataUrl;
  });
}

function syncDateListenedOption(): void {
  const opt = document.getElementById("sort-option-date-listened");
  const sel = document.getElementById("browse-sort");
  if (!(opt instanceof HTMLOptionElement) || !(sel instanceof HTMLSelectElement)) return;
  const isListened = appCtx().currentFilter === "listened";
  opt.hidden = !isListened;
  // If date-listened is selected but filter changed away from listened, reset to date-added
  if (!isListened && sel.value === "date-listened") {
    sel.value = "date-added";
    appActor.send({ type: "SORT_UPDATED", sort: "date-added" });
    const btn = document.getElementById("sort-direction-btn");
    if (btn instanceof HTMLButtonElement) {
      updateSortDirectionBtn(btn, "date-added", appCtx().currentSortDirection);
    }
  }
}

function setupFilterBar(): void {
  const filterBar = document.getElementById("filter-bar");
  if (!filterBar) {
    return;
  }

  filterBar.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("filter-btn")) {
      return;
    }

    appActor.send({
      type: "FILTER_SELECTED",
      filter: target.dataset.filter as ListenStatus | "all" | "scheduled",
    });
    syncDateListenedOption();
  });
}

function updateSortDirectionBtn(
  btn: HTMLButtonElement,
  sort: MusicItemSort,
  direction: MusicItemSortDirection,
): void {
  const isDate = sort === "date-added" || sort === "date-listened";
  const isRating = sort === "star-rating";
  if (isDate) {
    btn.textContent = direction === "desc" ? "↓ Newest first" : "↑ Oldest first";
    btn.setAttribute(
      "aria-label",
      direction === "desc" ? "Sort direction: newest first" : "Sort direction: oldest first",
    );
  } else if (isRating) {
    btn.textContent = direction === "desc" ? "↓ Highest first" : "↑ Lowest first";
    btn.setAttribute(
      "aria-label",
      direction === "desc" ? "Sort direction: highest first" : "Sort direction: lowest first",
    );
  } else {
    btn.textContent = direction === "asc" ? "↑ A–Z" : "↓ Z–A";
    btn.setAttribute(
      "aria-label",
      direction === "asc" ? "Sort direction: A to Z" : "Sort direction: Z to A",
    );
  }
  btn.dataset.direction = direction;
}

function setupBrowseControls(): void {
  const browseTools = document.querySelector(".browse-tools");
  const searchInput = document.getElementById("browse-search");
  const sortSelect = document.getElementById("browse-sort");
  const searchToggle = document.getElementById("browse-search-toggle");
  const sortToggle = document.getElementById("browse-sort-toggle");

  const searchClearBtn = document.getElementById("search-clear-btn");
  const sortDirectionBtn = document.getElementById("sort-direction-btn");
  const sortOptionDateListened = document.getElementById("sort-option-date-listened");

  if (searchInput instanceof HTMLInputElement) {
    const updateClearBtn = () => {
      if (searchClearBtn) {
        searchClearBtn.style.display = searchInput.value ? "" : "none";
      }
    };

    searchInput.addEventListener("input", () => {
      appActor.send({
        type: "SEARCH_UPDATED",
        query: searchInput.value,
      });
      updateClearBtn();

      if (appCtx().stackManageOpen) {
        void renderStackManagePanel();
      }
    });

    searchClearBtn?.addEventListener("click", () => {
      searchInput.value = "";
      appActor.send({ type: "SEARCH_UPDATED", query: "" });
      updateClearBtn();
      searchInput.focus();
    });
  }

  if (sortSelect instanceof HTMLSelectElement) {
    sortSelect.addEventListener("change", () => {
      const newSort = sortSelect.value as MusicItemSort;
      appActor.send({
        type: "SORT_UPDATED",
        sort: newSort,
      });

      // Show/hide date-listened option
      if (sortOptionDateListened instanceof HTMLOptionElement) {
        sortOptionDateListened.hidden = appCtx().currentFilter !== "listened";
      }

      // Update direction button label
      if (sortDirectionBtn instanceof HTMLButtonElement) {
        updateSortDirectionBtn(sortDirectionBtn, newSort, appCtx().currentSortDirection);
      }
    });
  }

  if (sortDirectionBtn instanceof HTMLButtonElement) {
    sortDirectionBtn.addEventListener("click", () => {
      const next = appCtx().currentSortDirection === "desc" ? "asc" : "desc";
      appActor.send({ type: "SORT_DIRECTION_UPDATED", direction: next });
      updateSortDirectionBtn(sortDirectionBtn, appCtx().currentSort, appCtx().currentSortDirection);
    });
  }

  searchToggle?.addEventListener("click", () => {
    appActor.send({ type: "SEARCH_PANEL_TOGGLED" });
    if (appCtx().searchPanelOpen) {
      requestAnimationFrame(() => {
        if (searchInput instanceof HTMLInputElement) searchInput.focus();
      });
    }
  });

  sortToggle?.addEventListener("click", () => {
    appActor.send({ type: "SORT_PANEL_TOGGLED" });
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !(browseTools instanceof HTMLElement)) return;
    if (!browseTools.contains(target)) {
      appActor.send({ type: "BROWSE_PANELS_CLOSED" });
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      appActor.send({ type: "BROWSE_PANELS_CLOSED" });
    }
  });
}

function getNormalizedSearchQuery(): string {
  return appCtx().searchQuery.trim().toLowerCase();
}

function isBrowseOrderLocked(): boolean {
  return (
    getNormalizedSearchQuery().length > 0 ||
    appCtx().currentSort !== "date-added" ||
    appCtx().currentSortDirection !== "desc"
  );
}

async function renderStackBar(): Promise<void> {
  const stacks = await api.listStacks();
  appActor.send({
    type: "STACKS_LOADED",
    stacks,
  });

  const bar = document.getElementById("stack-bar");
  const manageBtn = document.getElementById("manage-stacks-btn");
  const deleteBtn = document.getElementById("delete-stack-btn");
  if (!bar || !manageBtn) {
    return;
  }

  const allBtn = bar.querySelector('[data-stack="all"]');

  bar.querySelectorAll(".stack-tab[data-stack-id]").forEach((element) => {
    element.remove();
  });

  const searchQuery = getNormalizedSearchQuery();
  const visibleStacks = searchQuery
    ? appCtx().stacks.filter(
        (stack) =>
          stack.id === appCtx().currentStack || stack.name.toLowerCase().includes(searchQuery),
      )
    : appCtx().stacks;

  for (const stack of visibleStacks) {
    const button = document.createElement("button");
    button.className = `stack-tab${appCtx().currentStack === stack.id ? " active" : ""}`;
    button.dataset.stackId = String(stack.id);
    button.textContent = stack.name;
    bar.insertBefore(button, manageBtn);
  }

  if (allBtn) {
    allBtn.className = `stack-tab${appCtx().currentStack === null ? " active" : ""}`;
  }

  if (deleteBtn instanceof HTMLButtonElement) {
    const selectedStack = appCtx().stacks.find((stack) => stack.id === appCtx().currentStack);
    const hasSelection = selectedStack !== undefined;
    deleteBtn.hidden = !hasSelection;
    deleteBtn.disabled = !hasSelection;
    deleteBtn.title = hasSelection ? `Delete "${selectedStack.name}"` : "Delete selected stack";
  }

  syncStackFeedLinks();
  syncCustomStackScrollbar();
  scrollActiveStackTabIntoView();
}

function scrollActiveStackTabIntoView(): void {
  const bar = document.getElementById("stack-bar");
  if (!(bar instanceof HTMLElement)) {
    return;
  }

  const activeBtn = bar.querySelector(".stack-tab.active");
  if (!(activeBtn instanceof HTMLElement)) {
    return;
  }

  const tabLeft = activeBtn.offsetLeft;
  const tabRight = tabLeft + activeBtn.offsetWidth;
  if (tabLeft < bar.scrollLeft) {
    bar.scrollLeft = tabLeft;
  } else if (tabRight > bar.scrollLeft + bar.clientWidth) {
    bar.scrollLeft = tabRight - bar.clientWidth;
  }
}

function syncStackFeedLinks(): void {
  document.head.querySelectorAll("link[data-rss-feed-link]").forEach((element) => {
    element.remove();
  });

  for (const stack of appCtx().stacks) {
    const link = document.createElement("link");
    link.rel = "alternate";
    link.type = "application/rss+xml";
    link.title = buildStackFeedTitle(stack.name);
    link.href = buildStackFeedHref(stack.id);
    link.dataset.rssFeedLink = String(stack.id);
    if (appCtx().currentStack === stack.id) {
      link.dataset.rssActiveFeed = "true";
    }
    document.head.appendChild(link);
  }
}

function setupStackBar(): void {
  const bar = document.getElementById("stack-bar");
  if (!bar) {
    return;
  }

  bar.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const deleteBtn = target.closest("#delete-stack-btn");
    if (deleteBtn) {
      const currentStack = appCtx().currentStack;
      if (currentStack !== null) {
        await deleteStackById(currentStack);
      }
      return;
    }

    const tab = target.closest(".stack-tab") as HTMLElement | null;
    if (!tab || tab.id === "manage-stacks-btn" || tab.id === "delete-stack-btn") {
      return;
    }

    if (tab.dataset.stack === "all") {
      selectAllStacks();
    } else if (tab.dataset.stackId) {
      selectStack(Number(tab.dataset.stackId));
    }
  });
}

function setupCustomStackScrollbar(): void {
  const bar = document.getElementById("stack-bar");
  const scrollbar = document.getElementById("stack-bar-scrollbar");
  const track = document.getElementById("stack-bar-scroll-track");
  const thumb = document.getElementById("stack-bar-scroll-thumb");
  if (
    !(bar instanceof HTMLElement) ||
    !(scrollbar instanceof HTMLElement) ||
    !(track instanceof HTMLElement) ||
    !(thumb instanceof HTMLElement)
  ) {
    return;
  }

  stackBarEl = bar;
  stackBarScrollbarEl = scrollbar;
  stackBarTrackEl = track;
  stackBarThumbEl = thumb;

  const leftButton = scrollbar.querySelector('[data-stack-scroll-btn="left"]');
  const rightButton = scrollbar.querySelector('[data-stack-scroll-btn="right"]');

  const scrollByStep = (delta: number): void => {
    bar.scrollBy({ left: delta, behavior: "auto" });
  };

  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  const startRepeatScroll = (delta: number): void => {
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }

    repeatTimer = setInterval(() => {
      scrollByStep(delta);
    }, 60);
  };

  const stopRepeatScroll = (): void => {
    if (!repeatTimer) {
      return;
    }

    clearInterval(repeatTimer);
    repeatTimer = null;
  };

  const bindScrollButton = (button: Element | null, delta: number): void => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.addEventListener("click", () => {
      scrollByStep(delta);
    });
    button.addEventListener("mousedown", () => {
      startRepeatScroll(delta);
    });
    button.addEventListener("mouseup", stopRepeatScroll);
    button.addEventListener("mouseleave", stopRepeatScroll);
  };

  bindScrollButton(leftButton, -80);
  bindScrollButton(rightButton, 80);
  document.addEventListener("mouseup", stopRepeatScroll);
  window.addEventListener("blur", stopRepeatScroll);

  track.addEventListener("mousedown", (event) => {
    if (event.target === thumb) {
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const clickOffset = event.clientX - trackRect.left;
    const thumbLeft = thumbRect.left - trackRect.left;
    const direction = clickOffset < thumbLeft ? -1 : 1;

    bar.scrollBy({ left: direction * Math.max(80, bar.clientWidth * 0.8), behavior: "auto" });
  });

  const onDragMove = (event: MouseEvent): void => {
    if (!stackThumbDrag || !stackBarEl || !stackBarTrackEl || !stackBarThumbEl) {
      return;
    }

    const scrollRange = stackBarEl.scrollWidth - stackBarEl.clientWidth;
    if (scrollRange <= 0) {
      return;
    }

    const trackWidth = stackBarTrackEl.clientWidth;
    const thumbWidth = stackBarThumbEl.offsetWidth;
    const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
    if (maxThumbLeft <= 0) {
      return;
    }

    const nextLeft = Math.max(
      0,
      Math.min(maxThumbLeft, stackThumbDrag.startLeft + (event.clientX - stackThumbDrag.startX)),
    );
    const ratio = nextLeft / maxThumbLeft;
    stackBarEl.scrollLeft = ratio * scrollRange;
  };

  const onDragEnd = (): void => {
    stackThumbDrag = null;
    document.removeEventListener("mousemove", onDragMove);
  };

  thumb.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    stackThumbDrag = {
      startX: event.clientX,
      startLeft: thumbRect.left - trackRect.left,
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd, { once: true });
  });

  bar.addEventListener("scroll", () => {
    syncCustomStackScrollbar();
  });
  window.addEventListener("resize", () => {
    syncCustomStackScrollbar();
  });

  syncCustomStackScrollbar();
}

function syncCustomStackScrollbar(): void {
  if (!stackBarEl || !stackBarScrollbarEl || !stackBarTrackEl || !stackBarThumbEl) {
    return;
  }

  const scrollRange = stackBarEl.scrollWidth - stackBarEl.clientWidth;
  const hasOverflow = scrollRange > 0;

  stackBarScrollbarEl.classList.toggle("is-disabled", !hasOverflow);

  const trackWidth = stackBarTrackEl.clientWidth;
  if (!hasOverflow || trackWidth <= 0) {
    stackBarThumbEl.style.width = `${trackWidth}px`;
    stackBarThumbEl.style.left = "0px";
    return;
  }

  const minThumbWidth = 42;
  const thumbWidth = Math.max(
    minThumbWidth,
    Math.floor((stackBarEl.clientWidth / stackBarEl.scrollWidth) * trackWidth),
  );
  const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
  const scrollRatio = scrollRange <= 0 ? 0 : stackBarEl.scrollLeft / scrollRange;
  const thumbLeft = Math.round(maxThumbLeft * scrollRatio);

  stackBarThumbEl.style.width = `${thumbWidth}px`;
  stackBarThumbEl.style.left = `${thumbLeft}px`;
}

async function deleteStackById(stackId: number): Promise<void> {
  const stack = appCtx().stacks.find((candidate) => candidate.id === stackId);
  const stackName = stack?.name ?? "this stack";
  if (!confirm(`Delete "${stackName}"? Links won't be deleted, just untagged.`)) {
    return;
  }

  await api.deleteStack(stackId);
  appActor.send({
    type: "STACK_DELETED",
    stackId,
  });
  await renderStackManagePanel();
}

function setupEventDelegation(): void {
  const list = document.getElementById("music-list");
  if (!list) {
    return;
  }

  list.addEventListener("pointermove", (event) => {
    if (isReordering) {
      return;
    }

    const hover = resolveStarRatingHover(event as MouseEvent);
    if (!hover) {
      return;
    }

    if (activeStarRatingPreviewEl && activeStarRatingPreviewEl !== hover.element) {
      clearStarRatingPreview(activeStarRatingPreviewEl);
    }

    setStarRatingPreview(hover.element, hover.hoverRating);
    activeStarRatingPreviewEl = hover.element;
  });

  list.addEventListener("pointerout", (event) => {
    if (isReordering) {
      return;
    }

    if (!activeStarRatingPreviewEl) {
      return;
    }

    const target = event.target as Node | null;
    if (!target || !activeStarRatingPreviewEl.contains(target)) {
      return;
    }

    const relatedTarget = event.relatedTarget as Node | null;
    if (relatedTarget && activeStarRatingPreviewEl.contains(relatedTarget)) {
      return;
    }

    clearStarRatingPreview(activeStarRatingPreviewEl);
    activeStarRatingPreviewEl = null;
  });

  list.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;

    const menuToggle = target.closest('[data-action="toggle-item-menu"]') as HTMLElement | null;

    if (menuToggle) {
      const itemContext = resolveItemContext(menuToggle);
      if (itemContext) {
        toggleItemActionMenu(itemContext.card, menuToggle);
      }
      return;
    }

    if (target.closest(".music-card__menu-item")) {
      closeItemActionMenu();
    }

    const starRating = resolveStarRatingInteraction(event as MouseEvent);
    if (starRating) {
      closeItemActionMenu();
      clearStarRatingPreview(starRating.element);
      activeStarRatingPreviewEl = null;
      setStarRatingPending(starRating.element, true);
      setStarRatingValue(starRating.element, starRating.nextRating);
      try {
        await api.updateMusicItem(starRating.itemId, { rating: starRating.nextRating });
      } catch (error) {
        console.error("Failed to update rating:", error);
        setStarRatingValue(starRating.element, starRating.currentRating);
        alert("Failed to update rating. Please try again.");
      } finally {
        setStarRatingPending(starRating.element, false);
      }
      return;
    }

    if (
      target.dataset.action === "stack" ||
      target.dataset.action === "stack-menu" ||
      target.closest('[data-action="stack"]') ||
      target.closest('[data-action="stack-menu"]')
    ) {
      const itemContext = resolveItemContext(target);
      if (itemContext) {
        closeItemActionMenu();
        await renderStackDropdown(itemContext.card, itemContext.itemId);
      }
      return;
    }

    const deleteBtn = target.closest(
      '[data-action="delete"], [data-action="delete-menu"]',
    ) as HTMLElement | null;
    if (!deleteBtn) {
      return;
    }

    const itemContext = resolveItemContext(deleteBtn);
    if (!itemContext || !confirm("Delete this item?")) {
      return;
    }

    closeItemActionMenu();
    itemContext.card.remove();
    await api.deleteMusicItem(itemContext.itemId);
  });

  list.addEventListener("change", async (event) => {
    const target = event.target as HTMLElement;

    if (target instanceof HTMLSelectElement && target.classList.contains("status-select")) {
      const itemContext = resolveItemContext(target);
      if (!itemContext) {
        return;
      }

      const result = await api.updateListenStatus(itemContext.itemId, target.value as ListenStatus);
      await renderMusicListView();

      if (target.value === "listened" && result?.suggestion) {
        showSuggestionPicker(result.suggestion, itemContext.itemId);
      }
      return;
    }
  });
}

function showSuggestionPicker(
  suggestion: import("./types").ItemSuggestion,
  sourceItemId: number,
): void {
  const modal = document.getElementById("suggestion-picker-modal");
  const list = document.getElementById("suggestion-picker-list");
  const message = document.getElementById("suggestion-picker-message");
  const acceptBtn = document.getElementById("suggestion-picker-accept");
  const dismissBtn = document.getElementById("suggestion-picker-dismiss");
  if (!modal || !list || !message || !acceptBtn || !dismissBtn) return;

  message.textContent = `Also by ${suggestion.artistName}`;
  const yearStr = suggestion.year ? ` (${suggestion.year})` : "";
  const artworkUrl = suggestion.musicbrainzReleaseId
    ? `https://coverartarchive.org/release/${encodeURIComponent(suggestion.musicbrainzReleaseId)}/front-250`
    : null;
  list.innerHTML = `
    <button
      type="button"
      class="link-picker__candidate is-selected"
      aria-pressed="true"
    >
      ${
        artworkUrl
          ? `<img
              src="${escapeHtml(artworkUrl)}"
              alt="${escapeHtml(suggestion.title)}"
              class="suggestion-picker__artwork"
              onerror="this.style.display='none'"
            />`
          : ""
      }
      <span class="link-picker__candidate-main">
        <span class="link-picker__candidate-title">${escapeHtml(suggestion.title)}${escapeHtml(yearStr)}</span>
        <span class="link-picker__candidate-artist">${escapeHtml(suggestion.artistName)}</span>
      </span>
      <span class="link-picker__candidate-meta">
        <span class="badge badge--source">${escapeHtml(suggestion.itemType)}</span>
      </span>
    </button>
  `;
  modal.hidden = false;

  const onAccept = async () => {
    cleanup();
    await api.acceptSuggestion(sourceItemId);
    appActor.send({ type: "LIST_REFRESH" });
  };

  const onDismiss = async () => {
    cleanup();
    await api.dismissSuggestion(sourceItemId);
  };

  const onBackdrop = (e: Event) => {
    if ((e.target as HTMLElement).dataset.suggestionPickerClose === "true") {
      onDismiss();
    }
  };

  const onEscape = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !modal.hidden) {
      onDismiss();
    }
  };

  function cleanup() {
    modal!.hidden = true;
    acceptBtn!.removeEventListener("click", onAccept);
    dismissBtn!.removeEventListener("click", onDismiss);
    modal!.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onEscape);
  }

  acceptBtn.addEventListener("click", onAccept);
  dismissBtn.addEventListener("click", onDismiss);
  modal.addEventListener("click", onBackdrop);
  document.addEventListener("keydown", onEscape);
}

function resolveItemContext(target: HTMLElement): ItemContext | null {
  const card = target.closest("[data-item-id]") as HTMLElement | null;
  if (!card) {
    return null;
  }

  const itemId = Number(card.dataset.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return null;
  }

  return { card, itemId };
}

function setupMusicListReorder(): void {
  const list = document.getElementById("music-list");
  if (!(list instanceof HTMLElement) || musicListSortable) {
    return;
  }

  musicListSortable = Sortable.create(list, {
    draggable: ".music-card, .folder-row",
    animation: 160,
    fallbackTolerance: 4,
    invertSwap: true,
    swapThreshold: 0.35,
    // Keep interactive controls clickable while making the card body draggable.
    filter:
      "button:not(.music-card__reorder-handle):not(.folder-row__reorder-handle),input,select,textarea,[data-action],.music-card__menu-item",
    preventOnFilter: false,
    ghostClass: "music-card--drag-ghost",
    chosenClass: "music-card--drag-chosen",
    dragClass: "music-card--dragging",
    onStart: () => {
      isReordering = true;
      closeItemActionMenu();
      closeActiveStackDropdown();
    },
    onEnd: (event: Sortable.SortableEvent) => {
      isReordering = false;
      if (event.oldIndex === event.newIndex) {
        return;
      }

      void persistMusicListOrder();
    },
  });

  musicListReorderMediaQuery = window.matchMedia("(max-width: 520px)");
  musicListReorderMediaQuery.addEventListener("change", handleMusicListReorderMediaChange);
  syncMusicListReorderMode();
}

function syncMusicListReorderMode(): void {
  if (!musicListSortable) {
    return;
  }

  const handleSelector = musicListReorderMediaQuery?.matches
    ? ".music-card__reorder-handle, .folder-row__reorder-handle"
    : undefined;
  musicListSortable.option("handle", handleSelector);
}

async function persistMusicListOrder(): Promise<void> {
  if (isBrowseOrderLocked()) {
    return;
  }

  const list = document.getElementById("music-list");
  if (!(list instanceof HTMLElement)) {
    return;
  }

  const entries: string[] = [];
  for (const el of list.querySelectorAll<HTMLElement>("[data-item-id], [data-child-stack-id]")) {
    if (el.dataset.itemId) {
      const id = Number(el.dataset.itemId);
      if (Number.isInteger(id) && id > 0) entries.push(`i:${id}`);
    } else if (el.dataset.childStackId) {
      const id = Number(el.dataset.childStackId);
      if (Number.isInteger(id) && id > 0) entries.push(`s:${id}`);
    }
  }

  if (entries.length === 0) {
    return;
  }

  const contextKey = buildContextKey(appCtx().currentFilter, appCtx().currentStack);
  try {
    await api.saveOrderEntries(contextKey, entries);
  } catch (error) {
    console.error("Failed to persist reordered items:", error);
    await renderMusicListView();
    alert("Failed to save the new order. Please try again.");
  }
}

function setupCustomListScrollbar(): void {
  const list = document.getElementById("music-list");
  const scrollbar = document.getElementById("music-list-scrollbar");
  const track = document.getElementById("music-list-scroll-track");
  const thumb = document.getElementById("music-list-scroll-thumb");
  if (
    !(list instanceof HTMLElement) ||
    !(scrollbar instanceof HTMLElement) ||
    !(track instanceof HTMLElement) ||
    !(thumb instanceof HTMLElement)
  ) {
    return;
  }

  musicListEl = list;
  musicListScrollbarEl = scrollbar;
  musicListTrackEl = track;
  musicListThumbEl = thumb;

  const upButton = scrollbar.querySelector('[data-scroll-btn="up"]');
  const downButton = scrollbar.querySelector('[data-scroll-btn="down"]');

  const scrollByStep = (delta: number): void => {
    list.scrollBy({ top: delta, behavior: "auto" });
  };

  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  const startRepeatScroll = (delta: number): void => {
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }

    repeatTimer = setInterval(() => {
      scrollByStep(delta);
    }, 60);
  };

  const stopRepeatScroll = (): void => {
    if (!repeatTimer) {
      return;
    }

    clearInterval(repeatTimer);
    repeatTimer = null;
  };

  const bindScrollButton = (button: Element | null, delta: number): void => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    button.addEventListener("click", () => {
      scrollByStep(delta);
    });
    button.addEventListener("mousedown", () => {
      startRepeatScroll(delta);
    });
    button.addEventListener("mouseup", stopRepeatScroll);
    button.addEventListener("mouseleave", stopRepeatScroll);
  };

  bindScrollButton(upButton, -40);
  bindScrollButton(downButton, 40);
  document.addEventListener("mouseup", stopRepeatScroll);
  window.addEventListener("blur", stopRepeatScroll);

  track.addEventListener("mousedown", (event) => {
    if (event.target === thumb) {
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const clickOffset = event.clientY - trackRect.top;
    const thumbTop = thumbRect.top - trackRect.top;
    const direction = clickOffset < thumbTop ? -1 : 1;

    list.scrollBy({ top: direction * Math.max(80, list.clientHeight * 0.8), behavior: "auto" });
  });

  const onDragMove = (event: MouseEvent): void => {
    if (!listThumbDrag || !musicListEl || !musicListTrackEl || !musicListThumbEl) {
      return;
    }

    const scrollRange = musicListEl.scrollHeight - musicListEl.clientHeight;
    if (scrollRange <= 0) {
      return;
    }

    const trackHeight = musicListTrackEl.clientHeight;
    const thumbHeight = musicListThumbEl.offsetHeight;
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    if (maxThumbTop <= 0) {
      return;
    }

    const nextTop = Math.max(
      0,
      Math.min(maxThumbTop, listThumbDrag.startTop + (event.clientY - listThumbDrag.startY)),
    );
    const ratio = nextTop / maxThumbTop;
    musicListEl.scrollTop = ratio * scrollRange;
  };

  const onDragEnd = (): void => {
    listThumbDrag = null;
    document.removeEventListener("mousemove", onDragMove);
  };

  thumb.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    listThumbDrag = {
      startY: event.clientY,
      startTop: thumbRect.top - trackRect.top,
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd, { once: true });
  });

  list.addEventListener("scroll", () => {
    syncCustomListScrollbar();
  });
  window.addEventListener("resize", () => {
    syncCustomListScrollbar();
  });

  syncCustomListScrollbar();
}

function syncCustomListScrollbar(): void {
  if (!musicListEl || !musicListScrollbarEl || !musicListTrackEl || !musicListThumbEl) {
    return;
  }

  const scrollRange = musicListEl.scrollHeight - musicListEl.clientHeight;
  const hasOverflow = scrollRange > 0;
  musicListScrollbarEl.classList.toggle("is-disabled", !hasOverflow);

  const trackHeight = musicListTrackEl.clientHeight;
  if (!hasOverflow || trackHeight <= 0) {
    musicListThumbEl.style.height = `${trackHeight}px`;
    musicListThumbEl.style.top = "0px";
    return;
  }

  const minThumbHeight = 56;
  const thumbHeight = Math.max(
    minThumbHeight,
    Math.floor((musicListEl.clientHeight / musicListEl.scrollHeight) * trackHeight),
  );
  const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
  const scrollRatio = scrollRange <= 0 ? 0 : musicListEl.scrollTop / scrollRange;
  const thumbTop = Math.round(maxThumbTop * scrollRatio);

  musicListThumbEl.style.height = `${thumbHeight}px`;
  musicListThumbEl.style.top = `${thumbTop}px`;
}

function setupCustomLinkPickerScrollbar(): void {
  const list = document.getElementById("link-picker-list");
  const scrollbar = document.getElementById("link-picker-scrollbar");
  const track = document.getElementById("link-picker-scroll-track");
  const thumb = document.getElementById("link-picker-scroll-thumb");
  if (
    !(list instanceof HTMLElement) ||
    !(scrollbar instanceof HTMLElement) ||
    !(track instanceof HTMLElement) ||
    !(thumb instanceof HTMLElement)
  ) {
    return;
  }

  linkPickerListEl = list;
  linkPickerScrollbarEl = scrollbar;
  linkPickerTrackEl = track;
  linkPickerThumbEl = thumb;

  const upButton = scrollbar.querySelector('[data-link-picker-scroll-btn="up"]');
  const downButton = scrollbar.querySelector('[data-link-picker-scroll-btn="down"]');

  const scrollByStep = (delta: number): void => {
    list.scrollBy({ top: delta, behavior: "auto" });
  };

  let repeatTimer: ReturnType<typeof setInterval> | null = null;
  const startRepeatScroll = (delta: number): void => {
    if (repeatTimer) {
      clearInterval(repeatTimer);
    }
    repeatTimer = setInterval(() => {
      scrollByStep(delta);
    }, 60);
  };

  const stopRepeatScroll = (): void => {
    if (!repeatTimer) {
      return;
    }
    clearInterval(repeatTimer);
    repeatTimer = null;
  };

  const bindScrollButton = (button: Element | null, delta: number): void => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    button.addEventListener("click", () => {
      scrollByStep(delta);
    });
    button.addEventListener("mousedown", () => {
      startRepeatScroll(delta);
    });
    button.addEventListener("mouseup", stopRepeatScroll);
    button.addEventListener("mouseleave", stopRepeatScroll);
  };

  bindScrollButton(upButton, -40);
  bindScrollButton(downButton, 40);
  document.addEventListener("mouseup", stopRepeatScroll);
  window.addEventListener("blur", stopRepeatScroll);

  track.addEventListener("mousedown", (event) => {
    if (event.target === thumb) {
      return;
    }
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const clickOffset = event.clientY - trackRect.top;
    const thumbTop = thumbRect.top - trackRect.top;
    const direction = clickOffset < thumbTop ? -1 : 1;
    list.scrollBy({ top: direction * Math.max(80, list.clientHeight * 0.8), behavior: "auto" });
  });

  const onDragMove = (event: MouseEvent): void => {
    if (!linkPickerThumbDrag || !linkPickerListEl || !linkPickerTrackEl || !linkPickerThumbEl) {
      return;
    }
    const scrollRange = linkPickerListEl.scrollHeight - linkPickerListEl.clientHeight;
    if (scrollRange <= 0) {
      return;
    }
    const trackHeight = linkPickerTrackEl.clientHeight;
    const thumbHeight = linkPickerThumbEl.offsetHeight;
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    if (maxThumbTop <= 0) {
      return;
    }
    const nextTop = Math.max(
      0,
      Math.min(
        maxThumbTop,
        linkPickerThumbDrag.startTop + (event.clientY - linkPickerThumbDrag.startY),
      ),
    );
    const ratio = nextTop / maxThumbTop;
    linkPickerListEl.scrollTop = ratio * scrollRange;
  };

  const onDragEnd = (): void => {
    linkPickerThumbDrag = null;
    document.removeEventListener("mousemove", onDragMove);
  };

  thumb.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    linkPickerThumbDrag = {
      startY: event.clientY,
      startTop: thumbRect.top - trackRect.top,
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd, { once: true });
  });

  list.addEventListener("scroll", () => {
    syncCustomLinkPickerScrollbar();
  });
  window.addEventListener("resize", () => {
    syncCustomLinkPickerScrollbar();
  });
}

function syncCustomLinkPickerScrollbar(): void {
  if (!linkPickerListEl || !linkPickerScrollbarEl || !linkPickerTrackEl || !linkPickerThumbEl) {
    return;
  }

  const scrollRange = linkPickerListEl.scrollHeight - linkPickerListEl.clientHeight;
  const hasOverflow = scrollRange > 0;
  linkPickerScrollbarEl.classList.toggle("is-disabled", !hasOverflow);

  const trackHeight = linkPickerTrackEl.clientHeight;
  if (!hasOverflow || trackHeight <= 0) {
    linkPickerThumbEl.style.height = `${trackHeight}px`;
    linkPickerThumbEl.style.top = "0px";
    return;
  }

  const minThumbHeight = 56;
  const thumbHeight = Math.max(
    minThumbHeight,
    Math.floor((linkPickerListEl.clientHeight / linkPickerListEl.scrollHeight) * trackHeight),
  );
  const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
  const scrollRatio = scrollRange <= 0 ? 0 : linkPickerListEl.scrollTop / scrollRange;
  const thumbTop = Math.round(maxThumbTop * scrollRatio);

  linkPickerThumbEl.style.height = `${thumbHeight}px`;
  linkPickerThumbEl.style.top = `${thumbTop}px`;
}

function buildBreadcrumbTrail(stackId: number): Array<{ id: number; name: string }> {
  const trail: Array<{ id: number; name: string }> = [];
  let current = stackId;
  const stacks = appCtx().stacks;
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

async function renderMusicListView(): Promise<void> {
  const container = document.getElementById("music-list");
  if (!container) {
    return;
  }

  if (activeStarRatingPreviewEl) {
    activeStarRatingPreviewEl = null;
  }

  closeItemActionMenu();
  const filters = buildMusicItemFilters(
    appCtx().currentFilter,
    appCtx().currentStack,
    appCtx().searchQuery,
    appCtx().currentSort,
    appCtx().currentSortDirection,
  );
  const result = await api.listMusicItems(filters);

  const currentStack = appCtx().currentStack;
  let childStacks: Array<{ id: number; name: string; item_count: number }> = [];
  if (currentStack !== null) {
    childStacks = await api.getStackChildren(currentStack);
  }

  // Build breadcrumb trail
  const breadcrumbHtml =
    currentStack !== null ? renderBreadcrumbs(buildBreadcrumbTrail(currentStack)) : "";

  // Render mixed list: breadcrumbs + folder rows + music items
  const folderRowsHtml = childStacks.map((s) => renderFolderRow(s)).join("");
  const itemsHtml = renderMusicList(result.items, appCtx().currentFilter, appCtx().searchQuery);

  const addListBtnHtml =
    currentStack !== null
      ? `<button type="button" id="add-child-stack-btn" class="btn btn--ghost add-child-stack-btn" title="Add a list into this list">+ Add list</button>`
      : "";

  container.innerHTML = breadcrumbHtml + addListBtnHtml + folderRowsHtml + itemsHtml;

  setupMusicListReorder();
  musicListSortable?.option("disabled", isBrowseOrderLocked());
  syncCustomListScrollbar();
  requestAnimationFrame(() => {
    syncCustomListScrollbar();
  });
}

async function renderStackManagePanel(): Promise<void> {
  const stacks = await api.listStacks();
  const list = document.getElementById("stack-manage-list");
  if (!list) {
    return;
  }

  const searchQuery = getNormalizedSearchQuery();
  const visibleStacks = searchQuery
    ? stacks.filter((stack) => stack.name.toLowerCase().includes(searchQuery))
    : stacks;

  list.innerHTML = renderStackManageList(visibleStacks);
}

function setupStackManagePanel(): void {
  const panel = document.getElementById("stack-manage");
  const manageButton = document.getElementById("manage-stacks-btn");
  if (!panel || !manageButton) {
    return;
  }

  manageButton.addEventListener("click", () => {
    appActor.send({ type: "STACK_MANAGE_TOGGLED" });
    panel.hidden = !appCtx().stackManageOpen;

    if (!panel.hidden) {
      void renderStackManagePanel();
    }
  });

  document.getElementById("stack-manage-create-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("stack-manage-input");
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const name = input.value.trim();
    if (!name) {
      return;
    }

    await api.createStack(name);
    input.value = "";
    await renderStackBar();
    await renderStackManagePanel();
  });

  document.getElementById("stack-manage-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest("[data-manage-stack-id]") as HTMLElement | null;
    if (!item) {
      return;
    }

    const stackId = Number(item.dataset.manageStackId);

    if (target.classList.contains("stack-manage__rename-btn")) {
      const nameEl = item.querySelector(".stack-manage__name");
      const currentName = nameEl?.textContent?.trim() ?? "";
      item.innerHTML = renderStackRenameEditor(currentName);

      const renameInput = item.querySelector(".stack-manage__rename-input");
      if (renameInput instanceof HTMLInputElement) {
        renameInput.focus();
        renameInput.select();
      }
    }

    if (target.classList.contains("stack-manage__rename-confirm")) {
      const renameInput = item.querySelector(".stack-manage__rename-input");
      if (!(renameInput instanceof HTMLInputElement)) {
        return;
      }

      const newName = renameInput.value.trim();
      if (!newName) {
        return;
      }

      await api.renameStack(stackId, newName);
      await renderStackBar();
      await renderStackManagePanel();
    }

    if (target.classList.contains("stack-manage__delete-btn")) {
      await deleteStackById(stackId);
    }
  });
}

function renderAddFormStackChipsView(): void {
  const container = document.getElementById("add-form-stack-chips");
  if (!container) {
    return;
  }

  container.innerHTML = renderAddFormStackChips(formCtx().selectedStackIds, appCtx().stacks);
}

async function showAddFormStackDropdown(): Promise<void> {
  const picker = document.getElementById("add-form-stacks");
  if (!(picker instanceof HTMLElement)) {
    return;
  }

  await openStackDropdown({
    container: picker,
    selectedStackIds: new Set(formCtx().selectedStackIds),
    onToggle: (stackId, checked) => {
      addFormActor.send({
        type: "STACK_TOGGLED",
        stackId,
        checked,
      });
      renderAddFormStackChipsView();
    },
    onCreate: async (name) => {
      const stack = await api.createStack(name);
      addFormActor.send({
        type: "STACK_ADDED",
        stackId: stack.id,
      });
      await renderStackBar();
      renderAddFormStackChipsView();
      await showAddFormStackDropdown();
    },
    shouldIgnoreOutsideClick: (target) => target.closest("#add-form-stack-btn") !== null,
  });
}

async function renderStackDropdown(cardEl: HTMLElement, itemId: number): Promise<void> {
  const actionsEl = cardEl.querySelector(".music-card__actions");
  if (!(actionsEl instanceof HTMLElement)) {
    return;
  }

  const stackBtn = actionsEl.querySelector<HTMLElement>('[data-action="stack"]');
  const itemStacks = await api.getStacksForItem(itemId);
  actionsEl.style.position = "relative";
  await openStackDropdown({
    container: actionsEl,
    selectedStackIds: new Set(itemStacks.map((stack) => stack.id)),
    onToggle: async (stackId, checked) => {
      if (checked) {
        await api.addItemToStack(itemId, stackId);
      } else {
        await api.removeItemFromStack(itemId, stackId);
      }

      await renderStackBar();
    },
    onCreate: async (name) => {
      const stack = await api.createStack(name);
      await api.addItemToStack(itemId, stack.id);
      await renderStackDropdown(cardEl, itemId);
      await renderStackBar();
    },
    onClose: () => {
      void renderMusicListView();
    },
  });

  if (stackBtn) {
    const dropdown = actionsEl.querySelector<HTMLElement>(".stack-dropdown");
    if (dropdown) {
      dropdown.style.top = `${stackBtn.offsetTop + stackBtn.offsetHeight}px`;
    }
  }
}

function closeActiveStackDropdown(): void {
  activeStackDropdownCleanup?.(true);
  activeStackDropdownCleanup = null;
}

function closeItemActionMenu(): void {
  activeItemActionMenuCleanup?.();
  activeItemActionMenuCleanup = null;
}

function toggleItemActionMenu(cardEl: HTMLElement, toggleEl: HTMLElement): void {
  const panel = cardEl.querySelector(".music-card__menu-panel");
  if (!(panel instanceof HTMLElement)) {
    return;
  }

  const alreadyOpen = !panel.hidden;
  closeItemActionMenu();

  if (alreadyOpen) {
    return;
  }

  panel.hidden = false;
  toggleEl.setAttribute("aria-expanded", "true");

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }

    closed = true;
    panel.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", onEscape);
    document.removeEventListener("click", onOutsideClick);

    if (activeItemActionMenuCleanup === close) {
      activeItemActionMenuCleanup = null;
    }
  };

  const onEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close();
    }
  };

  const onOutsideClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (panel.contains(target) || toggleEl.contains(target)) {
      return;
    }

    close();
  };

  activeItemActionMenuCleanup = close;
  document.addEventListener("keydown", onEscape);

  setTimeout(() => {
    if (closed) {
      return;
    }

    document.addEventListener("click", onOutsideClick);
  }, 0);
}

async function openStackDropdown(options: StackDropdownOptions): Promise<void> {
  closeActiveStackDropdown();

  const stacks = await api.listStacks();

  const dropdown = document.createElement("div");
  dropdown.className = "stack-dropdown";
  dropdown.innerHTML = renderStackDropdownContent(stacks, options.selectedStackIds);
  options.container.appendChild(dropdown);

  let closed = false;
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close();
    }
  };

  const clickOutside = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (dropdown.contains(target) || options.shouldIgnoreOutsideClick?.(target)) {
      return;
    }

    close();
  };

  const close = (skipOnClose = false): void => {
    if (closed) {
      return;
    }

    closed = true;
    dropdown.remove();
    document.removeEventListener("keydown", closeOnEscape);
    document.removeEventListener("click", clickOutside);

    if (activeStackDropdownCleanup === close) {
      activeStackDropdownCleanup = null;
    }

    if (!skipOnClose) {
      options.onClose?.();
    }
  };

  activeStackDropdownCleanup = close;
  document.addEventListener("keydown", closeOnEscape);

  setTimeout(() => {
    if (closed) {
      return;
    }

    document.addEventListener("click", clickOutside);
  }, 0);

  dropdown.addEventListener("change", async (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.classList.contains("stack-dropdown__checkbox")) {
      return;
    }

    const stackId = Number(target.dataset.stackId);
    if (!Number.isInteger(stackId) || stackId <= 0) {
      return;
    }

    await options.onToggle(stackId, target.checked);
  });

  const newInput = dropdown.querySelector(".stack-dropdown__new-input");
  if (newInput instanceof HTMLInputElement) {
    newInput.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      const name = newInput.value.trim();
      if (!name) {
        return;
      }

      await options.onCreate(name);
    });
  }
}

// ── Release Modal & Now-Playing ──────────────────────────────────────────────

function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "m.youtube.com"
    ) {
      return parsed.searchParams.get("v");
    }
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1) || null;
    }
  } catch {
    // invalid URL
  }
  return null;
}

function extractYouTubePlaylistId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "m.youtube.com"
    ) {
      return parsed.searchParams.get("list");
    }
  } catch {
    // invalid URL
  }
  return null;
}

function parseItemLinkMetadata(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return null;
}
