import { apiApp } from "../../../../server/app";

// Delegate every /api/* request (any method) to the Hono REST API.
export const fallback = ({ request }: { request: Request }) => apiApp.fetch(request);
