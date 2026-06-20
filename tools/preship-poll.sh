#!/usr/bin/env bash
# Polls the FlyTab WebView pre-ship instrumentation every 60s, dumps results.
set -u
DURATION="${1:-360}"   # default 6 minutes
OUT="tools/preship-poll.csv"
echo "iso,elapsed_s,tickCount,sitMsgs,trafMsgs,sitSilent_s,trafSilent_s,vis,hidden" > "$OUT"
END=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$END" ]; do
  RESULT=$(node tools/cdp-eval.js "(() => { const p = window.__pre; if (!p) return {}; return { elapsed_s: Math.round((Date.now()-p.started)/1000), tickCount: p.tickLog.length, sitMsgs: p.sitMsgs, trafMsgs: p.trafMsgs, sitSilent_s: p.lastSit ? Math.round((Date.now()-p.lastSit)/1000) : '', trafSilent_s: p.lastTraf ? Math.round((Date.now()-p.lastTraf)/1000) : '', vis: document.visibilityState, hidden: document.hidden ? 1 : 0 }; })()" 2>/dev/null || echo '{}')
  ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  CLEAN=$(echo "$RESULT" | sed 's/^"//; s/"$//' | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(','.join(str(d.get(k,'')) for k in ['elapsed_s','tickCount','sitMsgs','trafMsgs','sitSilent_s','trafSilent_s','vis','hidden']))" 2>/dev/null || echo ',,,,,,,')
  echo "$ISO,$CLEAN" >> "$OUT"
  echo "$ISO  $CLEAN"
  sleep 60
done
echo "preship poll done → $OUT"
