import { ApiClient } from "./services/api-client";
import type { ListenStatus } from "./types";
import {
  buildCreateMusicItemInputFromValues,
  getCoverScanErrorMessage,
  hasAnyNonEmptyField,
} from "./ui/domain/add-form";
import type { AddFormValues } from "./ui/domain/add-form";
import { buildMusicItemFilters, buildContextKey } from "./ui/domain/music-list";
import { constrainDimensions } from "./ui/domain/scan";
import { initialAddFormState, transitionAddFormState } from "./ui/state/add-form-machine";
import { initialAppState, transitionAppState } from "./ui/state/app-machine";
import {
  initialRatingState,
  resolveRatingClick,
  transitionRatingState,
} from "./ui/state/rating-machine";
import {
  renderAddFormStackChips,
  renderMusicList,
  renderStackDropdownContent,
  renderStackManageList,
  renderStackRenameEditor,
} from "./ui/view/templates";

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

export class App {
  private api: ApiClient;
  private appState = initialAppState;
  private addFormState = initialAddFormState;
  private ratingState = initialRatingState;
  private dragState: { sourceCard: HTMLElement | null } = { sourceCard: null };
  private activeStackDropdownCleanup: ((skipOnClose?: boolean) => void) | null = null;

  constructor() {
    this.api = new ApiClient();
  }

  async initialize(): Promise<void> {
    this.setupAddForm();
    this.appState = transitionAppState(this.appState, { type: "APP_READY" });
    this.initializeUI();

    const versionEl = document.getElementById("app-version");
    if (versionEl) {
      versionEl.textContent = `v${__APP_VERSION__}`;
    }
  }

  private initializeUI(): void {
    this.setupFilterBar();
    this.setupStackBar();
    this.setupStackManagePanel();
    this.setupEventDelegation();
    void this.renderStackBar();
    void this.renderMusicList();
  }

  private setupAddForm(): void {
    if (this.addFormState.initialized) {
      return;
    }

    const form = document.getElementById("add-form");
    const submitButton = document.getElementById("add-form-submit");
    if (!(form instanceof HTMLFormElement) || !(submitButton instanceof HTMLButtonElement)) {
      return;
    }

    this.addFormState = transitionAddFormState(this.addFormState, { type: "INITIALIZED" });

    const detailsEl = form.querySelector(".add-form__details");
    const titleInput = form.querySelector('input[name="title"]');
    const artistInput = form.querySelector('input[name="artist"]');
    const artworkInput = form.querySelector('input[name="artworkUrl"]');
    const scanButton = document.getElementById("add-form-scan-btn");
    const scanInput = document.getElementById("scan-file-input");

    const updateSubmitState = (): void => {
      const fieldsToCheck = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[name="url"], input[name="title"], input[name="artist"], input[name="label"], input[name="year"], input[name="country"], input[name="genre"], input[name="catalogueNumber"], textarea[name="notes"]',
      );
      submitButton.disabled = !hasAnyNonEmptyField(
        Array.from(fieldsToCheck, (field) => field.value),
      );
    };

    form.addEventListener("input", updateSubmitState);

