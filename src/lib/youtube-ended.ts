/**
 * YouTube end-of-playback detection without the iframe-API script.
 *
 * YouTube is the only iframe source that reports anything back: when a player
 * is loaded with `enablejsapi=1`, it accepts a small postMessage protocol from
 * the parent window and posts state updates in return. This module speaks just
 * enough of that protocol to learn when the video ended (state 0), so the play
 * queue can auto-advance. Bandcamp / SoundCloud / Mixcloud / the Apple Music
 * preview embed expose no end signal at all — those entries advance only via
 * the manual next button.
 *
 * The protocol has two gotchas, both verified against a live embed:
 *  - the player posts nothing to a parent that has not spoken first, so the
 *    parent must send `listening` (the official iframe API repeats it until the
 *    player answers);
 *  - `onStateChange` broadcasts only start after the parent sends the
 *    `addEventListener` command — state also arrives as `infoDelivery`
 *    `playerState` updates, which this watcher accepts as a fallback.
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
 * With `autoplay` the video also starts by itself — used for entries the queue
 * advances to, which should start playing rather than sit on their poster.
 * Non-YouTube srcs and SSR (no `window`) come back unchanged.
 */
export function enableYouTubeJsApi(src: string, options?: { autoplay?: boolean }): string {
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
  if (options?.autoplay) url.searchParams.set("autoplay", "1");
  return url.toString();
}

interface YouTubeMessage {
  event?: unknown;
  info?: unknown;
}

/** The player ignores us until it hears this, and drops anything else we send
 *  before it — so keep repeating it until the handshake answers below. */
const LISTEN_POLL_MS = 250;

/**
 * Watch one player iframe for ended events. The flow:
 *  1. We say `{"event":"listening", id, channel}` — immediately, and again
 *     every LISTEN_POLL_MS until the player answers, because the player posts
 *     nothing to a parent that has not spoken first (verified against a live
 *     embed: a silent parent receives no messages at all, ever).
 *  2. The player's first message (typically `initialDelivery` or `onReady`)
 *     completes the handshake; we stop polling and subscribe with the
 *     `addEventListener` command, which is what makes the player post
 *     `onStateChange` events.
 *  3. Ended arrives either as `{"event":"onStateChange","info":0}` or — no
 *     subscription required — as an `infoDelivery` with `playerState: 0`;
 *     both invoke `onEnded`, once per watch, so a duplicate ended message
 *     can't skip a second release (the MusicKit side guards the same way with
 *     its generation counter).
 *
 * Returns a dispose function that drops the window-level listener and the
 * poll; call it when the iframe goes away (stop, unmount, src change) so a
 * stale player can never land an ADVANCE for playback that is no longer
 * current.
 */
export function watchYouTubeEnd(iframe: HTMLIFrameElement, onEnded: () => void): () => void {
  let disposed = false;
  let handshook = false;
  let ended = false;

  const send = (payload: Record<string, unknown>): void => {
    iframe.contentWindow?.postMessage(JSON.stringify(payload), "*");
  };
  const listen = (): void => {
    send({ event: "listening", id: iframe.id || "otb-player", channel: "widget" });
  };
  const isEndedInfo = (info: unknown): boolean =>
    !!info && typeof info === "object" && (info as { playerState?: unknown }).playerState === 0;

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
      // Handshake complete: the player knows us now, so the poll can stop and
      // the subscription (the only way to get onStateChange broadcasts) go out.
      handshook = true;
      clearInterval(poll);
      send({ event: "command", func: "addEventListener", args: ["onStateChange"] });
    }

    const endedChange = data.event === "onStateChange" && data.info === 0;
    const endedDelivery = data.event === "infoDelivery" && isEndedInfo(data.info);
    if ((endedChange || endedDelivery) && !ended) {
      ended = true;
      onEnded();
    }
  };

  listen();
  const poll = setInterval(() => {
    if (!handshook) listen();
  }, LISTEN_POLL_MS);
  window.addEventListener("message", onMessage);
  return () => {
    disposed = true;
    clearInterval(poll);
    window.removeEventListener("message", onMessage);
  };
}
