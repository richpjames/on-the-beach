import { AmbiguousLinkApiError, ApiClient } from "./services/api-client";
import Sortable from "sortablejs";
import type { AddFormValues as AddFormValuesInput } from "./ui/domain/add-form";
import type {
  AmbiguousLinkPayload,
  LinkReleaseCandidate,
  ListenStatus,
  MusicItemSort,
  StackWithCount,
} from "./types";
import {
  buildCreateMusicItemInputFromValues,
  getCoverScanErrorMessage,
} from "./ui/domain/add-form";
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
import { addFormMachine } from "./ui/state/add-form-machine";
import { appMachine } from "./ui/state/app-machine";
import {
  renderAddFormStackChips,
  renderAmbiguousLinkCandidates,
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

interface LinkPickerState {
  url: string;
  message: string;
  values: AddFormValuesInput;
  candidates: LinkReleaseCandidate[];
  selectedCandidateId: string | null;
}

export class App {
  private api: ApiClient;
  private appActor = createActor(appMachine).start();
  private addFormActor = createActor(addFormMachine).start();
  private musicListEl: HTMLElement | null = null;
  private musicListScrollbarEl: HTMLElement | null = null;
  private musicListTrackEl: HTMLElement | null = null;
  private musicListThumbEl: HTMLElement | null = null;
  private stackBarEl: HTMLElement | null = null;
  private stackBarScrollbarEl: HTMLElement | null = null;
  private stackBarTrackEl: HTMLElement | null = null;
  private stackBarThumbEl: HTMLElement | null = null;
  private activeStarRatingPreviewEl: HTMLElement | null = null;
  private listThumbDrag: { startY: number; startTop: number } | null = null;
  private stackThumbDrag: { startX: number; startLeft: number } | null = null;
  private activeItemActionMenuCleanup: (() => void) | null = null;
  private activeStackDropdownCleanup: ((skipOnClose?: boolean) => void) | null = null;
  private musicListSortable: Sortable | null = null;
  private musicListReorderMediaQuery: MediaQueryList | null = null;
  private isReordering = false;
  private linkPickerState: LinkPickerState | null = null;
  private readonly handleMusicListReorderMediaChange = (): void => {
    this.syncMusicListReorderMode();
  };

  constructor() {
    this.api = new ApiClient();
  }

  async initialize(): Promise<void> {
    this.setupAddForm();
    this.appActor.send({ type: "APP_READY" });

    const serverState = this.readServerState();
    if (serverState) {
      this.appActor.send({
        type: "STACKS_LOADED",
        stacks: serverState.stacks,
      });
    }

    this.initializeUI(serverState !== null);

    const versionEl = document.getElementById("app-version");
    if (versionEl) {
      versionEl.textContent = `v${__APP_VERSION__}`;
    }
  }

  private readServerState(): { stacks: StackWithCount[] } | null {
    const el = document.getElementById("__initial_state__");
    if (!el?.textContent) return null;
    try {
      return JSON.parse(el.textContent) as { stacks: StackWithCount[] };
    } catch {
      return null;
    }
  }

  private initializeUI(hasServerData: boolean): void {
    this.setupFilterBar();
    this.setupBrowseControls();
    this.setupStackBar();
    this.setupStackManagePanel();
    this.setupStackParentLinker();
    this.setupLinkPicker();
    this.setupEventDelegation();
    this.setupMusicListReorder();
    this.setupCustomListScrollbar();
    this.setupCustomStackScrollbar();

    if (hasServerData) {
      this.syncStackFeedLinks();
      requestAnimationFrame(() => {
        this.syncCustomListScrollbar();
        this.syncCustomStackScrollbar();
      });
    } else {
      void this.renderStackBar();
      void this.renderMusicList();
    }
  }

  private setupAddForm(): void {
    if (this.formCtx.initialized) {
      return;
    }

    const form = document.getElementById("add-form");
    const submitButton = document.getElementById("add-form-submit");
    if (!(form instanceof HTMLFormElement) || !(submitButton instanceof HTMLButtonElement)) {
      return;
    }

    this.addFormActor.send({ type: "INITIALIZED" });

    const detailsEl = form.querySelector(".add-form__details");
    const titleInput = form.querySelector('input[name="title"]');
    const artistInput = form.querySelector('input[name="artist"]');
    const artworkInput = form.querySelector('input[name="artworkUrl"]');
    const scanButton = document.getElementById("add-form-scan-btn");
    const scanInput = document.getElementById("scan-file-input");

    submitButton.disabled = false;

    if (scanButton instanceof HTMLButtonElement && scanInput instanceof HTMLInputElement) {
      scanButton.addEventListener("click", () => {
        if (this.formCtx.scanState === "scanning") {
          return;
        }

        scanInput.click();
      });

      scanInput.addEventListener("change", async () => {
        const file = scanInput.files?.[0];
        if (!file) {
          return;
        }

        const secondary = form.querySelector<HTMLElement>(".add-form__secondary");
        if (secondary?.hidden) secondary.hidden = false;

        await this.handleCoverScan(
          file,
          scanButton,
          detailsEl instanceof HTMLDetailsElement ? detailsEl : null,
          artistInput instanceof HTMLInputElement ? artistInput : null,
          titleInput instanceof HTMLInputElement ? titleInput : null,
          artworkInput instanceof HTMLInputElement ? artworkInput : null,
        );
        scanInput.value = "";
      });
    }

    document.getElementById("add-form-stack-btn")?.addEventListener("click", () => {
      void this.showAddFormStackDropdown();
    });

    document.getElementById("add-form-stack-chips")?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (!target.dataset.removeStack) {
        return;
      }

      this.addFormActor.send({
        type: "STACK_REMOVED",
        stackId: Number(target.dataset.removeStack),
      });
      this.renderAddFormStackChips();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const secondary = form.querySelector<HTMLElement>(".add-form__secondary");
      const urlInput = form.querySelector<HTMLInputElement>('input[name="url"]');
      if (secondary?.hidden && !urlInput?.value.trim()) {
        secondary.hidden = false;
        const artistInput = form.querySelector<HTMLInputElement>('input[name="artist"]');
        artistInput?.focus();
        return;
      }
      if (secondary?.hidden) {
        secondary.hidden = false;
      }

      if (!this.appCtx.isReady) {
        alert("App is still loading. Please try again in a moment.");
        return;
      }

      try {
        await this.createItemFromValues(this.readAddFormValues(new FormData(form)), form);
      } catch (error) {
        console.error("Failed to add item:", error);
        alert("Failed to add item. Please try again.");
      }
    });
  }

  private readAddFormValues(formData: FormData): AddFormValuesInput {
    return {
      url: this.readStringField(formData, "url"),
      title: this.readStringField(formData, "title"),
      artist: this.readStringField(formData, "artist"),
      itemType: this.readStringField(formData, "itemType") || "album",
      label: this.readStringField(formData, "label"),
      year: this.readStringField(formData, "year"),
      country: this.readStringField(formData, "country"),
      genre: this.readStringField(formData, "genre"),
      catalogueNumber: this.readStringField(formData, "catalogueNumber"),
      notes: this.readStringField(formData, "notes"),
      artworkUrl: this.readStringField(formData, "artworkUrl"),
    };
  }

  private readStringField(formData: FormData, name: string): string {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  }

  private async enrichValuesWithMusicBrainz(values: AddFormValuesInput): Promise<{
    values: AddFormValuesInput;
    musicbrainzReleaseId?: string;
    musicbrainzArtistId?: string;
  }> {
    let mbReleaseId: string | undefined;
    let mbArtistId: string | undefined;

    if (values.artist.trim() && values.title.trim()) {
      try {
        const enrichment = await this.api.lookupRelease(
          values.artist.trim(),
          values.title.trim(),
          values.year.trim() || undefined,
        );

        if (enrichment.year != null && !values.year.trim()) {
          values.year = String(enrichment.year);
        }
        if (enrichment.label && !values.label.trim()) {
          values.label = enrichment.label;
        }
        if (enrichment.country && !values.country.trim()) {
          values.country = enrichment.country;
        }
        if (enrichment.catalogueNumber && !values.catalogueNumber.trim()) {
          values.catalogueNumber = enrichment.catalogueNumber;
        }
        if (enrichment.artworkUrl && !values.artworkUrl.trim()) {
          values.artworkUrl = enrichment.artworkUrl;
        }
        if (enrichment.musicbrainzReleaseId) {
          mbReleaseId = enrichment.musicbrainzReleaseId;
        }
        if (enrichment.musicbrainzArtistId) {
          mbArtistId = enrichment.musicbrainzArtistId;
        }
      } catch {
        // non-fatal: enrichment failure does not block saving
      }
    }

    return {
      values,
      musicbrainzReleaseId: mbReleaseId,
      musicbrainzArtistId: mbArtistId,
    };
  }

  private async createItemFromValues(
    rawValues: AddFormValuesInput,
    form: HTMLFormElement,
    options?: { selectedCandidateId?: string },
  ): Promise<void> {
    this.setSubmitButtonState(true);
    try {
      const values = { ...rawValues };
      const enriched = await this.enrichValuesWithMusicBrainz(values);

      const item = await this.api.createMusicItem({
        ...buildCreateMusicItemInputFromValues(enriched.values),
        listenStatus: "to-listen",
        musicbrainzReleaseId: enriched.musicbrainzReleaseId,
        musicbrainzArtistId: enriched.musicbrainzArtistId,
        selectedCandidateId: options?.selectedCandidateId,
      });

      await this.handleCreatedItem(item.id, form);
      this.closeLinkPicker();
    } catch (error) {
      if (error instanceof AmbiguousLinkApiError) {
        this.openLinkPicker(error.payload, rawValues);
        return;
      }
      throw error;
    } finally {
      this.setSubmitButtonState(false);
    }
  }

  private async handleCreatedItem(itemId: number, form: HTMLFormElement): Promise<void> {
    if (this.formCtx.selectedStackIds.length > 0) {
      await this.api.setItemStacks(itemId, this.formCtx.selectedStackIds);
      this.addFormActor.send({ type: "CLEAR_STACKS" });
      this.renderAddFormStackChips();
      await this.renderStackBar();
    }

    form.reset();
    const secondary = form.querySelector<HTMLElement>(".add-form__secondary");
    if (secondary) secondary.hidden = true;
    if (this.shouldRefreshListAfterAdd()) {
      await this.renderMusicList();
    }
  }

  private setupLinkPicker(): void {
    const modal = document.getElementById("link-picker-modal");
    const list = document.getElementById("link-picker-list");
    const submit = document.getElementById("link-picker-submit");
    const manual = document.getElementById("link-picker-manual");
    const cancel = document.getElementById("link-picker-cancel");

    if (
      !(modal instanceof HTMLElement) ||
      !(list instanceof HTMLElement) ||
      !(submit instanceof HTMLButtonElement) ||
      !(manual instanceof HTMLButtonElement) ||
      !(cancel instanceof HTMLButtonElement)
    ) {
      return;
    }

    list.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest(
        "[data-candidate-id]",
      ) as HTMLElement | null;
      if (!target || !this.linkPickerState) {
        return;
      }

      this.linkPickerState = {
        ...this.linkPickerState,
        selectedCandidateId: target.dataset.candidateId ?? null,
      };
      this.renderLinkPicker();
    });

    submit.addEventListener("click", () => {
      void this.submitSelectedLinkCandidate();
    });

    manual.addEventListener("click", () => {
      this.enterSelectedCandidateManually();
    });

    cancel.addEventListener("click", () => {
      this.closeLinkPicker();
    });

    modal.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.dataset.linkPickerClose === "true") {
        this.closeLinkPicker();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.linkPickerState) {
        this.closeLinkPicker();
      }
    });
  }

  private openLinkPicker(payload: AmbiguousLinkPayload, values: AddFormValuesInput): void {
    this.linkPickerState = {
      url: payload.url,
      message: payload.message,
      values: { ...values },
      candidates: payload.candidates,
      selectedCandidateId: null,
    };
    this.renderLinkPicker();
  }

  private closeLinkPicker(): void {
    this.linkPickerState = null;
    const modal = document.getElementById("link-picker-modal");
    if (modal instanceof HTMLElement) {
      modal.hidden = true;
    }
  }

  private renderLinkPicker(): void {
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
    ) {
      return;
    }

    if (!this.linkPickerState) {
      modal.hidden = true;
      return;
    }

    modal.hidden = false;
    url.textContent = this.linkPickerState.url;
    message.textContent = this.linkPickerState.message;
    list.innerHTML = renderAmbiguousLinkCandidates(
      this.linkPickerState.candidates,
      this.linkPickerState.selectedCandidateId,
    );
    submit.disabled = !this.linkPickerState.selectedCandidateId;
  }

  private findSelectedLinkCandidate(): LinkReleaseCandidate | null {
    if (!this.linkPickerState?.selectedCandidateId) {
      return null;
    }

    return (
      this.linkPickerState.candidates.find(
        (candidate) => candidate.candidateId === this.linkPickerState?.selectedCandidateId,
      ) ?? null
    );
  }

  private buildValuesForSelectedCandidate(
    values: AddFormValuesInput,
    candidate: LinkReleaseCandidate,
  ): AddFormValuesInput {
    return {
      ...values,
      artist: candidate.artist ?? values.artist,
      title: candidate.title || values.title,
      itemType: candidate.itemType ?? values.itemType,
    };
  }

  private enterSelectedCandidateManually(): void {
    const form = document.getElementById("add-form");
    if (!(form instanceof HTMLFormElement) || !this.linkPickerState) {
      return;
    }

    const selectedCandidate = this.findSelectedLinkCandidate();
    if (selectedCandidate) {
      this.populateAddFormFromCandidate(selectedCandidate);
    }

    const secondary = form.querySelector<HTMLElement>(".add-form__secondary");
    if (secondary) {
      secondary.hidden = false;
    }

    this.closeLinkPicker();
    form.querySelector<HTMLInputElement>('input[name="artist"]')?.focus();
  }

  private populateAddFormFromCandidate(candidate: LinkReleaseCandidate): void {
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

  private async submitSelectedLinkCandidate(): Promise<void> {
    const form = document.getElementById("add-form");
    if (!(form instanceof HTMLFormElement) || !this.linkPickerState?.selectedCandidateId) {
      return;
    }

    const selectedCandidate = this.findSelectedLinkCandidate();
    if (!selectedCandidate) {
      return;
    }

    const values = this.buildValuesForSelectedCandidate(
      this.linkPickerState.values,
      selectedCandidate,
    );
    await this.createItemFromValues(values, form, {
      selectedCandidateId: selectedCandidate.candidateId,
    });
  }

  private shouldRefreshListAfterAdd(): boolean {
    return this.appCtx.currentFilter === "all" || this.appCtx.currentFilter === "to-listen";
  }

  private setSubmitButtonState(isLoading: boolean): void {
    const button = document.getElementById("add-form-submit");
    if (!(button instanceof HTMLButtonElement)) return;

    this.addFormActor.send({ type: isLoading ? "SUBMIT_STARTED" : "SUBMIT_FINISHED" });
    button.disabled = isLoading;
    button.textContent = isLoading ? "Adding..." : "Add";
  }

  private setScanButtonState(button: HTMLButtonElement, isLoading: boolean): void {
    this.addFormActor.send({
      type: isLoading ? "SCAN_STARTED" : "SCAN_FINISHED",
    });

    button.disabled = isLoading;
    button.classList.toggle("is-loading", isLoading);
    button.textContent = isLoading ? "Scanning..." : "Scan";
  }

  private async handleCoverScan(
    file: File,
    scanButton: HTMLButtonElement,
    detailsEl: HTMLDetailsElement | null,
    artistInput: HTMLInputElement | null,
    titleInput: HTMLInputElement | null,
    artworkInput: HTMLInputElement | null,
  ): Promise<void> {
    this.setScanButtonState(scanButton, true);

    try {
      const imageBase64 = await this.encodeScanImage(file);
      const uploadResult = await this.api.uploadReleaseImage(imageBase64);

      if (artworkInput) {
        artworkInput.value = uploadResult.artworkUrl;
      }

      if (detailsEl) {
        detailsEl.open = true;
      }

      const result = await this.api.scanCover(imageBase64);
      if (artistInput && result.artist) {
        artistInput.value = result.artist;
        artistInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      if (titleInput && result.title) {
        titleInput.value = result.title;
        titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (error) {
      alert(getCoverScanErrorMessage(error));
    } finally {
      this.setScanButtonState(scanButton, false);
    }
  }

  private async encodeScanImage(file: File): Promise<string> {
    const imageDataUrl = await this.readFileAsDataUrl(file);
    const image = await this.loadImage(imageDataUrl);
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

  private readFileAsDataUrl(file: Blob): Promise<string> {
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

  private loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = dataUrl;
    });
  }

  private setupFilterBar(): void {
    const filterBar = document.getElementById("filter-bar");
    if (!filterBar) {
      return;
    }

    filterBar.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("filter-btn")) {
        return;
      }

      this.appActor.send({
        type: "FILTER_SELECTED",
        filter: target.dataset.filter as ListenStatus | "all",
      });

      filterBar.querySelectorAll(".filter-btn").forEach((button) => {
        button.classList.remove("active");
      });
      target.classList.add("active");

      void this.renderMusicList();
    });
  }

  private setupBrowseControls(): void {
    const browseTools = document.querySelector(".browse-tools");
    const searchInput = document.getElementById("browse-search");
    const sortSelect = document.getElementById("browse-sort");
    const searchToggle = document.getElementById("browse-search-toggle");
    const sortToggle = document.getElementById("browse-sort-toggle");
    const searchPanel = document.getElementById("browse-search-panel");
    const sortPanel = document.getElementById("browse-sort-panel");

    const closeBrowsePanels = (): void => {
      searchPanel?.classList.remove("is-open");
      sortPanel?.classList.remove("is-open");
      searchToggle?.setAttribute("aria-expanded", "false");
      sortToggle?.setAttribute("aria-expanded", "false");
    };

    const toggleBrowsePanel = (
      panel: HTMLElement | null,
      button: HTMLElement | null,
      sibling: HTMLElement | null,
      siblingButton: HTMLElement | null,
    ): void => {
      if (!panel || !button) {
        return;
      }

      const willOpen = !panel.classList.contains("is-open");
      sibling?.classList.remove("is-open");
      siblingButton?.setAttribute("aria-expanded", "false");
      panel.classList.toggle("is-open", willOpen);
      button.setAttribute("aria-expanded", String(willOpen));

      if (willOpen && panel === searchPanel && searchInput instanceof HTMLInputElement) {
        requestAnimationFrame(() => {
          searchInput.focus();
        });
      }
    };

    if (searchInput instanceof HTMLInputElement) {
      searchInput.addEventListener("input", () => {
        this.appActor.send({
          type: "SEARCH_UPDATED",
          query: searchInput.value,
        });

        void this.renderStackBar();
        if (this.appCtx.stackManageOpen) {
          void this.renderStackManagePanel();
        }
        void this.renderMusicList();
      });
    }

    if (sortSelect instanceof HTMLSelectElement) {
      sortSelect.addEventListener("change", () => {
        this.appActor.send({
          type: "SORT_UPDATED",
          sort: sortSelect.value as MusicItemSort,
        });

        void this.renderMusicList();
      });
    }
    searchToggle?.addEventListener("click", () => {
      toggleBrowsePanel(
        searchPanel instanceof HTMLElement ? searchPanel : null,
        searchToggle instanceof HTMLElement ? searchToggle : null,
        sortPanel instanceof HTMLElement ? sortPanel : null,
        sortToggle instanceof HTMLElement ? sortToggle : null,
      );
    });

    sortToggle?.addEventListener("click", () => {
      toggleBrowsePanel(
        sortPanel instanceof HTMLElement ? sortPanel : null,
        sortToggle instanceof HTMLElement ? sortToggle : null,
        searchPanel instanceof HTMLElement ? searchPanel : null,
        searchToggle instanceof HTMLElement ? searchToggle : null,
      );
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !(browseTools instanceof HTMLElement)) {
        return;
      }

      if (browseTools.contains(target)) {
        return;
      }

      closeBrowsePanels();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeBrowsePanels();
      }
    });
  }

  private getNormalizedSearchQuery(): string {
    return this.appCtx.searchQuery.trim().toLowerCase();
  }

  private isBrowseOrderLocked(): boolean {
    return this.getNormalizedSearchQuery().length > 0 || this.appCtx.currentSort !== "default";
  }

  private async renderStackBar(): Promise<void> {
    const stacks = await this.api.listStacks();
    this.appActor.send({
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

    const searchQuery = this.getNormalizedSearchQuery();
    const visibleStacks = searchQuery
      ? this.appCtx.stacks.filter(
          (stack) =>
            stack.id === this.appCtx.currentStack || stack.name.toLowerCase().includes(searchQuery),
        )
      : this.appCtx.stacks;

    for (const stack of visibleStacks) {
      const button = document.createElement("button");
      button.className = `stack-tab${this.appCtx.currentStack === stack.id ? " active" : ""}`;
      button.dataset.stackId = String(stack.id);
      button.textContent = stack.name;
      bar.insertBefore(button, manageBtn);
    }

    if (allBtn) {
      allBtn.className = `stack-tab${this.appCtx.currentStack === null ? " active" : ""}`;
    }

    if (deleteBtn instanceof HTMLButtonElement) {
      const selectedStack = this.appCtx.stacks.find(
        (stack) => stack.id === this.appCtx.currentStack,
      );
      const hasSelection = selectedStack !== undefined;
      deleteBtn.hidden = !hasSelection;
      deleteBtn.disabled = !hasSelection;
      deleteBtn.title = hasSelection ? `Delete "${selectedStack.name}"` : "Delete selected stack";
    }

    const list = document.getElementById("music-list");
    if (list instanceof HTMLElement) {
      this.renderStackParentLinker(list);
    }

    this.syncStackFeedLinks();
    this.syncCustomStackScrollbar();
  }

  private syncStackFeedLinks(): void {
    document.head.querySelectorAll("link[data-rss-feed-link]").forEach((element) => {
      element.remove();
    });

    for (const stack of this.appCtx.stacks) {
      const link = document.createElement("link");
      link.rel = "alternate";
      link.type = "application/rss+xml";
      link.title = buildStackFeedTitle(stack.name);
      link.href = buildStackFeedHref(stack.id);
      link.dataset.rssFeedLink = String(stack.id);
      if (this.appCtx.currentStack === stack.id) {
        link.dataset.rssActiveFeed = "true";
      }
      document.head.appendChild(link);
    }
  }

  private setupStackBar(): void {
    const bar = document.getElementById("stack-bar");
    if (!bar) {
      return;
    }

    bar.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const deleteBtn = target.closest("#delete-stack-btn");
      if (deleteBtn) {
        if (this.appCtx.currentStack !== null) {
          await this.deleteStackById(this.appCtx.currentStack);
        }
        return;
      }

      const tab = target.closest(".stack-tab") as HTMLElement | null;
      if (!tab || tab.id === "manage-stacks-btn" || tab.id === "delete-stack-btn") {
        return;
      }

      if (tab.dataset.stack === "all") {
        this.appActor.send({ type: "STACK_SELECTED_ALL" });
      } else if (tab.dataset.stackId) {
        this.appActor.send({
          type: "STACK_SELECTED",
          stackId: Number(tab.dataset.stackId),
        });
      }

      void this.renderStackBar();
      void this.renderMusicList();
    });
  }

  private setupCustomStackScrollbar(): void {
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

    this.stackBarEl = bar;
    this.stackBarScrollbarEl = scrollbar;
    this.stackBarTrackEl = track;
    this.stackBarThumbEl = thumb;

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
      if (
        !this.stackThumbDrag ||
        !this.stackBarEl ||
        !this.stackBarTrackEl ||
        !this.stackBarThumbEl
      ) {
        return;
      }

      const scrollRange = this.stackBarEl.scrollWidth - this.stackBarEl.clientWidth;
      if (scrollRange <= 0) {
        return;
      }

      const trackWidth = this.stackBarTrackEl.clientWidth;
      const thumbWidth = this.stackBarThumbEl.offsetWidth;
      const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
      if (maxThumbLeft <= 0) {
        return;
      }

      const nextLeft = Math.max(
        0,
        Math.min(
          maxThumbLeft,
          this.stackThumbDrag.startLeft + (event.clientX - this.stackThumbDrag.startX),
        ),
      );
      const ratio = nextLeft / maxThumbLeft;
      this.stackBarEl.scrollLeft = ratio * scrollRange;
    };

    const onDragEnd = (): void => {
      this.stackThumbDrag = null;
      document.removeEventListener("mousemove", onDragMove);
    };

    thumb.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      this.stackThumbDrag = {
        startX: event.clientX,
        startLeft: thumbRect.left - trackRect.left,
      };
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd, { once: true });
    });

    bar.addEventListener("scroll", () => {
      this.syncCustomStackScrollbar();
    });
    window.addEventListener("resize", () => {
      this.syncCustomStackScrollbar();
    });

    this.syncCustomStackScrollbar();
  }

  private syncCustomStackScrollbar(): void {
    if (
      !this.stackBarEl ||
      !this.stackBarScrollbarEl ||
      !this.stackBarTrackEl ||
      !this.stackBarThumbEl
    ) {
      return;
    }

    const isMobile = window.matchMedia("(max-width: 520px)").matches;
    const scrollRange = this.stackBarEl.scrollWidth - this.stackBarEl.clientWidth;
    const hasOverflow = isMobile && scrollRange > 0;

    this.stackBarScrollbarEl.classList.toggle("is-disabled", !hasOverflow);

    const trackWidth = this.stackBarTrackEl.clientWidth;
    if (!hasOverflow || trackWidth <= 0) {
      this.stackBarThumbEl.style.width = `${trackWidth}px`;
      this.stackBarThumbEl.style.left = "0px";
      return;
    }

    const minThumbWidth = 42;
    const thumbWidth = Math.max(
      minThumbWidth,
      Math.floor((this.stackBarEl.clientWidth / this.stackBarEl.scrollWidth) * trackWidth),
    );
    const maxThumbLeft = Math.max(trackWidth - thumbWidth, 0);
    const scrollRatio = scrollRange <= 0 ? 0 : this.stackBarEl.scrollLeft / scrollRange;
    const thumbLeft = Math.round(maxThumbLeft * scrollRatio);

    this.stackBarThumbEl.style.width = `${thumbWidth}px`;
    this.stackBarThumbEl.style.left = `${thumbLeft}px`;
  }

  private async deleteStackById(stackId: number): Promise<void> {
    const stack = this.appCtx.stacks.find((candidate) => candidate.id === stackId);
    const stackName = stack?.name ?? "this stack";
    if (!confirm(`Delete "${stackName}"? Links won't be deleted, just untagged.`)) {
      return;
    }

    await this.api.deleteStack(stackId);
    this.appActor.send({
      type: "STACK_DELETED",
      stackId,
    });
    await this.renderStackBar();
    await this.renderStackManagePanel();
    await this.renderMusicList();
  }

  private setupEventDelegation(): void {
    const list = document.getElementById("music-list");
    if (!list) {
      return;
    }

    list.addEventListener("pointermove", (event) => {
      if (this.isReordering) {
        return;
      }

      const hover = resolveStarRatingHover(event as MouseEvent);
      if (!hover) {
        return;
      }

      if (this.activeStarRatingPreviewEl && this.activeStarRatingPreviewEl !== hover.element) {
        clearStarRatingPreview(this.activeStarRatingPreviewEl);
      }

      setStarRatingPreview(hover.element, hover.hoverRating);
      this.activeStarRatingPreviewEl = hover.element;
    });

    list.addEventListener("pointerout", (event) => {
      if (this.isReordering) {
        return;
      }

      if (!this.activeStarRatingPreviewEl) {
        return;
      }

      const target = event.target as Node | null;
      if (!target || !this.activeStarRatingPreviewEl.contains(target)) {
        return;
      }

      const relatedTarget = event.relatedTarget as Node | null;
      if (relatedTarget && this.activeStarRatingPreviewEl.contains(relatedTarget)) {
        return;
      }

      clearStarRatingPreview(this.activeStarRatingPreviewEl);
      this.activeStarRatingPreviewEl = null;
    });

    list.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const menuToggle = target.closest('[data-action="toggle-item-menu"]') as HTMLElement | null;

      if (menuToggle) {
        const itemContext = this.resolveItemContext(menuToggle);
        if (itemContext) {
          this.toggleItemActionMenu(itemContext.card, menuToggle);
        }
        return;
      }

      if (target.closest(".music-card__menu-item")) {
        this.closeItemActionMenu();
      }

      const starRating = resolveStarRatingInteraction(event as MouseEvent);
      if (starRating) {
        this.closeItemActionMenu();
        clearStarRatingPreview(starRating.element);
        this.activeStarRatingPreviewEl = null;
        setStarRatingPending(starRating.element, true);
        setStarRatingValue(starRating.element, starRating.nextRating);
        try {
          await this.api.updateMusicItem(starRating.itemId, { rating: starRating.nextRating });
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
        const itemContext = this.resolveItemContext(target);
        if (itemContext) {
          this.closeItemActionMenu();
          await this.renderStackDropdown(itemContext.card, itemContext.itemId);
        }
        return;
      }

      const deleteBtn = target.closest(
        '[data-action="delete"], [data-action="delete-menu"]',
      ) as HTMLElement | null;
      if (!deleteBtn) {
        return;
      }

      const itemContext = this.resolveItemContext(deleteBtn);
      if (!itemContext || !confirm("Delete this item?")) {
        return;
      }

      this.closeItemActionMenu();
      itemContext.card.remove();
      await this.api.deleteMusicItem(itemContext.itemId);
    });

    list.addEventListener("change", async (event) => {
      const target = event.target as HTMLElement;

      if (target instanceof HTMLSelectElement && target.classList.contains("status-select")) {
        const itemContext = this.resolveItemContext(target);
        if (!itemContext) {
          return;
        }

        await this.api.updateListenStatus(itemContext.itemId, target.value as ListenStatus);
        await this.renderMusicList();
        return;
      }
    });
  }

  private resolveItemContext(target: HTMLElement): ItemContext | null {
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

  private setupMusicListReorder(): void {
    const list = document.getElementById("music-list");
    if (!(list instanceof HTMLElement) || this.musicListSortable) {
      return;
    }

    this.musicListSortable = Sortable.create(list, {
      draggable: ".music-card",
      animation: 160,
      fallbackTolerance: 4,
      invertSwap: true,
      swapThreshold: 0.35,
      // Keep interactive controls clickable while making the card body draggable.
      filter:
        "button:not(.music-card__reorder-handle),input,select,textarea,[data-action],.music-card__menu-item",
      preventOnFilter: false,
      ghostClass: "music-card--drag-ghost",
      chosenClass: "music-card--drag-chosen",
      dragClass: "music-card--dragging",
      onStart: () => {
        this.isReordering = true;
        this.closeItemActionMenu();
        this.closeActiveStackDropdown();
      },
      onEnd: (event: Sortable.SortableEvent) => {
        this.isReordering = false;
        if (event.oldIndex === event.newIndex) {
          return;
        }

        void this.persistMusicListOrder();
      },
    });

    this.musicListReorderMediaQuery = window.matchMedia("(max-width: 520px)");
    this.musicListReorderMediaQuery.addEventListener(
      "change",
      this.handleMusicListReorderMediaChange,
    );
    this.syncMusicListReorderMode();
  }

  private syncMusicListReorderMode(): void {
    if (!this.musicListSortable) {
      return;
    }

    const handleSelector = this.musicListReorderMediaQuery?.matches
      ? ".music-card__reorder-handle"
      : undefined;
    this.musicListSortable.option("handle", handleSelector);
  }

  private async persistMusicListOrder(): Promise<void> {
    if (this.isBrowseOrderLocked()) {
      return;
    }

    const list = document.getElementById("music-list");
    if (!(list instanceof HTMLElement)) {
      return;
    }

    const itemIds = Array.from(list.querySelectorAll<HTMLElement>("[data-item-id]"))
      .map((card) => Number(card.dataset.itemId))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (itemIds.length === 0) {
      return;
    }

    const contextKey = buildContextKey(this.appCtx.currentFilter, this.appCtx.currentStack);
    try {
      await this.api.saveOrder(contextKey, itemIds);
    } catch (error) {
      console.error("Failed to persist reordered items:", error);
      await this.renderMusicList();
      alert("Failed to save the new order. Please try again.");
    }
  }

  private setupCustomListScrollbar(): void {
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

    this.musicListEl = list;
    this.musicListScrollbarEl = scrollbar;
    this.musicListTrackEl = track;
    this.musicListThumbEl = thumb;

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
      if (
        !this.listThumbDrag ||
        !this.musicListEl ||
        !this.musicListTrackEl ||
        !this.musicListThumbEl
      ) {
        return;
      }

      const scrollRange = this.musicListEl.scrollHeight - this.musicListEl.clientHeight;
      if (scrollRange <= 0) {
        return;
      }

      const trackHeight = this.musicListTrackEl.clientHeight;
      const thumbHeight = this.musicListThumbEl.offsetHeight;
      const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
      if (maxThumbTop <= 0) {
        return;
      }

      const nextTop = Math.max(
        0,
        Math.min(
          maxThumbTop,
          this.listThumbDrag.startTop + (event.clientY - this.listThumbDrag.startY),
        ),
      );
      const ratio = nextTop / maxThumbTop;
      this.musicListEl.scrollTop = ratio * scrollRange;
    };

    const onDragEnd = (): void => {
      this.listThumbDrag = null;
      document.removeEventListener("mousemove", onDragMove);
    };

    thumb.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const trackRect = track.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      this.listThumbDrag = {
        startY: event.clientY,
        startTop: thumbRect.top - trackRect.top,
      };
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd, { once: true });
    });

    list.addEventListener("scroll", () => {
      this.syncCustomListScrollbar();
    });
    window.addEventListener("resize", () => {
      this.syncCustomListScrollbar();
    });

    this.syncCustomListScrollbar();
  }

  private syncCustomListScrollbar(): void {
    if (
      !this.musicListEl ||
      !this.musicListScrollbarEl ||
      !this.musicListTrackEl ||
      !this.musicListThumbEl
    ) {
      return;
    }

    const scrollRange = this.musicListEl.scrollHeight - this.musicListEl.clientHeight;
    const hasOverflow = scrollRange > 0;
    this.musicListScrollbarEl.classList.toggle("is-disabled", !hasOverflow);

    const trackHeight = this.musicListTrackEl.clientHeight;
    if (!hasOverflow || trackHeight <= 0) {
      this.musicListThumbEl.style.height = `${trackHeight}px`;
      this.musicListThumbEl.style.top = "0px";
      return;
    }

    const minThumbHeight = 56;
    const thumbHeight = Math.max(
      minThumbHeight,
      Math.floor((this.musicListEl.clientHeight / this.musicListEl.scrollHeight) * trackHeight),
    );
    const maxThumbTop = Math.max(trackHeight - thumbHeight, 0);
    const scrollRatio = scrollRange <= 0 ? 0 : this.musicListEl.scrollTop / scrollRange;
    const thumbTop = Math.round(maxThumbTop * scrollRatio);

    this.musicListThumbEl.style.height = `${thumbHeight}px`;
    this.musicListThumbEl.style.top = `${thumbTop}px`;
  }

  private async renderMusicList(): Promise<void> {
    const container = document.getElementById("music-list");
    if (!container) {
      return;
    }

    if (this.activeStarRatingPreviewEl) {
      this.activeStarRatingPreviewEl = null;
    }

    this.closeItemActionMenu();
    const filters = buildMusicItemFilters(
      this.appCtx.currentFilter,
      this.appCtx.currentStack,
      this.appCtx.searchQuery,
      this.appCtx.currentSort,
    );
    const result = await this.api.listMusicItems(filters);

    container.innerHTML = renderMusicList(
      result.items,
      this.appCtx.currentFilter,
      this.appCtx.searchQuery,
    );
    this.setupMusicListReorder();
    this.musicListSortable?.option("disabled", this.isBrowseOrderLocked());
    this.renderStackParentLinker(container);
    this.syncCustomListScrollbar();
    requestAnimationFrame(() => {
      this.syncCustomListScrollbar();
    });
  }

  private async renderStackManagePanel(): Promise<void> {
    const stacks = await this.api.listStacks();
    const list = document.getElementById("stack-manage-list");
    if (!list) {
      return;
    }

    const searchQuery = this.getNormalizedSearchQuery();
    const visibleStacks = searchQuery
      ? stacks.filter((stack) => stack.name.toLowerCase().includes(searchQuery))
      : stacks;

    list.innerHTML = renderStackManageList(visibleStacks);
  }

  private setupStackManagePanel(): void {
    const panel = document.getElementById("stack-manage");
    const manageButton = document.getElementById("manage-stacks-btn");
    if (!panel || !manageButton) {
      return;
    }

    manageButton.addEventListener("click", () => {
      this.appActor.send({ type: "STACK_MANAGE_TOGGLED" });
      panel.hidden = !this.appCtx.stackManageOpen;

      if (!panel.hidden) {
        void this.renderStackManagePanel();
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

      await this.api.createStack(name);
      input.value = "";
      await this.renderStackBar();
      await this.renderStackManagePanel();
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

        await this.api.renameStack(stackId, newName);
        await this.renderStackBar();
        await this.renderStackManagePanel();
      }

      if (target.classList.contains("stack-manage__delete-btn")) {
        await this.deleteStackById(stackId);
      }
    });
  }

  private setupStackParentLinker(): void {
    document.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;
      const linkButton = target.closest("#stack-parent-link-btn");
      if (!(linkButton instanceof HTMLButtonElement)) {
        return;
      }

      const parentSelect = document.getElementById("stack-parent-select");
      if (!(parentSelect instanceof HTMLSelectElement) || this.appCtx.currentStack === null) {
        return;
      }

      const parentStackId = Number(parentSelect.value);
      if (!Number.isInteger(parentStackId) || parentStackId <= 0) {
        return;
      }

      try {
        await this.api.setStackParent(this.appCtx.currentStack, parentStackId);
        parentSelect.value = "";
        await this.renderStackBar();
        if (this.appCtx.stackManageOpen) {
          await this.renderStackManagePanel();
        }
        await this.renderMusicList();
      } catch (error) {
        console.error("Failed to add list to list:", error);
        alert("Failed to add list to list. It may create a cycle.");
      }
    });
  }

  private renderStackParentLinker(list: HTMLElement): void {
    const existing = list.querySelector("#stack-parent-linker");
    if (existing instanceof HTMLElement) {
      existing.remove();
    }

    if (this.appCtx.currentStack === null) {
      return;
    }

    const currentStack = this.appCtx.stacks.find((stack) => stack.id === this.appCtx.currentStack);
    if (!currentStack) {
      return;
    }

    const parentCandidates = this.appCtx.stacks.filter(
      (stack) => stack.id !== this.appCtx.currentStack,
    );

    const options =
      (parentCandidates.length === 0
        ? '<option value="">No other lists</option>'
        : '<option value="">Parent list...</option>') +
      parentCandidates
        .map((stack) => `<option value="${stack.id}">${stack.name}</option>`)
        .join("");

    const linker = document.createElement("div");
    linker.id = "stack-parent-linker";
    linker.className = "music-list__parent-linker";
    linker.innerHTML = `
      <select id="stack-parent-select" class="input" aria-label="Parent list">
        ${options}
      </select>
      <button
        type="button"
        id="stack-parent-link-btn"
        class="btn btn--ghost"
        title="Add current list to parent list"
      >
        +
      </button>
    `;

    const parentSelect = linker.querySelector("#stack-parent-select");
    const linkButton = linker.querySelector("#stack-parent-link-btn");
    if (
      !(parentSelect instanceof HTMLSelectElement) ||
      !(linkButton instanceof HTMLButtonElement)
    ) {
      return;
    }

    const hasCandidates = parentCandidates.length > 0;
    parentSelect.disabled = !hasCandidates;
    linkButton.disabled = !hasCandidates;
    if (currentStack.parent_stack_id !== null) {
      parentSelect.value = String(currentStack.parent_stack_id);
    }

    list.appendChild(linker);
  }

  private renderAddFormStackChips(): void {
    const container = document.getElementById("add-form-stack-chips");
    if (!container) {
      return;
    }

    container.innerHTML = renderAddFormStackChips(
      this.formCtx.selectedStackIds,
      this.appCtx.stacks,
    );
  }

  private async showAddFormStackDropdown(): Promise<void> {
    const picker = document.getElementById("add-form-stacks");
    if (!(picker instanceof HTMLElement)) {
      return;
    }

    await this.openStackDropdown({
      container: picker,
      selectedStackIds: new Set(this.formCtx.selectedStackIds),
      onToggle: (stackId, checked) => {
        this.addFormActor.send({
          type: "STACK_TOGGLED",
          stackId,
          checked,
        });
        this.renderAddFormStackChips();
      },
      onCreate: async (name) => {
        const stack = await this.api.createStack(name);
        this.addFormActor.send({
          type: "STACK_ADDED",
          stackId: stack.id,
        });
        await this.renderStackBar();
        this.renderAddFormStackChips();
        await this.showAddFormStackDropdown();
      },
      shouldIgnoreOutsideClick: (target) => target.closest("#add-form-stack-btn") !== null,
    });
  }

  private async renderStackDropdown(cardEl: HTMLElement, itemId: number): Promise<void> {
    const actionsEl = cardEl.querySelector(".music-card__actions");
    if (!(actionsEl instanceof HTMLElement)) {
      return;
    }

    const itemStacks = await this.api.getStacksForItem(itemId);
    actionsEl.style.position = "relative";
    await this.openStackDropdown({
      container: actionsEl,
      selectedStackIds: new Set(itemStacks.map((stack) => stack.id)),
      onToggle: async (stackId, checked) => {
        if (checked) {
          await this.api.addItemToStack(itemId, stackId);
        } else {
          await this.api.removeItemFromStack(itemId, stackId);
        }

        await this.renderStackBar();
      },
      onCreate: async (name) => {
        const stack = await this.api.createStack(name);
        await this.api.addItemToStack(itemId, stack.id);
        await this.renderStackDropdown(cardEl, itemId);
        await this.renderStackBar();
      },
      onClose: () => {
        void this.renderMusicList();
      },
    });
  }

  private closeActiveStackDropdown(): void {
    this.activeStackDropdownCleanup?.(true);
    this.activeStackDropdownCleanup = null;
  }

  private closeItemActionMenu(): void {
    this.activeItemActionMenuCleanup?.();
    this.activeItemActionMenuCleanup = null;
  }

  private toggleItemActionMenu(cardEl: HTMLElement, toggleEl: HTMLElement): void {
    const panel = cardEl.querySelector(".music-card__menu-panel");
    if (!(panel instanceof HTMLElement)) {
      return;
    }

    const alreadyOpen = !panel.hidden;
    this.closeItemActionMenu();

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

      if (this.activeItemActionMenuCleanup === close) {
        this.activeItemActionMenuCleanup = null;
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

    this.activeItemActionMenuCleanup = close;
    document.addEventListener("keydown", onEscape);

    setTimeout(() => {
      if (closed) {
        return;
      }

      document.addEventListener("click", onOutsideClick);
    }, 0);
  }

  private async openStackDropdown(options: StackDropdownOptions): Promise<void> {
    this.closeActiveStackDropdown();

    const stacks = await this.api.listStacks();

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

      if (this.activeStackDropdownCleanup === close) {
        this.activeStackDropdownCleanup = null;
      }

      if (!skipOnClose) {
        options.onClose?.();
      }
    };

    this.activeStackDropdownCleanup = close;
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

  private get appCtx() {
    return this.appActor.getSnapshot().context;
  }

  private get formCtx() {
    return this.addFormActor.getSnapshot().context;
  }
}
