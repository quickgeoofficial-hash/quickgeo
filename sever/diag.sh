#!/data/data/com.termux/files/usr/bin/bash
# Quickgeo — one-shot diagnostic. Run on the phone:  bash ~/quickgeo/diag.sh
cd ~/quickgeo || exit 1
ok(){ echo "✅  $*"; }; bad(){ echo "❌  $*"; }; info(){ echo "ℹ️   $*"; }

echo "── Versions ──"
info "node $(node -v)   (needs >= 22.5 for node:sqlite)"
V=$(grep -o "version:'[0-9.]*'" server.js | head -1)
[ -n "$V" ] && ok "server.js reports $V" || bad "server.js has no version string → this looks like the OLD v1 server (no push, no SSE)"
grep -q "push.init" server.js && ok "server.js wires up push" || bad "server.js does NOT load push.js → notifications can never work"
[ -d node_modules/web-push ] && ok "web-push installed" || bad "web-push NOT installed → run: npm install"
[ -f .env ] && ok ".env present" || bad ".env missing"

echo "── Local server ──"
H=$(curl -s -m 5 localhost:3000/health); [ -n "$H" ] && ok "health: $H" || bad "server not answering on :3000"
K=$(curl -s -m 5 localhost:3000/api/push/key); echo "$K" | grep -q publicKey && ok "push key endpoint OK" || bad "push key endpoint: $K"

echo "── Subscribers (from database) ──"
node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/quickgeo.db');
try{console.log('subscribers:',db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n);
console.log('latest subs:',db.prepare('SELECT substr(endpoint,1,45) e,createdAt FROM push_subscriptions ORDER BY createdAt DESC LIMIT 3').all());
console.log('notified posts:',db.prepare('SELECT COUNT(*) n FROM posts WHERE notifiedAt IS NOT NULL').get().n)}catch(e){console.log('push tables missing:',e.message)}
" 2>/dev/null

echo "── Can this phone reach the push services? ──"
for h in fcm.googleapis.com updates.push.services.mozilla.com; do
  C=000; for i in 1 2 3; do C=$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://$h/); [ "$C" != "000" ] && break; done
  [ "$C" != "000" ] && ok "$h reachable (HTTP $C, try $i)" || bad "$h unreachable after 3 tries (network problem on this phone)"
done
echo "── Public path ──"
C=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.quickgeo.live/health); [ "$C" = "200" ] && ok "api.quickgeo.live/health → 200" || bad "api.quickgeo.live/health → $C"
pgrep -fa cloudflared | grep -q http2 && ok "tunnel is using http2" || info "tunnel not on http2 (use the new start.sh)"
