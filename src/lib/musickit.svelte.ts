/**
 * Browser MusicKit controller.
 *
 * Loads Apple's MusicKit JS (v3) on demand, configures it with a developer
 * token minted server-side, and exposes a small reactive facade the player UI
 * binds to. Unlike the old `embed.music.apple.com` iframe — which only ever
 * plays 30-second previews — MusicKit streams full tracks once the listener has
 * authorised their own Apple Music subscription.
 *
 * All playback state lives at module scope so it survives SvelteKit client-side
 * navigation, mirroring `player.svelte.ts`.
 */
import type { AppleMusicKind } from "../../shared/apple-music";

const MUSICKIT_SRC = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";

// ── Minimal MusicKit typings (no official @types package) ───────────────────
interface MusicKitArtwork {
  url?: string;
}

interface MusicKitMediaItem {
  title?: string;
  artistName?: string;
  albumName?: string;
  artwork?: MusicKitArtwork;
}

interface MusicKitQueue {
  items: MusicKitMediaItem[];
  position: number;
}

type SetQueueOptions = Partial<Record<AppleMusicKind, string>>;

interface MusicKitInstance {
  isAuthorized: boolean;
  playbackState: number;
  currentPlaybackTime: number;
  currentPlaybackDuration: number;
  nowPlayingItem: MusicKitMediaItem | null;
  nowPlayingItemIndex: number;
  queue: MusicKitQueue;
  addEventListener(name: string, handler: (event: unknown) => void): void;
  authorize(): Promise<string>;
  unauthorize(): Promise<void>;
  setQueue(options: SetQueueOptions): Promise<unknown>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seekToTime(seconds: number): Promise<void>;
  skipToNextItem(): Promise<void>;
  skipToPreviousItem(): Promise<void>;
  changeToMediaAtIndex(index: number): Promise<void>;
}

interface MusicKitStatic {
  configure(config: {
    developerToken: string;
    app: { name: string; build: string };
  }): Promise<MusicKitInstance>;
  getInstance(): MusicKitInstance | undefined;
  PlaybackStates: Record<string, number>;
  formatArtworkURL?(artwork: MusicKitArtwork, height: number, width: number): string;
}

declare global {
  interface Window {
    MusicKit?: MusicKitStatic;
  }
}

// ── Reactive state ──────────────────────────────────────────────────────────
type Availability = "unknown" | "loading" | "ready" | "unavailable";

/** One entry of the current playback queue (an album/playlist's track list). */
export interface QueueTrack {
  title: string;
  artist: string;
}

interface MusicKitUiState {
  availability: Availability;
  authorized: boolean;
  playing: boolean;
  loadingTrack: boolean;
  position: number;
  duration: number;
  title: string;
  artist: string;
  artworkUrl: string | null;
  error: string | null;
  tracks: QueueTrack[];
  trackIndex: number;
}

const ui = $state<MusicKitUiState>({
  availability: "unknown",
  authorized: false,
  playing: false,
  loadingTrack: false,
  position: 0,
  duration: 0,
  title: "",
  artist: "",
  artworkUrl: null,
  error: null,
  tracks: [],
  trackIndex: -1,
});

let instance: MusicKitInstance | null = null;
let configurePromise: Promise<MusicKitInstance | null> | null = null;

function scriptEl(): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(`script[src="${MUSICKIT_SRC}"]`);
}

