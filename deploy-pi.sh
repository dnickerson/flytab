#!/usr/bin/env bash
# deploy-pi.sh — Set up Pi SD card for FlyTab architecture
#
# FlyTab Pi role: data relay ONLY
#   - Stratux (standard, unmodified) — GPS, ADS-B, FIS-B
#   - Engine Monitor (/opt/engine-monitor/) — EDM serial → JSON + WebSocket
#   - NO FastAPI, NO tiles, NO NASR, NO plates, NO web files
#
# Usage:
#   bash flytab/deploy-pi.sh              — deploy engine monitor only
#   bash flytab/deploy-pi.sh --clean      — deploy + remove FlyPi data (tiles, NASR, plates, etc.)
#   bash flytab/deploy-pi.sh --full       — deploy + clean + restart services
#
# Pi must be reachable at PI_HOST (home network or Stratux hotspot)

set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ENGINE_SRC="$REPO_ROOT/engine-monitor"

# #113: what this deploy is about to ship, so it's visible in the deploy output
# rather than only discoverable by diffing engine_monitor.py. If FlyTab's
# MIN_PI_CONTRACT (web/shared/engine-client.js) requires more than this after
# deploying, the ENG page + status bar will say so on the tablet.
PI_VERSION_LOCAL="$(grep -m1 '^VERSION = ' "$ENGINE_SRC/engine_monitor.py" | sed -E 's/VERSION = "(.*)"/\1/')"
PI_API_CONTRACT_LOCAL="$(grep -m1 '^PI_API_CONTRACT = ' "$ENGINE_SRC/engine_monitor.py" | sed -E 's/PI_API_CONTRACT = ([0-9]+)/\1/')"

PI_HOST="${PI_HOST:-192.168.1.212}"
PI_USER="pi"
PI_SSH="$PI_USER@$PI_HOST"
RSYNC="rsync -az --progress"

DO_CLEAN=false
DO_RESTART=false

for arg in "$@"; do
    case $arg in
        --clean) DO_CLEAN=true ;;
        --full)  DO_CLEAN=true; DO_RESTART=true ;;
        --restart) DO_RESTART=true ;;
    esac
done

echo "=============================="
echo " FlyTab Pi Deploy"
echo "=============================="
echo " Target: $PI_SSH"
echo " Deploying: engine_monitor.py v${PI_VERSION_LOCAL:-?} (api_contract ${PI_API_CONTRACT_LOCAL:-?})"
echo ""

# ── Check Pi is reachable ──────────────────────────────────────────────
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$PI_SSH" true 2>/dev/null; then
    echo "ERROR: Cannot reach $PI_SSH"
    echo ""
    echo "Options:"
    echo "  Home network:    PI_HOST=192.168.1.212 bash flytab/deploy-pi.sh"
    echo "  Cockpit hotspot: PI_HOST=192.168.10.1  bash flytab/deploy-pi.sh"
    exit 1
fi

# ── Install websockets (required for /ws/engine endpoint) ─────────────
echo "[1] Ensuring Python websockets module is installed..."
ssh "$PI_SSH" "sudo mount -o remount,rw /overlay/robase 2>/dev/null || true"
ssh "$PI_SSH" "python3 -c 'import websockets' 2>/dev/null || sudo pip3 install websockets --break-system-packages 2>/dev/null || sudo pip3 install websockets"
echo "    ✓ websockets installed"

# ── Deploy engine monitor to /opt/engine-monitor/ ─────────────────────
echo ""
echo "[2] Deploying engine monitor to /opt/engine-monitor/..."
ssh "$PI_SSH" "sudo mkdir -p /opt/engine-monitor && sudo chown pi:pi /opt/engine-monitor"
$RSYNC \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.claude' \
    "$ENGINE_SRC/" "$PI_SSH:/opt/engine-monitor/"
echo "    ✓ Engine monitor deployed"

# ── Also keep /opt/capture_v5/ in sync (backward compat) ─────────────
echo ""
echo "[3] Syncing to /opt/capture_v5/ (backward compat)..."
ssh "$PI_SSH" "sudo chown -R pi:pi /opt/capture_v5/ 2>/dev/null || true"
$RSYNC \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.claude' \
    "$ENGINE_SRC/" "$PI_SSH:/opt/capture_v5/"
echo "    ✓ capture_v5 synced"

