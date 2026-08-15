/**
 * Quickgeo Backend Server v2.2
 * Runs on Android via Termux
 * Node.js + Express + JSON storage + Session auth + File uploads
 */
'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const crypto  = require('crypto');
const multer  = require('multer');

const app = express();

/* ── CONFIG ── */
const CONFIG_FILE = path.join(__dirname, 'config.json');
const INSECURE_DEFAULTS = ['Change_Me_Now@2025!', 'quickgeo_admin_2025', 'password', '123456'];

let config = {
  adminUsername : 'quickgeo_admin',
  adminPassword : '',
  allowedOrigins: [
    'https://quickgeo.live',
    'https://www.quickgeo.live',
    'http://localhost:3000',
    'http://localhost:5500'
  ],
  port         : 3000,
  maxBodyMB    : 10,
  sessionHours : 24
};

if (fs.existsSync(CONFIG_FILE)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { console.warn('⚠  Bad config.json'); process.exit(1); }
} else {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.error('\n❌  Set adminUsername + adminPassword in config.json then restart.\n');
  process.exit(1);
}

if (!config.adminPassword || INSECURE_DEFAULTS.includes(config.adminPassword)) {
  console.error('\n❌  Insecure or missing password in config.json. Please set a strong password.\n');
  process.exit(1);
}
if (!config.adminUsername) {
  console.error('❌  adminUsername is blank in config.json.\n');
  process.exit(1);
}

/* ── DATA + UPLOADS DIRS ── */
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const POSTS_F     = path.join(DATA_DIR, 'posts.json');
const CATS_F      = path.join(DATA_DIR, 'categories.json');

[DATA_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

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
const getPosts  = () => readJSON(POSTS_F, []);
const savePosts = d  => writeJSON(POSTS_F, d);
const getCats   = () => readJSON(CATS_F, DEFAULT_CATS);
const saveCats  = d  => writeJSON(CATS_F, d);

/* ── MULTER: save files to disk ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB max per file
  fileFilter(req, file, cb) {
    const allowed = /image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime)/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

/* ── SESSION STORE ── */
const sessions = {};
function createSession() {
  const token  = crypto.randomBytes(32).toString('hex');
  sessions[token] = Date.now() + config.sessionHours * 3600000;
  for (const t in sessions) { if (sessions[t] < Date.now()) delete sessions[t]; }
  return token;
}
function isValidSession(token) {
  if (!token || !sessions[token]) return false;
  if (sessions[token] < Date.now()) { delete sessions[token]; return false; }
  return true;
}

/* ── CORS ── */
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (config.allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true
}));

app.use(express.json({ limit: `${config.maxBodyMB}mb` }));
app.use((req, _, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
  next();
});

/* ── SERVE UPLOADED FILES ── */
app.use('/uploads', express.static(UPLOADS_DIR));

/* ── AUTH ── */
function adminOnly(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!isValidSession(token)) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  next();
}

/* ════════════════════════
   ROUTES
════════════════════════ */

app.get('/health', (req, res) => res.json({
  status: 'ok', server: 'Quickgeo', version: '2.2.0',
  time: new Date().toISOString(), posts: getPosts().length
}));

/* ── FILE UPLOAD ── */
app.post('/api/upload', adminOnly, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  // Build the public URL for this file
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host     = req.headers['x-forwarded-host'] || req.get('host');
  const url      = `${protocol}://${host}/uploads/${req.file.filename}`;
  console.log(`[UPLOAD] Saved: ${req.file.filename} (${(req.file.size/1024/1024).toFixed(2)} MB)`);
  res.json({
    url,
    filename : req.file.filename,
    size     : req.file.size,
    type     : req.file.mimetype
  });
});

/* Delete uploaded file when post is deleted */
function deleteUploadedFiles(media = []) {
  media.forEach(m => {
    if (!m.url || m.url.startsWith('data:')) return; // skip base64
    try {
      const filename = m.url.split('/uploads/').pop();
      if (!filename) return;
      const filePath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch(e) { console.warn('Could not delete file:', e.message); }
  });
}

/* ── LOGIN / AUTH ── */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.adminUsername && password === config.adminPassword) {
    const token = createSession();
    console.log(`[AUTH] Login OK: ${username}`);
    return res.json({ token, expiresIn: `${config.sessionHours}h` });
  }
  console.log(`[AUTH] Failed login: ${username || '(blank)'}`);
  setTimeout(() => res.status(401).json({ error: 'Invalid username or password.' }), 1200);
});

app.post('/api/logout', (req, res) => {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  delete sessions[token];
  res.json({ ok: true });
});

app.get('/api/me', adminOnly, (req, res) => res.json({ ok: true, role: 'admin' }));

/* ── POSTS ── */
app.get('/api/posts', (req, res) => {
  const posts = getPosts().map(({ reactUsers, ...p }) => p);
  res.json(posts);
});

app.post('/api/posts', adminOnly, (req, res) => {
  const { tag, tagEmoji, text, media } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag is required' });
  const now  = new Date();
  const post = {
    id: Date.now(), tag, tagEmoji: tagEmoji||'',
    text: text||'',
    media: Array.isArray(media) ? media : [],
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

app.delete('/api/posts/:id', adminOnly, (req, res) => {
  const id    = Number(req.params.id);
  const posts = getPosts();
  const idx   = posts.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Post not found' });
  // Delete associated uploaded files from disk
  deleteUploadedFiles(posts[idx].media);
  posts.splice(idx, 1);
  savePosts(posts);
  res.json({ ok: true });
});

app.patch('/api/posts/:id/pin', adminOnly, (req, res) => {
  const posts = getPosts();
  const p     = posts.find(p => p.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Post not found' });
  p.pinned = !p.pinned;
  savePosts(posts);
  res.json({ ok: true, pinned: p.pinned });
});

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
    delete p.reactUsers[key]; nowReacted = false;
  } else {
    p.reactions[emoji] = (p.reactions[emoji]||0)+1;
    p.reactUsers[key]  = true; nowReacted = true;
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
  console.log('║   Quickgeo Server v2.2 Running   ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`\n✅  Port      → ${config.port}`);
  console.log(`👤  Username  → ${config.adminUsername}`);
  console.log(`🔒  Password  → *** (set in config.json)`);
  console.log(`📁  Uploads   → ${UPLOADS_DIR}`);
  console.log(`🌐  Origins   → ${config.allowedOrigins.join(', ')}\n`);
});
