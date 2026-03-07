import { describe, expect, test } from "bun:test";
import type { MusicItemFull } from "../../src/types";
import { renderMusicCard } from "../../src/ui/view/templates";

const ITEM: MusicItemFull = {
  id: 42,
  title: 'A&B "Test"',
  normalized_title: "aandb test",
  item_type: "album",
  artist_id: 7,
  listen_status: "to-listen",
  purchase_intent: "maybe",
  price_cents: null,
  currency: "EUR",
  notes: null,
  rating: 4,
  created_at: "2026-03-07T00:00:00.000Z",
  updated_at: "2026-03-07T00:00:00.000Z",
  listened_at: null,
  artwork_url: "https://example.com/artwork.png",
  is_physical: 0,
  physical_format: null,
  label: null,
  year: null,
  country: null,
  genre: null,
  catalogue_number: null,
  musicbrainz_release_id: null,
  musicbrainz_artist_id: null,
  artist_name: "Example Artist",
  primary_url: "https://example.com/release",
  primary_source: "bandcamp",
  stacks: [{ id: 3, name: "Ambient" }],
};

describe("renderMusicCard", () => {
  test("renders a dedicated reorder handle with an escaped label", () => {
    const html = renderMusicCard(ITEM);

    expect(html).toContain('class="btn btn--ghost music-card__reorder-handle"');
    expect(html).toContain('aria-label="Reorder A&amp;B &quot;Test&quot;"');
  });
});
