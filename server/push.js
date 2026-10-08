/**
 * Quickgeo — Admin-controlled Web Push notifications
 *
 * NOTHING in here runs automatically when a post is published. A notification is
 * sent only when the admin calls POST /api/posts/:id/notify (the "Notify" button).
 *
 * Public  : GET  /api/push/key            → VAPID public key (browser needs it to subscribe)
 *           POST /api/push/subscribe      → store a browser's push subscription
 *           POST /api/push/unsubscribe    → remove it
 * Admin   : GET  /api/push/stats          → { enabled, subscribers }
 *           POST /api/posts/:id/notify    → send ONE notification for that post (once only)
 *
 * Duplicate protection is enforced HERE on the server, not just in the UI:
 * the post row is claimed with `UPDATE … WHERE notifiedAt IS NULL`, which is atomic,
 * so double-clicks, two admin tabs, or two devices can never send the same post twice.
 *
 * If the `web-push` package is not installed, push is simply disabled and the rest of
 * the server keeps working exactly as before.
 */
'use strict';
const fs = require('fs'), path = require('path');

let webpush = null;
try { webpush = require('web-push'); } catch { /* not installed → push disabled, nothing else affected */ }

/* Subscriber-supplied endpoint URLs are fetched BY THIS SERVER when sending, so only real
   browser push services are accepted — otherwise anyone could make the server POST to an
   arbitrary/internal address (SSRF). Suffix match: "x.notify.windows.com" etc. */
const PUSH_HOSTS = [
  'fcm.googleapis.com',          // Chrome, Edge, Brave, Opera, Samsung Internet (Android + desktop)
  'android.googleapis.com',
  'push.services.mozilla.com',   // Firefox (updates.push.services.mozilla.com)
  'push.apple.com',              // Safari / iOS home-screen apps (web.push.apple.com)
  'notify.windows.com',          // Edge via WNS
];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_SUBSCRIBERS = 200000;   // hard cap so the public subscribe route can't grow the DB forever
const SEND_BATCH = 50;            // parallel sends per batch

function isAllowedEndpoint(ep) {
  if (typeof ep !== 'string' || ep.length > 2048) return false;
  try {
    const u = new URL(ep);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return PUSH_HOSTS.some(s => h === s || h.endsWith('.' + s));
  } catch { return false; }
}

/* Adds posts.notifiedAt (NULL = not notified yet) and the subscriptions table.
   Safe to run on every start; existing data is untouched. */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions(
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    createdAt TEXT NOT NULL, lastSeenAt TEXT)`);
  const cols = db.prepare('PRAGMA table_info(posts)').all().map(c => c.name);
  if (!cols.includes('notifiedAt')) db.exec('ALTER TABLE posts ADD COLUMN notifiedAt TEXT DEFAULT NULL');
}

/* VAPID identifies this server to the browser push services. Order: .env → data/vapid.json →
   generate once and save. The key must NEVER change afterwards or existing subscribers stop
   receiving (they're bound to it) — that's why it's persisted next to the database. */
function loadVapid(dataDir) {
  const envPub = (process.env.VAPID_PUBLIC_KEY || '').trim(), envPriv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv, source: '.env' };
  const file = path.join(dataDir, 'vapid.json');
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return { publicKey: k.publicKey, privateKey: k.privateKey, source: 'data/vapid.json' };
  } catch { /* none yet */ }
  const k = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return { ...k, source: 'data/vapid.json (newly generated)' };
}

const truncate = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : s; }; // code-point safe (never splits an emoji)

/* What the user sees. `url` is the same deep link the Share button uses, so clicking opens that exact post. */
function buildPayload(p) {
  let hasMedia = false;
  try { hasMedia = JSON.parse(p.media || '[]').length > 0; } catch {}
  const text = String(p.text || '').replace(/\s+/g, ' ').trim();
  return {
    title: truncate(`Quickgeo · ${p.tagEmoji ? p.tagEmoji + ' ' : ''}${p.tag}`, 60),
    body: text ? truncate(text, 140) : (hasMedia ? 'New photo/video update — tap to view.' : 'New update — tap to read.'),
    postId: p.id,
    url: `/#post-${p.id}`,
  };
}

