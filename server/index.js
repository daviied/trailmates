'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { parseGpx } = require('./gpx');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_UA = process.env.TILE_USER_AGENT || 'TrailMates/1.0 (self-hosted hiking app)';
const LOCATION_MAX_AGE_MIN = Number(process.env.LOCATION_MAX_AGE_MIN || 60);

fs.mkdirSync(path.join(DATA_DIR, 'tiles'), { recursive: true });
const db = new Database(path.join(DATA_DIR, 'trailmates.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, pass TEXT, is_admin INTEGER DEFAULT 0, color TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS trails (id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, created INTEGER, distance REAL, gain REAL, loss REAL, points TEXT);
CREATE TABLE IF NOT EXISTS locations (user_id INTEGER PRIMARY KEY, lat REAL, lon REAL, acc REAL, ts INTEGER, trail_id INTEGER, hiking INTEGER);
`);

const COLORS = ['#d7263d', '#1b998b', '#3a86ff', '#ff8c00', '#8338ec', '#2b9348', '#c9184a', '#0077b6'];
function createUser(username, password, isAdmin) {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  return db.prepare('INSERT INTO users (username, pass, is_admin, color) VALUES (?,?,?,?)')
    .run(username.trim(), bcrypt.hashSync(password, 10), isAdmin ? 1 : 0, COLORS[n % COLORS.length]);
}
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const u = process.env.ADMIN_USERNAME || 'admin';
  let p = process.env.ADMIN_PASSWORD;
  if (!p) { p = crypto.randomBytes(6).toString('hex'); console.log(`Created admin user "${u}" with password: ${p}`); }
  createUser(u, p, true);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
// Token auth (no cookies), so open CORS is safe and lets the Android app talk to the server.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function userFromToken(token) {
  if (!token) return null;
  return db.prepare('SELECT u.id, u.username, u.is_admin, u.color FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token) || null;
}
function auth(req, res, next) {
  const h = req.get('Authorization') || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : req.query.t);
  if (!user) return res.status(401).json({ error: 'Please log in again' });
  req.user = user; next();
}
function admin(req, res, next) { if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' }); next(); }
const pub = u => ({ id: u.id, username: u.username, isAdmin: !!u.is_admin, color: u.color });

// --- Auth ---
const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip; const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
  const { username = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!u || !bcrypt.compareSync(String(password), u.pass)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: 'Wrong name or password' });
  }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, u.id, Date.now());
  res.json({ token, user: pub(u) });
});
app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run((req.get('Authorization') || '').slice(7));
  db.prepare('DELETE FROM locations WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));
app.put('/api/me/password', auth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
  res.json({ ok: true });
});

// --- Users (admin) ---
app.get('/api/users', auth, admin, (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY username').all().map(pub)));
app.post('/api/users', auth, admin, (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password || password.length < 4) return res.status(400).json({ error: 'Name and a password (4+ characters) are needed' });
  try { createUser(username, password, isAdmin); } catch { return res.status(400).json({ error: 'That name is already used' }); }
  res.json({ ok: true });
});
app.delete('/api/users/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  for (const t of ['sessions', 'locations']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Trails ---
app.get('/api/trails', auth, (req, res) => {
  res.json(db.prepare('SELECT t.id, t.name, t.distance, t.gain, t.loss, t.created, t.owner_id ownerId, u.username owner FROM trails t LEFT JOIN users u ON u.id = t.owner_id ORDER BY t.name COLLATE NOCASE').all());
});
app.get('/api/trails/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM trails WHERE id = ?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Trail not found' });
  res.json({ id: t.id, name: t.name, distance: t.distance, gain: t.gain, loss: t.loss, points: JSON.parse(t.points) });
});
app.post('/api/trails', auth, (req, res) => {
  const { gpx, name } = req.body || {};
  let parsed;
  try { parsed = parseGpx(String(gpx || '')); } catch (e) { return res.status(400).json({ error: e.message }); }
  const r = db.prepare('INSERT INTO trails (name, owner_id, created, distance, gain, loss, points) VALUES (?,?,?,?,?,?,?)')
    .run((name || parsed.name || 'My Trail').slice(0, 120), req.user.id, Date.now(), parsed.distance, parsed.gain, parsed.loss, JSON.stringify(parsed.points));
  res.json({ id: r.lastInsertRowid });
});
app.delete('/api/trails/:id', auth, (req, res) => {
  const t = db.prepare('SELECT owner_id FROM trails WHERE id = ?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Trail not found' });
  if (t.owner_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Only the person who added it can delete it' });
  db.prepare('DELETE FROM trails WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// --- Live locations ---
app.post('/api/location', auth, (req, res) => {
  const { lat, lon, acc, trailId, hiking } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Bad location' });
  db.prepare('INSERT OR REPLACE INTO locations VALUES (?,?,?,?,?,?,?)')
    .run(req.user.id, lat, lon, Number(acc) || null, Date.now(), trailId || null, hiking ? 1 : 0);
  res.json({ ok: true });
});
app.get('/api/locations', auth, (req, res) => {
  const since = Date.now() - LOCATION_MAX_AGE_MIN * 60e3;
  res.json(db.prepare(`SELECT u.id, u.username, u.color, l.lat, l.lon, l.acc, l.ts, l.trail_id trailId, l.hiking
    FROM locations l JOIN users u ON u.id = l.user_id WHERE l.ts > ? AND l.user_id != ?`).all(since, req.user.id));
});

// --- Map tiles: proxy + disk cache so each tile is fetched from the provider only once ---
const inflight = new Map();
app.get('/tiles/:z/:x/:y.png', auth, async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 17 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return res.sendStatus(400);
  const file = path.join(DATA_DIR, 'tiles', String(z), String(x), `${y}.png`);
  res.set('Cache-Control', 'public, max-age=2592000');
  if (fs.existsSync(file)) return res.type('png').sendFile(file);
  try {
    const key = `${z}/${x}/${y}`;
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
        const r = await fetch(url, { headers: { 'User-Agent': TILE_UA } });
        if (!r.ok) throw new Error('tile ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        return buf;
      })().finally(() => inflight.delete(key)));
    }
    res.type('png').send(await inflight.get(key));
  } catch { res.sendStatus(502); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (/sw\.js$|index\.html$/.test(p)) res.set('Cache-Control', 'no-cache'); }
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.listen(PORT, () => console.log(`TrailMates running on port ${PORT}`));
