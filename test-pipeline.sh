#!/usr/bin/env bash
# test-pipeline.sh — End-to-end test of FlyTab engine data pipeline
#
# Full pipeline test (serial mode):
#   data_simulator.py → virtual serial → engine_monitor.py (serial read + parse)
#     → HTTP :8080 + WebSocket :8082 → FlyTab app → Savvy CSV on tablet
#
# This tests EVERY layer including serial port reading and EDM parsing.
#
# Prerequisites:
#   - Pi reachable at PI_HOST
#   - FlyTab app built and installed on tablet (with flight-recorder.js)
#   - Tablet on same network as Pi (home WiFi or Pi hotspot)
#
# Usage:
#   bash flytab/test-pipeline.sh                          # Largest flight file, 10x speed
#   bash flytab/test-pipeline.sh --rate 30                # 30x speed (~2 min test)
#   bash flytab/test-pipeline.sh --file stream_0033.txt   # Specific file
#   bash flytab/test-pipeline.sh --stop                   # Stop test, restore normal

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DATA_DIR="$HOME/Engine_Analysis"
ENGINE_SRC="$REPO_ROOT/flypi/engine-monitor"
PI_HOST="${PI_HOST:-192.168.1.212}"
PI_USER="pi"
PI_SSH="$PI_USER@$PI_HOST"

# Defaults
RATE=10
STREAM_FILE=""
STOP_MODE=false

# Parse args (positional-safe)
while [[ $# -gt 0 ]]; do
    case $1 in
        --rate)   RATE="$2"; shift 2 ;;
        --rate=*) RATE="${1#*=}"; shift ;;
        --file)   STREAM_FILE="$2"; shift 2 ;;
        --file=*) STREAM_FILE="${1#*=}"; shift ;;
        --stop)   STOP_MODE=true; shift ;;
        *)        shift ;;
    esac
done

echo "=============================="
echo " FlyTab Pipeline Test"
echo "=============================="
echo ""

# ── Stop mode: kill test processes, restore normal engine monitor ─────
if [ "$STOP_MODE" = true ]; then
    echo "Stopping test mode..."
    ssh "$PI_SSH" "
        # Kill test engine monitor
        kill \$(cat /tmp/engine-test.pid 2>/dev/null) 2>/dev/null || true
        kill \$(cat /tmp/simulator.pid 2>/dev/null) 2>/dev/null || true
        sleep 1
        # Restore normal engine monitor service
        sudo systemctl start engine-monitor
        rm -f /tmp/engine-test.pid /tmp/simulator.pid /tmp/ttyUSB0
        echo 'Done'
    "
    echo "✓ Normal engine monitor restored"
    echo ""
    echo "Check: ssh $PI_SSH 'sudo systemctl status engine-monitor --no-pager | head -8'"
    exit 0
fi

# ── Select stream file ───────────────────────────────────────────────
if [ -z "$STREAM_FILE" ]; then
    STREAM_FILE=$(ls -S "$ENGINE_DATA_DIR"/stream_*.txt 2>/dev/null | head -1)
    if [ -z "$STREAM_FILE" ]; then
        echo "ERROR: No stream_*.txt files in $ENGINE_DATA_DIR"
        exit 1
    fi
fi

# Resolve relative names
if [ ! -f "$STREAM_FILE" ] && [ -f "$ENGINE_DATA_DIR/$STREAM_FILE" ]; then
    STREAM_FILE="$ENGINE_DATA_DIR/$STREAM_FILE"
fi
if [ ! -f "$STREAM_FILE" ]; then
    echo "ERROR: File not found: $STREAM_FILE"
    exit 1
fi

FILE_SIZE=$(du -h "$STREAM_FILE" | cut -f1)
LINE_COUNT=$(grep -c "." "$STREAM_FILE" || echo 0)
EST_SECONDS=$((LINE_COUNT / 6))
EST_MINUTES=$((EST_SECONDS / 60))
TEST_MINUTES=$((EST_MINUTES / RATE))
if [ "$TEST_MINUTES" -eq 0 ]; then TEST_MINUTES=1; fi

echo " Stream file: $(basename "$STREAM_FILE") ($FILE_SIZE, $LINE_COUNT data lines)"
echo " Estimated flight: ~${EST_MINUTES} min"
echo " Playback rate: ${RATE}x → test takes ~${TEST_MINUTES} min"
echo " Pi: $PI_SSH"
echo ""

# ── Check Pi ──────────────────────────────────────────────────────────
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$PI_SSH" true 2>/dev/null; then
    echo "ERROR: Cannot reach $PI_SSH"
    exit 1
fi
echo "✓ Pi reachable"

# ── Copy stream file + data_simulator.py to Pi ───────────────────────
echo ""
echo "[1] Copying test data to Pi..."
scp -q "$STREAM_FILE" "$PI_SSH:/opt/engine-monitor/test_stream.txt"
echo "    ✓ Copied $(basename "$STREAM_FILE")"

# ── Stop normal engine monitor ────────────────────────────────────────
echo ""
echo "[2] Stopping normal engine monitor..."
ssh "$PI_SSH" "sudo systemctl stop engine-monitor"
echo "    ✓ engine-monitor.service stopped"

