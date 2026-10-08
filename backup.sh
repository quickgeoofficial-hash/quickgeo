#!/data/data/com.termux/files/usr/bin/bash
# Quickgeo — Automated Database Backup
# Run manually or via cron: keeps last 7 daily backups

BACKUP_DIR=/sdcard/quickgeo-backups
DB_FILE=~/quickgeo/data/quickgeo.db
DATE=$(date +%Y-%m-%d_%H%M)

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "❌  Database file not found at $DB_FILE"
  exit 1
fi

# Copy the database (SQLite files are safe to copy while WAL mode is active)
cp "$DB_FILE" "$BACKUP_DIR/quickgeo_$DATE.db"
echo "✅  Backup saved: $BACKUP_DIR/quickgeo_$DATE.db"

# Also back up uploaded media folder listing (not the files themselves — too large)
ls -la ~/quickgeo/uploads > "$BACKUP_DIR/uploads_list_$DATE.txt" 2>/dev/null

# Keep only the last 7 backups — delete older ones
cd "$BACKUP_DIR"
ls -t quickgeo_*.db 2>/dev/null | tail -n +8 | xargs -r rm --
ls -t uploads_list_*.txt 2>/dev/null | tail -n +8 | xargs -r rm --

echo "📦  Backups in $BACKUP_DIR: $(ls "$BACKUP_DIR"/quickgeo_*.db 2>/dev/null | wc -l) kept"
