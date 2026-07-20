import { assign, setup } from "xstate";
import type { AppleMusicKind } from "../../../shared/apple-music";

export type PlayerType = "audio" | "video";

export interface AppleMusicTarget {
  kind: AppleMusicKind;
  id: string;
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
  /** Source URL for iframe playback (Bandcamp / YouTube / Mixcloud / AM preview). */
  src: string | null;
  /** Target catalogue resource when playing through MusicKit. */
  apple: AppleMusicTarget | null;
  /** "{artist} — {title}" (or just the title) shown in the window/taskbar. */
  label: string;
  playerType: PlayerType;
  minimized: boolean;
}

export type PlayerEvent =
  | { type: "LOAD_IFRAME"; src: string; label: string; playerType: PlayerType }
  | { type: "LOAD_APPLE_MUSIC"; kind: AppleMusicKind; id: string; label: string }
  | { type: "STOP" }
  | { type: "MINIMIZE" }
  | { type: "TOGGLE_WINDOW" };

export type PlayerInput = Partial<PlayerEffects>;

const noop = (): void => {};

/**
 * Now-playing state machine.
 *
 * Playback has three positions — `idle`, `iframe`, and `appleMusic` — and the
 * app only ever plays one release at a time. Because every "start playback"
 * event targets a concrete state, the outgoing state's `exit` action always
 * runs first: leaving `appleMusic` stops MusicKit, and leaving `iframe` drops
 * the `src` so the embed unmounts. That is what guarantees a currently playing
 * release stops when another is started — including when moving between Apple
 * Music and Bandcamp in either direction — without every caller having to
 * remember to tear the previous one down.
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
  },
}).createMachine({
  context: ({ input }) => ({
    src: null,
    apple: null,
    label: "",
    playerType: "audio",
    minimized: false,
    playAppleMusic: input?.playAppleMusic ?? noop,
    stopAppleMusic: input?.stopAppleMusic ?? noop,
  }),
  initial: "idle",
  on: {
    // Starting playback supersedes whatever is currently playing. Targeting a
    // concrete state (rather than an internal transition) forces the active
    // state's `exit` action to run first — re-entering `appleMusic` from itself
    // likewise stops the old track before queuing the new one.
    LOAD_IFRAME: {
      target: ".iframe",
      actions: assign(({ event }) => ({
        src: event.src,
        apple: null,
        label: event.label,
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
        playerType: "audio" as const,
        minimized: false,
      })),
    },
    STOP: {
      target: ".idle",
      actions: assign({
        src: null,
        apple: null,
        label: "",
        playerType: "audio" as const,
        minimized: false,
      }),
    },
    MINIMIZE: {
      actions: assign({ minimized: true }),
    },
    TOGGLE_WINDOW: {
      actions: assign(({ context }) => ({ minimized: !context.minimized })),
    },
  },
  states: {
    idle: {},
    iframe: {},
    appleMusic: {
      entry: "startAppleMusic",
      exit: "stopAppleMusic",
    },
  },
});
