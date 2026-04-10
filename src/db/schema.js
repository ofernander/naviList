'use strict';

// Full DB schema — all tables defined here.
// No migrations. Drop the DB file and restart to rebuild clean.

module.exports = function (db) {
  db.exec(`
    -- Settings
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Tracks (synced from Navidrome)
    CREATE TABLE IF NOT EXISTS tracks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      artist      TEXT,
      artist_id   TEXT,
      album       TEXT,
      album_id    TEXT,
      duration    INTEGER,
      year        INTEGER,
      genre       TEXT,
      play_count  INTEGER DEFAULT 0,
      starred     INTEGER DEFAULT 0,
      user_rating INTEGER,
      bit_rate    INTEGER,
      synced_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_genre     ON tracks(genre);
    CREATE INDEX IF NOT EXISTS idx_tracks_year      ON tracks(year);

    -- Play history
    CREATE TABLE IF NOT EXISTS play_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      played_at   INTEGER NOT NULL,
      source      TEXT NOT NULL DEFAULT 'navidrome',
      external_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_play_history_track_id  ON play_history(track_id);
    CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_play_history_dedup
      ON play_history(track_id, played_at);
    CREATE INDEX IF NOT EXISTS idx_play_history_external_id
      ON play_history(external_id) WHERE external_id IS NOT NULL;

    -- Sync state — tracks last successful import per source
    CREATE TABLE IF NOT EXISTS sync_state (
      source         TEXT PRIMARY KEY,
      last_synced_at INTEGER,
      last_run_at    INTEGER,
      status         TEXT,
      result         TEXT
    );

    -- Artists — optional MBID lookup cache (populated on demand, e.g. radio playlist creation)
    CREATE TABLE IF NOT EXISTS artists (
      artist_id   TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      mbid        TEXT,
      updated_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name);
    CREATE INDEX IF NOT EXISTS idx_artists_mbid ON artists(mbid) WHERE mbid IS NOT NULL;

    -- Similar artists cache (Last.fm) — keyed on ND artist_id
    CREATE TABLE IF NOT EXISTS artist_similar (
      artist_id         TEXT NOT NULL,
      similar_name      TEXT NOT NULL,
      similar_artist_id TEXT,
      score             REAL,
      source            TEXT NOT NULL DEFAULT 'lastfm',
      fetched_at        INTEGER NOT NULL,
      PRIMARY KEY (artist_id, similar_name)
    );

    CREATE INDEX IF NOT EXISTS idx_artist_similar_artist_id ON artist_similar(artist_id);

    -- Artist tags cache (Last.fm + MusicBrainz) — keyed on ND artist_id
    CREATE TABLE IF NOT EXISTS artist_tags (
      artist_id  TEXT NOT NULL,
      tag        TEXT NOT NULL,
      weight     INTEGER DEFAULT 0,
      source     TEXT NOT NULL DEFAULT 'musicbrainz',
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (artist_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_artist_tags_artist_id ON artist_tags(artist_id);
    CREATE INDEX IF NOT EXISTS idx_artist_tags_tag       ON artist_tags(tag);

    -- Loved / hated tracks (Last.fm loved, ListenBrainz feedback)
    CREATE TABLE IF NOT EXISTS loved_tracks (
      track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      source     TEXT NOT NULL,
      score      INTEGER NOT NULL DEFAULT 1,
      loved_at   INTEGER,
      PRIMARY KEY (track_id, source)
    );

    CREATE INDEX IF NOT EXISTS idx_loved_tracks_track_id ON loved_tracks(track_id);
    CREATE INDEX IF NOT EXISTS idx_loved_tracks_score    ON loved_tracks(score);

    -- User top artists by period (Last.fm / ListenBrainz)
    CREATE TABLE IF NOT EXISTS user_top_artists (
      artist_id  TEXT NOT NULL,
      source     TEXT NOT NULL,
      period     TEXT NOT NULL,
      rank       INTEGER NOT NULL,
      play_count INTEGER,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (artist_id, source, period)
    );

    CREATE INDEX IF NOT EXISTS idx_user_top_artists_period ON user_top_artists(source, period);

    -- User top tracks by period (Last.fm / ListenBrainz)
    CREATE TABLE IF NOT EXISTS user_top_tracks (
      track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      source     TEXT NOT NULL,
      period     TEXT NOT NULL,
      rank       INTEGER NOT NULL,
      play_count INTEGER,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (track_id, source, period)
    );

    CREATE INDEX IF NOT EXISTS idx_user_top_tracks_period ON user_top_tracks(source, period);

    -- Missing artists — discovered from external sources, not yet in local library
    CREATE TABLE IF NOT EXISTS missing_artists (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_name TEXT NOT NULL UNIQUE,
      mbid        TEXT,
      source      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      added_at    INTEGER NOT NULL,
      sent_at     INTEGER,
      found_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_missing_artists_status ON missing_artists(status);

    -- LB playlist subscriptions
    CREATE TABLE IF NOT EXISTS lb_playlists (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      lb_mbid          TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      playlist_type    TEXT NOT NULL DEFAULT 'generated',
      enabled          INTEGER NOT NULL DEFAULT 0,
      protected        INTEGER NOT NULL DEFAULT 0,
      navidrome_id     TEXT,
      slot_key         TEXT,
      last_imported_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_lb_playlists_slot_key ON lb_playlists(slot_key);
    CREATE INDEX IF NOT EXISTS idx_lb_playlists_enabled ON lb_playlists(enabled);

    -- LB playlist tracks cache — populated during Sync All, read by UI
    CREATE TABLE IF NOT EXISTS lb_playlist_tracks (
      lb_mbid   TEXT NOT NULL,
      position  INTEGER NOT NULL,
      artist    TEXT NOT NULL,
      title     TEXT NOT NULL,
      matched   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (lb_mbid, position)
    );

    CREATE INDEX IF NOT EXISTS idx_lb_playlist_tracks_mbid ON lb_playlist_tracks(lb_mbid);

    -- Last.fm playlist cache
    CREATE TABLE IF NOT EXISTS lfm_playlists (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      lfm_id           TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      navidrome_id     TEXT,
      last_imported_at INTEGER
    );

    -- Last.fm playlist tracks cache
    CREATE TABLE IF NOT EXISTS lfm_playlist_tracks (
      lfm_id    TEXT NOT NULL,
      position  INTEGER NOT NULL,
      artist    TEXT NOT NULL,
      title     TEXT NOT NULL,
      matched   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (lfm_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_lfm_playlist_tracks_id ON lfm_playlist_tracks(lfm_id);

    -- naviList playlist registry — local copies of all known playlists
    CREATE TABLE IF NOT EXISTS navilist_playlists (
      navidrome_id    TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      comment         TEXT,
      active          INTEGER NOT NULL DEFAULT 1,
      track_count     INTEGER,
      duration        INTEGER,
      created_at      INTEGER NOT NULL,
      deactivated_at  INTEGER
    );

    -- naviList playlist track snapshots
    CREATE TABLE IF NOT EXISTS navilist_playlist_tracks (
      playlist_id  TEXT NOT NULL,
      track_id     TEXT NOT NULL,
      position     INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS idx_navilist_playlist_tracks_playlist
      ON navilist_playlist_tracks(playlist_id);
  `);
};
