import { createActor } from "xstate";
import { describe, expect, it } from "bun:test";

import {
  canAutoAdvance,
  moveEntry,
  parseStoredQueue,
  playerMachine,
  type PlayerEffects,
  type QueueEntry,
} from "../../src/ui/state/player-machine";

function iframeEntry(n: number): QueueEntry {
  return {
    itemId: n,
    label: `Item ${n}`,
    target: { kind: "iframe", src: `https://bandcamp.com/embed/${n}`, playerType: "audio" },
  };
}

function appleEntry(n: number): QueueEntry {
  return {
    itemId: n,
    label: `Item ${n}`,
    target: { kind: "appleMusic", amKind: "album", id: String(n) },
  };
}

function youtubeEntry(n: number): QueueEntry {
  return {
    itemId: n,
    label: `Item ${n}`,
    target: {
      kind: "iframe",
      src: `https://www.youtube-nocookie.com/embed/${n}`,
      playerType: "video",
    },
  };
}

interface Harness {
  actor: ReturnType<typeof createActor<typeof playerMachine>>;
  effects: string[];
}

/** Actor with recording side effects, so exit/entry behaviour is observable. */
function makePlayer(input: Partial<PlayerEffects> = {}): Harness {
  const effects: string[] = [];
  const actor = createActor(playerMachine, {
    input: {
      playAppleMusic: (kind, id) => effects.push(`play:${kind}:${id}`),
      stopAppleMusic: () => effects.push("stop"),
      ...input,
    },
  }).start();
  return { actor, effects };
}

function queueOf(actor: Harness["actor"]): QueueEntry[] {
  return actor.getSnapshot().context.queue;
}

