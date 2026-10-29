import { assign, setup } from "xstate";
import type { AppleMusicKind } from "../../../domain/apple-music";

export type PlayerType = "audio" | "video";

export interface AppleMusicTarget {
  kind: AppleMusicKind;
  id: string;
}

/** How a queued release plays back when its turn comes. */
export type QueueTarget =
  | { kind: "iframe"; src: string; playerType: PlayerType }
  | { kind: "appleMusic"; amKind: AppleMusicKind; id: string };

/** One upcoming release in the play queue. Plain JSON-able data (persisted). */
export interface QueueEntry {
  itemId: number;
  label: string;
  target: QueueTarget;
}

/**
 * Side effects the machine drives on transitions. Injected via `input` so the
 * machine itself stays free of any browser / MusicKit dependency and can be
 * unit-tested in isolation (mirrors how `add-form-machine` injects its `api`).
 */
export interface PlayerEffects {
  /** Start full-track Apple Music playback for a catalogue resource. */
  playAppleMusic: (kind: AppleMusicKind, id: string) => void;
  /** Tear down any in-progress Apple Music playback. */
  stopAppleMusic: () => void;
}

export interface PlayerContext extends PlayerEffects {
  /** Source URL for iframe playback (Bandcamp / YouTube / SoundCloud / Mixcloud / AM preview). */
  src: string | null;
  /** Target catalogue resource when playing through MusicKit. */
  apple: AppleMusicTarget | null;
  /** "{artist} — {title}" (or just the title) shown in the window/taskbar. */
  label: string;
  /** The release this playback came from, so the window can link back to it. */
  itemId: number | null;
  playerType: PlayerType;
  minimized: boolean;
  /** Upcoming releases, next first. Never contains the now-playing entry. */
  queue: QueueEntry[];
  /** Whether the queue window is open. The queue itself persists regardless. */
  queueWindowVisible: boolean;
}

export type PlayerEvent =
  | { type: "LOAD_IFRAME"; src: string; label: string; playerType: PlayerType; itemId?: number }
  | { type: "LOAD_APPLE_MUSIC"; kind: AppleMusicKind; id: string; label: string; itemId?: number }
  | { type: "STOP" }
  | { type: "MINIMIZE" }
  | { type: "TOGGLE_WINDOW" }
  | { type: "ENQUEUE"; entry: QueueEntry }
  | { type: "REMOVE_FROM_QUEUE"; index: number }
  | { type: "MOVE_IN_QUEUE"; from: number; to: number }
  | { type: "CLEAR_QUEUE" }
  | { type: "ADVANCE" }
  | { type: "TOGGLE_QUEUE_WINDOW" };

export type PlayerInput = Partial<PlayerEffects> & {
  /** Queue restored from localStorage; the facade passes it at actor creation. */
  initialQueue?: QueueEntry[];
};

const noop = (): void => {};

const APPLE_MUSIC_KINDS: AppleMusicKind[] = ["album", "song", "playlist", "musicVideo"];

// ── Pure queue helpers (exported for the facade and unit tests) ─────────────

/** Move an entry within a queue. Indices are clamped into range; the empty
 * queue (or a move that lands where it started) is a no-op. */
export function moveEntry<T>(queue: T[], from: number, to: number): T[] {
  if (queue.length === 0) return queue;
  const clamp = (index: number): number => Math.max(0, Math.min(index, queue.length - 1));
  const fromIndex = clamp(from);
  const toIndex = clamp(to);
  if (fromIndex === toIndex) return queue;
  const next = [...queue];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Whether playback of this target can report "ended" back to the app. Only
 * YouTube embeds (postMessage) and MusicKit (playbackStateDidChange) expose an
 * end signal; Bandcamp / SoundCloud / Mixcloud / the AM preview iframe are
 * silent, so their queue entries advance only by the manual next button.
 */
export function canAutoAdvance(target: QueueTarget): boolean {
  if (target.kind === "appleMusic") return true;
  return isYouTubeEmbedSrc(target.src);
}

export function isYouTubeEmbedSrc(src: string): boolean {
  try {
    const hostname = new URL(src).hostname;
    return hostname === "www.youtube.com" || hostname === "www.youtube-nocookie.com";
  } catch {
    return false;
  }
}

function isQueueTarget(value: unknown): value is QueueTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "iframe") {
    return (
      typeof target.src === "string" &&
      (target.playerType === "audio" || target.playerType === "video")
    );
  }
  if (target.kind === "appleMusic") {
    return (
      APPLE_MUSIC_KINDS.includes(target.amKind as AppleMusicKind) && typeof target.id === "string"
    );
  }
  return false;
}

