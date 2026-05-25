#!/usr/bin/env bash
# FlyTab tablet pre-flight check — runs CDP assertions against the live WebView.
# Usage: bash tools/tablet-check.sh
# Requires: adb forward tcp:9223 localabstract:webview_devtools_remote_$(adb shell pidof app.flywhere.flytab)

set -u

PASS=0
FAIL=0

check() {
    local label="$1"
    local expr="$2"
    local result
    result=$(node tools/cdp-eval.js "$expr" 2>/dev/null | tr -d '"')
    if [ "$result" = "true" ]; then
        echo "  PASS  $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL  $label  (got: $result)"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "FlyTab Tablet Check"
echo "==================="
echo ""

check "Stratux connected" \
    "String(window.app && window.app.stratuxClient && window.app.stratuxClient.connected)"

check "GPS fix quality >= 2" \
    "String(window.app && window.app.stratuxClient && window.app.stratuxClient.situation && window.app.stratuxClient.situation.gps_fix_quality >= 2)"

check "Engine client connected" \
    "String(window.engineClient && window.engineClient.connected)"

check "NASR loaded (KLKR in IDB)" \
    "(async () => { try { const a = await window.app._nasrDb.getAirport('KLKR'); return String(a !== null && a !== undefined); } catch(e) { return 'error: '+e.message; } })()"

check "Tile server reachable" \
    "(async () => { try { const r = await fetch('http://localhost:9090/nasr/cycle_info.json', { signal: AbortSignal.timeout(2000) }); return String(r.ok); } catch { return 'false'; } })()"

check "No JS console errors recorded" \
    "String(!window.__consoleErrors || window.__consoleErrors.length === 0)"

check "EngineML last result present" \
    "String(window.engineML && window.engineML.lastResult && typeof window.engineML.lastResult.score === 'number')"

echo ""
echo "Result: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