describe("player machine — queue", () => {
  it("starts the entry immediately when enqueued while idle (iframe)", () => {
    const { actor } = makePlayer();
    actor.send({ type: "ENQUEUE", entry: iframeEntry(1) });

    const snap = actor.getSnapshot();
    expect(snap.matches("iframe")).toBe(true);
    expect(snap.context.src).toBe("https://bandcamp.com/embed/1");
    expect(snap.context.label).toBe("Item 1");
    expect(snap.context.itemId).toBe(1);
    expect(snap.context.queue).toEqual([]);
  });

  it("starts the entry immediately when enqueued while idle (Apple Music)", () => {
    const { actor, effects } = makePlayer();
    actor.send({ type: "ENQUEUE", entry: appleEntry(2) });

    const snap = actor.getSnapshot();
    expect(snap.matches("appleMusic")).toBe(true);
    expect(snap.context.apple).toEqual({ kind: "album", id: "2" });
    expect(effects).toEqual(["play:album:2"]);
  });

  it("appends when enqueued while playing, without disturbing playback", () => {
    const { actor, effects } = makePlayer();
    actor.send({ type: "LOAD_APPLE_MUSIC", kind: "album", id: "1", label: "Now" });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(5) });
    actor.send({ type: "ENQUEUE", entry: appleEntry(6) });

    const snap = actor.getSnapshot();
    expect(snap.matches("appleMusic")).toBe(true);
    expect(snap.context.apple).toEqual({ kind: "album", id: "1" });
    expect(queueOf(actor)).toEqual([iframeEntry(5), appleEntry(6)]);
    expect(effects).toEqual(["play:album:1"]);
  });

  it("ADVANCE pops the head, stops the old playback, and loads the next entry", () => {
    const { actor, effects } = makePlayer();
    actor.send({ type: "LOAD_APPLE_MUSIC", kind: "album", id: "1", label: "Now" });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(5) });
    actor.send({ type: "ENQUEUE", entry: appleEntry(6) });

    actor.send({ type: "ADVANCE" });

    const snap = actor.getSnapshot();
    // The iframe head took over: leaving appleMusic ran stopAppleMusic first.
    expect(snap.matches("iframe")).toBe(true);
    expect(snap.context.src).toBe("https://bandcamp.com/embed/5");
    expect(snap.context.apple).toBeNull();
    expect(queueOf(actor)).toEqual([appleEntry(6)]);
    expect(effects).toEqual(["play:album:1", "stop"]);

    actor.send({ type: "ADVANCE" });
    // Now the Apple Music head started after the iframe was dropped.
    const next = actor.getSnapshot();
    expect(next.matches("appleMusic")).toBe(true);
    expect(next.context.apple).toEqual({ kind: "album", id: "6" });
    expect(queueOf(actor)).toEqual([]);
    expect(effects).toEqual(["play:album:1", "stop", "play:album:6"]);
  });

  it("ADVANCE with an empty queue goes idle (and stops Apple Music)", () => {
    const { actor, effects } = makePlayer();
    actor.send({ type: "LOAD_APPLE_MUSIC", kind: "song", id: "9", label: "Last" });

    actor.send({ type: "ADVANCE" });

    const snap = actor.getSnapshot();
    expect(snap.matches("idle")).toBe(true);
    expect(snap.context.src).toBeNull();
    expect(snap.context.apple).toBeNull();
    expect(snap.context.label).toBe("");
    expect(effects).toEqual(["play:song:9", "stop"]);
  });

  it("STOP keeps the queue; ADVANCE afterwards starts the head", () => {
    const { actor } = makePlayer();
    actor.send({
      type: "LOAD_IFRAME",
      src: "https://now/embed",
      label: "Now",
      playerType: "audio",
    });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(1) });
    actor.send({ type: "ENQUEUE", entry: appleEntry(2) });
    actor.send({ type: "STOP" });

    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(queueOf(actor)).toEqual([iframeEntry(1), appleEntry(2)]);

    actor.send({ type: "ADVANCE" });
    expect(actor.getSnapshot().matches("iframe")).toBe(true);
    expect(actor.getSnapshot().context.itemId).toBe(1);
    expect(queueOf(actor)).toEqual([appleEntry(2)]);
  });

  it("CLEAR_QUEUE empties the queue without stopping playback", () => {
    const { actor, effects } = makePlayer();
    actor.send({
      type: "LOAD_IFRAME",
      src: "https://bandcamp.com/embed/1",
      label: "Now",
      playerType: "audio",
    });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(2) });

    actor.send({ type: "CLEAR_QUEUE" });

    expect(queueOf(actor)).toEqual([]);
    expect(actor.getSnapshot().matches("iframe")).toBe(true);
    expect(actor.getSnapshot().context.src).toBe("https://bandcamp.com/embed/1");
    expect(effects).toEqual([]);
  });

  it("REMOVE_FROM_QUEUE drops one entry and ignores out-of-range indices", () => {
    const { actor } = makePlayer();
    actor.send({
      type: "LOAD_IFRAME",
      src: "https://now/embed",
      label: "Now",
      playerType: "audio",
    });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(1) });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(2) });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(3) });

    actor.send({ type: "REMOVE_FROM_QUEUE", index: 1 });
    expect(queueOf(actor)).toEqual([iframeEntry(1), iframeEntry(3)]);

    actor.send({ type: "REMOVE_FROM_QUEUE", index: 99 });
    actor.send({ type: "REMOVE_FROM_QUEUE", index: -1 });
    expect(queueOf(actor)).toEqual([iframeEntry(1), iframeEntry(3)]);
  });

  it("MOVE_IN_QUEUE reorders with clamped indices and no-ops on the empty queue", () => {
    const { actor } = makePlayer();
    actor.send({
      type: "LOAD_IFRAME",
      src: "https://now/embed",
      label: "Now",
      playerType: "audio",
    });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(1) });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(2) });
    actor.send({ type: "ENQUEUE", entry: iframeEntry(3) });

    actor.send({ type: "MOVE_IN_QUEUE", from: 2, to: 0 });
    expect(queueOf(actor)).toEqual([iframeEntry(3), iframeEntry(1), iframeEntry(2)]);

    // `to` beyond the end clamps to the last slot.
    actor.send({ type: "MOVE_IN_QUEUE", from: 0, to: 99 });
    expect(queueOf(actor)).toEqual([iframeEntry(1), iframeEntry(2), iframeEntry(3)]);

    // A move that lands where it started is a no-op.
    actor.send({ type: "MOVE_IN_QUEUE", from: 1, to: 1 });
    expect(queueOf(actor)).toEqual([iframeEntry(1), iframeEntry(2), iframeEntry(3)]);

    actor.send({ type: "CLEAR_QUEUE" });
    actor.send({ type: "MOVE_IN_QUEUE", from: 0, to: 2 });
    expect(queueOf(actor)).toEqual([]);
  });

  it("a stray LOAD_IFRAME during playback supersedes playback but keeps the queue", () => {
    const { actor, effects } = makePlayer();
    actor.send({ type: "LOAD_APPLE_MUSIC", kind: "album", id: "1", label: "Now" });
    actor.send({ type: "ENQUEUE", entry: appleEntry(2) });

    actor.send({
      type: "LOAD_IFRAME",
      src: "https://elsewhere/embed",
      label: "Something else",
      playerType: "audio",
    });

    const snap = actor.getSnapshot();
    expect(snap.matches("iframe")).toBe(true);
    expect(snap.context.src).toBe("https://elsewhere/embed");
    expect(snap.context.itemId).toBeNull();
    expect(queueOf(actor)).toEqual([appleEntry(2)]);
    // The Apple Music track was stopped on the way out, as ever.
    expect(effects).toEqual(["play:album:1", "stop"]);
  });

  it("hydrates the queue from input and toggles the queue window", () => {
    const { actor } = makePlayer();
    const hydrated = createActor(playerMachine, {
      input: { initialQueue: [iframeEntry(7)] },
    }).start();
    expect(hydrated.getSnapshot().context.queue).toEqual([iframeEntry(7)]);

    expect(actor.getSnapshot().context.queueWindowVisible).toBe(false);
    actor.send({ type: "TOGGLE_QUEUE_WINDOW" });
    expect(actor.getSnapshot().context.queueWindowVisible).toBe(true);
    actor.send({ type: "TOGGLE_QUEUE_WINDOW" });
    expect(actor.getSnapshot().context.queueWindowVisible).toBe(false);
  });
});

