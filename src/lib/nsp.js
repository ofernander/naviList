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
  { value: 'title',           label: 'Title',              type: 'string'  },
  { value: 'album',           label: 'Album',              type: 'string'  },
  { value: 'artist',          label: 'Artist',             type: 'string'  },
  { value: 'albumartist',     label: 'Album Artist',       type: 'string'  },
  { value: 'genre',           label: 'Genre',              type: 'string'  },
  { value: 'year',            label: 'Year',               type: 'number'  },
  { value: 'playcount',       label: 'Play Count',         type: 'number'  },
  { value: 'lastplayed',      label: 'Last Played',        type: 'date'    },
  { value: 'loved',           label: 'Loved',              type: 'boolean' },
  { value: 'dateloved',       label: 'Date Loved',         type: 'date'    },
  { value: 'rating',          label: 'Rating',             type: 'number'  },
  { value: 'dateadded',       label: 'Date Added',         type: 'date'    },
  { value: 'duration',        label: 'Duration (seconds)', type: 'number'  },
  { value: 'bpm',             label: 'BPM',                type: 'number'  },
  { value: 'bitrate',         label: 'Bitrate',            type: 'number'  },
  { value: 'compilation',     label: 'Compilation',        type: 'boolean' },
  { value: 'tracknumber',     label: 'Track Number',       type: 'number'  },
  { value: 'albumrating',     label: 'Album Rating',       type: 'number'  },
  { value: 'albumplaycount',  label: 'Album Play Count',   type: 'number'  },
  { value: 'artistplaycount', label: 'Artist Play Count',  type: 'number'  },
  { value: 'artistloved',     label: 'Artist Loved',       type: 'boolean' },
  { value: 'filepath',        label: 'File Path',          type: 'string'  },
  { value: 'filetype',        label: 'File Type',          type: 'string'  },
];

const OPERATORS_BY_TYPE = {
  string:  ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith'],
  number:  ['is', 'isNot', 'gt', 'lt', 'inTheRange'],
  date:    ['before', 'after', 'inTheLast', 'notInTheLast'],
  boolean: ['is'],
};

const OPERATOR_LABELS = {
  is: 'is', isNot: 'is not', gt: 'greater than', lt: 'less than',
  contains: 'contains', notContains: 'does not contain',
  startsWith: 'starts with', endsWith: 'ends with',
  inTheRange: 'in range', before: 'before', after: 'after',
  inTheLast: 'in the last', notInTheLast: 'not in the last',
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
