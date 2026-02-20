import type { SourceName } from '../src/types'

export interface OgData {
  ogTitle?: string
  ogDescription?: string
  ogImage?: string
  ogSiteName?: string
  title?: string
}

export interface ScrapedMetadata {
  potentialArtist?: string
  potentialTitle?: string
  imageUrl?: string
}

type OgParser = (og: OgData) => ScrapedMetadata

const MAX_HEAD_BYTES = 100_000

export function parseOgTags(html: string): OgData {
  const data: OgData = {}

  // Match <meta> tags with property/name and content in either order
  const metaRegex = /<meta\s+(?:[^>]*?)(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*?)["'][^>]*?\/?>/gi
  const metaRegexReversed = /<meta\s+(?:[^>]*?)content\s*=\s*["']([^"']*?)["'][^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?\/?>/gi

  const tags = new Map<string, string>()

  let match: RegExpExecArray | null
  while ((match = metaRegex.exec(html)) !== null) {
    tags.set(match[1].toLowerCase(), decodeHtmlEntities(match[2]))
  }
  while ((match = metaRegexReversed.exec(html)) !== null) {
    tags.set(match[2].toLowerCase(), decodeHtmlEntities(match[1]))
  }

  data.ogTitle = tags.get('og:title')
  data.ogDescription = tags.get('og:description')
  data.ogImage = tags.get('og:image')
  data.ogSiteName = tags.get('og:site_name')

  // Fallback to <title> tag
  if (!data.ogTitle) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch) {
      data.title = decodeHtmlEntities(titleMatch[1].trim())
    }
  }

  return data
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
}

export function parseBandcampOg(og: OgData): ScrapedMetadata {
  const title = og.ogTitle || og.title || ''
  // Bandcamp format: "Album Title, by Artist Name"
  const byMatch = title.match(/^(.+?),\s*by\s+(.+)$/i)
  if (byMatch) {
    return {
      potentialTitle: byMatch[1].trim(),
      potentialArtist: byMatch[2].trim(),
      imageUrl: og.ogImage,
    }
  }
  return { potentialTitle: title || undefined, imageUrl: og.ogImage }
}

export function parseSoundcloudOg(og: OgData): ScrapedMetadata {
  const title = og.ogTitle || og.title || ''
  // SoundCloud format: "Track by Artist" or "Stream Track by Artist"
  const byMatch = title.match(/^(?:Stream\s+)?(.+?)\s+by\s+(.+?)(?:\s+on\s+SoundCloud)?$/i)
  if (byMatch) {
    return {
      potentialTitle: byMatch[1].trim(),
      potentialArtist: byMatch[2].trim(),
      imageUrl: og.ogImage,
    }
  }
  return { potentialTitle: title || undefined, imageUrl: og.ogImage }
}

export function parseAppleMusicOg(og: OgData): ScrapedMetadata {
  const result: ScrapedMetadata = { imageUrl: og.ogImage }
  if (og.ogTitle) {
    result.potentialTitle = og.ogTitle
  }
  // og:description on Apple Music often contains "Album · YEAR · N Songs" or artist info
  if (og.ogDescription) {
    const artistMatch = og.ogDescription.match(/^(.+?)\s+[·\-]\s+/i)
    if (artistMatch) {
      result.potentialArtist = artistMatch[1].trim()
    }
  }
  return result
}

export function parseDefaultOg(og: OgData): ScrapedMetadata {
  return {
    potentialTitle: og.ogTitle || og.title || undefined,
    imageUrl: og.ogImage,
  }
}

export const SOURCE_PARSERS: Partial<Record<SourceName, OgParser>> = {
  bandcamp: parseBandcampOg,
  soundcloud: parseSoundcloudOg,
  apple_music: parseAppleMusicOg,
}

export async function scrapeUrl(
  url: string,
  source: SourceName,
  timeoutMs = 5000,
): Promise<ScrapedMetadata | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MusicBot/1.0)',
        Accept: 'text/html',
      },
    })

    clearTimeout(timer)

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/html')) {
      return null
    }

    // Read only up to the </head> or MAX_HEAD_BYTES
    const reader = response.body?.getReader()
    if (!reader) return null

    let html = ''
    const decoder = new TextDecoder()

    while (html.length < MAX_HEAD_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })
      if (html.includes('</head>')) break
    }

    reader.cancel()

    const og = parseOgTags(html)
    const parser = SOURCE_PARSERS[source] || parseDefaultOg
    return parser(og)
  } catch {
    return null
  }
}
