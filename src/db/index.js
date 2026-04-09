const Database = require('better-sqlite3');
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || path.join('/app/data', 'navilist.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

logger.info('db', `SQLite opened at ${DB_PATH}`);

require('./schema')(db);
logger.info('db', 'schema ready');

// Give logger a DB reference so it can read log_level from settings
logger.setDb(db);

// Seed settings from environment variables on first boot.
// INSERT OR IGNORE means env vars only apply if the key doesn't already exist in the DB.
// UI-saved values always take precedence over env vars.
const ENV_SETTINGS = {
  navidrome_url:         process.env.NAVIDROME_URL,
  navidrome_user:        process.env.NAVIDROME_USER,
  navidrome_password:    process.env.NAVIDROME_PASSWORD,
  music_folder_ids:      process.env.MUSIC_FOLDER_IDS,
  lastfm_api_key:        process.env.LASTFM_API_KEY,
  lastfm_username:       process.env.LASTFM_USERNAME,
  listenbrainz_token:    process.env.LISTENBRAINZ_TOKEN,
  listenbrainz_username: process.env.LISTENBRAINZ_USERNAME,
  lidarr_url:                process.env.LIDARR_URL,
  lidarr_api_key:            process.env.LIDARR_API_KEY,
  lidarr_root_folder:        process.env.LIDARR_ROOT_FOLDER,
  lidarr_quality_profile_id: process.env.LIDARR_QUALITY_PROFILE_ID,
  lidarr_metadata_profile_id: process.env.LIDARR_METADATA_PROFILE_ID,
};

const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const seedMany = db.transaction((entries) => {
  for (const [key, value] of entries) seedSetting.run(key, value);
});

const toSeed = Object.entries(ENV_SETTINGS).filter(([, v]) => v !== undefined);
if (toSeed.length > 0) {
  seedMany(toSeed);
  logger.info('db', `seeded ${toSeed.length} setting(s) from environment: ${toSeed.map(([k]) => k).join(', ')}`);
}

module.exports = db;
