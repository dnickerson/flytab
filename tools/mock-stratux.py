#!/usr/bin/env python3
"""
Mock Stratux WebSocket server for FlyTab ADS-B display testing.
Serves /traffic, /situation, /weather, /jsonio on a configurable port.

Usage:
    python3 tools/mock-stratux.py [--port PORT] [--lat LAT] [--lon LON]

Default port: 5678 (matches cockpit-config.json simBridgePort default)
Default position: 35.0, -80.0 (KLKR area)

Setup in cockpit-config.json:
    "simMode": true,
    "simBridgeIp": "localhost",   (or dev machine LAN IP for tablet testing)
    "simBridgePort": 5678

Then reload the app — it will connect to this server instead of Stratux.
"""

import asyncio
import json
import math
import time
import argparse
import websockets
import websockets.server

# ---------------------------------------------------------------------------
# Ownship state — moves east at 150 kts
# ---------------------------------------------------------------------------
OWN_LAT   = 35.0
OWN_LON   = -80.0
OWN_ALT   = 5000    # ft MSL
OWN_SPEED = 150     # kts
OWN_TRACK = 90      # degrees true

# ---------------------------------------------------------------------------
# Static traffic catalog — positions are lat/lon offsets from ownship origin.
# Planes move based on their track/speed each update tick.
# ---------------------------------------------------------------------------
# 1 deg lat  ≈ 60 NM
# 1 deg lon  ≈ 60 * cos(35°) ≈ 49 NM  →  1 NM ≈ 0.0204°

_TRAFFIC_INIT = [
    # Normal white targets — well separated
    {"icao": 0xABC001, "tail": "N123AB", "dlat":  0.25,  "dlon":  0.0,   "alt": 3500, "track": 270, "speed": 120, "vvel":    0},
    {"icao": 0xABC002, "tail": "N456CD", "dlat":  0.0,   "dlon":  0.40,  "alt": 6500, "track": 180, "speed": 200, "vvel": -500},
    {"icao": 0xABC003, "tail": "N789EF", "dlat": -0.15,  "dlon":  0.15,  "alt": 4800, "track":  45, "speed": 140, "vvel":  200},
    {"icao": 0xABC004, "tail": "N012GH", "dlat": -0.35,  "dlon":  0.0,   "alt": 2500, "track":   0, "speed":  90, "vvel":    0},
    {"icao": 0xABC005, "tail": "N345IJ", "dlat":  0.0,   "dlon": -0.30,  "alt": 5500, "track":  90, "speed": 175, "vvel":    0},
    # Yellow caution — within ~3 NM, within 1000 ft
    {"icao": 0xABC006, "tail": "N678KL", "dlat":  0.035, "dlon":  0.035, "alt": 5200, "track": 225, "speed": 160, "vvel":    0},
    # Red proximate — within ~1 NM, within 500 ft
    {"icao": 0xABC007, "tail": "N999TH", "dlat":  0.008, "dlon":  0.012, "alt": 4900, "track": 270, "speed": 150, "vvel":    0},
]

# Runtime state — lat/lon updated each tick
_traffic = [dict(t) for t in _TRAFFIC_INIT]
for t in _traffic:
    t["lat"] = OWN_LAT + t["dlat"]
    t["lon"] = OWN_LON + t["dlon"]

_start_time = time.time()

# Connected client sets for each endpoint
_traffic_clients   = set()
_situation_clients = set()
_weather_clients   = set()
_jsonio_clients    = set()


def _elapsed():
    return time.time() - _start_time


def _ownship_pos():
    """Ownship drifts east over time."""
    t = _elapsed()
    # 150 kts east = ~0.00051 deg lon/sec at 35°N
    lon_rate = (OWN_SPEED / 3600.0) / 49.0   # deg/sec
    return OWN_LAT, OWN_LON + t * lon_rate


def _situation_msg():
    lat, lon = _ownship_pos()
    return {
        "GPSLatitude":          lat,
        "GPSLongitude":         lon,
        "GPSAltitudeMSL":       float(OWN_ALT),
        "BaroPressureAltitude": float(OWN_ALT - 50),
        "GPSGroundSpeed":       float(OWN_SPEED),
        "GPSTrueCourse":        float(OWN_TRACK),
        "GPSVerticalSpeed":     0.0,
        "GPSFixQuality":        2,
        "GPSSatellites":        9,
        "GPSSatellitesSeen":    11,
        "AHRSPitch":            1.5,
        "AHRSRoll":             0.5,
        "AHRSGLoad":            1.0,
        "AHRSGLoadMin":         0.98,
        "AHRSGLoadMax":         1.02,
    }