describe("player machine — pure queue helpers", () => {
  it("moveEntry clamps and never mutates its input", () => {
    const queue = ["a", "b", "c"];
    expect(moveEntry(queue, 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveEntry(queue, 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveEntry(queue, 1, 1)).toBe(queue);
    expect(moveEntry([], 0, 1)).toEqual([]);
    expect(queue).toEqual(["a", "b", "c"]);
  });

  it("canAutoAdvance is true only for Apple Music and YouTube targets", () => {
    expect(canAutoAdvance(appleEntry(1).target)).toBe(true);
    expect(canAutoAdvance(youtubeEntry(1).target)).toBe(true);
    expect(canAutoAdvance(iframeEntry(1).target)).toBe(false);
    expect(
      canAutoAdvance({
        kind: "iframe",
        src: "https://embed.music.apple.com/album/x",
        playerType: "audio",
      }),
    ).toBe(false);
  });

  it("parseStoredQueue keeps well-formed entries and drops the rest", () => {
    const good = iframeEntry(1);
    expect(parseStoredQueue(null)).toEqual([]);
    expect(parseStoredQueue("nope")).toEqual([]);
    expect(parseStoredQueue([good])).toEqual([good]);
    expect(
      parseStoredQueue([
        good,
        "not an entry",
        { itemId: 2, label: "No target" },
        { itemId: "two", label: "Bad id", target: good.target },
        { itemId: 3, label: "Bad target", target: { kind: "iframe", src: 4 } },
        {
          itemId: 4,
          label: "Bad kind",
          target: { kind: "appleMusic", amKind: "podcast", id: "1" },
        },
        {
          itemId: 5,
          label: "Bad playerType",
          target: { kind: "iframe", src: "https://x", playerType: "podcast" },
        },
        appleEntry(9),
      ]),
    ).toEqual([good, appleEntry(9)]);
  });
});