# ── Install/update systemd service ────────────────────────────────────
echo ""
echo "[4] Installing engine-monitor systemd service..."
# Write service file to overlay base so it survives reboots
ssh "$PI_SSH" "sudo mount -o remount,rw /overlay/robase 2>/dev/null || true"
ssh "$PI_SSH" "cat > /tmp/engine-monitor.service << 'SVCEOF'
[Unit]
Description=Engine Monitor (FlyTab)
After=network.target stratux.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/engine-monitor/engine_monitor.py
WorkingDirectory=/opt/engine-monitor
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
sudo cp /tmp/engine-monitor.service /etc/systemd/system/engine-monitor.service
sudo cp /tmp/engine-monitor.service /overlay/robase/etc/systemd/system/engine-monitor.service 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable engine-monitor"
echo "    ✓ engine-monitor.service installed and enabled"

# ── Stop and disable FlyPi service ────────────────────────────────────
echo ""
echo "[5] Disabling FlyPi and old capture_v5 services (not needed for FlyTab)..."
ssh "$PI_SSH" "sudo systemctl stop flypi 2>/dev/null || true; sudo systemctl disable flypi 2>/dev/null || true"
ssh "$PI_SSH" "sudo systemctl stop capture_v5 2>/dev/null || true; sudo systemctl disable capture_v5 2>/dev/null || true"
echo "    ✓ flypi.service disabled"
echo "    ✓ capture_v5.service disabled (replaced by engine-monitor)"

# ── Clean up unnecessary data ─────────────────────────────────────────
if [ "$DO_CLEAN" = true ]; then
    echo ""
    echo "[6] Removing FlyPi data not needed for FlyTab..."

    # Tiles — biggest space hog
    echo "    Removing tiles..."
    ssh "$PI_SSH" "sudo rm -rf /opt/flypi/data/tiles"

    # NASR data
    echo "    Removing NASR data..."
    ssh "$PI_SSH" "sudo rm -rf /opt/flypi/data/nasr"

    # Approach plates
    echo "    Removing approach plates..."
    ssh "$PI_SSH" "sudo rm -rf /opt/flypi/data/plates"

    # CIFP procedures
    echo "    Removing CIFP data..."
    ssh "$PI_SSH" "sudo rm -rf /opt/flypi/data/cifp"

    # Web files (iPad PWA — not needed)
    echo "    Removing web files..."
    ssh "$PI_SSH" "sudo rm -rf /opt/flypi/web"

    # FastAPI backend
    echo "    Removing FastAPI backend..."
    ssh "$PI_SSH" "sudo rm -rf /opt/flypi/app"

    echo "    ✓ FlyPi data removed"

    # Show freed space
    echo ""
    ssh "$PI_SSH" "df -h /opt | tail -1 | awk '{print \"    Disk: \" \$3 \" used / \" \$4 \" free (\" \$5 \" used)\"}'"
fi

# ── Restart services ──────────────────────────────────────────────────
if [ "$DO_RESTART" = true ]; then
    echo ""
    echo "[7] Restarting engine monitor..."
    ssh "$PI_SSH" "sudo systemctl restart engine-monitor"
    sleep 2

    echo ""
    echo "    Service status:"
    ssh "$PI_SSH" "sudo systemctl status engine-monitor --no-pager -l 2>&1 | head -15"

    echo ""
    echo "    Stratux status:"
    ssh "$PI_SSH" "sudo systemctl status stratux --no-pager -l 2>&1 | head -5"

    # Verify WebSocket endpoint
    echo ""
    echo "    Testing /ws/engine endpoint (port 8082)..."
    ssh "$PI_SSH" "python3 -c \"
import asyncio, websockets, json
async def test():
    try:
        async with websockets.connect('ws://localhost:8082/ws/engine', open_timeout=3) as ws:
            msg = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(msg)
            print('    ✓ WebSocket alive — keys:', list(data.keys())[:6], '...')
    except Exception as e:
        print('    ⚠ WebSocket not responding:', e)
        print('      (Normal if no EDM connected)')
asyncio.run(test())
\" 2>&1"
fi

echo ""
echo "=============================="
echo " FlyTab Pi Deploy Complete!"
echo "=============================="
echo ""
echo " Services on Pi:"
echo "   Stratux:        standard (port 80/443, hotspot 192.168.10.1)"
echo "   Engine Monitor: /opt/engine-monitor/ (HTTP :8080, WS :8082)"
echo "                   v${PI_VERSION_LOCAL:-?}, api_contract ${PI_API_CONTRACT_LOCAL:-?}"
echo ""
echo " If the tablet's FlyTab build requires a newer api_contract than this,"
echo " it will show an amber badge in the status bar and a banner on the ENG page."
echo ""
if [ "$DO_RESTART" = false ]; then
    echo " To restart engine monitor:"
    echo "   ssh $PI_SSH 'sudo systemctl restart engine-monitor'"
    echo ""
    echo " To clean + restart:"
    echo "   bash flytab/deploy-pi.sh --full"
fi
