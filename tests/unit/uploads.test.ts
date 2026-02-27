import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  getUploadsDir,
  rewriteUploadsRequestPath,
  toUploadsPublicPath,
} from "../../server/uploads";

const initialUploadsDir = process.env.UPLOADS_DIR;

afterEach(() => {
  if (initialUploadsDir === undefined) {
    delete process.env.UPLOADS_DIR;
    return;
  }

  process.env.UPLOADS_DIR = initialUploadsDir;
});

describe("getUploadsDir", () => {
  test("defaults to cwd/uploads when UPLOADS_DIR is unset", () => {
    delete process.env.UPLOADS_DIR;

    expect(getUploadsDir()).toBe(path.resolve(process.cwd(), "uploads"));
  });

  test("resolves relative UPLOADS_DIR values from cwd", () => {
    process.env.UPLOADS_DIR = "var/uploads";

    expect(getUploadsDir()).toBe(path.resolve(process.cwd(), "var/uploads"));
  });

  test("uses absolute UPLOADS_DIR values as-is", () => {
    process.env.UPLOADS_DIR = "/app/uploads";

    expect(getUploadsDir()).toBe("/app/uploads");
  });
});

describe("uploads URL helpers", () => {
  test("creates public uploads URL path", () => {
    expect(toUploadsPublicPath("cover.jpg")).toBe("/uploads/cover.jpg");
  });

  test("rewrites uploads route request paths to file paths", () => {
    expect(rewriteUploadsRequestPath("/uploads/cover.jpg")).toBe("/cover.jpg");
    expect(rewriteUploadsRequestPath("/uploads/nested/cover.jpg")).toBe("/nested/cover.jpg");
  });

  test("keeps non-uploads paths unchanged", () => {
    expect(rewriteUploadsRequestPath("/api/music-items")).toBe("/api/music-items");
  });
});
