#!/data/data/com.termux/files/usr/bin/bash
# Quickgeo — Watchdog. Run in a SEPARATE Termux session alongside start.sh.
# Checks the local server AND the public tunnel every 60s; restarts after 3 straight failures.
termux-wake-lock 2>/dev/null || true
echo "🐕  Watchdog started — checking every 60s"
FAIL=0
while true; do
  sleep 60
  LOCAL=$(curl -s -m 5 http://localhost:3000/health 2>/dev/null)
  PUB=$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://api.quickgeo.live/health 2>/dev/null)
  if [[ "$LOCAL" == *'"status":"ok"'* && "$PUB" == "200" ]]; then
    [ $FAIL -gt 0 ] && echo "[$(date '+%H:%M:%S')] ✅ recovered after $FAIL failed check(s)"
    FAIL=0
  else
    FAIL=$((FAIL+1))
    WHAT="local=$([[ "$LOCAL" == *ok* ]] && echo ok || echo DOWN) public=$PUB"
    echo "[$(date '+%H:%M:%S')] ⚠️  check failed ($FAIL/3) $WHAT"
    if [ $FAIL -ge 3 ]; then
      echo "[$(date '+%H:%M:%S')] 🔄 restarting..."
      pkill -f "node server.js" 2>/dev/null; pkill -f cloudflared 2>/dev/null
      sleep 3
      cd ~/quickgeo && nohup bash start.sh >> ~/quickgeo/watchdog-restart.log 2>&1 &
      FAIL=0; sleep 20
    fi
  fi
done
