/**
 * YouTube end-of-playback detection without the iframe-API script.
 *
 * YouTube is the only iframe source that reports anything back: when a player
 * is loaded with `enablejsapi=1`, it posts state changes to the parent window
 * and accepts a small postMessage protocol in return. This module speaks just
 * enough of that protocol to learn when the video ended (state 0), so the play
 * queue can auto-advance. Bandcamp / SoundCloud / Mixcloud / the Apple Music
 * preview embed expose no end signal at all — those entries advance only via
 * the manual next button.
 *
 * Kept as a plain module (no runes) so it stays trivially testable; PlayerWindow
 * drives it from an $effect tied to the current video iframe.
 */

const YOUTUBE_EMBED_ORIGINS = new Set([
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
]);

/**
 * Append the parameters the postMessage protocol needs to a YouTube embed src.
 * Non-YouTube srcs and SSR (no `window`) come back unchanged.
 */
export function enableYouTubeJsApi(src: string): string {
  if (typeof window === "undefined") return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return src;
  }
  if (!YOUTUBE_EMBED_ORIGINS.has(url.origin)) return src;
  url.searchParams.set("enablejsapi", "1");
  // The player only accepts postMessage commands from the origin it was
  // told about — without this it stays mute.
  url.searchParams.set("origin", window.location.origin);
  return url.toString();
}

interface YouTubeMessage {
  event?: unknown;
  info?: unknown;
}

/**
 * Watch one player iframe for ended events. The flow:
 *  1. YouTube posts an initial message once its player is up (the handshake).
 *  2. We answer with `{"event":"listening", id, channel}` so it starts
 *     broadcasting state changes to us.
 *  3. `{"event":"onStateChange","info":0}` (ended) invokes `onEnded` — once
 *     per ended message.
 *
 * Returns a dispose function that drops the window-level listener; call it when
 * the iframe goes away (stop, unmount, src change) so a stale player can never
 * land an ADVANCE for playback that is no longer current.
 */
export function watchYouTubeEnd(iframe: HTMLIFrameElement, onEnded: () => void): () => void {
  let disposed = false;
  let handshook = false;

  const onMessage = (ev: MessageEvent): void => {
    if (disposed) return;
    // Only messages from our player, on the origins a YouTube embed posts from.
    if (!YOUTUBE_EMBED_ORIGINS.has(ev.origin)) return;
    if (ev.source !== iframe.contentWindow) return;

    let data: YouTubeMessage | null = null;
    if (typeof ev.data === "string" && ev.data.length > 0) {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (parsed && typeof parsed === "object") data = parsed as YouTubeMessage;
      } catch {
        return;
      }
    } else if (ev.data && typeof ev.data === "object") {
      data = ev.data as YouTubeMessage;
    }
    if (!data) return;

    if (!handshook) {
      // The handshake: answer the player's first message with the listening
      // command so it starts posting onStateChange events.
      handshook = true;
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: iframe.id || "otb-player", channel: "widget" }),
        "*",
      );
      // Fall through: a first message could itself be a state change, and
      // missing it would mean missing the ended event.
    }

    if (data.event === "onStateChange" && data.info === 0) {
      onEnded();
    }
  };

  window.addEventListener("message", onMessage);
  return () => {
    disposed = true;
    window.removeEventListener("message", onMessage);
  };
}
