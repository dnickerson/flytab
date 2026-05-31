# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

FlyTab is an Android cockpit app for experimental aircraft. It runs as a Capacitor web app (vanilla JavaScript, no framework) and communicates with a Raspberry Pi running a Python engine monitor and an unmodified Stratux ADS-B/GPS receiver.

## Build Policy

Run `bash build.sh` automatically after any code change is complete — no need to wait for the user to ask. Always increment `FLYTAB_VERSION` in `web/app.js` before building (build.sh reads it to set versionCode/versionName).

If the change touches any file under `web/shared/planning/`, run `npm test` first and fix failures before building.

## Tap Handler Regression Rule

Any change to the three map tap handlers (`onAirportClick`, `onNavaidClick`, `onFixClick` in `app.js`) **must** verify that the airport info popup still opens on a normal tap before the work is considered complete. Tapping an airport to see its popup is a primary cockpit interaction — breaking it is a critical regression. This cannot be verified by the test suite; it requires manual confirmation or explicit acknowledgment that UI testing was not performed.

## User Manual

`docs/user-manual.md` is the pilot-facing reference for FlyTab. **Update it whenever a user-visible feature is shipped.** This means any change that adds, removes, or meaningfully alters something the pilot sees or interacts with — new layer panel toggles, new map overlays, new tab content, new MORE drawer items, changed behavior of existing controls.

Update the manual as part of the same commit as the feature code. Do not batch manual updates for later.

What counts as user-visible:
- New or renamed toggle in the layer panel
- New map overlay or marker type
- New tab, panel, or drawer item
- Changed behavior a pilot would notice (e.g. a polygon now expands, an arrow now appears)
- New status bar badge or changed badge semantics
- Any new workflow step the pilot must follow

What does not need a manual update:
- Bug fixes that restore previously correct behavior
- Internal refactors with no visible effect
- Performance improvements with no behavioral change
- Developer tooling (tools/, scripts)

## Build & Deploy Commands

```bash
# Build Android APK (syncs web assets, compiles, copies APK to data/)
bash build.sh

# Deploy engine monitor to Pi
bash deploy-pi.sh          # Basic deploy
bash deploy-pi.sh --clean  # Also removes old tiles/NASR/plates
bash deploy-pi.sh --full   # Also restarts services

# Start home server (tiles, plates, NASR, CIFP) on port 8090
bash ~/fly-pipeline/start-home-server.sh

# Test the full data pipeline (serial → engine monitor → FlyTab)
bash test-pipeline.sh
bash test-pipeline.sh --rate 30        # 30x playback speed
bash test-pipeline.sh --file <name>    # Specific file
bash test-pipeline.sh --stop           # Stop test
```

The planning library (`web/shared/planning/`) has a vitest test suite in `tests/`. Run with `npm test`. All other app JS is loaded directly via `<script>` tags in `web/index.html` — no test coverage there.

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
- **Home server data directory**: `start-home-server.sh` serves directly from `~/fly-pipeline/data/`. All data (NASR, CIFP, plates, terrain, tiles, mbtiles) lives there — no symlinks needed in `~/flytab/data/`. If the pipeline directory is missing the server fails at startup.
- **NASR update on tablet**: After rebuilding the bundle, start the home server and restart FlyTab on the tablet while on home WiFi — the app fetches and imports the bundle automatically at startup. The staleness check compares `sua_count` in the home server's `cycle_info.json` against what's stored in IDB meta — if they differ, it re-imports from the home server automatically.
- **Do not import data into the tablet via CDP/DevTools** — writing directly to the WebView's IndexedDB bypasses app integrity checks and can cause protection errors.
- **SAA AIXM boundary parsing**: All 1234 SUA XML files have `gml:PolygonPatch/LinearRing/pos` with pre-computed coordinates — use this as primary boundary source. `gml:Curve` (arcs/circles) is only present in 795 files; keep as fallback only. Files without `Curve` (e.g. R-6001A/B) were silently skipped before this fix.
- **SAA AIXM designator scoping**: `root.iter('{aixm}designator')` picks up `OrganisationAuthority` designators (FAA, USAF, USN…) that appear before the `AirspaceTimeSlice`. Always scope to `root.iter('{aixm}AirspaceTimeSlice')` and find `designator` within that element.
- **SUA layer is off by default**: `sua: false` in `cockpit-config.json`. Pilot must enable in the layer panel. The layer renders R/P/W/A/MOA areas from z6 up.
- **IDB transaction hang**: An extremely long JS execution during NASR import (parsing 18MB JSON + writing 98k records) can leave IDB connections in a blocked state where new `indexedDB.open()` calls never resolve. Force-stopping the app clears it.

