# FlyTab

A personal Electronic Flight Bag (EFB) for experimental aircraft, designed to run on a **Lenovo Yoga Tab Plus** Android tablet. Built specifically for an RV-9A with a Lycoming O-360-A1A engine, though most features work with any aircraft and Stratux-compatible avionics stack.

What's unique is that this EFB combines flight data with weather, engine monitoring and emergency procedures.

The engine data is collected from a Dynon D-180 connected to the same Raspberry Pi running the Stratux software, with a USB to RS-232 Serial Adapter. I use a INSIGNIA 23k02h.

This is a personal project — not a commercial product, not certified avionics. For reference use only.

The UI/UX is a little rough as I'm not a UI designer but it works for me.

---

## Hardware Stack

| Component                                  | Role                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| Lenovo Yoga Tab Plus (Android)             | Primary display — runs FlyTab APK                       |
| [Stratux](https://stratux.me) (unmodified) | ADS-B In, GPS, FIS-B weather via Wi-Fi                  |
| Raspberry Pi 4/5                           | Engine monitor relay — EDM serial → JSON/WebSocket      |
| EDM engine monitor (D-180 or compatible)   | EGT, CHT, RPM, MAP, fuel flow via RS-232                |
| Home server (Linux PC)                     | Map tiles, approach plates, NASR/CIFP data on port 8090 |

**Connectivity:**

- Tablet connects to Stratux hotspot (`192.168.10.1`) in flight
- Pi engine monitor listens on `:8080` (HTTP) and `:8082` (WebSocket)
- Home server serves offline data when on home Wi-Fi

---

## Features

### Moving Map

- Sectional, vector, and OpenStreetMap base layers
- Real-time ownship position from Stratux GPS
- ADS-B traffic overlay with altitude filtering
- Airspace classes B/C/D/E with configurable minimum zoom
- Navaids, airports, airways, and fixes overlays
- Route line with active leg highlighted
- NEXRAD radar loop (2-hour playback, configurable frame interval)
- Lightning overlay
- Terrain elevation grid

### Engine Monitoring

- Live EGT/CHT per cylinder, RPM, MAP, fuel flow, oil pressure, volts, carb temp
- 30-minute EGT/CHT trend charts
- BSFC (brake-specific fuel consumption) calculation
- Peak EGT detection with lean-of-peak delta
- **ML anomaly detection** — trained on 2,004 actual cruise data points; flags deviations from established engine patterns
- **Emergency glide calculator** — on ML-confirmed engine anomaly, ranks reachable airports by glide distance, with live approach guidance panel:
  - Heading and distance to selected airport
  - Overhead target altitude for 2 nm emergency pattern → 500 ft threshold crossing
  - ON PROFILE / HIGH / LOW status with required vs actual V/S
  - Best runway from METAR wind (nearest METAR fallback when own-airport METAR unavailable)
  - CTAF / Tower frequencies
  - Live route line drawn on map; panel shrinks to reveal map below
  - Best-glide (DMMS) airspeed reminder

### Fuel Management

- Fuel remaining with caution/warning thresholds
- Tic mark to gallons conversion using calibration polynomial
- Fuel burn history and endurance calculations
- Power/speed trade-off panel with actual performance data
- Weight & balance calculator

### Flight Planning & Navigation

- Route editor — enter waypoints, airways, and airports
- Nav strip: bearing, distance, ETE, groundspeed, fuel remaining, wind
- Route table with per-leg fuel and time calculations
- Fuel stop planner
- Integration with [flywhere.app](https://www.flywhere.app) for flight plan sync via `flytab://plan/{uuid}` deep link

### Approach Charts

- Downloadable georeferenced approach plates
- Ownship position overlay on plate (GPS-aware)
- Auto-rotate track-up option
- Preload plates for entire route
- State-by-state plate management (admin UI on home server)

### Weather

- FIS-B METAR/TAF display from Stratux
- NEXRAD radar playback
- Wind display with runway crosswind components
- Airport weather popup from map tap

### Logbook

- Auto-record flights on engine start (configurable RPM threshold)
- Manual entry creation
- Sync to flywhere.app
- Hobbs time tracking

### IFR Tools

- CRAFT clearance entry form
- CD phone directory (configurable per facility)

### Checklists

- Normal, abnormal, and emergency checklists (customizable via `checklist.json`)
- Preflight weather brief generator

---

## Architecture

```
Stratux (unmodified)  ──WebSocket──▶  stratux-client.js
                                       └─ GPS, ADS-B traffic, FIS-B weather

EDM serial port  ──▶  engine-monitor/engine_monitor.py
                       └─ HTTP :8080 + WebSocket :8082  ──▶  engine-client.js

Home server (:8090)  ──HTTP──▶  map tiles, plates, NASR, CIFP
```

**Frontend:** Vanilla JavaScript Capacitor web app — no framework, no bundler. All modules loaded via `<script>` tags in `web/index.html`. 40+ specialized cockpit components in `web/cockpit/`.

**Android wrapper:** Standard Capacitor/Gradle project targeting Android 9+. Mixed HTTP content allowed so the WebView can reach the Pi and home server over HTTP.

**Backend (Pi):** `engine-monitor/engine_monitor.py` (Python) — reads EDM serial data, exposes HTTP status endpoint and WebSocket stream. Supports `--playback` mode for ground testing with captured flight files.

---

## Configuration

| File                       | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `web/cockpit-config.json`  | UI settings: map layers, overlays, radar, FIS-B, home server URLs          |
| `web/aircraft-config.json` | Aircraft performance: V-speeds, fuel capacity, glide ratio, power settings |
| `web/checklist.json`       | Checklist sections and items                                               |

The in-app **Configuration** page (MORE → ⚙) provides a GUI editor for all settings. Values are stored in `localStorage` and override the bundled JSON defaults.

### Quick-start configuration

1. Set your home server IP in cockpit-config.json (`homeServer.tileBase` etc.)
2. Set your aircraft parameters in `aircraft-config.json`
3. Set Stratux IP in the app (default `192.168.10.1`) if different
4. For flywhere.app integration, enter your API key in the Configuration page

---

## Build & Deploy

```bash
# Build Android APK
bash build.sh

# Deploy engine monitor to Pi
bash deploy-pi.sh              # deploy only
bash deploy-pi.sh --full       # deploy + restart services

# Start home data server (tiles, plates, NASR) on port 8090
bash start-home-server.sh

# Test the full data pipeline with a captured flight file
bash test-pipeline.sh
bash test-pipeline.sh --rate 30    # 30x playback speed
bash test-pipeline.sh --stop       # restore normal engine monitor
```

**Requirements:**

- Android Studio (for Gradle / `gradlew`)
- Java 17+
- Android SDK (set `ANDROID_HOME`)
- Python 3.9+ (for home server and engine monitor)

---

## Pi Setup

```bash
# First-time deploy (installs engine-monitor service)
bash deploy-pi.sh --full

# Check service
ssh pi@192.168.1.X 'sudo systemctl status engine-monitor'
```

The Pi runs two services:

- **Stratux** (standard, unmodified) — ADS-B, GPS, FIS-B
- **engine-monitor** (`/opt/engine-monitor/`) — EDM serial → HTTP/WebSocket

---

## Data Sources

| Data                           | Source                        | Notes                     |
| ------------------------------ | ----------------------------- | ------------------------- |
| Navigation (airports, navaids) | FAA NASR                      | Updated 28-day cycles     |
| Approach plates                | FAA digital-TPP               | Served from home server   |
| Procedures (CIFP)              | FAA CIFP                      | IFR procedure data        |
| Map tiles                      | OpenStreetMap / FAA sectional | Served from home server   |
| Terrain elevation              | SRTM (1 arc-second)           | HGT tiles via home server |
| Weather (METAR/TAF/NEXRAD)     | FIS-B via Stratux             | In-flight only            |
| Traffic                        | ADS-B via Stratux             | 978 MHz UAT + 1090 ES     |

---

## Why the Lenovo Yoga Tab Plus

The short version: OLED sunlight readability + kick ass processor plus NPU + large battery + sideloadable APK.

It's actually become my go to mobile device. I don't take my laptop on trips anylonger as the Yoga Tab does everything

- Although it is a bit large I find it is a great form factor for the cockpit. 

- 12.7" OLED display — high brightness and deep blacks make it readable in direct sunlight, which is the hardest EFB condition to satisfy

- Accurate color reproduction makes weather radar, terrain, and airspace colors distinguishable in bright light   

- Snapdragon 870 — fast enough to run the Leaflet map, NEXRAD radar, ADS-B traffic overlay, ML inference, and approach plate rendering simultaneously without frame drops                                                       

- 8 GB RAM — the NASR database, tile cache, and approach plates all live in memory; less swapping during critical phases

- Capacitor targets Android natively; the APK can be sideloaded without an app
  store (this removes mountains of frustration)

- ADB wireless debugging works over Wi-Fi — allows updating the app on the   
  tablet from the development machine without a cable, even when the tablet is  
  mounted in the aircraft

- Android's "keep screen on" and "immersive mode" APIs work reliably; iPad PWA
  equivalents are inconsistent

- One downside is that it does not have a GPS chip but neither does the iPad

## Disclaimer

This is a personal hobby project. It is not certified, not tested for airworthiness, and should never be used as a primary navigation or systems reference. All decisions in the aircraft remain the pilot's responsibility.
