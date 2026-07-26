import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { encodeImageFile } from "../../src/lib/encode-image";
import { MAX_UPLOAD_BASE64_LENGTH } from "../../src/ui/domain/scan";

// The encoder is browser code (FileReader, Image, canvas), so the DOM pieces it
// touches are stubbed here. The fake canvas models a JPEG encoder: payload size
// scales with pixel count and quality, which is what drives the retry ladder.

interface EncodeCall {
  width: number;
  height: number;
  quality: number;
}

/** Bytes per pixel at quality 1.0 — tuned so a 1024px photo lands over the limit. */
let bytesPerPixel = 1;
let encodeCalls: EncodeCall[] = [];

const originalGlobals = {
  FileReader: globalThis.FileReader,
  Image: globalThis.Image,
  document: globalThis.document,
};

class StubFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(_file: Blob): void {
    this.result = "data:image/jpeg;base64,c291cmNl";
    queueMicrotask(() => this.onload?.());
  }
}

class StubImage {
  width = 3000;
  height = 2000;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function createStubCanvas() {
  return {
    width: 0,
    height: 0,
    getContext(_id: string) {
      return { drawImage() {} };
    },
    toDataURL(_type: string, quality: number): string {
      encodeCalls.push({ width: this.width, height: this.height, quality });
      const length = Math.round(this.width * this.height * bytesPerPixel * quality);
      return `data:image/jpeg;base64,${"a".repeat(length)}`;
    },
  };
}

beforeEach(() => {
  encodeCalls = [];
  globalThis.FileReader = StubFileReader as unknown as typeof FileReader;
  globalThis.Image = StubImage as unknown as typeof Image;
  globalThis.document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error(`unexpected element: ${tag}`);
      return createStubCanvas();
    },
  } as unknown as Document;
});

afterEach(() => {
  bytesPerPixel = 1;
  globalThis.FileReader = originalGlobals.FileReader;
  globalThis.Image = originalGlobals.Image;
  globalThis.document = originalGlobals.document;
});

describe("encodeImageFile", () => {
  it("returns the first encode when it already fits the upload budget", async () => {
    bytesPerPixel = 0.1;

    const encoded = await encodeImageFile(new Blob());

    expect(encoded.length).toBeLessThanOrEqual(MAX_UPLOAD_BASE64_LENGTH);
    expect(encodeCalls).toHaveLength(1);
    expect(encodeCalls[0]).toEqual({ width: 1024, height: 683, quality: 0.85 });
  });

  it("compresses harder until the payload fits instead of sending an oversized upload", async () => {
    // 1024 x 683 at quality 0.85 encodes to ~595k characters at the default
    // bytesPerPixel of 1.0, putting the first attempt over the limit.
    const encoded = await encodeImageFile(new Blob());

    expect(encodeCalls.length).toBeGreaterThan(1);
    expect(encoded.length).toBeLessThanOrEqual(MAX_UPLOAD_BASE64_LENGTH);

    // Each retry is strictly cheaper than the one before it.
    const costs = encodeCalls.map((call) => call.width * call.height * call.quality);
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeLessThan(costs[i - 1]!);
    }
  });

  it("falls back to the smallest encode when nothing on the ladder fits", async () => {
    bytesPerPixel = 40;

    const encoded = await encodeImageFile(new Blob());

    expect(encodeCalls).toHaveLength(5);
    expect(encoded.length).toBeGreaterThan(MAX_UPLOAD_BASE64_LENGTH);
    const last = encodeCalls.at(-1)!;
    expect(encoded.length).toBe(
      Math.round(last.width * last.height * bytesPerPixel * last.quality),
    );
  });

  it("does not upscale an image smaller than the max edge", async () => {
    bytesPerPixel = 0.1;
    class SmallImage extends StubImage {
      override width = 400;
      override height = 300;
    }
    globalThis.Image = SmallImage as unknown as typeof Image;

    await encodeImageFile(new Blob());

    expect(encodeCalls[0]).toEqual({ width: 400, height: 300, quality: 0.85 });
  });
});