# ── Start engine monitor in playback mode ─────────────────────────────
echo ""
echo "[3] Starting engine monitor (--playback mode at ${RATE}x)..."
ssh "$PI_SSH" "
    # Kill any existing test processes
    kill \$(cat /tmp/engine-test.pid 2>/dev/null) 2>/dev/null || true
    kill \$(cat /tmp/simulator.pid 2>/dev/null) 2>/dev/null || true
    sleep 1
    nohup python3 /opt/engine-monitor/engine_monitor.py \
        --playback /opt/engine-monitor/test_stream.txt \
        --playback-rate $RATE \
        > /tmp/engine-test.log 2>&1 &
    echo \$! > /tmp/engine-test.pid
"
sleep 4

# Verify engine monitor is running
PID=$(ssh "$PI_SSH" "cat /tmp/engine-test.pid 2>/dev/null")
RUNNING=$(ssh "$PI_SSH" "ps -p $PID -o pid= 2>/dev/null" | tr -d ' ')
if [ -z "$RUNNING" ]; then
    echo "    ERROR: Engine monitor failed to start"
    echo "    Log:"
    ssh "$PI_SSH" "tail -20 /tmp/engine-test.log"
    ssh "$PI_SSH" "sudo systemctl start engine-monitor"
    exit 1
fi
echo "    ✓ Engine monitor running (PID $PID, playback mode)"

# ── Verify data flowing through the pipeline ─────────────────────────
echo ""
echo "[4] Verifying pipeline..."
sleep 3

# Check HTTP API
echo -n "    HTTP API (:8080): "
ssh "$PI_SSH" "curl -s http://localhost:8080/api/status | python3 -c '
import sys,json
d = json.load(sys.stdin)
data = d.get(\"data\",{})
rpm = data.get(\"RPM\",0)
mp = data.get(\"MP\",0)
ff = data.get(\"Fuel_Flow\",0)
cnt = d.get(\"data_count\",0)
cap = d.get(\"capturing\",False)
ser = d.get(\"serial_connected\",False)
print(f\"serial={ser} RPM={rpm} MP={mp} FF={ff} count={cnt} capturing={cap}\")
' 2>/dev/null || echo 'FAILED — check /tmp/engine-test.log'"

# Check WebSocket
echo -n "    WebSocket (:8082): "
ssh "$PI_SSH" "timeout 8 python3 -c \"
import asyncio, websockets, json
async def t():
    async with websockets.connect('ws://127.0.0.1:8082/ws/engine') as ws:
        msg = await asyncio.wait_for(ws.recv(), timeout=5)
        d = json.loads(msg)
        data = d.get('data',{})
        rpm = data.get('RPM',0)
        egt1 = data.get('EGT1',0)
        cht1 = data.get('CHT1',0)
        print(f'RPM={rpm} EGT1={egt1} CHT1={cht1} keys={len(d)}')
asyncio.run(t())
\" 2>/dev/null || echo 'FAILED — check /tmp/engine-test.log'"

# Check Pi-side CSV recording
echo -n "    Pi CSV recording: "
ssh "$PI_SSH" "
    CSV=\$(ls -t /opt/engine-monitor/flight_active.csv /opt/capture_v5/flight_active.csv 2>/dev/null | head -1)
    if [ -n \"\$CSV\" ]; then
        LINES=\$(wc -l < \"\$CSV\")
        echo \"active (\$LINES lines) at \$CSV\"
    else
        echo 'no active CSV yet (may take a few seconds)'
    fi
"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=============================="
echo " Pipeline Test Running!"
echo "=============================="
echo ""
echo " Full pipeline: stream file → virtual serial → engine_monitor.py"
echo "   → parse_line() → get_status() → HTTP :8080 + WS :8082"
echo "   → FlyTab EngineClient → FlightRecorder → Savvy CSV"
echo ""
echo " Test will run ~${TEST_MINUTES} min at ${RATE}x speed."
echo ""
echo " On the tablet:"
echo "   1. Connect to Pi network (home WiFi or hotspot)"
echo "   2. Open FlyTab — engine data should appear on ENG panel"
echo "   3. REC badge auto-appears when RPM > 500 for 10s"
echo "   4. After playback ends: RPM drops to 0, recorder stops after 60s"
echo "   5. CSV saved to Documents/FlyTab/flights/ on the tablet"
echo ""
echo " Manual control (tablet JS console):"
echo "   flightRecorder.start()    // force start"
echo "   flightRecorder.stop()     // force stop + flush CSV"
echo "   flightRecorder.recording  // true/false"
echo "   flightRecorder.rowCount   // rows written"
echo "   flightRecorder.fileName   // current CSV filename"
echo ""
echo " Monitor:"
echo "   ssh $PI_SSH 'tail -f /tmp/engine-test.log'      # engine monitor"
echo "   ssh $PI_SSH 'tail -f /tmp/simulator.log'         # data simulator"
echo ""
echo " Stop test & restore normal mode:"
echo "   bash flytab/test-pipeline.sh --stop"
echo ""