## AWC Network Calls Must Go Through the flywhere Proxy

**Never fetch `aviationweather.gov` directly from app code.** The Capacitor WebView runs as `http://localhost` — AWC sends no `Access-Control-Allow-Origin` header on any endpoint, so the browser silently blocks every direct AWC fetch. The error is swallowed and the feature just doesn't work.

All AWC calls must route through `Settings.workerBase` (defaults to `https://www.flywhere.app/api`):

```javascript
const base = (typeof Settings !== 'undefined' && Settings.workerBase)
    ? Settings.workerBase : 'https://www.flywhere.app/api';
const url = `${base}/weather?type=windtemp&region=all&level=low&fcst=${cycle}`;
```

The proxy at `flywhere/app/api/weather/route.ts` accepts `type=` values: `metar`, `taf`, `windtemp`, `pirep`, `airsigmet`, `fcstdisc`, `gairmet`. All other query params are forwarded to AWC verbatim.

**When adding a new AWC endpoint type to the proxy**, verify the response branch in `route.ts` includes `'Access-Control-Allow-Origin': '*'` — the text/plain and JSON branches are separate and both must carry the header. Missing it on the plain-text branch is how `windtemp` was broken (May 2026).

## Display Bugs From External Data — Inspect Before Fixing

**When a UI bug involves rendering data from an external API, hit the live endpoint and inspect the actual response BEFORE writing any fix.** Field names, value formats, and special tokens are routinely surprising and can't be inferred from the symptom or the existing parser. Guessing at semantics produces fixes that look correct in the diff but fail in production — and burns multiple iterations to discover what 30 seconds of `curl | jq` would have shown up front.

This rule applies whenever the bug is "display X looks wrong" and X comes from a network source: AWC, FAA NMS-API, NWS, Stratux FIS-B JSON frames, etc. It does NOT apply to bugs in pure local logic (touch handling, layout, state machines).

### AWC G-AIRMET data conventions (verified April 2026)

These caught me five times before I inspected the raw API. Endpoint: `https://aviationweather.gov/api/data/gairmet?format=json`.

- **Numeric altitudes are in HUNDREDS of feet, not feet.** `"260"` means FL260 (26,000 ft). `"080"` means 8,000 ft. `"040"` means 4,000 ft. Apply `*100` when parsing.
- **`base: "FZL"` is a literal string token** for ICING G-AIRMETs, meaning "from the freezing level." The freezing-level range is in `fzlbase`/`fzltop`. Display as `FZL–<top>` with the FZL range as supplementary description, not "Below 160."
- **FZLVL G-AIRMETs are LINEs, not areas.** `geometryType: "LINE"`, with the freezing altitude in the `level` field. 11 of 13 active FZLVL items in a typical fetch are lines. Render with `L.polyline` (no fill); never `L.polygon`. Skip them in popup hit-tests — they're map overlays, not tappable weather areas.
- **Empty fields come back as empty strings (`""`), not null.** `?? null` does NOT normalize them. Use `(v != null && v !== '') ? v : null` or check both at the display site.
- **MT_OBSC and IFR have no altitude data at all** — all altitude fields are empty strings. Don't display "—" as a bug; that's correct (these are surface-to-ceiling advisories described entirely in `due_to`).

The shared parser/formatter for these lives in `web/shared/altitude-utils.js` (`parseAltFt`, `formatAlt`, `formatAdvisoryAltBand`). Use those — don't write inline alt-formatting closures.

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

## Spec Quality Requirements

Apply these rules to any spec or plan that touches more than one file:

