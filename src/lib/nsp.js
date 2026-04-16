'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const db      = require('../db/index');
const logger  = require('../utils/logger');

function getNspPath() {
  return db.prepare("SELECT value FROM settings WHERE key = 'nsp_path'").get()?.value || null;
}

function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function listNspFiles(nspPath) {
  try {
    const files = fs.readdirSync(nspPath).filter(f => f.endsWith('.nsp'));
    return files.map(file => {
      const filePath = path.join(nspPath, file);
      try {
        const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const name   = config.name || path.basename(file, '.nsp');
        return { name, slug: slugify(name), file, config };
      } catch (e) {
        const slug = path.basename(file, '.nsp');
        return { name: slug, slug, file, config: null };
      }
    });
  } catch (e) {
    return [];
  }
}

const NSP_FIELDS = [
  // ── Track ────────────────────────────────────────────────────────────────
  { value: 'title',              label: 'Title',                type: 'string'  },
  { value: 'artist',             label: 'Artist',               type: 'string'  },
  { value: 'album',              label: 'Album',                type: 'string'  },
  { value: 'albumartist',        label: 'Album Artist',         type: 'string'  },
  { value: 'genre',              label: 'Genre',                type: 'string'  },
  { value: 'year',               label: 'Year',                 type: 'number'  },
  { value: 'date',               label: 'Date',                 type: 'date'    },
  { value: 'originalyear',       label: 'Original Year',        type: 'number'  },
  { value: 'originaldate',       label: 'Original Date',        type: 'date'    },
  { value: 'releaseyear',        label: 'Release Year',         type: 'number'  },
  { value: 'releasedate',        label: 'Release Date',         type: 'date'    },
  { value: 'tracknumber',        label: 'Track Number',         type: 'number'  },
  { value: 'discnumber',         label: 'Disc Number',          type: 'number'  },
  { value: 'discsubtitle',       label: 'Disc Subtitle',        type: 'string'  },
  { value: 'compilation',        label: 'Compilation',          type: 'boolean' },
  { value: 'hascoverart',        label: 'Has Cover Art',        type: 'boolean' },
  { value: 'comment',            label: 'Comment',              type: 'string'  },
  { value: 'lyrics',             label: 'Lyrics',               type: 'string'  },
  { value: 'grouping',           label: 'Grouping',             type: 'string'  },
  { value: 'catalognumber',      label: 'Catalog Number',       type: 'string'  },
  // ── Sort fields ──────────────────────────────────────────────────────────
  { value: 'sorttitle',          label: 'Sort Title',           type: 'string'  },
  { value: 'sortalbum',          label: 'Sort Album',           type: 'string'  },
  { value: 'sortartist',         label: 'Sort Artist',          type: 'string'  },
  { value: 'sortalbumartist',    label: 'Sort Album Artist',    type: 'string'  },
  // ── Audio properties ─────────────────────────────────────────────────────
  { value: 'duration',           label: 'Duration (seconds)',   type: 'number'  },
  { value: 'bitrate',            label: 'Bitrate',              type: 'number'  },
  { value: 'bitdepth',           label: 'Bit Depth',            type: 'number'  },
  { value: 'channels',           label: 'Channels',             type: 'number'  },
  { value: 'bpm',                label: 'BPM',                  type: 'number'  },
  { value: 'size',               label: 'File Size',            type: 'number'  },
  { value: 'filetype',           label: 'File Type',            type: 'string'  },
  { value: 'filepath',           label: 'File Path',            type: 'string'  },
  // ── User data ────────────────────────────────────────────────────────────
  { value: 'loved',              label: 'Loved',                type: 'boolean' },
  { value: 'dateloved',          label: 'Date Loved',           type: 'date'    },
  { value: 'rating',             label: 'Rating',               type: 'number'  },
  { value: 'averagerating',      label: 'Average Rating',       type: 'number'  },
  { value: 'playcount',          label: 'Play Count',           type: 'number'  },
  { value: 'lastplayed',         label: 'Last Played',          type: 'date'    },
  { value: 'dateadded',          label: 'Date Added',           type: 'date'    },
  { value: 'datemodified',       label: 'Date Modified',        type: 'date'    },
  // ── Album ────────────────────────────────────────────────────────────────
  { value: 'albumtype',          label: 'Album Type',           type: 'string'  },
  { value: 'albumcomment',       label: 'Album Comment',        type: 'string'  },
  { value: 'albumrating',        label: 'Album Rating',         type: 'number'  },
  { value: 'albumloved',         label: 'Album Loved',          type: 'boolean' },
  { value: 'albumplaycount',     label: 'Album Play Count',     type: 'number'  },
  { value: 'albumlastplayed',    label: 'Album Last Played',    type: 'date'    },
  { value: 'albumdateloved',     label: 'Album Date Loved',     type: 'date'    },
  { value: 'albumdaterated',     label: 'Album Date Rated',     type: 'date'    },
  // ── Artist ───────────────────────────────────────────────────────────────
  { value: 'artistrating',       label: 'Artist Rating',        type: 'number'  },
  { value: 'artistloved',        label: 'Artist Loved',         type: 'boolean' },
  { value: 'artistplaycount',    label: 'Artist Play Count',    type: 'number'  },
  // ── MusicBrainz ──────────────────────────────────────────────────────────
  { value: 'mbz_album_id',          label: 'MBZ Album ID',          type: 'string'  },
  { value: 'mbz_album_artist_id',   label: 'MBZ Album Artist ID',   type: 'string'  },
  { value: 'mbz_artist_id',         label: 'MBZ Artist ID',         type: 'string'  },
  { value: 'mbz_recording_id',      label: 'MBZ Recording ID',      type: 'string'  },
  { value: 'mbz_release_track_id',  label: 'MBZ Release Track ID',  type: 'string'  },
  { value: 'mbz_release_group_id',  label: 'MBZ Release Group ID',  type: 'string'  },
  // ── Library ──────────────────────────────────────────────────────────────
  { value: 'library_id',         label: 'Library ID',           type: 'number'  },
  // ── Playlist ──────────────────────────────────────────────────────────────
  { value: 'playlist',           label: 'Playlist',             type: 'playlist' },
];