function isQueueEntry(value: unknown): value is QueueEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.itemId === "number" &&
    Number.isInteger(entry.itemId) &&
    typeof entry.label === "string" &&
    isQueueTarget(entry.target)
  );
}

/**
 * Parse a queue persisted by the facade. Anything malformed — a corrupt write,
 * a shape from an older version, a non-array — drops just the bad entries; the
 * queue is a convenience, never worth a crashed player over.
 */
export function parseStoredQueue(raw: unknown): QueueEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isQueueEntry);
}

/**
 * Now-playing state machine, plus the play queue behind it.
 *
 * Playback has three positions — `idle`, `iframe`, and `appleMusic` — and the
 * app only ever plays one release at a time. Because every "start playback"
 * event targets a concrete state, the outgoing state's `exit` action always
 * runs first: leaving `appleMusic` stops MusicKit, and leaving `iframe` drops
 * the `src` so the embed unmounts. That is what guarantees a currently playing
 * release stops when another is started — including when moving between Apple
 * Music and Bandcamp in either direction — without every caller having to
 * remember to tear the previous one down.
 *
 * The queue is upcoming-only: the now-playing release is never listed in it.
 * `ENQUEUE` plays immediately when idle (same semantics as `LOAD_*`) and
 * otherwise appends. `ADVANCE` pops the queue head and starts it, going through
 * the same concrete-state targets so the outgoing playback is stopped first;
 * with an empty queue it behaves like `STOP`. `STOP` (the window's ✕) stops
 * only the now-playing release and deliberately keeps the queue — only
 * `CLEAR_QUEUE` empties it. `LOAD_*` likewise supersedes playback without
 * touching the queue. The facade persists `queue` across sessions; now-playing
 * is re-derived by playback, never persisted.
 */