/** Inject the MusicKit JS script once and resolve when the global is ready. */
function loadScript(): Promise<MusicKitStatic | null> {
  return new Promise((resolve) => {
    if (window.MusicKit) {
      resolve(window.MusicKit);
      return;
    }

    const onLoaded = (): void => resolve(window.MusicKit ?? null);

    const existing = scriptEl();
    if (existing) {
      document.addEventListener("musickitloaded", onLoaded, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = MUSICKIT_SRC;
    script.async = true;
    document.addEventListener("musickitloaded", onLoaded, { once: true });
    script.addEventListener("error", () => resolve(null), { once: true });
    document.head.appendChild(script);
  });
}

function artworkUrlFor(item: MusicKitMediaItem | null): string | null {
  const template = item?.artwork?.url;
  if (!template) return null;
  return template.replace(/\{w\}/g, "240").replace(/\{h\}/g, "240").replace(/\{f\}/g, "jpg");
}

function isPlayingState(state: number, MK: MusicKitStatic): boolean {
  const playing = MK.PlaybackStates?.playing;
  return typeof playing === "number" ? state === playing : state === 2;
}

function syncFromInstance(MK: MusicKitStatic): void {
  if (!instance) return;
  ui.authorized = instance.isAuthorized;
  ui.playing = isPlayingState(instance.playbackState, MK);
  ui.position = instance.currentPlaybackTime || 0;
  ui.duration = instance.currentPlaybackDuration || 0;
  const item = instance.nowPlayingItem;
  ui.title = item?.title ?? "";
  ui.artist = item?.artistName ?? "";
  ui.artworkUrl = artworkUrlFor(item);
  syncQueueFromInstance();
}

/** Mirror MusicKit's playback queue (the release's track list) into the UI. */
function syncQueueFromInstance(): void {
  if (!instance) return;
  const items = instance.queue?.items ?? [];
  ui.tracks = items.map((it) => ({ title: it.title ?? "", artist: it.artistName ?? "" }));
  const idx =
    typeof instance.nowPlayingItemIndex === "number" && instance.nowPlayingItemIndex >= 0
      ? instance.nowPlayingItemIndex
      : (instance.queue?.position ?? -1);
  ui.trackIndex = idx;
}

function attachListeners(MK: MusicKitStatic): void {
  if (!instance) return;
  const sync = (): void => syncFromInstance(MK);
  instance.addEventListener("playbackStateDidChange", sync);
  instance.addEventListener("nowPlayingItemDidChange", sync);
  instance.addEventListener("authorizationStatusDidChange", sync);
  instance.addEventListener("queueItemsDidChange", () => syncQueueFromInstance());
  instance.addEventListener("queuePositionDidChange", () => syncQueueFromInstance());
  instance.addEventListener("playbackTimeDidChange", (event) => {
    // The event carries the fresh time; read the instance to stay authoritative.
    void event;
    if (!instance) return;
    ui.position = instance.currentPlaybackTime || 0;
    ui.duration = instance.currentPlaybackDuration || ui.duration;
  });
}

/**
 * Load and configure MusicKit, memoised. Resolves to the configured instance,
 * or null when Apple Music isn't configured / the SDK can't load. Safe to call
 * repeatedly.
 */
export function ensureConfigured(): Promise<MusicKitInstance | null> {
  if (configurePromise) return configurePromise;

  configurePromise = (async () => {
    ui.availability = "loading";
    ui.error = null;
    try {
      const res = await fetch("/api/apple-music/token");
      if (!res.ok) {
        ui.availability = "unavailable";
        return null;
      }
      const { token } = (await res.json()) as { token?: string };
      if (!token) {
        ui.availability = "unavailable";
        return null;
      }

      const MK = await loadScript();
      if (!MK) {
        ui.availability = "unavailable";
        ui.error = "Couldn't load Apple Music.";
        return null;
      }

      instance =
        MK.getInstance() ??
        (await MK.configure({
          developerToken: token,
          app: { name: "On The Beach", build: "1.0.0" },
        }));

      attachListeners(MK);
      syncFromInstance(MK);
      ui.availability = "ready";
      return instance;
    } catch (err) {
      console.error("[musickit] configuration failed:", err);
      ui.availability = "unavailable";
      ui.error = "Apple Music is unavailable.";
      // Let a later call retry rather than caching the failure forever.
      configurePromise = null;
      return null;
    }
  })();

  return configurePromise;
}

/** Prompt the listener to sign in to their Apple Music account. */
export async function authorize(): Promise<boolean> {
  const mk = await ensureConfigured();
  if (!mk) return false;
  try {
    await mk.authorize();
    ui.authorized = mk.isAuthorized;
    return mk.isAuthorized;
  } catch (err) {
    console.error("[musickit] authorize failed:", err);
    return false;
  }
}

/** Sign the listener out of Apple Music for this app. */
export async function unauthorize(): Promise<void> {
  if (!instance) return;
  try {
    await instance.unauthorize();
    ui.authorized = false;
  } catch (err) {
    console.error("[musickit] unauthorize failed:", err);
  }
}

/** Queue and play a catalogue resource (full playback for subscribers). */
export async function playResource(kind: AppleMusicKind, id: string): Promise<void> {
  const mk = await ensureConfigured();
  if (!mk) return;

  ui.loadingTrack = true;
  ui.error = null;
  try {
    if (!mk.isAuthorized) {
      const ok = await authorize();
      if (!ok) {
        ui.error = "Sign in to Apple Music to play the full track.";
        return;
      }
    }
    await mk.setQueue({ [kind]: id } as SetQueueOptions);
    await mk.play();
  } catch (err) {
    console.error("[musickit] playback failed:", err);
    ui.error = "Playback failed.";
  } finally {
    ui.loadingTrack = false;
  }
}

export async function togglePlay(): Promise<void> {
  if (!instance) return;
  try {
    if (ui.playing) {
      await instance.pause();
    } else {
      await instance.play();
    }
  } catch (err) {
    console.error("[musickit] toggle play failed:", err);
  }
}

/** Advance to the next track in the queue (e.g. the next album track). */
export async function skipNext(): Promise<void> {
  if (!instance) return;
  try {
    await instance.skipToNextItem();
  } catch (err) {
    console.error("[musickit] skip next failed:", err);
  }
}

/** Go back to the previous track in the queue. */
export async function skipPrevious(): Promise<void> {
  if (!instance) return;
  try {
    await instance.skipToPreviousItem();
  } catch (err) {
    console.error("[musickit] skip previous failed:", err);
  }
}

/** Jump straight to a track by its position in the queue (track-list click). */
export async function playTrackAt(index: number): Promise<void> {
  if (!instance) return;
  try {
    await instance.changeToMediaAtIndex(index);
  } catch (err) {
    console.error("[musickit] change track failed:", err);
  }
}

export async function seek(seconds: number): Promise<void> {
  if (!instance) return;
  try {
    await instance.seekToTime(seconds);
    ui.position = seconds;
  } catch (err) {
    console.error("[musickit] seek failed:", err);
  }
}

export async function stop(): Promise<void> {
  if (!instance) return;
  try {
    await instance.stop();
  } catch (err) {
    console.error("[musickit] stop failed:", err);
  }
  ui.playing = false;
  ui.position = 0;
  ui.tracks = [];
  ui.trackIndex = -1;
}

/** Reactive facade the player UI binds to. */
export const musickit = {
  get availability(): Availability {
    return ui.availability;
  },
  get authorized(): boolean {
    return ui.authorized;
  },
  get playing(): boolean {
    return ui.playing;
  },
  get loadingTrack(): boolean {
    return ui.loadingTrack;
  },
  get position(): number {
    return ui.position;
  },
  get duration(): number {
    return ui.duration;
  },
  get title(): string {
    return ui.title;
  },
  get artist(): string {
    return ui.artist;
  },
  get artworkUrl(): string | null {
    return ui.artworkUrl;
  },
  get error(): string | null {
    return ui.error;
  },
  get tracks(): QueueTrack[] {
    return ui.tracks;
  },
  get trackIndex(): number {
    return ui.trackIndex;
  },
  /** More than one track queued, so skip/track-list controls are meaningful. */
  get hasQueue(): boolean {
    return ui.tracks.length > 1;
  },
  get canSkipNext(): boolean {
    return ui.tracks.length > 1 && ui.trackIndex < ui.tracks.length - 1;
  },
  get canSkipPrevious(): boolean {
    return ui.tracks.length > 1 && ui.trackIndex > 0;
  },
};
