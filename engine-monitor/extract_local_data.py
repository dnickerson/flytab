#!/usr/bin/env python3
"""
Extracts flight data from iPad localStorage by impersonating the Stratux.

Creates a WiFi hotspot with IP 192.168.10.1 so the iPad PWA
(origin http://192.168.10.1:8080) can access its stored data.

Usage:
  1. sudo python3 extract_local_data.py
  2. On iPad, connect to WiFi network "StratuxData" (password: extract1)
  3. Open the engine monitor from the iPad home screen
  4. Tap "Download CSV" to save your flight data
  5. Ctrl+C to stop and restore your network
"""

import http.server
import subprocess
import signal
import sys
import os
import time

PORT = 8080
HOTSPOT_IP = '192.168.10.1'
HOTSPOT_SSID = 'StratuxData'
HOTSPOT_PASS = 'extract1'
CON_NAME = 'stratux-extract'

HTML_PAGE = """<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>Stratux Data Extract</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: -apple-system, Helvetica, sans-serif;
    background: #FFFFF0; color: #333;
    display: flex; flex-direction: column; align-items: center;
    padding: 40px 20px; min-height: 100vh;
}
h1 { color: #006400; margin-bottom: 8px; font-size: 1.5em; }
.subtitle { color: #666; margin-bottom: 30px; }
.status { background: #fff; border: 2px solid #ccc; border-radius: 10px;
    padding: 20px; width: 100%; max-width: 500px; margin-bottom: 20px; }
.status.has-data { border-color: #006400; }
.status.no-data { border-color: #CC0000; }
.label { font-size: 0.85em; color: #666; }
.value { font-size: 1.3em; font-weight: bold; margin: 4px 0 12px; }
.value.green { color: #006400; }
.value.red { color: #CC0000; }
button {
    background: #006400; color: white; border: none;
    padding: 16px 40px; border-radius: 8px; font-size: 1.2em;
    cursor: pointer; width: 100%; max-width: 500px; margin: 8px 0;
}
button:active { background: #004d00; }
button:disabled { background: #999; }
button.secondary { background: #666; font-size: 1em; padding: 12px 40px; }
.note { color: #999; font-size: 0.8em; margin-top: 20px; text-align: center;
    max-width: 500px; line-height: 1.4; }
</style>
</head>
<body>
<h1>Stratux Data Extract</h1>
<p class="subtitle">Flight recording from localStorage</p>

<div class="status" id="statusBox">
    <div class="label">Flight Recording</div>
    <div class="value" id="pointCount">Checking...</div>
    <div class="label">Session Start</div>
    <div class="value" id="sessionStart">--</div>
    <div class="label">Recording State</div>
    <div class="value" id="recState">--</div>
</div>

<button id="btnCSV" onclick="downloadCSV()" disabled>Download CSV</button>
<button class="secondary" id="btnJSON" onclick="downloadJSON()" disabled>Download Raw JSON</button>

<p class="note" id="allKeys"></p>
<p class="note">
    This page reads flight data stored in Safari's localStorage for this origin.
    Downloads are generated entirely on the iPad.
</p>

<script>
var rawData = null;
var parsedData = null;

// Show all localStorage keys for debugging
try {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
        keys.push(localStorage.key(i));
    }
    document.getElementById('allKeys').textContent =
        'localStorage keys found: ' + (keys.length > 0 ? keys.join(', ') : '(none)');
} catch(e) {
    document.getElementById('allKeys').textContent = 'Could not read localStorage: ' + e.message;
}

try {
    rawData = localStorage.getItem('flightDataRecording');
} catch(e) {
    document.getElementById('pointCount').textContent = 'Error: ' + e.message;
    document.getElementById('pointCount').className = 'value red';
}

if (rawData) {
    try {
        parsedData = JSON.parse(rawData);
        var pts = parsedData.points || [];
        var box = document.getElementById('statusBox');
        var countEl = document.getElementById('pointCount');
        var startEl = document.getElementById('sessionStart');
        var stateEl = document.getElementById('recState');

        countEl.textContent = pts.length + ' data points';
        countEl.className = 'value green';
        box.className = 'status has-data';

        if (parsedData.sessionStart) {
            var d = new Date(parsedData.sessionStart);
            startEl.textContent = d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
        }

        stateEl.textContent = parsedData.isRecording ? 'Active' : 'Stopped';

        document.getElementById('btnCSV').disabled = (pts.length === 0);
        document.getElementById('btnJSON').disabled = false;
    } catch(e) {
        document.getElementById('pointCount').textContent = 'Parse error: ' + e.message;
        document.getElementById('pointCount').className = 'value red';
    }
} else {
    document.getElementById('pointCount').textContent = 'No data found';
    document.getElementById('pointCount').className = 'value red';
    document.getElementById('statusBox').className = 'status no-data';
}

function downloadCSV() {
    if (!parsedData || !parsedData.points || parsedData.points.length === 0) return;
    var pts = parsedData.points;
    var header = 'Zulu_Time,MP,Oil Temp,Oil Pressure,Fuel Pressure,Volts,Amps,RPM,Fuel Flow,Gallons Remaining,Fuel Level 1,Fuel Level 2,Carb Temp,GP 2,GP 3,Thermalcouple,EGT 1,EGT 2,EGT 3,EGT 4,CHT 1,CHT 2,CHT 3,CHT 4,date,time_z,longitude,latitude,altitude_ft,speed_kts,bank,pitch,acc_vert,course,EGT Spread,CHT Spread,Max EGT,Final_Percent_Power,Operating_Condition,Percent,SFC';
    var csv = header + '\\n';
    for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        csv += [
            p.zulu_time, p.mp, p.oil_temp, p.oil_press, p.fuel_press,
            p.volts, p.amps, p.rpm, p.fuel_flow, p.gallons_rem,
            p.fuel_l1, p.fuel_l2, p.carb_temp, p.gp2, p.gp3, p.thermo,
            p.egt1, p.egt2, p.egt3, p.egt4, p.cht1, p.cht2, p.cht3, p.cht4,
            p.date, p.time_z, p.longitude, p.latitude, p.altitude_ft,
            p.speed_kts, p.bank, p.pitch, p.acc_vert, p.course,
            p.egt_spread, p.cht_spread, p.max_egt, p.percent_power,
            p.operating_condition, p.rop_lop_percent, p.sfc
        ].join(',') + '\\n';
    }
    var startDate = parsedData.sessionStart ? new Date(parsedData.sessionStart) : new Date();
    var filename = 'flight_' + startDate.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.csv';
    triggerDownload(csv, filename, 'text/csv');
}

function downloadJSON() {
    if (!rawData) return;
    var startDate = parsedData && parsedData.sessionStart ? new Date(parsedData.sessionStart) : new Date();
    var filename = 'flight_raw_' + startDate.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    triggerDownload(rawData, filename, 'application/json');
}

function triggerDownload(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
</script>
</body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(HTML_PAGE.encode())

    def log_message(self, format, *args):
        print(f"  iPad request: {args[0]}")


def find_wifi_interface():
    """Find the wireless interface name."""
    try:
        result = subprocess.run(['nmcli', '-t', '-f', 'DEVICE,TYPE', 'device'],
                                capture_output=True, text=True)
        for line in result.stdout.strip().split('\n'):
            parts = line.split(':')
            if len(parts) == 2 and parts[1] == 'wifi':
                return parts[0]
    except Exception:
        pass
    # Common defaults
    for name in ['wlan0', 'wlp2s0', 'wlp3s0']:
        if os.path.exists(f'/sys/class/net/{name}'):
            return name
    return None


def start_hotspot(iface):
    """Create a WiFi hotspot with the Stratux IP address."""
    print(f"  Creating WiFi hotspot on {iface}...")

    # Remove old connection if it exists
    subprocess.run(['nmcli', 'connection', 'delete', CON_NAME],
                   capture_output=True)

    # Create hotspot connection with Stratux IP
    result = subprocess.run([
        'nmcli', 'connection', 'add',
        'type', 'wifi',
        'ifname', iface,
        'con-name', CON_NAME,
        'autoconnect', 'no',
        'ssid', HOTSPOT_SSID,
        '802-11-wireless.mode', 'ap',
        '802-11-wireless.band', 'bg',
        'ipv4.method', 'shared',
        'ipv4.addresses', f'{HOTSPOT_IP}/24',
        'wifi-sec.key-mgmt', 'wpa-psk',
        'wifi-sec.psk', HOTSPOT_PASS,
    ], capture_output=True, text=True)

    if result.returncode != 0:
        print(f"  ERROR creating hotspot: {result.stderr.strip()}")
        return False

    # Bring it up
    result = subprocess.run(['nmcli', 'connection', 'up', CON_NAME],
                            capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR starting hotspot: {result.stderr.strip()}")
        return False

    return True


def stop_hotspot():
    """Remove the hotspot and restore normal WiFi."""
    print("  Removing hotspot...")
    subprocess.run(['nmcli', 'connection', 'down', CON_NAME], capture_output=True)
    subprocess.run(['nmcli', 'connection', 'delete', CON_NAME], capture_output=True)
    print("  Hotspot removed. Your WiFi should reconnect automatically.")


def main():
    if os.geteuid() != 0:
        print("  This script needs root to create a WiFi hotspot.")
        print("  Run with: sudo python3 extract_local_data.py")
        sys.exit(1)

    iface = find_wifi_interface()
    if not iface:
        print("  ERROR: No WiFi interface found.")
        sys.exit(1)

    print(f"\n  WiFi interface: {iface}")

    if not start_hotspot(iface):
        sys.exit(1)

    # Give the hotspot a moment to start
    time.sleep(2)

    print(f"""
  =============================================
  Hotspot ready!

  WiFi:     {HOTSPOT_SSID}
  Password: {HOTSPOT_PASS}

  Steps:
    1. On iPad, connect to WiFi "{HOTSPOT_SSID}"
    2. Open the engine monitor from the home screen
    3. Download your data
    4. Ctrl+C here when done
  =============================================
""")

    server = http.server.HTTPServer(('0.0.0.0', PORT), Handler)

    def cleanup(sig=None, frame=None):
        print("\n  Shutting down...")
        server.shutdown()
        stop_hotspot()
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        cleanup()


if __name__ == '__main__':
    main()
