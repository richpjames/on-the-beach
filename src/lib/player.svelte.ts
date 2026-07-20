/**
 * Now-playing player state, shared by the player window, taskbar, and any
 * page that starts playback. Lives at module scope on the client so playback
 * survives SvelteKit client-side navigation (the player window itself is
 * rendered by the root layout, which never unmounts).
 *
 * The actual state — idle / iframe / apple_music, and the "stop whatever is
 * playing before starting the next release" rule — lives in `playerMachine`
 * (see src/ui/state/player-machine.ts). This module owns the single client-side
 * actor, injects the browser side effects (MusicKit start/stop), and exposes a
 * reactive facade the components bind to. See docs/areas/frontend/state-machines.md.
 *
 * Two playback modes:
 *  - "iframe": Bandcamp / YouTube / Mixcloud (and the Apple Music preview
 *    embed used as a fallback) render an <iframe> from `src`.
 *  - "apple_music": full-track playback driven by MusicKit (see musickit.svelte.ts).
 */
import { browser } from "$app/environment";
import { createActor } from "xstate";
import type { AppleMusicKind } from "../../shared/apple-music";
import { playResource, stop as stopMusicKit } from "./musickit.svelte";
import { playerMachine, type PlayerType } from "../ui/state/player-machine";

export type { PlayerType };

// One actor for the whole client session. During SSR it is never started — the
// initial (idle) snapshot renders and the machine comes alive on the client,
// matching `useMachine`.
const actor = createActor(playerMachine, {
  input: {
    playAppleMusic: (kind, id) => {
      void playResource(kind, id);
    },
    stopAppleMusic: () => {
      void stopMusicKit();
    },
  },
});

let snapshot = $state.raw(actor.getSnapshot());
if (browser) {
  actor.subscribe((next) => {
    snapshot = next;
  });
  actor.start();
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

  /** Play an iframe-embedded source (Bandcamp, YouTube, Mixcloud, AM preview). */
  load(src: string, title: string, artist: string, playerType: PlayerType = "audio"): void {
    actor.send({ type: "LOAD_IFRAME", src, label: toLabel(title, artist), playerType });
  },

  /** Play a full Apple Music catalogue resource via MusicKit. */
  loadAppleMusic(kind: AppleMusicKind, id: string, title: string, artist: string): void {
    actor.send({ type: "LOAD_APPLE_MUSIC", kind, id, label: toLabel(title, artist) });
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
