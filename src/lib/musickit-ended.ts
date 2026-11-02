/**
 * Pure end-of-playback logic for the Apple Music side of the play queue.
 *
 * Extracted from musickit.svelte.ts — that module uses runes at module scope,
 * so nothing can import it from a unit test — and kept runes-free here, the
 * same way youtube-ended.ts is, so the queue's end detection stays testable.
 */

/**
 * Whether a MusicKit playback state means "the queue played through to the
 * end" — the natural-completion signal the app auto-advances on. Defensive
 * lookup, like isPlayingState: MusicKit JS v3's PlaybackStates names it
 * `ended` (5); if a build renames it, `completed` or the numeric fallback
 * still lands close.
 */
export function isEndedState(state: number, states: Record<string, number> | undefined): boolean {
  const ended =
    typeof states?.ended === "number"
      ? states.ended
      : typeof states?.completed === "number"
        ? states.completed
        : 5;
  return state === ended;
}

export interface PlaybackGeneration {
  /** A playback began: its end signal is the live one. */
  begin(): void;
  /** Teardown (stop, manual skip, a new release taking over): any end signal
   *  still in flight is now stale. */
  retire(): void;
  /** Whether an arriving end signal belongs to the live playback. Consumes it,
   *  so a burst of duplicate `ended` events notifies at most once. */
  consumeIfLive(): boolean;
}

/**
 * The stale-signal guard behind auto-advance: every begun playback opens a
 * generation, teardown retires it, and only an `ended` arriving while its
 * generation is still live invokes the callback. Teardown states a manual skip
 * or a new release causes can never masquerade as natural completion.
 */
export function createPlaybackGeneration(): PlaybackGeneration {
  let playbackGeneration = 0;
  let playingGeneration = -1;
  return {
    begin: () => {
      playbackGeneration += 1;
      playingGeneration = playbackGeneration;
    },
    retire: () => {
      playbackGeneration += 1;
    },
    consumeIfLive: () => {
      if (playingGeneration !== playbackGeneration) return false;
      playingGeneration = -1;
      return true;
    },
  };
}
