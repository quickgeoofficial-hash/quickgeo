/**
 * Quickgeo Backend Server v2
 * Runs on Android via Termux
 * Node.js + Express + JSON storage + Session auth
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const crypto  = require('crypto');

const app = express();

/* ── CONFIG ── */
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  adminUsername : 'quickgeo_admin',
  adminPassword : 'Change_Me_Now@2025!',
  port          : 3000,
  maxBodyMB     : 50,
  sessionHours  : 24
};

if (fs.existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { console.warn('⚠ Bad config.json — using defaults.'); }
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('📝 Created config.json — CHANGE YOUR PASSWORD!');
}

/* ── DATA ── */
const DATA_DIR = path.join(__dirname, 'data');
const POSTS_F  = path.join(DATA_DIR, 'posts.json');
const CATS_F   = path.join(DATA_DIR, 'categories.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_CATS = [
  {emoji:'🔴',name:'Breaking'},{emoji:'🗺',name:'Maps'},{emoji:'🛰',name:'Satellite'},
  {emoji:'🌐',name:'OSM'},{emoji:'📊',name:'Data'},{emoji:'✨',name:'Feature'},{emoji:'🔄',name:'Update'}
];

function readJSON(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : (writeJSON(file,fallback),fallback); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Write error:', e.message); }
}
const getPosts   = () => readJSON(POSTS_F, []);
const savePosts  = d  => writeJSON(POSTS_F, d);
const getCats    = () => readJSON(CATS_F, DEFAULT_CATS);
const saveCats   = d  => writeJSON(CATS_F, d);

/* ── SESSION STORE (in-memory, survives as long as server runs) ── */
const sessions = {};  // token → expiry timestamp

function createSession() {
  const token  = crypto.randomBytes(32).toString('hex');
  const expiry = Date.now() + config.sessionHours * 60 * 60 * 1000;
  sessions[token] = expiry;
  // Clean old sessions
  for (const t in sessions) { if (sessions[t] < Date.now()) delete sessions[t]; }
  return token;
}

function isValidSession(token) {
  if (!token || !sessions[token]) return false;
  if (sessions[token] < Date.now()) { delete sessions[token]; return false; }
  return true;
}

/* ── MIDDLEWARE ── */
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: `${config.maxBodyMB}mb` }));

app.use((req, _, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
  next();
});

/* ── AUTH MIDDLEWARE ── */
function adminOnly(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
  next();
}

/* ── ROUTES ── */

// Health check (public)
app.get('/health', (req, res) => res.json({
  status: 'ok', server: 'Quickgeo', version: '2.0.0',
  time: new Date().toISOString(), posts: getPosts().length
}));

// LOGIN — returns a session token
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.adminUsername && password === config.adminPassword) {
    const token = createSession();
    return res.json({ token, expiresIn: `${config.sessionHours}h` });
  }
  // Delay response to slow brute force
  setTimeout(() => res.status(401).json({ error: 'Invalid username or password.' }), 1200);
});

// LOGOUT
app.post('/api/logout', (req, res) => {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  delete sessions[token];
  res.json({ ok: true });
});

// Verify session (used by admin panel on load)
app.get('/api/me', adminOnly, (req, res) => res.json({ ok: true, role: 'admin' }));

/* ── POSTS ── */

// GET all posts (public)
app.get('/api/posts', (req, res) => {
  const posts = getPosts().map(({ reactUsers, ...p }) => p); // strip internal field
  res.json(posts);
});

// CREATE post (admin only)
app.post('/api/posts', adminOnly, (req, res) => {
  const { tag, tagEmoji, text, media } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag is required' });
  const now  = new Date();
  const post = {
    id: Date.now(), tag, tagEmoji: tagEmoji||'',
    text: text||'', media: Array.isArray(media)?media:[],
    reactions: {}, reactUsers: {}, pinned: false,
    time: now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
    date: now.toLocaleDateString(), createdAt: now.toISOString()
  };
  const posts = getPosts();
  posts.unshift(post);
  savePosts(posts);
  const { reactUsers, ...safe } = post;
  res.status(201).json(safe);
});

// DELETE post (admin only)
app.delete('/api/posts/:id', adminOnly, (req, res) => {
  const id    = Number(req.params.id);
  const posts = getPosts();
  const idx   = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Post not found' });
  posts.splice(idx, 1);
  savePosts(posts);
  res.json({ ok: true });
});

// PIN/UNPIN post (admin only)
app.patch('/api/posts/:id/pin', adminOnly, (req, res) => {
  const posts = getPosts();
  const p     = posts.find(p => p.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found' });
  p.pinned = !p.pinned;
  savePosts(posts);
  res.json({ ok: true, pinned: p.pinned });
});

// REACT to post (public — per userId)
app.post('/api/posts/:id/react', (req, res) => {
  const { emoji, userId } = req.body||{};
  if (!emoji||!userId) return res.status(400).json({ error: 'emoji and userId required' });
  const posts = getPosts();
  const p     = posts.find(p => p.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found' });
  if (!p.reactions)  p.reactions  = {};
  if (!p.reactUsers) p.reactUsers = {};
  const key = `${userId}_${emoji}`;
  let nowReacted;
  if (p.reactUsers[key]) {
    p.reactions[emoji] = Math.max(0,(p.reactions[emoji]||1)-1);
    if (!p.reactions[emoji]) delete p.reactions[emoji];
    delete p.reactUsers[key];
    nowReacted = false;
  } else {
    p.reactions[emoji] = (p.reactions[emoji]||0)+1;
    p.reactUsers[key]  = true;
    nowReacted = true;
  }
  savePosts(posts);
  res.json({ reactions: p.reactions, reacted: nowReacted });
});

/* ── CATEGORIES ── */
app.get('/api/categories', (_, res) => res.json(getCats()));

app.post('/api/categories', adminOnly, (req, res) => {
  const { emoji, name } = req.body||{};
  if (!name) return res.status(400).json({ error: 'name required' });
  const cats = getCats();
  if (cats.some(c => c.name.toLowerCase()===name.toLowerCase()))
    return res.status(409).json({ error: 'Category already exists' });
  cats.push({ emoji: emoji||'📌', name });
  saveCats(cats);
  res.status(201).json({ ok: true });
});

app.delete('/api/categories/:name', adminOnly, (req, res) => {
  let cats = getCats();
  const before = cats.length;
  cats = cats.filter(c => c.name !== decodeURIComponent(req.params.name));
  if (cats.length===before) return res.status(404).json({ error: 'Category not found' });
  saveCats(cats);
  res.json({ ok: true });
});

/* ── START ── */
app.listen(config.port, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════╗');
  console.log('║    Quickgeo Server v2 Running    ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`\n✅  Port     → ${config.port}`);
  console.log(`👤  Username → ${config.adminUsername}`);
  console.log(`🔑  Password → ${config.adminPassword}`);
  console.log('\n⚠   Change password in config.json if still default!\n');
});
