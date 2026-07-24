import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET } from "../../src/routes/uploads/[...path]/+server";

const initialUploadsDir = process.env.UPLOADS_DIR;
let dir: string;

// The route only reads `params.path`; a minimal event stands in for the full
// SvelteKit RequestEvent.
function call(pathParam: string) {
  return GET({ params: { path: pathParam } } as never);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "otb-uploads-"));
  process.env.UPLOADS_DIR = dir;
});

afterEach(async () => {
  if (initialUploadsDir === undefined) delete process.env.UPLOADS_DIR;
  else process.env.UPLOADS_DIR = initialUploadsDir;
  await rm(dir, { recursive: true, force: true });
});

describe("GET /uploads/[...path]", () => {
  test("serves an existing upload with an image content type", async () => {
    await writeFile(path.join(dir, "cover.jpg"), "JPEGBYTES");

    const res = await call("cover.jpg");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(await res.text()).toBe("JPEGBYTES");
  });

  test("404s for a missing file", async () => {
    await expect(call("nope.jpg")).rejects.toMatchObject({ status: 404 });
  });

  test("403s on path traversal outside the uploads dir", async () => {
    await writeFile(path.join(dir, "cover.jpg"), "JPEGBYTES");

    await expect(call("../secret.txt")).rejects.toMatchObject({ status: 403 });
    await expect(call("../../etc/passwd")).rejects.toMatchObject({ status: 403 });
  });
});
