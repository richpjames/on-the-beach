/**
 * Now-playing player state, shared by the player window, taskbar, and any
 * page that starts playback. Lives at module scope on the client so playback
 * survives SvelteKit client-side navigation (the player window itself is
 * rendered by the root layout, which never unmounts).
 *
 * Two playback modes:
 *  - "iframe": Bandcamp / YouTube / Mixcloud (and the Apple Music preview
 *    embed used as a fallback) render an <iframe> from `src`.
 *  - "apple_music": full-track playback driven by MusicKit (see musickit.svelte.ts).
 */
import type { AppleMusicKind } from "../../shared/apple-music";
import { playResource, stop as stopMusicKit } from "./musickit.svelte";

export type PlayerType = "audio" | "video";
export type PlayerMode = "iframe" | "apple_music";

interface AppleMusicTarget {
  kind: AppleMusicKind;
  id: string;
}

interface PlayerState {
  mode: PlayerMode;
  src: string | null;
  apple: AppleMusicTarget | null;
  label: string;
  playerType: PlayerType;
  minimized: boolean;
}

const state = $state<PlayerState>({
  mode: "iframe",
  src: null,
  apple: null,
  label: "",
  playerType: "audio",
  minimized: false,
});

export const player = {
  get mode() {
    return state.mode;
  },
  get src() {
    return state.src;
  },
  get label() {
    return state.label;
  },
  get playerType() {
    return state.playerType;
  },
  get isAppleMusic() {
    return state.mode === "apple_music";
  },
  get minimized() {
    return state.minimized;
  },
  get active() {
    return state.mode === "apple_music" ? state.apple !== null : state.src !== null;
  },
  get windowVisible() {
    return this.active && !state.minimized;
  },

  /** Play an iframe-embedded source (Bandcamp, YouTube, Mixcloud, AM preview). */
  load(src: string, title: string, artist: string, playerType: PlayerType = "audio"): void {
    state.mode = "iframe";
    state.src = src;
    state.apple = null;
    state.label = artist ? `${artist} — ${title}` : title;
    state.playerType = playerType;
    state.minimized = false;
  },

  /** Play a full Apple Music catalogue resource via MusicKit. */
  loadAppleMusic(kind: AppleMusicKind, id: string, title: string, artist: string): void {
    state.mode = "apple_music";
    state.src = null;
    state.apple = { kind, id };
    state.label = artist ? `${artist} — ${title}` : title;
    state.playerType = "audio";
    state.minimized = false;
    void playResource(kind, id);
  },

  stop(): void {
    if (state.mode === "apple_music") {
      void stopMusicKit();
    }
    state.mode = "iframe";
    state.src = null;
    state.apple = null;
    state.label = "";
    state.playerType = "audio";
    state.minimized = false;
  },

  minimize(): void {
    state.minimized = true;
  },

  toggleWindow(): void {
    state.minimized = !state.minimized;
  },
};
