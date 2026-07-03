import { ApiClient, withCsrf } from "../services/api-client";

/** Shared API client for browser-side calls to /api/*. */
export const api = new ApiClient();

/** `fetch` wrapper that attaches the CSRF token header to unsafe requests. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, withCsrf(init));
}
