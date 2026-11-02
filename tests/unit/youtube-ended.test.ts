import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { enableYouTubeJsApi, watchYouTubeEnd } from "../../src/lib/youtube-ended";

// ── window / iframe stubs ───────────────────────────────────────────────────
// watchYouTubeEnd only needs addEventListener/removeEventListener on window and
// postMessage on the iframe's content window, so plain objects stand in.

type Handler = (ev: never) => void;

let realWindow: unknown;
let handlers: Handler[] = [];

const windowStub = {
  origin: "http://localhost:4173",
  location: { origin: "http://localhost:4173" },
  addEventListener(_name: string, handler: Handler): void {
    handlers.push(handler);
  },
  removeEventListener(_name: string, handler: Handler): void {
    handlers = handlers.filter((h) => h !== handler);
  },
};

beforeEach(() => {
  realWindow = (globalThis as { window?: unknown }).window;
  handlers = [];
  (globalThis as { window?: unknown }).window = windowStub;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Dispatch a message event to everything currently listening. */
function message(ev: { origin?: string; source?: unknown; data?: unknown }): void {
  for (const handler of handlers) handler(ev as never);
}

const YT = "https://www.youtube.com";

function makeIframe(id = ""): {
  el: HTMLIFrameElement;
  contentWindow: { postMessage: (data: string, targetOrigin: string) => void };
  posts: { data: string; targetOrigin: string }[];
} {
  const posts: { data: string; targetOrigin: string }[] = [];
  const contentWindow = {
    postMessage(data: string, targetOrigin: string): void {
      posts.push({ data, targetOrigin });
    },
  };
  const el = { id, contentWindow } as unknown as HTMLIFrameElement;
  return { el, contentWindow, posts };
}

describe("enableYouTubeJsApi", () => {
  it("leaves the src alone during SSR (no window)", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(enableYouTubeJsApi(`${YT}/embed/abc`)).toBe(`${YT}/embed/abc`);
  });

  it("leaves non-YouTube srcs unchanged", () => {
    expect(enableYouTubeJsApi("https://bandcamp.com/EmbeddedPlayer/id=1")).toBe(
      "https://bandcamp.com/EmbeddedPlayer/id=1",
    );
  });

  it("leaves unparseable srcs unchanged", () => {
    expect(enableYouTubeJsApi("not a url")).toBe("not a url");
  });

  it("adds enablejsapi and the page origin to a YouTube embed", () => {
    const out = new URL(enableYouTubeJsApi(`${YT}/embed/abc`));
    expect(out.origin).toBe(YT);
    expect(out.searchParams.get("enablejsapi")).toBe("1");
    expect(out.searchParams.get("origin")).toBe("http://localhost:4173");
  });

  it("treats youtube-nocookie as a YouTube embed", () => {
    const out = new URL(enableYouTubeJsApi("https://www.youtube-nocookie.com/embed/abc"));
    expect(out.searchParams.get("enablejsapi")).toBe("1");
  });
});

describe("watchYouTubeEnd", () => {
  it("answers the player's first message with the listening handshake", () => {
    const { el, posts } = makeIframe("vid-1");
    const dispose = watchYouTubeEnd(el, () => {});
    message({ origin: YT, source: el.contentWindow, data: { event: "onReady" } });

    expect(posts).toHaveLength(1);
    expect(posts[0].targetOrigin).toBe("*");
    expect(JSON.parse(posts[0].data)).toEqual({
      event: "listening",
      id: "vid-1",
      channel: "widget",
    });
    dispose();
  });

  it("uses a stable fallback id when the iframe has none", () => {
    const { el, posts } = makeIframe();
    const dispose = watchYouTubeEnd(el, () => {});
    message({ origin: YT, source: el.contentWindow, data: { event: "onReady" } });
    expect(JSON.parse(posts[0].data).id).toBe("otb-player");
    dispose();
  });

  it("ignores messages from other origins", () => {
    const { el, posts } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    message({
      origin: "https://evil.example",
      source: el.contentWindow,
      data: { event: "onStateChange", info: 0 },
    });
    expect(ended).toBe(0);
    expect(posts).toHaveLength(0);
    dispose();
  });

  it("ignores messages from other windows", () => {
    const { el, posts } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    message({
      origin: YT,
      source: { postMessage() {} },
      data: { event: "onStateChange", info: 0 },
    });
    expect(ended).toBe(0);
    expect(posts).toHaveLength(0);
    dispose();
  });

  it("fires onEnded for an ended event sent as a JSON string", () => {
    const { el } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    message({
      origin: YT,
      source: el.contentWindow,
      data: JSON.stringify({ event: "onStateChange", info: 0 }),
    });
    expect(ended).toBe(1);
    dispose();
  });

  it("fires onEnded for an ended event sent as an object", () => {
    const { el } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    message({ origin: YT, source: el.contentWindow, data: { event: "onStateChange", info: 0 } });
    expect(ended).toBe(1);
    dispose();
  });

  it("fires onEnded only once per watched playback", () => {
    const { el } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    message({ origin: YT, source: el.contentWindow, data: { event: "onStateChange", info: 0 } });
    message({ origin: YT, source: el.contentWindow, data: { event: "onStateChange", info: 0 } });
    expect(ended).toBe(1);
    dispose();
  });

  it("does not fire for non-ended state changes", () => {
    const { el } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    for (const info of [-1, 1, 2, 3, 5]) {
      message({ origin: YT, source: el.contentWindow, data: { event: "onStateChange", info } });
    }
    expect(ended).toBe(0);
    dispose();
  });

  it("ignores junk payloads without throwing", () => {
    const { el } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    message({ origin: YT, source: el.contentWindow, data: "not json {" });
    message({ origin: YT, source: el.contentWindow, data: "" });
    message({ origin: YT, source: el.contentWindow, data: 42 });
    message({ origin: YT, source: el.contentWindow, data: JSON.stringify("just a string") });
    expect(ended).toBe(0);
    dispose();
  });

  it("stops delivering after dispose", () => {
    const { el } = makeIframe();
    let ended = 0;
    const dispose = watchYouTubeEnd(el, () => ended++);
    dispose();
    expect(handlers).toHaveLength(0);
    message({ origin: YT, source: el.contentWindow, data: { event: "onStateChange", info: 0 } });
    expect(ended).toBe(0);
  });
});