**Interface contracts** — Name the exact field at every module boundary. "Pass altitude" is not enough; say "waypoint.altFt (number, feet) consumed by `recomputeLegs`; `route-table.js` reads `wp.altFt`, not `wp.alt`." Mismatches here produce silent null display bugs with no error.

**Trigger conditions** — Every picker, modal, or action must list all conditions that fire it — not just the primary one. "Fuel stop picker fires when route exceeds limit" is incomplete; say "fires on Plan tap AND on leg-limit button tap when a route already exists."

**State lifecycle** — For any async state or modal state, note what exists and when it's cleared. (`_lastPlan` is set by `plan()`, cleared on `open()`, never cleared by a leg-limit change.)

## EngineML Plugin

The `EngineML` Capacitor plugin runs a TFLite Conv1D autoencoder on 60-second rolling windows of engine data and produces anomaly scores, per-feature reconstruction errors, and rule-based advisories.

### Files

| File | Purpose |
|------|---------|
| `android/app/src/main/assets/anomaly_v2.tflite` | TFLite model (currently float32, ~379K) |
| `android/app/src/main/assets/anomaly_v2_metadata.json` | Normalization stats, per-phase thresholds, feature list |
| `android/app/src/main/java/.../engineml/InferenceEngine.java` | TFLite wrapper — dtype detection, inference, MSE |
| `android/app/src/main/java/.../engineml/EngineMLPlugin.java` | Capacitor bridge — rolling window, calls InferenceEngine + EngineAdvisor |
| `android/app/src/main/java/.../engineml/EngineAdvisor.java` | Rule-based advisories — trends, mixture, carb ice, fuel |
| `android/app/src/main/java/.../engineml/PhaseDetector.java` | Flight phase from RPM + altitude + ground speed |
| `web/cockpit/engine-ml.js` | JS bridge — calls plugin at 1Hz, exposes `window.engineML.lastResult` |

### Feature Array — 12 Features, No Altitude

The v2 model takes **12 features**: `[RPM, EGT1, EGT2, EGT3, EGT4, CHT1, CHT2, CHT3, CHT4, OilTemp, OilPress, FuelFlow]` (indices 0–11).

**Altitude is NOT a model feature.** It is extracted from the JS call separately and passed only to `PhaseDetector.detect()` and `EngineAdvisor.addSample()`. If the training model is retrained with altitude as a feature (index 12 like v1), `EngineAdvisor.java` and `EngineMLPlugin.java` both need updating — they currently expect 12-element feature arrays.

### Dtype — Detect at Runtime, Never Assume

The `anomaly_v2_metadata.json` `"quantization"` field is documentation only and has been wrong before. `InferenceEngine.java` always calls `interpreter.getInputTensor(0).dataType()` after loading and branches on `isFloat32`. **Never hard-code INT8 or float32 assumptions in the inference path.**

**What breaks when dtype is wrong:**
- INT8 code on a float32 model: allocates 1/4 the required buffer → `interpreter.run()` hangs indefinitely, blocking the Capacitor main thread and all subsequent plugin calls
- Float32 code with XNNPACK partial delegation: `ByteBuffer` input/output is incompatible → `ArrayIndexOutOfBoundsException` inside the interpreter

**Always use Java arrays for float32** (`float[1][windowSize][nFeatures]`), not `ByteBuffer`. XNNPACK replaces 20 of 55 ops on this device and does not accept raw ByteBuffer for float32 models.

### Delegate Selection on Snapdragon 8 Gen 3 (TB520FU)

NNAPI and GPU delegates are rejected at load time (`"static-sized tensors only, graph has dynamic tensors"`). CPU with XNNPACK is the active delegate. Inference latency: **~2.5ms** per 60-sample window.

If a new model eliminates dynamic-shaped tensors, NNAPI may work — the warmup in `tryQnnDelegate()` handles it automatically. Check logcat on first launch after any model change:
```
InferenceEngine: NNAPI delegate loaded (warmup: 1ms → NPU (NNAPI))  ← NPU active
InferenceEngine: Using CPU delegate                                   ← NNAPI rejected
```

### Deploying a New Model

