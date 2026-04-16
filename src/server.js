require('dotenv').config();
const express = require('express');
const path = require('path');
const logger = require('./utils/logger');
// Initialise DB at startup
require('./db/index');

const app = express();
const PORT = process.env.PORT || 3000;

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP request logging
const LOG_SKIP = ['/logs/api/tail', '/logs/api/level'];
app.use((req, res, next) => {
  res.on('finish', () => {
    if (!LOG_SKIP.some(p => req.url.startsWith(p))) {
      if (res.statusCode === 304) {
        logger.debug('http', `${req.method} ${req.url} ${res.statusCode}`);
      } else {
        logger.info('http', `${req.method} ${req.url} ${res.statusCode}`);
      }
    }
  });
  next();
});

// Routes
app.get('/', (req, res) => res.redirect('/playlists'));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/api/version', (req, res) => {
  const { version } = require('../package.json');
  res.json({ version });
});
app.use('/playlists', require('./lib/playlists'));
app.use('/library', require('./lib/library'));
app.use('/settings', require('./lib/settings'));
app.use('/nsp', require('./lib/nsp'));
const syncModule = require('./lib/sync');
app.use('/sync', syncModule.router);
syncModule.startAutoRefresh();
app.use('/status', require('./lib/status'));
app.use('/logs',   require('./lib/logs'));

// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// 500
app.use((err, req, res, next) => {
  logger.error('server', err.message, { stack: err.stack });
  res.status(500).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

app.listen(PORT, () => {
  logger.info('server', `naviList running on http://localhost:${PORT}`);
});
