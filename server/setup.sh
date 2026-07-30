#!/data/data/com.termux/files/usr/bin/bash
# ═══════════════════════════════════════════
#  Quickgeo — One-time Termux Setup Script
#  Run this ONCE to install everything
# ═══════════════════════════════════════════

set -e   # stop on any error

echo ""
echo "╔══════════════════════════════════════╗"
echo "║    Quickgeo Server — First Setup     ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "📦  Step 1/5 — Updating package list..."
pkg update -y -q

echo "📦  Step 2/5 — Installing Node.js..."
pkg install nodejs -y -q

echo "📦  Step 3/5 — Installing Cloudflare Tunnel..."
pkg install cloudflared -y -q

echo "📦  Step 4/5 — Setting up server files..."
mkdir -p ~/quickgeo
cp -r /sdcard/quickgeo/server/* ~/quickgeo/ 2>/dev/null || true

# If files weren't copied from sdcard, download them
cd ~/quickgeo

echo "📦  Step 5/5 — Installing Node.js dependencies..."
npm install --quiet

echo ""
echo "✅  Setup complete!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " To START the server, run:"
echo "   bash ~/quickgeo/start.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