function init({ app, db, adminOnly, rateLimit, dataDir }) {
  let enabled = false, vapid = null;
  if (!webpush) {
    console.warn('⚠️  Push → DISABLED (run `npm install` to add the web-push package)');
  } else {
    try {
      vapid = loadVapid(dataDir);
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://quickgeo.live', vapid.publicKey, vapid.privateKey);
      enabled = true;
      console.log(`📣  Push       → enabled (VAPID key: ${vapid.source})`);
    } catch (e) { console.warn('⚠️  Push → DISABLED:', e.message); }
  }
  const off = res => res.status(503).json({ error: 'Push notifications are not available on this server.' });
  const subCount = () => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;

  /* ── public: let a browser subscribe / unsubscribe ── */
  app.get('/api/push/key', (req, res) => enabled ? res.json({ publicKey: vapid.publicKey }) : off(res));

  app.post('/api/push/subscribe', rateLimit('push-sub', 60, 10 * 60000), (req, res) => {
    if (!enabled) return off(res);
    const b = req.body || {}, k = b.keys || {};
    if (!isAllowedEndpoint(b.endpoint)) return res.status(400).json({ error: 'Invalid push endpoint' });
    if (![k.p256dh, k.auth].every(v => typeof v === 'string' && v.length >= 8 && v.length <= 200 && B64URL.test(v)))
      return res.status(400).json({ error: 'Invalid subscription keys' });
    const exists = db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint=?').get(b.endpoint);
    if (!exists && subCount() >= MAX_SUBSCRIBERS) return res.status(503).json({ error: 'Subscriber limit reached' });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO push_subscriptions(endpoint,p256dh,auth,createdAt,lastSeenAt) VALUES(?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,lastSeenAt=excluded.lastSeenAt`)
      .run(b.endpoint, k.p256dh, k.auth, now, now);
    res.status(201).json({ ok: true });
  });

  app.post('/api/push/unsubscribe', rateLimit('push-unsub', 60, 10 * 60000), (req, res) => {
    const ep = req.body && req.body.endpoint;
    if (typeof ep !== 'string' || ep.length > 2048) return res.status(400).json({ error: 'endpoint required' });
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(ep);
    res.json({ ok: true });
  });

  /* ── admin only ── */
  app.get('/api/push/stats', adminOnly, (req, res) => res.json({ enabled, subscribers: enabled ? subCount() : 0 }));

  app.post('/api/posts/:id(\\d+)/notify', adminOnly, rateLimit('notify', 30, 10 * 60000), async (req, res) => {
    if (!enabled) return off(res);
    const id = Number(req.params.id);
    const post = db.prepare('SELECT id,tag,tagEmoji,text,media,notifiedAt FROM posts WHERE id=?').get(id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.notifiedAt) return res.status(409).json({ error: 'This post has already been notified.', notifiedAt: post.notifiedAt });

    const subs = db.prepare('SELECT endpoint,p256dh,auth FROM push_subscriptions').all();
    if (!subs.length) return res.json({ ok: true, notified: false, sent: 0, subscribers: 0, message: 'No one has enabled notifications yet — nothing was sent.' });

    // Atomic claim: only ONE request can ever flip NULL → timestamp for this post.
    const stamp = new Date().toISOString();
    if (db.prepare('UPDATE posts SET notifiedAt=? WHERE id=? AND notifiedAt IS NULL').run(stamp, id).changes !== 1)
      return res.status(409).json({ error: 'This post has already been notified.' });
    const release = () => db.prepare('UPDATE posts SET notifiedAt=NULL WHERE id=? AND notifiedAt=?').run(id, stamp); // undo claim if nobody got it

    let sent = 0, failed = 0, removed = 0;
    try {
      const payload = JSON.stringify(buildPayload(post));
      const drop = db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?');
      for (let i = 0; i < subs.length; i += SEND_BATCH) {
        await Promise.all(subs.slice(i, i + SEND_BATCH).map(async s => {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              payload, { TTL: 86400, urgency: 'normal', topic: 'qg' + id, timeout: 10000 });
            sent++;
          } catch (e) {
            if (e && (e.statusCode === 404 || e.statusCode === 410)) { drop.run(s.endpoint); removed++; } // user revoked / uninstalled
            else failed++;
          }
        }));
      }
    } catch (e) {
      console.error('[PUSH] notify crashed:', e.message);
      if (!sent) release();
      return res.status(500).json({ error: 'Failed to send notifications.' });
    }
    console.log(`[PUSH] post ${id} → sent ${sent}, failed ${failed}, expired/removed ${removed}`);

    if (!sent) { // nobody received it → don't burn the one-shot; admin can retry
      release();
      if (failed) return res.status(502).json({ error: 'Delivery failed for every device. Nothing was marked as notified — you can try again.' });
      return res.json({ ok: true, notified: false, sent: 0, subscribers: subCount(), message: 'All saved subscriptions had expired and were cleaned up — nothing was sent.' });
    }
    res.json({ ok: true, notified: true, notifiedAt: stamp, sent, failed, removed, subscribers: subCount() });
  });
}

module.exports = { init, migrate, buildPayload, isAllowedEndpoint };
