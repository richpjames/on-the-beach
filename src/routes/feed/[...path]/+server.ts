import { apiApp } from "../../../../server/app";

// Delegate every /feed/* request to the Hono RSS routes.
export const fallback = ({ request }: { request: Request }) => apiApp.fetch(request);
