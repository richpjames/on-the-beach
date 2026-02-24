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

  // ── Music Items ──────────────────────────────────────────────

  async createMusicItem(input: CreateMusicItemInput): Promise<MusicItemFull> {
    const res = await fetch(`${this.baseUrl}/api/music-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`createMusicItem failed: ${res.status}`);
    return res.json();
  }

  async getMusicItem(id: number): Promise<MusicItemFull | null> {
    const res = await fetch(`${this.baseUrl}/api/music-items/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getMusicItem failed: ${res.status}`);
    return res.json();
  }

  async updateMusicItem(id: number, input: UpdateMusicItemInput): Promise<MusicItemFull | null> {
    const res = await fetch(`${this.baseUrl}/api/music-items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`updateMusicItem failed: ${res.status}`);
    return res.json();
  }

  async deleteMusicItem(id: number): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/music-items/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`deleteMusicItem failed: ${res.status}`);
    const body = await res.json();
    return body.success === true;
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
    const url = `${this.baseUrl}/api/music-items${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`listMusicItems failed: ${res.status}`);
    return res.json();
  }

  async updateListenStatus(id: number, status: ListenStatus): Promise<MusicItemFull | null> {
    return this.updateMusicItem(id, { listenStatus: status });
  }

  // ── Stacks ───────────────────────────────────────────────────

  async createStack(name: string): Promise<Stack> {
    const res = await fetch(`${this.baseUrl}/api/stacks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`createStack failed: ${res.status}`);
    return res.json();
  }

  async renameStack(id: number, name: string): Promise<Stack | null> {
    const res = await fetch(`${this.baseUrl}/api/stacks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`renameStack failed: ${res.status}`);
    return res.json();
  }

  async deleteStack(id: number): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/stacks/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`deleteStack failed: ${res.status}`);
    const body = await res.json();
    return body.success === true;
  }

  async listStacks(): Promise<StackWithCount[]> {
    const res = await fetch(`${this.baseUrl}/api/stacks`);
    if (!res.ok) throw new Error(`listStacks failed: ${res.status}`);
    return res.json();
  }

  async getStacksForItem(musicItemId: number): Promise<Stack[]> {
    const res = await fetch(`${this.baseUrl}/api/stacks/items/${musicItemId}`);
    if (!res.ok) throw new Error(`getStacksForItem failed: ${res.status}`);
    return res.json();
  }

  async addItemToStack(musicItemId: number, stackId: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/stacks/items/${musicItemId}/${stackId}`, {
      method: "PUT",
    });
    if (!res.ok) throw new Error(`addItemToStack failed: ${res.status}`);
  }

  async removeItemFromStack(musicItemId: number, stackId: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/stacks/items/${musicItemId}/${stackId}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`removeItemFromStack failed: ${res.status}`);
  }

  async setItemStacks(musicItemId: number, stackIds: number[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/stacks/items/${musicItemId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stackIds }),
    });
    if (!res.ok) throw new Error(`setItemStacks failed: ${res.status}`);
  }

  // ── Release Scan ────────────────────────────────────────────

  async scanCover(imageBase64: string): Promise<ScanResult> {
    const res = await fetch(`${this.baseUrl}/api/release/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
    });
    if (!res.ok) throw new Error(`scanCover failed: ${res.status}`);
    return res.json();
  }

  async uploadReleaseImage(imageBase64: string): Promise<UploadImageResult> {
    const res = await fetch(`${this.baseUrl}/api/release/image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64 }),
    });
    if (!res.ok) throw new Error(`uploadReleaseImage failed: ${res.status}`);
    return res.json();
  }
}