const OPERATORS_BY_TYPE = {
  string:   ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith'],
  number:   ['is', 'isNot', 'gt', 'lt', 'inTheRange'],
  date:     ['before', 'after', 'inTheLast', 'notInTheLast'],
  boolean:  ['is'],
  playlist: ['inPlaylist', 'notInPlaylist'],
};

const OPERATOR_LABELS = {
  is: 'is', isNot: 'is not', gt: 'greater than', lt: 'less than',
  contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with', endsWith: 'ends with',
  inTheRange: 'in range', before: 'before', after: 'after',
  inTheLast: 'in the last', notInTheLast: 'not in the last',
  inPlaylist: 'in playlist', notInPlaylist: 'not in playlist',
};

// GET /nsp/api/fields
router.get('/api/fields', (req, res) => {
  res.json({ ok: true, fields: NSP_FIELDS, operatorsByType: OPERATORS_BY_TYPE, operatorLabels: OPERATOR_LABELS });
});

// GET /nsp/api/list
router.get('/api/list', (req, res) => {
  const nspPath = getNspPath();
  if (!nspPath) return res.json({ ok: true, playlists: [] });
  res.json({ ok: true, playlists: listNspFiles(nspPath) });
});

// GET /nsp/api/:slug
router.get('/api/:slug', (req, res) => {
  const nspPath = getNspPath();
  if (!nspPath) return res.json({ ok: false, error: 'NSP path not configured' });
  const entry = listNspFiles(nspPath).find(f => f.slug === req.params.slug);
  if (!entry) return res.json({ ok: false, error: 'Not found' });
  res.json({ ok: true, name: entry.name, slug: entry.slug, config: entry.config });
});

// POST /nsp/save
router.post('/save', (req, res) => {
  const { name, config, existingSlug } = req.body;
  if (!name?.trim()) return res.json({ ok: false, error: 'name required' });
  if (!config)       return res.json({ ok: false, error: 'config required' });

  const nspPath = getNspPath();
  if (!nspPath) return res.json({ ok: false, error: 'NSP output path not configured — set it in Settings' });

  try { fs.mkdirSync(nspPath, { recursive: true }); } catch (e) {
    return res.json({ ok: false, error: `Cannot create NSP directory: ${e.message}` });
  }

  const slug      = slugify(name.trim());
  const nspConfig = { ...config, name: name.trim() };
  const filePath  = path.join(nspPath, `${slug}.nsp`);

  if (existingSlug && existingSlug !== slug) {
    try { fs.unlinkSync(path.join(nspPath, `${existingSlug}.nsp`)); } catch (e) {}
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(nspConfig, null, 2), 'utf8');
  } catch (e) {
    return res.json({ ok: false, error: `Failed to write .nsp file: ${e.message}` });
  }

  logger.info('nsp', `saved "${name.trim()}" → ${filePath}`);
  res.json({ ok: true, slug, filePath });
});

// POST /nsp/:slug/delete
router.post('/:slug/delete', async (req, res) => {
  const nspPath = getNspPath();
  if (!nspPath) return res.json({ ok: false, error: 'NSP path not configured' });

  const filePath = path.join(nspPath, `${req.params.slug}.nsp`);

  // Read the name from the file before deleting
  let playlistName = null;
  try {
    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    playlistName = config.name || null;
  } catch (e) {}

  try {
    fs.unlinkSync(filePath);
    logger.info('nsp', `deleted ${filePath}`);
  } catch (e) {
    return res.json({ ok: false, error: `Could not delete file: ${e.message}` });
  }

  // Delete matching ND playlist by name (sync — wait before responding)
  if (playlistName) {
    try {
      const navidrome = require('../providers/navidrome');
      const playlists = await navidrome.getPlaylists(db);
      const match     = playlists.find(p => p.name === playlistName);
      if (match) {
        await navidrome.deletePlaylist(db, match.id);
        logger.info('nsp', `deleted ND playlist "${playlistName}" (${match.id})`);
      }
    } catch (e) {
      logger.warn('nsp', `ND delete failed for "${playlistName}": ${e.message}`);
    }
  }

  res.json({ ok: true });
});

module.exports        = router;
module.exports.listNspFiles = listNspFiles;
module.exports.getNspPath   = getNspPath;
