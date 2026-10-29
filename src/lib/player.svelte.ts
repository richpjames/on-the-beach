/**
 * Now-playing player state, shared by the player window, queue window,
 * taskbar, and any page that starts playback. Lives at module scope on the
 * client so playback survives SvelteKit client-side navigation (the player
 * window itself is rendered by the root layout, which never unmounts).
 *
 * The actual state — idle / iframe / apple_music, the "stop whatever is
 * playing before starting the next release" rule, and the upcoming play queue —
 * lives in `playerMachine` (see src/ui/state/player-machine.ts). This module
 * owns the single client-side actor, injects the browser side effects
 * (MusicKit start/stop), persists the queue to localStorage, and exposes a
 * reactive facade the components bind to. See docs/areas/frontend/state-machines.md.
 *
 * Two playback modes:
 *  - "iframe": Bandcamp / YouTube / SoundCloud / Mixcloud (and the Apple Music
 *    preview embed used as a fallback) render an <iframe> from `src`.
 *  - "apple_music": full-track playback driven by MusicKit (see musickit.svelte.ts).
 */
import { browser } from "$app/environment";
import { createActor } from "xstate";
import type { AppleMusicKind } from "../../domain/apple-music";
import { playResource, setOnQueueEnded, stop as stopMusicKit } from "./musickit.svelte";
import {
  parseStoredQueue,
  playerMachine,
  type PlayerType,
  type QueueEntry,
} from "../ui/state/player-machine";

export type { PlayerType, QueueEntry };

const QUEUE_STORAGE_KEY = "otb.player.queue";

/** Read the persisted upcoming queue; anything malformed resolves to empty. */
function readStoredQueue(): QueueEntry[] {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    return parseStoredQueue(JSON.parse(raw));
  } catch {
    return [];
  }
}

// One actor for the whole client session. During SSR it is never started — the
// initial (idle) snapshot renders and the machine comes alive on the client,
// matching `useMachine`. The queue is hydrated from localStorage at creation so
// the first snapshot already carries it.
const actor = createActor(playerMachine, {
  input: {
    playAppleMusic: (kind, id) => {
      void playResource(kind, id);
    },
    stopAppleMusic: () => {
      void stopMusicKit();
    },
    initialQueue: browser ? readStoredQueue() : [],
  },
});

let snapshot = $state.raw(actor.getSnapshot());
if (browser) {
  // Persist only the upcoming queue, and only when it actually changed.
  // Now-playing is re-derived by playback and never persisted.
  let persistedQueue: QueueEntry[] | undefined;
  actor.subscribe((next) => {
    snapshot = next;
    const { queue } = next.context;
    if (queue !== persistedQueue) {
      persistedQueue = queue;
      try {
        localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
      } catch {
        // Private-mode storage quotas and the like: playback still works,
        // the queue just won't survive a reload.
      }
    }
  });
  actor.start();

  // Natural end of Apple Music playback advances the queue. musickit.svelte
  // can't import this module (circular), so the callback is registered here;
  // its own generation counter keeps teardown noise from reaching the actor.
  setOnQueueEnded(() => {
    actor.send({ type: "ADVANCE" });
  });
}

function toLabel(title: string, artist: string): string {
  return artist ? `${artist} — ${title}` : title;
}

export const player = {
  get src() {
    return snapshot.context.src;
  },
  get label() {
    return snapshot.context.label;
  },
  get playerType() {
    return snapshot.context.playerType;
  },
  /** Link back to the release that started playback, or null if unknown. */
  get releaseHref() {
    const id = snapshot.context.itemId;
    return id === null ? null : `/r/${id}`;
  },
  get isAppleMusic() {
    return snapshot.matches("appleMusic");
  },
  get minimized() {
    return snapshot.context.minimized;
  },
  get active() {
    return !snapshot.matches("idle");
  },
  get windowVisible() {
    return !snapshot.matches("idle") && !snapshot.context.minimized;
  },

  /** Upcoming queue entries, next first (never contains the now-playing one). */
  get queue() {
    return snapshot.context.queue;
  },
  /** Whether the queue window should render: toggled open, and something to show. */
  get queueWindowOpen() {
    return (
      snapshot.context.queueWindowVisible && (player.active || snapshot.context.queue.length > 0)
    );
  },
  /** Something is queued, so the next button / auto-advance has somewhere to go. */
  get canSkipNext() {
    return snapshot.context.queue.length > 0;
  },

  /** Play an iframe-embedded source (Bandcamp, YouTube, SoundCloud, Mixcloud, AM preview). */
  load(
    src: string,
    title: string,
    artist: string,
    playerType: PlayerType = "audio",
    itemId?: number,
  ): void {
    actor.send({ type: "LOAD_IFRAME", src, label: toLabel(title, artist), playerType, itemId });
  },

  /** Play a full Apple Music catalogue resource via MusicKit. */
  loadAppleMusic(
    kind: AppleMusicKind,
    id: string,
    title: string,
    artist: string,
    itemId?: number,
  ): void {
    actor.send({ type: "LOAD_APPLE_MUSIC", kind, id, label: toLabel(title, artist), itemId });
  },

  /**
   * Add a release to the queue. When nothing is playing it starts immediately
   * (same semantics as load/loadAppleMusic); otherwise it plays when its turn
   * comes.
   */
  enqueue(entry: QueueEntry): void {
    actor.send({ type: "ENQUEUE", entry });
  },

  /** Remove the queued entry at `index` (out of range is a no-op). */
  removeAt(index: number): void {
    actor.send({ type: "REMOVE_FROM_QUEUE", index });
  },

  /** Reorder the queue; indices are clamped. */
  move(from: number, to: number): void {
    actor.send({ type: "MOVE_IN_QUEUE", from, to });
  },

  /** Empty the queue (the now-playing release keeps playing). */
  clearQueue(): void {
    actor.send({ type: "CLEAR_QUEUE" });
  },

  /**
   * Advance playback: the queue head becomes now-playing; with an empty queue
   * this stops playback. Serves both the manual next button and the natural
   * end-of-playback auto-advance.
   */
  skipNext(): void {
    actor.send({ type: "ADVANCE" });
  },

  /**
   * Play the queued entry at `index` right now. Simplest correct semantics:
   * move it to the head of the queue and advance, so it becomes now-playing
   * while the rest of the queue keeps its order around the gap it left.
   */
  playQueueEntry(index: number): void {
    actor.send({ type: "MOVE_IN_QUEUE", from: index, to: 0 });
    actor.send({ type: "ADVANCE" });
  },

  toggleQueueWindow(): void {
    actor.send({ type: "TOGGLE_QUEUE_WINDOW" });
  },

  stop(): void {
    actor.send({ type: "STOP" });
  },

  minimize(): void {
    actor.send({ type: "MINIMIZE" });
  },

  toggleWindow(): void {
    actor.send({ type: "TOGGLE_WINDOW" });
  },
};
