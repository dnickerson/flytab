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
| `web/aircraft-config.json` | Aircraft performance: speeds, power settings, W&B (RV-9A N194JT, Lycoming O-360 A1A) |
| `web/checklist.json` | VFR checklist sections |
| `capacitor.config.ts` | Capacitor/Android settings |

## Data Pipeline Dependencies

- **`pyshp` required for Class B/C/D/E airspace**: `~/fly-pipeline/build_nasr.py` parses Class B/C/D/E airspace from FAA shapefiles (`Additional_Data/Shape_Files/Class_Airspace.*` inside the NASR zip). Without `pyshp` installed, the step is silently skipped and the bundle only contains 26 ARTCC boundaries — no controlled airspace around airports. Install with `pip install pyshp --break-system-packages`.
- **Home server data directory**: `start-home-server.sh` expects data at `~/flytab/data/`. NASR output lives in `~/fly-pipeline/data/nasr/`. If the `data/` dir is missing, the server crashes and the systemd service (`flytab-data.service`) loops in failure every 10 seconds. Fix with: `mkdir -p ~/flytab/data && ln -s ~/fly-pipeline/data/nasr ~/flytab/data/nasr`. The service recovers automatically once the directory exists.
- **NASR update on tablet**: After rebuilding the bundle, start the home server and restart FlyTab on the tablet while on home WiFi — the app fetches and imports the bundle automatically at startup. The staleness check compares `sua_count` in the home server's `cycle_info.json` against what's stored in IDB meta — if they differ, it re-imports from the home server automatically.
- **Do not import data into the tablet via CDP/DevTools** — writing directly to the WebView's IndexedDB bypasses app integrity checks and can cause protection errors.
- **SAA AIXM boundary parsing**: All 1234 SUA XML files have `gml:PolygonPatch/LinearRing/pos` with pre-computed coordinates — use this as primary boundary source. `gml:Curve` (arcs/circles) is only present in 795 files; keep as fallback only. Files without `Curve` (e.g. R-6001A/B) were silently skipped before this fix.
- **SAA AIXM designator scoping**: `root.iter('{aixm}designator')` picks up `OrganisationAuthority` designators (FAA, USAF, USN…) that appear before the `AirspaceTimeSlice`. Always scope to `root.iter('{aixm}AirspaceTimeSlice')` and find `designator` within that element.
- **SUA layer is off by default**: `sua: false` in `cockpit-config.json`. Pilot must enable in the layer panel. The layer renders R/P/W/A/MOA areas from z6 up.
- **IDB transaction hang**: An extremely long JS execution during NASR import (parsing 18MB JSON + writing 98k records) can leave IDB connections in a blocked state where new `indexedDB.open()` calls never resolve. Force-stopping the app clears it.

## Leaflet Touch Handling

Leaflet's `.on('click')` and `.bindPopup()` are **unreliable on Android tablets** — Leaflet's drag handler swallows synthetic click events and `L.Map.Tap` is not loaded. Never rely on Leaflet's click pipeline for tap targets on map layers.

**Correct pattern — custom touchend + SVG CTM hit-test:**

```javascript
// Constructor:
this._tapStart = null;
this._onTapStart = (e) => {
    if (e.touches.length === 1)
        this._tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    else this._tapStart = null;
};
this._onTapEnd = (e) => {
    if (!this._tapStart || e.changedTouches.length !== 1) { this._tapStart = null; return; }
    const ts = this._tapStart; this._tapStart = null;
    const dx = e.changedTouches[0].clientX - ts.x;
    const dy = e.changedTouches[0].clientY - ts.y;
    if (dx*dx + dy*dy > 400) return;        // >20px = drag
    if (Date.now() - ts.t > 500) return;    // >500ms = long-press, not tap
    this._handleTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
};

// init(): register on map container
// IMPORTANT: capture:true on touchstart — Leaflet's disableClickPropagation
// (set via bubblingMouseEvents:false on airport/navaid markers) calls stopPropagation
// in the bubble phase, silently dropping touchstart if you listen in bubble phase.
const container = this._map.getContainer();
container.addEventListener('touchstart', this._onTapStart, { capture: true,  passive: true });
container.addEventListener('touchend',   this._onTapEnd,   { capture: false, passive: true });

// destroy(): remove both listeners (pass same capture flag used during add)

// Hit-test polygon elements via SVG coordinate transform:
_handleTap(clientX, clientY) {
    for (const entry of this._polygons) {
        const svgPath = entry.polygon.getElement();
        if (!svgPath) continue;
        const svg = svgPath.ownerSVGElement;
        if (!svg) continue;
        try {
            const pt = svg.createSVGPoint();
            pt.x = clientX; pt.y = clientY;
            const local = pt.matrixTransform(svgPath.getScreenCTM().inverse());
            if (svgPath.isPointInFill(local) || svgPath.isPointInStroke(local)) {
                entry.polygon.openPopup();
                return;
            }
        } catch (_) {}
    }
}
```

**Popup sizing** — use `bindPopup` options, not CSS on `.leaflet-popup-content-wrapper` (Leaflet overrides wrapper styles internally):

```javascript
polygon.bindPopup(html, { minWidth: 480, maxWidth: 600, className: 'my-popup-container' });
```

Style inner content only; enlarge close button via the container class:

```css
.my-popup-container .leaflet-popup-tip { display: none; }
.my-popup-container .leaflet-popup-close-button {
    width: 44px !important; height: 44px !important;
    font-size: 28px !important; line-height: 44px !important;
}
```

## Key Conventions

- **Versioning**: The app version lives at the top of `web/app.js`. `build.sh` reads it and sets `versionCode`/`versionName` in `build.gradle` automatically.
- **No bundler**: Add new JS modules as `<script>` tags in `web/index.html`. Load order matters — shared modules must come before cockpit components.
- **Styling**: All CSS is in `web/style.css` (monolithic). High-contrast cockpit design is intentional for sunlight readability.
- **Storage**: App state uses `localStorage` and `IndexedDB` on the client. No cloud storage.
