#!/usr/bin/env bash
# Polls the FlyTab WebView every 60s via CDP, logs WS state to CSV.
# Designed to run alongside stratux-ws-watch.js for apples-to-apples comparison.
set -u
DURATION_SEC="${1:-3600}"
OUT="tools/tablet-watch-$(date -u +%Y-%m-%dT%H-%M-%SZ).csv"
echo "iso,age_s,tMsgs,sMsgs,tSilent_s,sSilent_s,tWs,sWs,traffic_size,situation_alt,situation_fix" > "$OUT"
echo "Tablet polling → $OUT for ${DURATION_SEC}s"
END=$(( $(date +%s) + DURATION_SEC ))
while [ "$(date +%s)" -lt "$END" ]; do
  RESULT=$(node tools/cdp-eval.js "(() => { const w = window.__wsWatch; const c = app.stratuxClient; const s = c.situation; return { age_s: ((Date.now()-w.tStart)/1000).toFixed(0), tMsgs: w.tMsgs, sMsgs: w.sMsgs, tSilent_s: w.tLast ? ((Date.now()-w.tLast)/1000).toFixed(1) : '', sSilent_s: w.sLast ? ((Date.now()-w.sLast)/1000).toFixed(1) : '', tWs: c._trafficWs?.readyState ?? '', sWs: c._situationWs?.readyState ?? '', traffic_size: c.traffic.size, situation_alt: s?.alt_msl ? Math.round(s.alt_msl) : '', situation_fix: s?.gps_fix_quality ?? '' }; })()" 2>/dev/null || echo '{}')
  ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Strip surrounding JSON quotes and parse
  CLEAN=$(echo "$RESULT" | sed 's/^"//; s/"$//' | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(','.join(str(d.get(k,'')) for k in ['age_s','tMsgs','sMsgs','tSilent_s','sSilent_s','tWs','sWs','traffic_size','situation_alt','situation_fix']))" 2>/dev/null || echo ',,,,,,,,')
  echo "$ISO,$CLEAN" >> "$OUT"
  sleep 60
done
echo "tablet poll done → $OUT"
