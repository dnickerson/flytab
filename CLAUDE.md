# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

FlyTab is an Android cockpit app for experimental aircraft. It runs as a Capacitor web app (vanilla JavaScript, no framework) and communicates with a Raspberry Pi running a Python engine monitor and an unmodified Stratux ADS-B/GPS receiver.

## Build & Deploy Commands

```bash
# Build Android APK (syncs web assets, compiles, copies APK to data/)
bash build.sh

# Deploy engine monitor to Pi
bash deploy-pi.sh          # Basic deploy
bash deploy-pi.sh --clean  # Also removes old tiles/NASR/plates
bash deploy-pi.sh --full   # Also restarts services

# Start home server (tiles, plates, NASR, CIFP) on port 8090
bash start-home-server.sh

# Test the full data pipeline (serial → engine monitor → FlyTab)
bash test-pipeline.sh
bash test-pipeline.sh --rate 30        # 30x playback speed
bash test-pipeline.sh --file <name>    # Specific file
bash test-pipeline.sh --stop           # Stop test
```

There are no automated tests and no npm build step — all JS is loaded directly via `<script>` tags in `web/index.html`.

## Architecture

### Data flow

```
Stratux (unmodified)  ──WebSocket──▶  web/shared/stratux-client.js
                                       └─ GPS, ADS-B traffic, FIS-B weather

EDM serial port  ──▶  engine-monitor/engine_monitor.py (Python, HTTP/WS on :8080)
                       └─ EGT, CHT, RPM, MP, fuel flow  ──HTTP──▶  web/shared/engine-client.js

Home server (:8090)  ──HTTP──▶  map tiles, approach plates, NASR, CIFP data
```

### Frontend (`web/`)

- **Entry point**: `web/app.js` — `FlyTabApp` class instantiates and wires all modules.
- **`web/index.html`** — loads all libraries and modules via `<script>` tags (no bundler).
- **`web/cockpit/`** — 40+ specialized UI components (map, engine, weather, checklists, logbook, etc.).
- **`web/shared/`** — client libraries shared across components:
  - `stratux-client.js`, `engine-client.js`, `fisb-client.js`, `weather-client.js`
  - `flight-plan-model.js`, `gps-source.js`, `nasr-db.js`
  - `fuel-engine.js`, `fuel-state.js`, `wb-calculator.js`, `cockpit-config.js`
- **`web/lib/`** — vendored third-party libs: Leaflet, Chart.js, PDF.js, jszip.

### Backend (`engine-monitor/`)

- `engine_monitor.py` (v3.3.0) — HTTP server + WebSocket on Pi, parses EDM serial data.
- `data_simulator.py` — replays captured flight files as virtual serial for testing.

### Android wrapper (`android/`)

Standard Capacitor/Gradle project. Mixed HTTP content is explicitly allowed in the Capacitor config so the WebView can reach the Pi and home server over HTTP.

## Configuration Files

| File | Purpose |
|------|---------|
| `web/cockpit-config.json` | UI defaults: map layers, overlays, chart limits, FIS-B settings |
| `web/aircraft-config.json` | Aircraft performance: speeds, power settings, W&B (RV-9A N194JT) |
| `web/checklist.json` | VFR checklist sections |
| `web/version.json` | Version tracking |
| `capacitor.config.ts` | Capacitor/Android settings |

## Key Conventions

- **Versioning**: The app version lives at the top of `web/app.js`. `build.sh` reads it and sets `versionCode`/`versionName` in `build.gradle` automatically.
- **No bundler**: Add new JS modules as `<script>` tags in `web/index.html`. Load order matters — shared modules must come before cockpit components.
- **Styling**: All CSS is in `web/style.css` (monolithic). High-contrast cockpit design is intentional for sunlight readability.
- **Storage**: App state uses `localStorage` and `IndexedDB` on the client. No cloud storage.
