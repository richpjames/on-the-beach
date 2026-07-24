import path from "node:path";
import { error } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getUploadsDir } from "../../../../server/uploads";

/**
 * Serves uploaded cover images (`/uploads/<file>`).
 *
 * Uploads are written to `UPLOADS_DIR` (a mounted volume in production, see
 * server/uploads.ts), which is *outside* the app bundle — `adapter-node` only
 * serves the built client assets and `public/`, so without this route every
 * `artwork_url` of the form `/uploads/…` 404s and shows a broken image. Items
 * with external artwork (Apple Music, Bandcamp) are unaffected, which is why
 * this only surfaces once uploaded images (share-sheet photos, cover scans,
 * the release page's "Replace image") appear in the list.
 *
 * The `[...path]` param is resolved against the uploads dir and the result is
 * checked to still live inside it, so a crafted `../` can't escape the volume.
 */
export const GET: RequestHandler = async ({ params }) => {
  const uploadsDir = getUploadsDir();
  const requested = path.resolve(uploadsDir, params.path);

  // Reject path traversal: the resolved path must stay within the uploads dir.
  const withinUploads =
    requested === uploadsDir || requested.startsWith(uploadsDir + path.sep);
  if (!withinUploads) {
    throw error(403, "Forbidden");
  }

  const file = Bun.file(requested);
  if (!(await file.exists())) {
    throw error(404, "Not found");
  }

  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      // Filenames are content-addressed UUIDs, so an upload never changes.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