    if (scanButton instanceof HTMLButtonElement && scanInput instanceof HTMLInputElement) {
      scanButton.addEventListener("click", () => {
        if (this.addFormState.scanState === "scanning") {
          return;
        }

        scanInput.click();
      });

      scanInput.addEventListener("change", async () => {
        const file = scanInput.files?.[0];
        if (!file) {
          return;
        }

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

      this.addFormState = transitionAddFormState(this.addFormState, {
        type: "STACK_REMOVED",
        stackId: Number(target.dataset.removeStack),
      });
      this.renderAddFormStackChips();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!this.appState.isReady) {
        alert("App is still loading. Please try again in a moment.");
        return;
      }

      const formData = new FormData(form);
      const values = this.readAddFormValues(formData);

      try {
        const item = await this.api.createMusicItem(buildCreateMusicItemInputFromValues(values));

        if (this.addFormState.selectedStackIds.length > 0) {
          await this.api.setItemStacks(item.id, this.addFormState.selectedStackIds);
          this.addFormState = transitionAddFormState(this.addFormState, { type: "CLEAR_STACKS" });
          this.renderAddFormStackChips();
          await this.renderStackBar();
        }

        form.reset();
        submitButton.disabled = true;
        await this.renderMusicList();
      } catch (error) {
        console.error("Failed to add item:", error);
        alert("Failed to add item. Please check the URL and try again.");
      }
    });
  }

  private readAddFormValues(formData: FormData): AddFormValues {
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

  private setScanButtonState(button: HTMLButtonElement, isLoading: boolean): void {
    this.addFormState = transitionAddFormState(this.addFormState, {
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

      this.appState = transitionAppState(this.appState, {
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

  private async renderStackBar(): Promise<void> {
    const stacks = await this.api.listStacks();
    this.appState = transitionAppState(this.appState, {
      type: "STACKS_LOADED",
      stacks,
    });

    const bar = document.getElementById("stack-bar");
    const manageBtn = document.getElementById("manage-stacks-btn");
    if (!bar || !manageBtn) {
      return;
    }

    const allBtn = bar.querySelector('[data-stack="all"]');

    bar.querySelectorAll(".stack-tab[data-stack-id]").forEach((element) => {
      element.remove();
    });

    for (const stack of this.appState.stacks) {
      const button = document.createElement("button");
      button.className = `stack-tab${this.appState.currentStack === stack.id ? " active" : ""}`;
      button.dataset.stackId = String(stack.id);
      button.textContent = stack.name;
      bar.insertBefore(button, manageBtn);
    }

    if (allBtn) {
      allBtn.className = `stack-tab${this.appState.currentStack === null ? " active" : ""}`;
    }
  }

  private setupStackBar(): void {
    const bar = document.getElementById("stack-bar");
    if (!bar) {
      return;
    }

    bar.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const tab = target.closest(".stack-tab") as HTMLElement | null;
      if (!tab || tab.id === "manage-stacks-btn") {
        return;
      }

      if (tab.dataset.stack === "all") {
        this.appState = transitionAppState(this.appState, { type: "STACK_SELECTED_ALL" });
      } else if (tab.dataset.stackId) {
        this.appState = transitionAppState(this.appState, {
          type: "STACK_SELECTED",
          stackId: Number(tab.dataset.stackId),
        });
      }

      void this.renderStackBar();
      void this.renderMusicList();
    });
  }

  private setupEventDelegation(): void {
    const list = document.getElementById("music-list");
    if (!list) {
      return;
    }

    list.addEventListener("click", async (event) => {
      const target = event.target as HTMLElement;

      if (target.dataset.action === "stack" || target.closest('[data-action="stack"]')) {
        const itemContext = this.resolveItemContext(target);
        if (itemContext) {
          await this.renderStackDropdown(itemContext.card, itemContext.itemId);
        }
        return;
      }

      const deleteBtn = target.closest('[data-action="delete"]') as HTMLElement | null;
      if (!deleteBtn) {
        return;
      }

      const itemContext = this.resolveItemContext(deleteBtn);
      if (!itemContext || !confirm("Delete this item?")) {
        return;
      }

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

      if (!(target instanceof HTMLInputElement) || !this.isRatingInput(target)) {
        return;
      }

      const itemContext = this.resolveItemContext(target);
      if (!itemContext) {
        return;
      }

      await this.api.updateMusicItem(itemContext.itemId, { rating: Number(target.value) });
      await this.renderMusicList();
    });

    list.addEventListener("mousedown", (event) => {
      const input = this.resolveRatingInput(event.target as HTMLElement);
      if (!this.isRatingInput(input)) {
        return;
      }

      if (!input.checked) {
        this.ratingState = transitionRatingState(this.ratingState, { type: "RESET" });
        return;
      }

      const itemContext = this.resolveItemContext(input);
      if (!itemContext) {
        this.ratingState = transitionRatingState(this.ratingState, { type: "RESET" });
        return;
      }

      this.ratingState = transitionRatingState(this.ratingState, {
        type: "POINTER_DOWN_ON_CHECKED",
        itemId: itemContext.itemId,
        value: Number(input.value),
      });
    });

    list.addEventListener("click", async (event) => {
      const input = this.resolveRatingInput(event.target as HTMLElement);
      if (!this.isRatingInput(input)) {
        return;
      }

      const itemContext = this.resolveItemContext(input);
      if (!itemContext) {
        this.ratingState = transitionRatingState(this.ratingState, { type: "RESET" });
        return;
      }

      const clickResult = resolveRatingClick(
        this.ratingState,
        itemContext.itemId,
        Number(input.value),
      );
      this.ratingState = clickResult.state;

      if (clickResult.shouldClear) {
        await this.api.updateMusicItem(itemContext.itemId, { rating: null });
        await this.renderMusicList();
      }
    });

    list.addEventListener("dragstart", (event) => {
      const card = (event.target as HTMLElement).closest(".music-card") as HTMLElement | null;
      if (!card) return;
      this.dragState.sourceCard = card;
      card.classList.add("is-dragging");
      event.dataTransfer?.setData("text/plain", card.dataset.itemId ?? "");
    });

    list.addEventListener("dragend", () => {
      this.dragState.sourceCard?.classList.remove("is-dragging");
      this.dragState.sourceCard = null;
      this.clearDropTargets(list);
    });

    list.addEventListener("dragover", (event) => {
      event.preventDefault();
      const target = (event.target as HTMLElement).closest(".music-card") as HTMLElement | null;
      if (!target || target === this.dragState.sourceCard) return;

      this.clearDropTargets(list);

      const rect = target.getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      if (event.clientY < midpoint) {
        target.classList.add("drop-target-above");
      } else {
        target.classList.add("drop-target-below");
      }
    });

    list.addEventListener("drop", async (event) => {
      event.preventDefault();
      const source = this.dragState.sourceCard;
      if (!source) return;

      const target = (event.target as HTMLElement).closest(".music-card") as HTMLElement | null;
      if (!target || target === source) return;

      const rect = target.getBoundingClientRect();
      const insertBefore = event.clientY < rect.top + rect.height / 2;

      if (insertBefore) {
        list.insertBefore(source, target);
      } else {
        target.after(source);
      }

      const contextKey = buildContextKey(this.appState.currentFilter, this.appState.currentStack);
      const itemIds = Array.from(list.querySelectorAll<HTMLElement>("[data-item-id]"))
        .map((el) => Number(el.dataset.itemId))
        .filter((id) => !Number.isNaN(id) && id > 0);

      await this.api.saveOrder(contextKey, itemIds);
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

  private isRatingInput(input: HTMLInputElement | null): input is HTMLInputElement {
    return input !== null && input.type === "radio" && input.name.startsWith("rating-");
  }

  private clearDropTargets(list: HTMLElement): void {
    list.querySelectorAll(".drop-target-above, .drop-target-below").forEach((el) => {
      el.classList.remove("drop-target-above", "drop-target-below");
    });
  }

  private resolveRatingInput(target: HTMLElement): HTMLInputElement | null {
    if (target instanceof HTMLLabelElement && target.htmlFor) {
      return document.getElementById(target.htmlFor) as HTMLInputElement | null;
    }

    return target.closest('input[type="radio"]') as HTMLInputElement | null;
  }

  private async renderMusicList(): Promise<void> {
    const container = document.getElementById("music-list");
    if (!container) {
      return;
    }

    const filters = buildMusicItemFilters(this.appState.currentFilter, this.appState.currentStack);
    const result = await this.api.listMusicItems(filters);

    container.innerHTML = renderMusicList(result.items, this.appState.currentFilter);
  }

  private async renderStackManagePanel(): Promise<void> {
    const stacks = await this.api.listStacks();
    const list = document.getElementById("stack-manage-list");
    if (!list) {
      return;
    }

    list.innerHTML = renderStackManageList(stacks);
  }

  private setupStackManagePanel(): void {
    const panel = document.getElementById("stack-manage");
    const manageButton = document.getElementById("manage-stacks-btn");
    if (!panel || !manageButton) {
      return;
    }

    manageButton.addEventListener("click", () => {
      this.appState = transitionAppState(this.appState, { type: "STACK_MANAGE_TOGGLED" });
      panel.hidden = !this.appState.stackManageOpen;

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
        const stack = this.appState.stacks.find((candidate) => candidate.id === stackId);
        if (!confirm(`Delete "${stack?.name}"? Links won't be deleted, just untagged.`)) {
          return;
        }

        await this.api.deleteStack(stackId);
        this.appState = transitionAppState(this.appState, {
          type: "STACK_DELETED",
          stackId,
        });
        await this.renderStackBar();
        await this.renderStackManagePanel();
        await this.renderMusicList();
      }
    });
  }

  private renderAddFormStackChips(): void {
    const container = document.getElementById("add-form-stack-chips");
    if (!container) {
      return;
    }

    container.innerHTML = renderAddFormStackChips(
      this.addFormState.selectedStackIds,
      this.appState.stacks,
    );
  }

  private async showAddFormStackDropdown(): Promise<void> {
    const picker = document.getElementById("add-form-stacks");
    if (!(picker instanceof HTMLElement)) {
      return;
    }

    await this.openStackDropdown({
      container: picker,
      selectedStackIds: new Set(this.addFormState.selectedStackIds),
      onToggle: (stackId, checked) => {
        this.addFormState = transitionAddFormState(this.addFormState, {
          type: "STACK_TOGGLED",
          stackId,
          checked,
        });
        this.renderAddFormStackChips();
      },
      onCreate: async (name) => {
        const stack = await this.api.createStack(name);
        this.addFormState = transitionAddFormState(this.addFormState, {
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
        await this.renderStackBar();
        await this.renderStackDropdown(cardEl, itemId);
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
}
