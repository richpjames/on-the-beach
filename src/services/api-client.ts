import type {
  AmbiguousLinkPayload,
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
  LookupReleaseResult,
  RecognizeResult,
  ItemSuggestion,
  ReleaseAlert,
  ReleaseAlertStatus,
  TrackedArtist,
  ArtistFollowState,
  MbArtistCandidateView,
} from "../types";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../server/csrf";

export class AmbiguousLinkApiError extends Error {
  payload: AmbiguousLinkPayload;

  constructor(payload: AmbiguousLinkPayload) {
    super(payload.message);
    this.name = "AmbiguousLinkApiError";
    this.payload = payload;
  }
}

function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Attach the double-submit CSRF token header to unsafe-method requests.
 * The server issues the token cookie in `src/hooks.server.ts`.
 */
export function withCsrf(init?: RequestInit): RequestInit | undefined {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || !init) {
    return init;
  }

  const token = readCsrfToken();
  if (!token) {
    return init;
  }

  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      [CSRF_HEADER_NAME]: token,
    },
  };
}

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
    const response = await fetch(this.buildUrl(path), withCsrf(init));
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
    const response = await fetch(this.buildUrl(path), withCsrf(init));
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
    const response = await fetch(
      this.buildUrl("/api/music-items"),
      withCsrf(this.jsonRequest("POST", input)),
    );
    if (response.status === 409) {
      const body = (await response.json()) as Partial<AmbiguousLinkPayload>;
      if (
        body.kind === "ambiguous_link" &&
        typeof body.url === "string" &&
        Array.isArray(body.candidates)
      ) {
        throw new AmbiguousLinkApiError(body as AmbiguousLinkPayload);
      }
    }

    if (!response.ok) {
      throw new Error(`createMusicItem failed: ${response.status}`);
    }

    return (await response.json()) as MusicItemFull;
  }

  async getMusicItem(id: number): Promise<MusicItemFull | null> {
    return this.requestJsonOrNull<MusicItemFull>(`/api/music-items/${id}`, "getMusicItem");
  }

  async updateMusicItem(id: number, input: UpdateMusicItemInput): Promise<MusicItemFull | null> {
    const result = await this.requestJsonOrNull<{ item: MusicItemFull }>(
      `/api/music-items/${id}`,
      "updateMusicItem",
      this.jsonRequest("PATCH", input),
    );
    return result?.item ?? null;
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

    if (filters?.sort) {
      params.set("sort", filters.sort);
    }
    if (filters?.sortDirection) {
      params.set("sortDirection", filters.sortDirection);
    }

    if (filters?.hasReminder) {
      params.set("hasReminder", "true");
    }

    const qs = params.toString();
    return this.requestJson<PaginatedResult<MusicItemFull>>(
      `/api/music-items${qs ? `?${qs}` : ""}`,
      "listMusicItems",
    );
  }

  async updateListenStatus(
    id: number,
    status: ListenStatus,
  ): Promise<{ item: MusicItemFull; suggestions: ItemSuggestion[] } | null> {
    const result = await this.requestJsonOrNull<{
      item: MusicItemFull;
      suggestion?: ItemSuggestion | null;
      suggestions?: ItemSuggestion[];
    }>(
      `/api/music-items/${id}`,
      "updateListenStatus",
      this.jsonRequest("PATCH", {
        listenStatus: status,
      }),
    );
    if (!result) return null;

    // `suggestions` is what the server sends now; `suggestion` is the single
    // one older builds returned.
    const suggestions =
      result.suggestions ?? (result.suggestion ? [result.suggestion] : ([] as ItemSuggestion[]));
    return { item: result.item, suggestions };
  }

  async acceptSuggestion(sourceItemId: number, suggestionId: number): Promise<MusicItemFull> {
    return this.requestJson<MusicItemFull>(
      `/api/music-items/${sourceItemId}/suggestion/accept`,
      "acceptSuggestion",
      this.jsonRequest("POST", { suggestionId }),
    );
  }

  async dismissSuggestion(sourceItemId: number, suggestionIds: number[]): Promise<void> {
    await this.request(
      `/api/music-items/${sourceItemId}/suggestion/dismiss`,
      "dismissSuggestion",
      this.jsonRequest("POST", { suggestionIds }),
    );
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

  async saveOrderEntries(contextKey: string, entries: string[]): Promise<void> {
    await this.request(
      "/api/music-items/order",
      "saveOrderEntries",
      this.jsonRequest("PUT", { contextKey, entries }),
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

  async getStackChildren(
    stackId: number,
  ): Promise<Array<{ id: number; name: string; item_count: number }>> {
    return this.requestJson<Array<{ id: number; name: string; item_count: number }>>(
      `/api/stacks/${stackId}/children`,
      "getStackChildren",
    );
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

  async addStackParent(stackId: number, parentStackId: number): Promise<void> {
    await this.request(
      `/api/stacks/${stackId}/parent`,
      "addStackParent",
      this.jsonRequest("PATCH", { parentStackId }),
    );
  }

  async removeStackParent(stackId: number, parentStackId: number): Promise<void> {
    await this.request(`/api/stacks/${stackId}/parent/${parentStackId}`, "removeStackParent", {
      method: "DELETE",
    });
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

  async recognizeMusic(audioBase64: string, mimeType: string): Promise<RecognizeResult> {
    return this.requestJson<RecognizeResult>(
      "/api/release/recognize",
      "recognizeMusic",
      this.jsonRequest("POST", { audioBase64, mimeType }),
    );
  }

  async lookupRelease(artist: string, title: string, year?: string): Promise<LookupReleaseResult> {
    const body: Record<string, string> = { artist, title };
    if (year) body.year = year;

    try {
      return await this.requestJson<LookupReleaseResult>(
        "/api/release/lookup",
        "lookupRelease",
        this.jsonRequest("POST", body),
      );
    } catch {
      return {};
    }
  }

  async setReminder(itemId: number, remindAt: string): Promise<void> {
    await this.request(
      `/api/music-items/${itemId}/reminder`,
      "Set reminder",
      this.jsonRequest("PUT", { remindAt }),
    );
  }

  async clearReminder(itemId: number): Promise<void> {
    await this.request(`/api/music-items/${itemId}/reminder`, "Clear reminder", {
      method: "DELETE",
    });
  }

  // ── New-release alerts ───────────────────────────────────────

  async listReleaseAlerts(
    statuses: ReleaseAlertStatus[] = ["pending", "seen"],
  ): Promise<{ alerts: ReleaseAlert[]; pendingCount: number }> {
    return this.requestJson<{ alerts: ReleaseAlert[]; pendingCount: number }>(
      `/api/release-alerts?status=${statuses.join(",")}`,
      "listReleaseAlerts",
    );
  }

  async addReleaseAlert(
    alertId: number,
  ): Promise<{ item: MusicItemFull; remindAt: string | null }> {
    return this.requestJson<{ item: MusicItemFull; remindAt: string | null }>(
      `/api/release-alerts/${alertId}/add`,
      "addReleaseAlert",
      { method: "POST" },
    );
  }

  async dismissReleaseAlert(alertId: number): Promise<void> {
    await this.request(`/api/release-alerts/${alertId}/dismiss`, "dismissReleaseAlert", {
      method: "POST",
    });
  }

  async markReleaseAlertsSeen(): Promise<number> {
    const body = await this.requestJson<{ seen: number }>(
      "/api/release-alerts/mark-seen",
      "markReleaseAlertsSeen",
      { method: "POST" },
    );
    return body.seen;
  }

  // ── Tracked artists ──────────────────────────────────────────

  async listTrackedArtists(): Promise<TrackedArtist[]> {
    const body = await this.requestJson<{ artists: TrackedArtist[] }>(
      "/api/artists/tracked",
      "listTrackedArtists",
    );
    return body.artists;
  }

  async setArtistFollowState(artistId: number, followState: ArtistFollowState): Promise<void> {
    await this.request(
      `/api/artists/${artistId}/follow`,
      "setArtistFollowState",
      this.jsonRequest("PUT", { followState }),
    );
  }

  async setArtistMbid(artistId: number, musicbrainzArtistId: string): Promise<void> {
    await this.request(
      `/api/artists/${artistId}/mbid`,
      "setArtistMbid",
      this.jsonRequest("PUT", { musicbrainzArtistId }),
    );
  }

  async getArtistMbidCandidates(artistId: number): Promise<MbArtistCandidateView[]> {
    const body = await this.requestJson<{ candidates: MbArtistCandidateView[] }>(
      `/api/artists/${artistId}/mbid-candidates`,
      "getArtistMbidCandidates",
    );
    return body.candidates;
  }

  async pollArtistNow(artistId: number): Promise<{ alertsRaised: number; status: string }> {
    return this.requestJson<{ alertsRaised: number; status: string }>(
      `/api/artists/${artistId}/poll`,
      "pollArtistNow",
      { method: "POST" },
    );
  }

  async getPendingReminders(): Promise<Array<{ id: number; title: string }>> {
    const data = await this.requestJson<{ items: Array<{ id: number; title: string }> }>(
      "/api/music-items/reminders/pending",
      "Get pending reminders",
    );
    return data.items;
  }
}
