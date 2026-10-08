#!/data/data/com.termux/files/usr/bin/bash
# Quickgeo — Start Script (Named Tunnel)
cd ~/quickgeo || exit 1

# Keep Android from sleeping the CPU/Wi-Fi while the server runs (needs the Termux:API-free built-in)
termux-wake-lock 2>/dev/null || true

pkill -f "node server.js" 2>/dev/null || true
pkill -f "cloudflared"    2>/dev/null || true
sleep 1

# Make sure dependencies (incl. web-push) are installed — push is silently DISABLED without it
if [ ! -d node_modules/web-push ] || [ ! -d node_modules/express ]; then
  echo "📦  Installing missing dependencies..."
  npm install --omit=dev --no-audit --no-fund || { echo "❌ npm install failed"; exit 1; }
fi

echo "╔══════════════════════════════════════╗"
echo "║       Starting Quickgeo...           ║"
echo "╚══════════════════════════════════════╝"

node server.js &
NODE_PID=$!
sleep 3
if ! kill -0 $NODE_PID 2>/dev/null; then
  echo "❌  Node.js failed to start. Run: node server.js"; exit 1
fi
echo "✅  Node.js server running (PID: $NODE_PID)"
curl -s http://localhost:3000/health >/dev/null 2>&1 && echo "✅  Health check passed" || echo "⚠   Health check pending..."

echo "🌐  Starting Named Cloudflare Tunnel (http2)..."
# --protocol http2: QUIC (UDP) is frequently dropped/throttled on mobile networks and causes the
# "failed to dial to edge with quic: timeout" / "no recent network activity" errors. http2 uses TCP.
cloudflared tunnel --protocol http2 --no-autoupdate run quickgeo-server

echo "🛑  Tunnel stopped. Shutting down server..."
kill $NODE_PID 2>/dev/null || true