1. Replace `anomaly_v2.tflite` and `anomaly_v2_metadata.json` in `android/app/src/main/assets/`
2. Verify `n_features` in metadata matches what `EngineMLPlugin.N_FEATURES` sends (currently 12)
3. **Before building**, confirm the model dtype with Python:
   ```python
   import tensorflow as tf
   interp = tf.lite.Interpreter('anomaly_v2.tflite')
   interp.allocate_tensors()
   print(interp.get_input_details()[0]['dtype'])   # must match InferenceEngine path
   print(interp.get_input_details()[0]['shape'])   # must be [1, 60, 12]
   ```
4. After installing, run the on-device CDP test to confirm a score is returned:
   ```bash
   adb forward tcp:9223 localabstract:webview_devtools_remote_<PID>
   node /tmp/cdp-fill-window.js   # fills 60-sample window then checks for score
   ```
   A working result includes `"score"`, `"threshold"`, and `"featureErrors"` in the JSON.

### CDP Debugging

The FlyTab WebView inspector uses a PID-specific socket — not the default `chrome_devtools_remote`:
```bash
adb forward tcp:9223 localabstract:webview_devtools_remote_$(adb shell pidof app.flywhere.flytab)
curl http://localhost:9223/json   # should show title: "FlyTab", url: "http://localhost/"
```
Port 9222 is Chrome browser's DevTools — do not use it for FlyTab.

### ADB — use the SDK binary, not the distro one

There are two `adb` installs on this machine:

| Path | Version | Use? |
|------|---------|------|
| `~/Android/Sdk/platform-tools/adb` | **36.x** | ✅ Always use this one |
| `/usr/bin/adb` → `/usr/lib/android-sdk/...` | 34.0.4-debian | ❌ Stale, breaks wireless pairing |

Whichever binary starts the server on port 5037 owns it. If the old **v34** server answers the v36 client, `adb pair` fails with `error: protocol fault (couldn't read status message): Success` — every time, instantly. This is NOT a bad code/port/IP; it's the version mismatch.

**Before wireless pairing, force a clean v36 server:**
```bash
pkill -9 adb; sleep 1
~/Android/Sdk/platform-tools/adb start-server
~/Android/Sdk/platform-tools/adb pair <ip>:<pairing_port> <code>
```
Wireless-debugging pairing windows are single-use and short-lived — the code/port change every time the "Pair device with pairing code" dialog is reopened, and the pairing port closes after one attempt (success or fail). Have the fresh code/port ready and run `pair` immediately. After a successful pair, mDNS auto-connects (`adb devices` shows the device as `device`); no separate `adb connect` needed. The tablet (TB520FU) is on DHCP — its IP drifts (seen at .62/.63), so confirm the current IP rather than assuming.

## Key Conventions

- **Versioning**: The app version lives at the top of `web/app.js`. `build.sh` reads it and sets `versionCode`/`versionName` in `build.gradle` automatically.
- **No bundler**: Add new JS modules as `<script>` tags in `web/index.html`. Load order matters — shared modules must come before cockpit components.
- **Styling**: All CSS is in `web/style.css` (monolithic). High-contrast cockpit design is intentional for sunlight readability. Always use the design token system — never hardcode hex colors or raw px font sizes in component CSS or inline styles. See **Design Token Standards** below.

## Design Token Standards

All new UI must use CSS custom properties from `web/style.css`. Never use hardcoded hex colors, raw font-weight integers below 700, or brand-specific sizing constants.

### Color tokens

| Token | Role | Light value |
|-------|------|-------------|
| `var(--bg-primary)` | Page / overlay background | `#ffffff` |
| `var(--bg-surface)` | Card, section, input backgrounds | `#f5f5f5` |
| `var(--text-primary)` | Headings, primary values | `#1a1a2e` |
| `var(--text-secondary)` | Body text, field values, section labels | `#444444` |
| `var(--text-label)` | Column headers, field labels | `#666666` |
| `var(--text-muted)` | Hints, arm display, timestamps | `#888888` |
| `var(--accent)` | Accent buttons, active tabs | `#0066cc` |
| `var(--border)` | Card borders | `#e0e0e0` |
| `var(--border-light)` | Table row dividers | `#f0f0f0` |
| `var(--border-strong)` | Header borders, input underlines | `#b0b0b0` |
| `var(--color-success)` | In-limits, OK badges | `#1a8c35` |
| `var(--color-caution)` | Caution (non-urgent) | `#b87000` |
| `var(--color-danger)` | Out-of-limits, warnings, over-gross | `#cc2222` |
| `var(--color-info)` | Informational | `#0055bb` |

