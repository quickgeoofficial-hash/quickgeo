/**
 * Quickgeo Backend Server
 * Runs on your Android phone via Termux
 * Node.js + Express + JSON file storage
 */

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');

const app = express();

/* ── CONFIG ── */
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  adminPassword : 'quickgeo_admin_2025',
  port          : 3000,
  maxBodyMB     : 50
};

// Load or create config.json
if (fs.existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch (e) { console.warn('⚠ Could not read config.json, using defaults.'); }
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('📝 Created config.json — you can change your admin password there.');
}

/* ── DATA PATHS ── */
const DATA_DIR  = path.join(__dirname, 'data');
const POSTS_F   = path.join(DATA_DIR, 'posts.json');
const CATS_F    = path.join(DATA_DIR, 'categories.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_CATS = [
  { emoji: '🔴', name: 'Breaking'  },
  { emoji: '🗺',  name: 'Maps'      },
  { emoji: '🛰',  name: 'Satellite' },
  { emoji: '🌐', name: 'OSM'       },
  { emoji: '📊', name: 'Data'      },
  { emoji: '✨', name: 'Feature'   },
  { emoji: '🔄', name: 'Update'    }
];

/* ── FILE HELPERS ── */
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) { writeJSON(file, fallback); return fallback; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('Read error:', file, e.message); return fallback; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Write error:', file, e.message); }
}

function getPosts()      { return readJSON(POSTS_F, []); }
function savePosts(d)    { writeJSON(POSTS_F, d); }
function getCats()       { return readJSON(CATS_F, DEFAULT_CATS); }
function saveCats(d)     { writeJSON(CATS_F, d); }

/* ── MIDDLEWARE ── */
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: `${config.maxBodyMB}mb` }));
app.use((req, _, next) => {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

/* ── AUTH MIDDLEWARE ── */
function adminOnly(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== config.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized — wrong admin password.' });
  }
  next();
}

/* ── HEALTH CHECK ── */
app.get('/health', (req, res) => {
  res.json({
    status  : 'ok',
    server  : 'Quickgeo',
    time    : new Date().toISOString(),
    posts   : getPosts().length,
    version : '1.0.0'
  });
});

/* ── POSTS ── */

// GET all posts
app.get('/api/posts', (req, res) => {
  const posts = getPosts();
  res.json(posts);
});

// POST create post (admin only)
app.post('/api/posts', adminOnly, (req, res) => {
  const { tag, tagEmoji, text, media } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag is required' });

  const now  = new Date();
  const post = {
    id       : Date.now(),
    tag,
    tagEmoji : tagEmoji || '',
    text     : text || '',
    media    : Array.isArray(media) ? media : [],
    reactions: {},
    reactUsers: {},          // tracks userId_emoji to prevent double-react
    pinned   : false,
    time     : now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date     : now.toLocaleDateString(),
    createdAt: now.toISOString()
  };

  const posts = getPosts();
  posts.unshift(post);
  savePosts(posts);

  // Don't send reactUsers back to client
  const { reactUsers, ...safe } = post;
  res.status(201).json(safe);
});

// DELETE post (admin only)
app.delete('/api/posts/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const posts = getPosts();
  const idx = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Post not found' });
  posts.splice(idx, 1);
  savePosts(posts);
  res.json({ ok: true });
});

// PATCH toggle pin (admin only)
app.patch('/api/posts/:id/pin', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const posts = getPosts();
  const p = posts.find(p => p.id === id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  p.pinned = !p.pinned;
  savePosts(posts);
  res.json({ ok: true, pinned: p.pinned });
});

// POST react to a post (public — identified by userId)
app.post('/api/posts/:id/react', (req, res) => {
  const id = Number(req.params.id);
  const { emoji, userId } = req.body;
  if (!emoji || !userId) return res.status(400).json({ error: 'emoji and userId required' });

  const posts = getPosts();
  const p = posts.find(p => p.id === id);
  if (!p) return res.status(404).json({ error: 'Post not found' });

  if (!p.reactions)  p.reactions  = {};
  if (!p.reactUsers) p.reactUsers = {};

  const key = `${userId}_${emoji}`;
  if (p.reactUsers[key]) {
    // Un-react
    p.reactions[emoji] = Math.max(0, (p.reactions[emoji] || 1) - 1);
    if (!p.reactions[emoji]) delete p.reactions[emoji];
    delete p.reactUsers[key];
  } else {
    // React
    p.reactions[emoji] = (p.reactions[emoji] || 0) + 1;
    p.reactUsers[key]  = true;
  }
  savePosts(posts);
  res.json({ reactions: p.reactions, reacted: !p.reactUsers[key] });
});

/* ── CATEGORIES ── */

// GET all categories
app.get('/api/categories', (req, res) => res.json(getCats()));

// POST add category (admin only)
app.post('/api/categories', adminOnly, (req, res) => {
  const { emoji, name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const cats = getCats();
  if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Category already exists' });
  }
  cats.push({ emoji: emoji || '📌', name });
  saveCats(cats);
  res.status(201).json({ ok: true });
});

// DELETE category (admin only)
app.delete('/api/categories/:name', adminOnly, (req, res) => {
  let cats = getCats();
  const before = cats.length;
  cats = cats.filter(c => c.name !== req.params.name);
  if (cats.length === before) return res.status(404).json({ error: 'Category not found' });
  saveCats(cats);
  res.json({ ok: true });
});

/* ── START ── */
app.listen(config.port, '0.0.0.0', () => {
  console.log('\n╔═════════════════════════════════╗');
  console.log('║     Quickgeo Server Running     ║');
  console.log('╚═════════════════════════════════╝');
  console.log(`\n✅  Local URL  → http://localhost:${config.port}`);
  console.log(`🔑  Admin pass → ${config.adminPassword}`);
  console.log('\n👉  Now open a NEW Termux session (swipe right from left edge)');
  console.log('    and run:  cloudflared tunnel --url http://localhost:' + config.port);
  console.log('\n    Copy the https://....trycloudflare.com URL and paste it');
  console.log('    into both your admin.html and index.html setup screens.\n');
});
