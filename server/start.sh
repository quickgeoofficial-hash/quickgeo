#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════
#  Quickgeo — Start Script
#  Run this every time you want the server on
# ═══════════════════════════════════════════

cd ~/quickgeo

# Kill any old instances
pkill -f "node server.js"    2>/dev/null || true
pkill -f "cloudflared"       2>/dev/null || true
sleep 1

echo ""
echo "╔══════════════════════════════════════╗"
echo "║        Starting Quickgeo...          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Start Node.js server in background
node server.js &
NODE_PID=$!
echo "✅  Server started  (PID: $NODE_PID)"

# Wait for server to be ready
sleep 2

# Check it's actually running
if ! kill -0 $NODE_PID 2>/dev/null; then
  echo "❌  Server failed to start. Check for errors above."
  exit 1
fi

echo ""
echo "🌐  Starting Cloudflare Tunnel..."
echo "    (Your public URL will appear below in a few seconds)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 👁  Watch for a line that says:"
echo "     | https://xxxx.trycloudflare.com |"
echo " 📋  Copy that URL and paste it into"
echo "     your admin.html → Server Settings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Start Cloudflare tunnel (foreground — shows the URL)
cloudflared tunnel --url http://localhost:3000 2>&1 | \
  grep --line-buffered -E "(trycloudflare|error|ERR|Registered)"

# If cloudflared exits, also stop the Node server
echo ""
echo "🛑  Tunnel closed. Stopping server..."
kill $NODE_PID 2>/dev/null || true
echo "   Server stopped. Run start.sh again to restart."
