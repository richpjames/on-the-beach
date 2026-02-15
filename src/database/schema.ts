export const SCHEMA = `
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Sources: Where music can be found
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    url_pattern TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Artists
CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Music Items: The core entity
CREATE TABLE IF NOT EXISTS music_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    item_type TEXT NOT NULL DEFAULT 'album',
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    listen_status TEXT NOT NULL DEFAULT 'to-listen',
    purchase_intent TEXT NOT NULL DEFAULT 'no',
    price_cents INTEGER,
    currency TEXT DEFAULT 'USD',
    notes TEXT,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    listened_at TEXT,
    is_physical INTEGER NOT NULL DEFAULT 0,
    physical_format TEXT
);

-- Music Links: URLs where the music can be found
CREATE TABLE IF NOT EXISTS music_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    music_item_id INTEGER NOT NULL REFERENCES music_items(id) ON DELETE CASCADE,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(music_item_id, url)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_music_items_listen_status ON music_items(listen_status);
CREATE INDEX IF NOT EXISTS idx_music_items_purchase_intent ON music_items(purchase_intent);
CREATE INDEX IF NOT EXISTS idx_music_items_artist_id ON music_items(artist_id);
CREATE INDEX IF NOT EXISTS idx_music_items_created_at ON music_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_links_music_item_id ON music_links(music_item_id);
CREATE INDEX IF NOT EXISTS idx_music_links_url ON music_links(url);

-- Seed sources
INSERT OR IGNORE INTO sources (name, display_name, url_pattern) VALUES
    ('bandcamp', 'Bandcamp', 'bandcamp.com'),
    ('spotify', 'Spotify', 'open.spotify.com'),
    ('soundcloud', 'SoundCloud', 'soundcloud.com'),
    ('youtube', 'YouTube', 'youtube.com'),
    ('apple_music', 'Apple Music', 'music.apple.com'),
    ('discogs', 'Discogs', 'discogs.com'),
    ('tidal', 'Tidal', 'tidal.com'),
    ('deezer', 'Deezer', 'deezer.com'),
    ('mixcloud', 'Mixcloud', 'mixcloud.com'),
    ('physical', 'Physical Media', NULL);

-- View for full music items with joins
CREATE VIEW IF NOT EXISTS v_music_items_full AS
SELECT
    mi.*,
    a.name AS artist_name,
    (SELECT url FROM music_links ml WHERE ml.music_item_id = mi.id AND ml.is_primary = 1 LIMIT 1) AS primary_url,
    (SELECT s.name FROM music_links ml
     JOIN sources s ON ml.source_id = s.id
     WHERE ml.music_item_id = mi.id AND ml.is_primary = 1 LIMIT 1) AS primary_source
FROM music_items mi
LEFT JOIN artists a ON mi.artist_id = a.id;
`
