#!/data/data/com.termux/files/usr/bin/bash
# Quickgeo — one-time Termux setup (v3.4 server: Node 22+ built-in SQLite, no native compile)
set -e
echo "Setting up Quickgeo..."
termux-setup-storage || true
pkg update -y && pkg install -y nodejs cloudflared curl

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 22 ] || { echo "❌ Node 22+ required (node:sqlite). Have $(node -v)"; exit 1; }

mkdir -p ~/quickgeo/data ~/quickgeo/uploads
SRC="$(cd "$(dirname "$0")" && pwd)"
[ "$SRC" = "$HOME/quickgeo" ] || cp -r "$SRC"/. ~/quickgeo/
cd ~/quickgeo
npm install --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠  Edit your password first:  nano ~/quickgeo/.env"
fi
echo "Next:  1) nano ~/quickgeo/.env   2) bash ~/quickgeo/start.sh   3) bash ~/quickgeo/diag.sh"
