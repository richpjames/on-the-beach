import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { fetchFullItem } from "../../../../server/music-item-creator";
import { getLookupService } from "../../../../server/settings";
import { isAppleMusicConfigured } from "../../../../server/apple-music-token";
import {
  parseUrl,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
} from "../../../../server/utils";
import { parseAppleMusicCatalogUrl, type AppleMusicResource } from "../../../../shared/apple-music";
import type { MusicItemFull } from "../../../types";

const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  bandcamp: "Bandcamp",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
  apple_music: "Apple Music",
  discogs: "Discogs",
  tidal: "Tidal",
  deezer: "Deezer",
  mixcloud: "Mixcloud",
  physical: "Physical",
  unknown: "Link",
};

function sourceDisplayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

const SAFE_ARTWORK_URL = /^(https?:\/\/|\/uploads\/)/;

function safeArtworkUrl(url: string): string | null {
  return SAFE_ARTWORK_URL.test(url) ? url : null;
}

function parseLinkMetadata(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

export interface ListenEmbed {
  src: string;
  href: string | null;
  playerType: "audio" | "video";
}

function youTubeEmbed(item: MusicItemFull): ListenEmbed | null {
  if (item.primary_source !== "youtube" || !item.primary_url) return null;
  const videoId = extractYouTubeVideoId(item.primary_url);
  let src: string | null = null;
  if (videoId && /^[\w-]+$/.test(videoId)) {
    src = `https://www.youtube-nocookie.com/embed/${videoId}`;
  } else {
    const playlistId = extractYouTubePlaylistId(item.primary_url);
    if (playlistId && /^[\w-]+$/.test(playlistId)) {
      src = `https://www.youtube-nocookie.com/embed/videoseries?list=${playlistId}`;
    }
  }
  if (!src) return null;
  return { src, href: item.primary_url, playerType: "video" };
}

function bandcampEmbed(item: MusicItemFull): ListenEmbed | null {
  if (!item.primary_url?.includes("bandcamp.com")) return null;
  const meta = parseLinkMetadata(item.primary_link_metadata);
  const albumId = meta?.album_id;
  if (!albumId) return null;

  const embedType = meta.item_type === "track" ? "track" : "album";
  return {
    src: `https://bandcamp.com/EmbeddedPlayer/${embedType}=${albumId}/size=large/bgcol=ffffff/linkcol=0687f5/artwork=none/transparent=true/`,
    href: item.primary_url,
    playerType: "audio",
  };
}

/**
 * How to listen to a release on Apple Music.
 *  - "musickit": full-track playback via the browser MusicKit SDK, using the
 *    catalogue id parsed from the stored URL. Requires MusicKit configured.
 *  - "preview": the legacy `embed.music.apple.com` iframe (30-second previews),
 *    kept as a fallback when MusicKit isn't configured.
 */
export interface AppleMusicListen {
  mode: "musickit" | "preview";
  resource: AppleMusicResource | null;
  src: string | null;
  href: string;
}

/** The first Apple Music URL on the item (primary link preferred). */
function appleMusicUrlForItem(item: MusicItemFull): { url: string; isPrimary: boolean } | null {
  if (item.primary_url?.includes("music.apple.com")) {
    return { url: item.primary_url, isPrimary: true };
  }
  const link = item.links.find(
    (l) => !l.is_primary && (l.source_name === "apple_music" || l.url.includes("music.apple.com")),
  );
  return link ? { url: link.url, isPrimary: false } : null;
}

function appleMusicListen(item: MusicItemFull, configured: boolean): AppleMusicListen | null {
  const found = appleMusicUrlForItem(item);
  if (!found) return null;

  if (configured) {
    const resource = parseAppleMusicCatalogUrl(found.url);
    if (resource) {
      return { mode: "musickit", resource, src: null, href: found.url };
    }
  }

  // Preview fallback, only for a primary Apple Music link (unchanged behaviour
  // for unconfigured deployments — secondary AM links stay plain links).
  if (found.isPrimary) {
    try {
      const parsed = new URL(found.url);
      if (parsed.hostname.endsWith("music.apple.com")) {
        return {
          mode: "preview",
          resource: null,
          src: `https://embed.music.apple.com${parsed.pathname}`,
          href: found.url,
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function mixcloudWidgetSrc(item: MusicItemFull): string | null {
  const meta = parseLinkMetadata(item.primary_link_metadata);
  const mixcloudUrl = meta?.mixcloud_url;
  if (!mixcloudUrl) return null;

  let pathname: string;
  try {
    const parsed = new URL(mixcloudUrl);
    if (!parsed.hostname.toLowerCase().endsWith("mixcloud.com")) return null;
    pathname = parsed.pathname;
  } catch {
    return null;
  }

  return `https://www.mixcloud.com/widget/iframe/?hide_cover=1&feed=${encodeURIComponent(pathname)}`;
}

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    error(400, "Invalid ID");
  }

  const item = await fetchFullItem(id);
  if (!item) {
    error(404, "Not found — this release doesn't exist.");
  }

  const sourceLink =
    item.primary_url && !item.primary_url.includes("bandcamp.com")
      ? {
          href: item.primary_url,
          label: sourceDisplayName(item.primary_source ?? parseUrl(item.primary_url).source),
        }
      : null;

  const appleMusicConfigured = isAppleMusicConfigured();

  return {
    item,
    backdropUrl: safeArtworkUrl(item.artwork_url ?? ""),
    artworkUrl: safeArtworkUrl(item.artwork_url ?? ""),
    sourceLink,
    youtubeEmbed: youTubeEmbed(item),
    bandcampEmbed: bandcampEmbed(item),
    appleMusicListen: appleMusicListen(item, appleMusicConfigured),
    appleMusicConfigured,
    mixcloudWidgetSrc: mixcloudWidgetSrc(item),
    lookupService: await getLookupService(),
  };
};