**Status badge pattern** (solid fill, matches `fo-grade-*`):
```css
/* OK / in-limits */
background: var(--color-success); color: #000;

/* Warning / out-of-limits */
background: var(--color-danger);  color: #fff;

/* Caution */
background: var(--color-caution); color: #000;
```

Never use semi-transparent rgba approximations of these colors for badges — use the solid token.

### Font tokens

| Token | Use case |
|-------|----------|
| `var(--font-instrument)` | All numeric instrument values (weights, altitudes, speeds, CG) |
| `var(--font-ui)` | Labels, section titles, button text, unit suffixes |

**Font weight rules** — minimum 700 for anything the pilot reads:
- Section titles, column headers: `font-weight: 800`
- Instrument / data values: `font-weight: 900`
- Unit suffixes, secondary labels: `font-weight: 700`
- Never use `font-weight: 600` or lower in cockpit UI

### Touch target

```css
min-height: var(--touch-min, 56px);   /* all interactive elements */
min-height: var(--touch-preferred, 64px);  /* primary actions */
```

Never hardcode `48px` as a touch target — use `var(--touch-min, 56px)`.

### Chart.js colors

Chart.js cannot read CSS custom properties at runtime. Use the light-theme design-system values directly (they are stable):

| Semantic | Hex to use |
|----------|------------|
| Success / in-envelope | `#1a8c35` |
| Danger / out-of-envelope | `#cc2222` |
| Accent / highlight | `#0066cc` |
| Muted / grid lines | `#b0b0b0` |

### New panel checklist

When writing a new cockpit overlay or panel, verify:
- [ ] All colors use `var(--…)` tokens — no hardcoded hex
- [ ] All numeric displays use `var(--font-instrument)` with `font-weight: 900`
- [ ] All section labels use `font-weight: 800; color: var(--text-secondary)`
- [ ] Status badges use solid `background: var(--color-success/danger/caution)` fill
- [ ] Touch targets use `min-height: var(--touch-min, 56px)` or larger
- [ ] The panel works in the light theme (do NOT set `data-mode="cockpit"` — see memory)
- **Storage**: App state uses `localStorage` and `IndexedDB` on the client. No cloud storage.
- **`wireTap` double-fire guard**: `tap-utils.js` uses a module-level `_wireTapLastTouchAt` timestamp to suppress synthetic clicks for 350ms after any touch. This is required because DOM rebuilds in `_renderWaypoints()` / `_onEdited()` replace the original element before the browser fires its synthetic click — a per-element flag doesn't survive the rebuild. Do not revert to per-closure `touchHandled` flags. `route-table.js` touchend delegation also updates this global.
- **Route editor map lock**: `app.js` `onAirportClick` / `onNavaidClick` / `onFixClick` each guard with `if (this.routeEditor?.isVisible()) return;`. This is intentional — the map is read-only while the route editor panel is open. Do not remove these guards during refactoring.
- **Worktree build artifact**: Building from a git worktree rewrites `android/capacitor.settings.gradle` with worktree-relative paths (`../../../node_modules/`). Never stage or commit this file from a worktree — it will break the main build.
- **Worktree version drift**: A worktree only sees the *committed* `FLYTAB_VERSION`. If `web/app.js` has an uncommitted version bump on main, the worktree builds from a stale lower version. The merged APK then fails to install ("cannot install this app") because the tablet has a higher versionCode. Always commit the version bump before creating a worktree, or verify the version after creation. `versionCode` is derived by stripping `v` and removing the dot (e.g. `v5.99` → `599`, `v5.100` → `5100`). Note: `v6.0` → `60` — a major version reset produces a *lower* code than `v5.99`.
