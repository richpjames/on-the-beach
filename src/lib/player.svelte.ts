/**
 * Now-playing player state, shared by the player window, taskbar, and any
 * page that starts playback. Lives at module scope on the client so playback
 * survives SvelteKit client-side navigation (the player window itself is
 * rendered by the root layout, which never unmounts).
 */
export type PlayerType = "audio" | "video";

interface PlayerState {
  src: string | null;
  label: string;
  playerType: PlayerType;
  isAppleMusic: boolean;
  minimized: boolean;
}

const state = $state<PlayerState>({
  src: null,
  label: "",
  playerType: "audio",
  isAppleMusic: false,
  minimized: false,
});

export const player = {
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
    return state.isAppleMusic;
  },
  get minimized() {
    return state.minimized;
  },
  get active() {
    return state.src !== null;
  },
  get windowVisible() {
    return state.src !== null && !state.minimized;
  },

  load(src: string, title: string, artist: string, playerType: PlayerType = "audio"): void {
    state.src = src;
    state.label = artist ? `${artist} — ${title}` : title;
    state.playerType = playerType;
    state.isAppleMusic = playerType !== "video" && src.includes("embed.music.apple.com");
    state.minimized = false;
  },

  stop(): void {
    state.src = null;
    state.label = "";
    state.playerType = "audio";
    state.isAppleMusic = false;
    state.minimized = false;
  },

  minimize(): void {
    state.minimized = true;
  },

  toggleWindow(): void {
    state.minimized = !state.minimized;
  },
};
