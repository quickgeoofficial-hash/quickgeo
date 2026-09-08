#!/data/data/com.termux/files/usr/bin/bash
# Quickgeo — One-time Setup Script (v3.0)
echo "Setting up Quickgeo v3.0..."

# Storage permission
termux-setup-storage

# Install system packages
pkg update -y
pkg install -y nodejs python make build-essential binutils git

# Create project directory
mkdir -p ~/quickgeo/data ~/quickgeo/uploads

# Copy server files
cp -r /sdcard/quickgeo/server/* ~/quickgeo/ 2>/dev/null || true

cd ~/quickgeo

# Install Node dependencies (better-sqlite3 requires native compile)
npm install

# Create .env from example if not exists
if [ ! -f ~/quickgeo/.env ]; then
  cp ~/quickgeo/.env.example ~/quickgeo/.env
  echo ""
  echo "⚠  IMPORTANT: Edit your .env file before starting!"
  echo "   Run: nano ~/quickgeo/.env"
  echo "   Set ADMIN_USERNAME and ADMIN_PASSWORD"
fi

# Install cloudflared if not installed
if ! command -v cloudflared &>/dev/null; then
  pkg install -y cloudflared 2>/dev/null || \
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
    -o /data/data/com.termux/files/usr/bin/cloudflared && \
  chmod +x /data/data/com.termux/files/usr/bin/cloudflared
fi

echo ""
echo "✅  Setup complete!"
echo ""
echo "Next steps:"
echo "  1. nano ~/quickgeo/.env          # Set your password"
echo "  2. bash ~/quickgeo/start.sh      # Start the server"