def _update_traffic():
    """Advance each traffic target by one 2-second tick."""
    dt = 2.0   # seconds per update
    for t in _traffic:
        # Convert speed (kts) + track (deg) to lat/lon deltas
        track_rad = math.radians(t["track"])
        nm_per_sec = t["speed"] / 3600.0
        dlat = math.cos(track_rad) * nm_per_sec * dt / 60.0
        dlon = math.sin(track_rad) * nm_per_sec * dt / (60.0 * math.cos(math.radians(t["lat"])))
        t["lat"] += dlat
        t["lon"] += dlon
        t["alt"] += t["vvel"] * dt / 60.0


def _traffic_msgs():
    msgs = []
    for t in _traffic:
        msgs.append({
            "Icao_addr":            t["icao"],
            "Tail":                 t["tail"],
            "Lat":                  round(t["lat"], 6),
            "Lng":                  round(t["lon"], 6),
            "Alt":                  int(t["alt"]),
            "Track":                t["track"],
            "Speed":                t["speed"],
            "Vvel":                 t["vvel"],
            "Squawk":               "1200",
            "OnGround":             False,
            "Age":                  0.0,
            "ExtrapolatedPosition": False,
            "SignalLevel":          -45.0,
            "TargetType":           1,
        })
    return msgs


async def _broadcast(clients, payload):
    if not clients:
        return
    text = json.dumps(payload)
    dead = set()
    for ws in list(clients):
        try:
            await ws.send(text)
        except Exception:
            dead.add(ws)
    clients -= dead


async def _traffic_loop():
    while True:
        _update_traffic()
        for msg in _traffic_msgs():
            await _broadcast(_traffic_clients, msg)
        await asyncio.sleep(2.0)


async def _situation_loop():
    while True:
        await _broadcast(_situation_clients, _situation_msg())
        await asyncio.sleep(1.0)


async def handler(websocket):
    try:
        path = websocket.request.path
    except AttributeError:
        path = getattr(websocket, "path", "/")

    if path == "/traffic":
        _traffic_clients.add(websocket)
        print(f"  [+] traffic client  ({len(_traffic_clients)} connected)")
        try:
            await websocket.wait_closed()
        finally:
            _traffic_clients.discard(websocket)
            print(f"  [-] traffic client  ({len(_traffic_clients)} connected)")

    elif path == "/situation":
        _situation_clients.add(websocket)
        print(f"  [+] situation client ({len(_situation_clients)} connected)")
        try:
            await websocket.wait_closed()
        finally:
            _situation_clients.discard(websocket)
            print(f"  [-] situation client ({len(_situation_clients)} connected)")

    elif path == "/weather":
        _weather_clients.add(websocket)
        try:
            await websocket.wait_closed()
        finally:
            _weather_clients.discard(websocket)

    elif path == "/jsonio":
        _jsonio_clients.add(websocket)
        try:
            await websocket.wait_closed()
        finally:
            _jsonio_clients.discard(websocket)

    else:
        await websocket.close(1008, f"unknown path: {path}")


async def main(host, port):
    print(f"Mock Stratux  →  ws://{host}:{port}")
    print(f"  Ownship: {OWN_LAT}°N {abs(OWN_LON)}°W  {OWN_ALT} ft  {OWN_TRACK}°  {OWN_SPEED} kts")
    print(f"  Traffic: {len(_traffic)} targets  (2 normal, 1 caution, 1 proximate + {len(_traffic)-4} more)")
    print()
    print("cockpit-config.json:")
    print('  "simMode": true,')
    print(f'  "simBridgeIp": "localhost",')
    print(f'  "simBridgePort": {port}')
    print()

    async with websockets.serve(handler, host, port):
        await asyncio.gather(
            _traffic_loop(),
            _situation_loop(),
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Mock Stratux WebSocket server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=5678, help="Port (default: 5678)")
    parser.add_argument("--lat",  type=float, default=OWN_LAT)
    parser.add_argument("--lon",  type=float, default=OWN_LON)
    args = parser.parse_args()

    OWN_LAT = args.lat
    OWN_LON = args.lon

    try:
        asyncio.run(main(args.host, args.port))
    except KeyboardInterrupt:
        print("\nStopped.")