export const playerMachine = setup({
  types: {} as {
    context: PlayerContext;
    events: PlayerEvent;
    input: PlayerInput;
  },
  actions: {
    startAppleMusic: ({ context }) => {
      if (context.apple) context.playAppleMusic(context.apple.kind, context.apple.id);
    },
    stopAppleMusic: ({ context }) => {
      context.stopAppleMusic();
    },
    // ENQUEUE while idle: the entry becomes now-playing directly (it never
    // passes through the queue array), mirroring the LOAD_* assigns.
    playEntry: assign(({ event }) => {
      if (event.type !== "ENQUEUE") return {};
      const { entry } = event;
      if (entry.target.kind === "iframe") {
        return {
          src: entry.target.src,
          apple: null,
          label: entry.label,
          itemId: entry.itemId,
          playerType: entry.target.playerType,
          minimized: false,
        };
      }
      return {
        src: null,
        apple: { kind: entry.target.amKind, id: entry.target.id },
        label: entry.label,
        itemId: entry.itemId,
        playerType: "audio" as const,
        minimized: false,
      };
    }),
    appendToQueue: assign(({ context, event }) => {
      if (event.type !== "ENQUEUE") return {};
      return { queue: [...context.queue, event.entry] };
    }),
    // ADVANCE: pop the queue head into the now-playing slot. The guarded
    // transitions target a concrete state, so the outgoing state's exit stops
    // the old playback before the new entry starts.
    playQueueHead: assign(({ context }) => {
      const head = context.queue[0];
      if (!head) return {};
      const queue = context.queue.slice(1);
      if (head.target.kind === "iframe") {
        return {
          queue,
          src: head.target.src,
          apple: null,
          label: head.label,
          itemId: head.itemId,
          playerType: head.target.playerType,
          minimized: false,
        };
      }
      return {
        queue,
        src: null,
        apple: { kind: head.target.amKind, id: head.target.id },
        label: head.label,
        itemId: head.itemId,
        playerType: "audio" as const,
        minimized: false,
      };
    }),
    resetNowPlaying: assign({
      src: null,
      apple: null,
      label: "",
      itemId: null,
      playerType: "audio" as const,
      minimized: false,
    }),
  },
  guards: {
    entryIsIframe: ({ event }) => event.type === "ENQUEUE" && event.entry.target.kind === "iframe",
    entryIsAppleMusic: ({ event }) =>
      event.type === "ENQUEUE" && event.entry.target.kind === "appleMusic",
    queueHeadIsIframe: ({ context }) => context.queue[0]?.target.kind === "iframe",
    queueHeadIsAppleMusic: ({ context }) => context.queue[0]?.target.kind === "appleMusic",
    queueEmpty: ({ context }) => context.queue.length === 0,
  },
}).createMachine({
  context: ({ input }) => ({
    src: null,
    apple: null,
    label: "",
    itemId: null,
    playerType: "audio",
    minimized: false,
    queue: input?.initialQueue ?? [],
    queueWindowVisible: false,
    playAppleMusic: input?.playAppleMusic ?? noop,
    stopAppleMusic: input?.stopAppleMusic ?? noop,
  }),
  initial: "idle",
  on: {
    // Starting playback supersedes whatever is currently playing. Targeting a
    // concrete state (rather than an internal transition) forces the active
    // state's `exit` action to run first — re-entering `appleMusic` from itself
    // likewise stops the old track before queuing the new one. The queue is
    // left untouched: a stray play never drops what's lined up.
    LOAD_IFRAME: {
      target: ".iframe",
      actions: assign(({ event }) => ({
        src: event.src,
        apple: null,
        label: event.label,
        itemId: event.itemId ?? null,
        playerType: event.playerType,
        minimized: false,
      })),
    },
    LOAD_APPLE_MUSIC: {
      target: ".appleMusic",
      actions: assign(({ event }) => ({
        src: null,
        apple: { kind: event.kind, id: event.id },
        label: event.label,
        itemId: event.itemId ?? null,
        playerType: "audio" as const,
        minimized: false,
      })),
    },
    // ADVANCE serves both natural end-of-playback (MusicKit / YouTube end
    // signals) and the manual next button. The guarded targets re-create the
    // LOAD_* shape from the queue head; an empty queue behaves like STOP.
    ADVANCE: [
      {
        target: ".iframe",
        guard: "queueHeadIsIframe",
        actions: "playQueueHead",
      },
      {
        target: ".appleMusic",
        guard: "queueHeadIsAppleMusic",
        actions: "playQueueHead",
      },
      {
        target: ".idle",
        guard: "queueEmpty",
        actions: "resetNowPlaying",
      },
    ],
    // Stops now-playing only. The queue survives — the whole point is that
    // closing the player window doesn't throw away what's lined up.
    STOP: {
      target: ".idle",
      actions: "resetNowPlaying",
    },
    MINIMIZE: {
      actions: assign({ minimized: true }),
    },
    TOGGLE_WINDOW: {
      actions: assign(({ context }) => ({ minimized: !context.minimized })),
    },
    REMOVE_FROM_QUEUE: {
      actions: assign(({ context, event }) => ({
        queue:
          event.index >= 0 && event.index < context.queue.length
            ? context.queue.filter((_, i) => i !== event.index)
            : context.queue,
      })),
    },
    MOVE_IN_QUEUE: {
      actions: assign(({ context, event }) => ({
        queue: moveEntry(context.queue, event.from, event.to),
      })),
    },
    CLEAR_QUEUE: {
      actions: assign({ queue: [] }),
    },
    TOGGLE_QUEUE_WINDOW: {
      actions: assign(({ context }) => ({ queueWindowVisible: !context.queueWindowVisible })),
    },
  },
  states: {
    idle: {
      on: {
        // Nothing playing: an enqueued release starts immediately, exactly as
        // if its LOAD_* event had been sent.
        ENQUEUE: [
          { target: "iframe", guard: "entryIsIframe", actions: "playEntry" },
          { target: "appleMusic", guard: "entryIsAppleMusic", actions: "playEntry" },
        ],
      },
    },
    iframe: {
      on: {
        ENQUEUE: { actions: "appendToQueue" },
      },
    },
    appleMusic: {
      entry: "startAppleMusic",
      exit: "stopAppleMusic",
      on: {
        ENQUEUE: { actions: "appendToQueue" },
      },
    },
  },
});
