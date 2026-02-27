import type {
  CreateMusicItemInput,
  UpdateMusicItemInput,
  MusicItemFull,
  MusicItemFilters,
  PaginatedResult,
  ListenStatus,
  Stack,
  StackWithCount,
  ScanResult,
  UploadImageResult,
} from "../types";

export class ApiClient {
  constructor(private baseUrl: string = "") {}

  private buildUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private jsonRequest(method: "POST" | "PATCH" | "PUT", body: unknown): RequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private async request(path: string, action: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(this.buildUrl(path), init);
    if (!response.ok) {
      throw new Error(`${action} failed: ${response.status}`);
    }

    return response;
  }

  private async requestJson<T>(path: string, action: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, action, init);
    return (await response.json()) as T;
  }

  private async requestJsonOrNull<T>(
    path: string,
    action: string,
    init?: RequestInit,
  ): Promise<T | null> {
    const response = await fetch(this.buildUrl(path), init);
    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`${action} failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async requestSuccess(path: string, action: string, init?: RequestInit): Promise<boolean> {
    const body = await this.requestJson<{ success?: boolean }>(path, action, init);
    return body.success === true;
  }

  // ── Music Items ──────────────────────────────────────────────

  async createMusicItem(input: CreateMusicItemInput): Promise<MusicItemFull> {
    return this.requestJson<MusicItemFull>(
      "/api/music-items",
      "createMusicItem",
      this.jsonRequest("POST", input),
    );
  }

  async getMusicItem(id: number): Promise<MusicItemFull | null> {
    return this.requestJsonOrNull<MusicItemFull>(`/api/music-items/${id}`, "getMusicItem");
  }

  async updateMusicItem(id: number, input: UpdateMusicItemInput): Promise<MusicItemFull | null> {
    return this.requestJsonOrNull<MusicItemFull>(
      `/api/music-items/${id}`,
      "updateMusicItem",
      this.jsonRequest("PATCH", input),
    );
  }

  async deleteMusicItem(id: number): Promise<boolean> {
    return this.requestSuccess(`/api/music-items/${id}`, "deleteMusicItem", {
      method: "DELETE",
    });
  }

  async listMusicItems(filters?: MusicItemFilters): Promise<PaginatedResult<MusicItemFull>> {
    const params = new URLSearchParams();

    if (filters?.listenStatus) {
      const statuses = Array.isArray(filters.listenStatus)
        ? filters.listenStatus
        : [filters.listenStatus];
      params.set("listenStatus", statuses.join(","));
    }

    if (filters?.purchaseIntent) {
      const intents = Array.isArray(filters.purchaseIntent)
        ? filters.purchaseIntent
        : [filters.purchaseIntent];
      params.set("purchaseIntent", intents.join(","));
    }

    if (filters?.search) {
      params.set("search", filters.search);
    }

    if (filters?.stackId !== undefined) {
      params.set("stackId", String(filters.stackId));
    }

    const qs = params.toString();
    return this.requestJson<PaginatedResult<MusicItemFull>>(
      `/api/music-items${qs ? `?${qs}` : ""}`,
      "listMusicItems",
    );
  }

  async updateListenStatus(id: number, status: ListenStatus): Promise<MusicItemFull | null> {
    return this.updateMusicItem(id, { listenStatus: status });
  }

  async saveOrder(contextKey: string, itemIds: number[]): Promise<void> {
    await this.request(
      "/api/music-items/order",
      "saveOrder",
      this.jsonRequest("PUT", {
        contextKey,
        itemIds,
      }),
    );
  }

  // ── Stacks ───────────────────────────────────────────────────

  async createStack(name: string, parentStackId?: number | null): Promise<Stack> {
    return this.requestJson<Stack>(
      "/api/stacks",
      "createStack",
      this.jsonRequest("POST", { name, parentStackId }),
    );
  }

  async renameStack(id: number, name: string): Promise<Stack | null> {
    return this.requestJsonOrNull<Stack>(
      `/api/stacks/${id}`,
      "renameStack",
      this.jsonRequest("PATCH", { name }),
    );
  }

  async deleteStack(id: number): Promise<boolean> {
    return this.requestSuccess(`/api/stacks/${id}`, "deleteStack", { method: "DELETE" });
  }

  async listStacks(): Promise<StackWithCount[]> {
    return this.requestJson<StackWithCount[]>("/api/stacks", "listStacks");
  }

  async getStacksForItem(musicItemId: number): Promise<Stack[]> {
    return this.requestJson<Stack[]>(`/api/stacks/items/${musicItemId}`, "getStacksForItem");
  }

  async addItemToStack(musicItemId: number, stackId: number): Promise<void> {
    await this.request(`/api/stacks/items/${musicItemId}/${stackId}`, "addItemToStack", {
      method: "PUT",
    });
  }

  async removeItemFromStack(musicItemId: number, stackId: number): Promise<void> {
    await this.request(`/api/stacks/items/${musicItemId}/${stackId}`, "removeItemFromStack", {
      method: "DELETE",
    });
  }

  async setItemStacks(musicItemId: number, stackIds: number[]): Promise<void> {
    await this.request(
      `/api/stacks/items/${musicItemId}`,
      "setItemStacks",
      this.jsonRequest("POST", { stackIds }),
    );
  }

  async setStackParent(stackId: number, parentStackId: number | null): Promise<void> {
    await this.request(
      `/api/stacks/${stackId}/parent`,
      "setStackParent",
      this.jsonRequest("PATCH", { parentStackId }),
    );
  }

  // ── Release Scan ────────────────────────────────────────────

  async scanCover(imageBase64: string): Promise<ScanResult> {
    return this.requestJson<ScanResult>(
      "/api/release/scan",
      "scanCover",
      this.jsonRequest("POST", { imageBase64 }),
    );
  }

  async uploadReleaseImage(imageBase64: string): Promise<UploadImageResult> {
    return this.requestJson<UploadImageResult>(
      "/api/release/image",
      "uploadReleaseImage",
      this.jsonRequest("POST", { imageBase64 }),
    );
  }
}
