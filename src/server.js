const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const globalConfig = require('./globalConfig');
const db = require('./db');
const registry = require('./projectRegistry');
const sessionStore = require('./sessionStore');
const adminRoutes = require('./routes/admin');
const publicApiRoutes = require('./routes/publicApi');

const app = express();
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json());

// Admin API (protected, except /login) — lives under /api/admin so it can
// never collide with a project slug at /api/:slug/...
app.use('/api/admin', adminRoutes);

// Public per-project recommendation API.
app.use('/api', publicApiRoutes);

// Admin dashboard (static SPA) — registered BEFORE the generic static
// middleware below, otherwise express.static would treat "/admin" as a
// directory request and issue a 301 redirect instead of serving the page.
app.get(['/admin', '/admin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// Per-project chat test UI. Slug is read client-side from the URL path.
app.get('/chat/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'chat', 'index.html'));
});

app.get('/', (req, res) => res.redirect('/admin'));

// Fallback static file serving (for any future assets dropped in public/).
app.use(express.static(path.join(__dirname, '..', 'public')));

async function start() {
  try {
    await db.runMigrations();
    await registry.loadAllProjects();
  } catch (err) {
    console.error('FATAL: could not initialize database / load projects.');
    console.error(err.message);
    console.error('Check DATABASE_URL and that the database is reachable.');
    process.exit(1);
  }

  app.listen(globalConfig.port, () => {
    console.log(`Product recommender platform listening on port ${globalConfig.port}`);
    console.log(`Admin dashboard: /admin`);
    registry.startAutoRefresh();
    sessionStore.startSweeper();
  });
}

start();
