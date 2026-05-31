# FIS-B NEXRAD Regional/CONUS Split + CONUS Radar Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop FIS-B CONUS NEXRAD from painting oversized squares on the main map, and give CONUS its own zoomed-out radar page with ownship + loop, while wiring up the provisioned-but-dead `radar.cacheHours` frame persistence so frames survive restart and can be exported for ground testing.

**Architecture:** `FisbNexrad` becomes the single data layer (block store + frame history, blocks tagged with `Radar_Type`/`Scale`). Rendering is parameterized by a `{map,canvas,ctx}` target + a product filter (`'regional'`/`'conus'`). The main map renders Regional only; a new `RadarPage` (its own Leaflet map) renders CONUS only. Both animate via a target-aware `RadarLoop`. Frames persist to IndexedDB for `cacheHours` and can be exported as NDJSON and replayed through `mock-stratux.py`.

**Tech Stack:** Vanilla JS (no bundler; `<script>` tags in `web/index.html`), Leaflet, Canvas 2D, IndexedDB, Python `mock-stratux.py`. Build via `bash build.sh` (bump `FLYTAB_VERSION` in `web/app.js` first).

**Spec:** `docs/superpowers/specs/2026-05-29-fisb-nexrad-conus-radar-page-design.md`

---

## Testing reality (read first)

Cockpit JS has **no automated test harness** (only `web/shared/planning/` has vitest). So:
- The **pure** `_productOf` classifier gets a standalone Node assertion (Task 2) — the one true unit test.
- Everything else is verified **on the tablet** against `mock-stratux.py`, which Task 1 teaches to emit synthetic Regional+CONUS NEXRAD. Build the harness first so every later task is verifiable on the ground.
- Tablet is reachable over ADB at the SDK path (`~/Android/Sdk/platform-tools/adb`); CDP inspect via `adb forward tcp:9223 localabstract:webview_devtools_remote_$(adb shell pidof app.flywhere.flytab)`.
- **Tap Handler Regression Rule (CLAUDE.md):** after any map-touching task, manually confirm tapping an airport on the **main** map still opens its popup.

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `tools/mock-stratux.py` | Modify | Emit synthetic Regional+CONUS NEXRAD time-series on `/jsonio`; `--replay-nexrad` mode |
| `tools/test-productof.mjs` | Create | Node unit test for the product classifier |
| `web/cockpit/fisb-nexrad.js` | Modify | Tag blocks w/ product; product-aware `draw(target,product)`; per-product age; config wiring; IDB persistence + export |
| `web/cockpit/radar-page.js` | Create | CONUS full-screen page: own map, ownship, CONUS canvas, zoom/recenter, badge, loop |
| `web/cockpit/radar-loop.js` | Modify | Target-aware playback (`{renderer,target,product}`) |
| `web/cockpit/map.js` | Modify | Main map renders Regional only; Regional age badge |
| `web/cockpit/tab-bar.js` | Modify | MORE → In-flight "Radar" item |
| `web/app.js` | Modify | Instantiate `RadarPage`, wire into TabBar; bump version |
| `web/index.html` | Modify | `<script>` tag for `radar-page.js` |
| `web/style.css` | Modify | Radar page + badge styles (tokens only) |
| `web/cockpit-config.js` (defaults) | Modify | none new — wire existing `radar.*` |

---

## PHASE 1 — Harness, data model, render split, main-map fix + badge

### Task 1: Synthetic NEXRAD emitter in `mock-stratux.py`

**Files:**
- Modify: `tools/mock-stratux.py`

- [ ] **Step 1: Add NEXRAD block builder + emitter**

Add near the top (after the imports / ownship constants), using the verified `nexrad.go` geometry (`BLOCK_HEIGHT=4/60`, `BLOCK_WIDTH=48/60`, regional realScale 1, CONUS scale 1 → realScale 5):

```python
# --- Synthetic FIS-B NEXRAD ---------------------------------------------
BLOCK_H = 4.0 / 60.0          # 0.0667 deg lat
BLOCK_W = 48.0 / 60.0         # 0.8 deg lon

def _nexrad_block(lat_n, lon_w, scale, intensities):
    """One NEXRADBlock in Stratux /jsonio shape."""
    real = {0: 1.0, 1: 5.0, 2: 9.0}[scale]
    return {
        "Radar_Type": 63 if scale == 0 else 64,
        "Scale": scale,
        "LatNorth": round(lat_n, 4),
        "LonWest": round(lon_w, 4),
        "Height": round(BLOCK_H * real, 4),
        "Width": round(BLOCK_W * real, 4),
        "Intensity": intensities,           # list[int] length 128 (32x4)
    }

def _gradient_cell(seed):
    """128-bin (32x4) intensity grid: a moving blob of levels 1..6."""
    out = []
    for r in range(4):
        for c in range(32):
            d = abs(c - (seed % 32)) + abs(r - 2)
            out.append(max(0, 6 - d) if d <= 6 else 0)
    return out

def nexrad_frame(tick):
    """Return a Stratux UATFrame-shaped dict with Regional + CONUS blocks.
    Cells drift east with tick so the loop animates."""
    seed = tick % 32
    regional = [
        _nexrad_block(OWN_LAT + 0.5,  OWN_LON - 0.4 + 0.05*seed, 0, _gradient_cell(seed)),
        _nexrad_block(OWN_LAT + 0.43, OWN_LON - 0.4 + 0.05*seed, 0, _gradient_cell(seed+4)),
    ]
    # CONUS: scale-1 blocks (0.333 x 4.0 deg) spread across the Southeast
    conus = []
    for i in range(3):
        conus.append(_nexrad_block(35.0 + 0.33*i, -84.0 + 4.0 + 0.2*seed, 1,
                                   _gradient_cell(seed + i*3)))
    return {"Product_id": 63, "NEXRAD": regional + conus,
            "LocaltimeReceived": time.strftime("%Y-%m-%dT%H:%M:%S")}
```

- [ ] **Step 2: Broadcast it on the `/jsonio` channel each tick**

Find the per-client send loop (the one that emits traffic/situation as JSON over the websocket). Add, once per ~5 s tick (use the existing tick counter; if none, add `tick = 0` and increment):

```python
        await ws.send(json.dumps(nexrad_frame(tick)))
```

Emit it on the same socket the app reads for `/jsonio`/weather. If the mock serves channels by path, send `nexrad_frame` on the `/jsonio` handler; otherwise send on the shared JSON socket (the app's `stratux-client.js` discriminates by the presence of `msg.NEXRAD`).

- [ ] **Step 3: Run the mock and confirm frames go out**

Run: `python3 tools/mock-stratux.py --port 5678`
Expected: starts without error; log shows ticks. (Visual confirmation happens in Task 3 once the app renders it.)

- [ ] **Step 4: Commit**

```bash
git add tools/mock-stratux.py
git commit -m "test(radar): mock-stratux emits synthetic Regional+CONUS NEXRAD"
```

---

### Task 2: Tag blocks with product + `_productOf` classifier

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js:160-212` (`_handleNexrad`), add static `_productOf`
- Create: `tools/test-productof.mjs`

- [ ] **Step 1: Write the failing classifier test**

Create `tools/test-productof.mjs`:

```js
import assert from 'node:assert';
// Mirror of FisbNexrad._productOf (kept in sync; pure function).
const productOf = (b) => (b.radarType === 64 || b.scale > 0) ? 'conus' : 'regional';

assert.equal(productOf({ radarType: 63, scale: 0 }), 'regional');
assert.equal(productOf({ radarType: 64, scale: 1 }), 'conus');
assert.equal(productOf({ radarType: 63, scale: 1 }), 'conus'); // scale wins
assert.equal(productOf({ radarType: 64, scale: 0 }), 'conus'); // type wins
console.log('OK productOf');
```

- [ ] **Step 2: Run it (passes as a spec of intent)**

Run: `node tools/test-productof.mjs`
Expected: `OK productOf`

- [ ] **Step 3: Add `_productOf` + per-product age + keep fields in `_handleNexrad`**

In `fisb-nexrad.js`, add a static method:

```js
    /** Classify a stored block by FIS-B product. */
    static _productOf(block) {
        return (block.radarType === 64 || block.scale > 0) ? 'conus' : 'regional';
    }
```

In the constructor add per-product freshness:

```js
        this._newestAt = { regional: 0, conus: 0 };
```

In `_handleNexrad`, replace the stored-block object and add age tracking:

```js
        for (const block of blocks) {
            if (!block.Intensity || block.Intensity.length === 0) continue;

            const key = `${block.LatNorth},${block.LonWest}`;
            const stored = {
                latN: block.LatNorth,
                lonW: block.LonWest,
                height: block.Height,
                width: block.Width,
                intensity: block.Intensity,
                radarType: block.Radar_Type,   // 63 Regional | 64 CONUS
                scale: block.Scale,             // 0 | 1 | 2
                received_at: now,
            };
            this._blocks.set(key, stored);
            const p = FisbNexrad._productOf(stored);
            if (now > this._newestAt[p]) this._newestAt[p] = now;
        }
```

- [ ] **Step 4: Build**

Bump `FLYTAB_VERSION` in `web/app.js` (e.g. `v9.27`), then `bash build.sh`.
Expected: build succeeds; APK copied to `data/`.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/fisb-nexrad.js web/app.js tools/test-productof.mjs
git commit -m "feat(radar): tag NEXRAD blocks with product + per-product age"
```

---

### Task 3: Product-aware render targets; main map = Regional only

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (`addTo`, `_draw`, `drawFrame`, add `_drawToTarget`, `draw`)

- [ ] **Step 1: Store the main map as a target in `addTo`**

In `addTo(map)`, after creating `this._canvas`/`this._ctx`, add:

```js
        this._mainTarget = { map, canvas: this._canvas, ctx: this._ctx };
```

- [ ] **Step 2: Extract `_drawToTarget` and a public `draw`**

Replace the body of `_draw()` with a delegation, and add the generalized methods. `_drawBlock` is unchanged.

```js
    /** Public: draw current blocks of one product to a target. */
    draw(target, product) {
        this._drawToTarget(target, product, this._blocks);
    }

    /** Draw a block map (live or snapshot) of one product onto a target's canvas. */
    _drawToTarget(target, product, blockMap) {
        const { map, canvas, ctx } = target;
        if (!ctx || !map) return;

        const topLeft = map.containerPointToLayerPoint([0, 0]);
        canvas.style.transform = `translate(${topLeft.x}px, ${topLeft.y}px)`;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (blockMap.size === 0) return;

        ctx.globalAlpha = this._opacity;
        const bounds = map.getBounds();
        const zoom = map.getZoom();

        for (const [, block] of blockMap) {
            if (FisbNexrad._productOf(block) !== product) continue;
            const blockS = block.latN - block.height;
            const blockE = block.lonW + block.width;
            if (block.latN < bounds.getSouth() || blockS > bounds.getNorth()) continue;
            if (blockE < bounds.getWest() || block.lonW > bounds.getEast()) continue;
            this._drawBlock(ctx, map, block, zoom);
        }
        ctx.globalAlpha = 1.0;
    }
```

- [ ] **Step 3: Point the main-map live draw at Regional only**

Replace `_draw()` with:

```js
    /** Draw the main-map live view — Regional product only. */
    _draw() {
        if (!this._active || !this._mainTarget) return;
        this._drawToTarget(this._mainTarget, 'regional', this._blocks);
    }
```

- [ ] **Step 4: Make `drawFrame` target+product aware**

Change the signature and body:

```js
    /** Draw a specific historical frame of one product onto a target (radar loop). */
    drawFrame(target, product, frameIndex) {
        if (frameIndex < 0 || frameIndex >= this._frameHistory.length) return;
        const snap = this._frameHistory[frameIndex];
        if (!snap) return;
        this._drawToTarget(target, product, snap.blocks);
    }
```

Update the existing call site `drawLive()` to remain `this._draw()`. (RadarLoop call sites are updated in Task 5.)

- [ ] **Step 5: Build + verify on tablet against the mock**

`bash build.sh`; install; set `simMode:true`, `simBridgePort:5678` in config; start `python3 tools/mock-stratux.py`; enable NEXRAD layer.
Expected: only the small Regional gradient cells paint near ownship; the large CONUS rectangles do **not** appear on the map. Tap an airport → popup still opens (regression check).

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/fisb-nexrad.js
git commit -m "feat(radar): product-aware render targets; main map shows Regional only"
```

---

### Task 4: Product + age badge on the main map

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (add `getDataAgeMs(product)`)
- Modify: `web/cockpit/map.js` (badge element + update tick)
- Modify: `web/style.css` (badge style, tokens only)

- [ ] **Step 1: Per-product age accessor**

In `fisb-nexrad.js` replace `getDataAgeMs()` with a product-aware version (keep a no-arg fallback for existing callers):

```js
    getDataAgeMs(product) {
        if (product) {
            const t = this._newestAt[product];
            return t ? Date.now() - t : null;
        }
        return this._latestDataTime ? Date.now() - this._latestDataTime : null;
    }
```

- [ ] **Step 2: Add the badge to the map**

In `map.js`, where the NEXRAD layer is toggled on (`_radarLayer`/`_fisbNexrad.addTo`), create a badge element if absent and start a 30 s updater:

```js
    _updateRadarBadge() {
        if (!this._fisbNexrad) return;
        const el = this._radarBadge || (this._radarBadge = (() => {
            const d = document.createElement('div');
            d.className = 'radar-badge';
            this.container.appendChild(d);
            return d;
        })());
        const ageMs = this._fisbNexrad.getDataAgeMs('regional');
        if (ageMs == null) { el.style.display = 'none'; return; }
        const min = Math.round(ageMs / 60000);
        el.style.display = 'block';
        el.textContent = `FIS-B · Regional · ${min} min`;
    }
```

Call `this._updateRadarBadge()` when radar enables, on `fisb:nexrad`, and on a 30 s interval; hide/remove it when radar is disabled.

- [ ] **Step 3: Style the badge (tokens only)**

In `style.css`:

```css
.radar-badge {
    position: absolute; bottom: 8px; left: 8px; z-index: 500;
    background: var(--bg-surface); color: var(--text-secondary);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 4px 8px; font-family: var(--font-ui); font-weight: 700;
    font-size: 13px; pointer-events: none;
}
```

- [ ] **Step 4: Build + verify**

`bash build.sh`; run mock; enable NEXRAD.
Expected: badge reads `FIS-B · Regional · <n> min`; hidden when no data / radar off.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/fisb-nexrad.js web/cockpit/map.js web/style.css web/app.js
git commit -m "feat(radar): main-map FIS-B Regional product + age badge"
```

---

## PHASE 2 — CONUS radar page + loops + drawer

### Task 5: Target-aware `RadarLoop`

**Files:**
- Modify: `web/cockpit/radar-loop.js`

- [ ] **Step 1: Accept a target + product; default to main map / Regional**

In the constructor add:

```js
        this._target  = opts.target  || null;     // {map,canvas,ctx}; null → renderer's main target
        this._product = opts.product || 'regional';
```

Change the signature to `constructor(opts = {})`. Where the loop renders a frame, replace the `_fisbRenderer.drawFrame(i)` / `_nexrad.drawFrame(i)` calls with:

```js
        const target = this._target || this._fisbRenderer?._mainTarget;
        if (target) this._fisbRenderer.drawFrame(target, this._product, i);
```

(For the internet source path, keep its existing `drawFrame(i)` — internet frames are main-map only and unaffected.)

- [ ] **Step 2: Build + verify the main-map loop still animates**

`bash build.sh`; run mock (it emits a moving cell); enable NEXRAD; let ~2 frames accumulate or press play on the loop control.
Expected: Regional cells animate east; no CONUS on the map.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/radar-loop.js
git commit -m "feat(radar): target-aware RadarLoop playback"
```

---

### Task 6: `RadarPage` — CONUS view

**Files:**
- Create: `web/cockpit/radar-page.js`
- Modify: `web/index.html` (script tag, after `fisb-nexrad.js` and before `app.js`)
- Modify: `web/style.css` (page styles)
- Modify: `web/shared/cockpit-config.js` defaults (`radar.conusDefaultZoom: 6`)

- [ ] **Step 1: Add config default**

In `cockpit-config.js` `radar` defaults add: `conusDefaultZoom: 6,`

- [ ] **Step 2: Create the page**

`web/cockpit/radar-page.js`:

```js
/**
 * FlyTab — CONUS Radar Page
 * Full-screen dedicated FIS-B CONUS NEXRAD view: own Leaflet map, ownship icon,
 * SE-wide default zoom, pan/zoom + recenter, product/age badge, CONUS loop.
 * Reuses the shared FisbNexrad data layer (renders product 'conus' to its own target).
 */
class RadarPage {
    constructor(fisbNexrad, stratuxClient) {
        this._fisb = fisbNexrad;
        this._stratux = stratuxClient;
        this._visible = false;
        this._map = null;
        this._canvas = null;
        this._ctx = null;
        this._target = null;
        this._ownship = null;
        this._ownPos = null;            // last {lat,lon,course}
        this._badge = null;
        this._loop = null;
        this._ageTimer = null;
        this._defaultZoom = (CockpitConfig.get('radar.conusDefaultZoom')) || 6;

        this._onSituation = (e) => this._updateOwnship(e.detail);
        this._onNexrad = () => { if (this._visible) { this._drawConus(); this._updateBadge(); } };
        this._buildDom();
    }

    _buildDom() {
        this._el = document.createElement('div');
        this._el.className = 'radar-page';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="radar-page-header">
                <span class="radar-page-title">CONUS Radar</span>
                <span class="radar-badge radar-page-badge"></span>
                <button class="radar-page-close" aria-label="Close">&#x2715;</button>
            </div>
            <div class="radar-page-map"></div>
            <button class="radar-page-recenter">Recenter on me</button>`;
        document.body.appendChild(this._el);
        this._mapEl = this._el.querySelector('.radar-page-map');
        this._badge = this._el.querySelector('.radar-page-badge');
        this._el.querySelector('.radar-page-close')
            .addEventListener('click', () => this.hide());
        this._el.querySelector('.radar-page-recenter')
            .addEventListener('click', () => this._recenter());
    }

    _ensureMap() {
        if (this._map) return;
        const tileBase = 'http://localhost:9090/tiles';
        this._map = L.map(this._mapEl, { zoomControl: true, attributionControl: false });
        L.tileLayer(`${tileBase}/sectional/{z}/{x}/{y}.webp`,
            { minZoom: 4, maxZoom: 14 }).addTo(this._map);

        // CONUS canvas overlay in the map's overlay pane
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        this._map.getPanes().overlayPane.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');
        this._target = { map: this._map, canvas: this._canvas, ctx: this._ctx };

        const size = () => {
            const s = this._map.getSize();
            this._canvas.width = s.x * 2; this._canvas.height = s.y * 2;
        };
        size();
        this._map.on('resize', () => { size(); this._drawConus(); });
        this._map.on('move zoom moveend zoomend', () => this._drawConus());
    }

    _drawConus() {
        if (this._target) this._fisb.draw(this._target, 'conus');
    }

    _updateOwnship(sit) {
        if (!sit || sit.lat == null || sit.lon == null) return;
        this._ownPos = { lat: sit.lat, lon: sit.lon, course: sit.true_course || 0 };
        if (!this._visible || !this._map) return;
        const pos = [sit.lat, sit.lon];
        if (!this._ownship) {
            const icon = L.divIcon({ className: 'ownship-icon',
                html: CockpitMap._ownshipSvg(0), iconSize: [48, 48], iconAnchor: [24, 24] });
            this._ownship = L.marker(pos, { icon, zIndexOffset: 1000 }).addTo(this._map);
        } else {
            this._ownship.setLatLng(pos);
        }
        const g = this._ownship.getElement()?.querySelector('svg g');
        if (g) g.setAttribute('transform', `rotate(${this._ownPos.course}, 24, 24)`);
    }

    _recenter() {
        if (this._ownPos && this._map)
            this._map.setView([this._ownPos.lat, this._ownPos.lon], this._defaultZoom);
    }

    _updateBadge() {
        const ageMs = this._fisb.getDataAgeMs('conus');
        if (ageMs == null) { this._badge.textContent = 'FIS-B · CONUS · no data'; return; }
        this._badge.textContent = `FIS-B · CONUS · ${Math.round(ageMs / 60000)} min`;
    }

    isVisible() { return this._visible; }

    show() {
        this._visible = true;
        this._el.style.display = 'flex';
        this._ensureMap();
        // Leaflet needs a size recalc after the container becomes visible
        setTimeout(() => { this._map.invalidateSize(); this._recenter(); this._drawConus(); }, 0);
        this._stratux.addEventListener('stratux:situation', this._onSituation);
        this._fisb.addEventListener?.('fisb:nexrad', this._onNexrad); // FisbNexrad re-dispatch
        if (this._ownPos) this._updateOwnship({ lat: this._ownPos.lat, lon: this._ownPos.lon, true_course: this._ownPos.course });
        this._updateBadge();
        this._ageTimer = setInterval(() => this._updateBadge(), 30000);
    }

    hide() {
        this._visible = false;
        this._el.style.display = 'none';
        this._stratux.removeEventListener('stratux:situation', this._onSituation);
        this._fisb.removeEventListener?.('fisb:nexrad', this._onNexrad);
        if (this._loop) this._loop.stop?.();
        if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
    }
}
```

Note: `FisbNexrad` already extends `EventTarget` (it dispatches `fisb:nexrad`? — verify; if not, subscribe to `this._stratux`'s `stratux:nexrad` instead and call `_drawConus`). If `FisbNexrad` does not emit `fisb:nexrad`, change the `_onNexrad` subscription in `show()`/`hide()` to `this._fisb._fisb` (the FisbClient) `fisb:nexrad`, which it already listens to.

- [ ] **Step 3: Add the script tag**

In `web/index.html`, after the `fisb-nexrad.js` tag:

```html
    <script src="cockpit/radar-page.js"></script>
```

- [ ] **Step 4: Style the page (tokens only, light theme — do NOT set data-mode)**

In `style.css`:

```css
.radar-page { position: fixed; inset: 0; z-index: 4000; background: var(--bg-primary);
    display: flex; flex-direction: column; }
.radar-page-header { display: flex; align-items: center; gap: 12px;
    padding: 8px 12px; border-bottom: 2px solid var(--border-strong); }
.radar-page-title { font-family: var(--font-ui); font-weight: 800;
    font-size: 18px; color: var(--text-primary); }
.radar-page-close { margin-left: auto; min-width: var(--touch-min, 56px);
    min-height: var(--touch-min, 56px); font-size: 24px; font-weight: 800;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; }
.radar-page-map { flex: 1; position: relative; }
.radar-page-recenter { position: absolute; bottom: 16px; right: 16px; z-index: 500;
    min-height: var(--touch-preferred, 64px); padding: 0 18px;
    font-family: var(--font-ui); font-weight: 800; font-size: 16px;
    color: #fff; background: var(--accent); border: none; border-radius: 10px; }
.radar-page-badge { position: static; }
```

- [ ] **Step 5: Wire into app + drawer (deferred to Task 8); build + smoke**

Temporarily expose for testing: after `this.fisbNexrad = ...` in `app.js`, add `this.radarPage = new RadarPage(this.fisbNexrad, this.stratuxClient);` (full wiring in Task 8). `bash build.sh`.
Expected: no console errors at startup; page class loads.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/radar-page.js web/index.html web/style.css web/shared/cockpit-config.js web/app.js
git commit -m "feat(radar): CONUS RadarPage (own map, ownship, zoom/recenter, badge)"
```

---

### Task 7: CONUS loop on the radar page

**Files:**
- Modify: `web/cockpit/radar-page.js`

- [ ] **Step 1: Build a CONUS loop bound to the page target**

In `RadarPage` constructor, after `_buildDom()`:

```js
        this._loop = new RadarLoop({ target: this._target, product: 'conus' });
```

Move this to `_ensureMap()` end (target exists there). Set its renderer:

```js
        this._loop.setFisbRenderer(this._fisb);
        this._loop.setNexrad(this._fisb);
        this._mapEl.parentNode.appendChild(this._loop._controlEl); // show the loop control on the page
```

- [ ] **Step 2: Start/stop the loop with the page**

In `show()` after the map recalc add `this._loop?.show?.(this._map);` and in `hide()` ensure `this._loop?.hide?.()` (or `.stop()`), matching RadarLoop's actual show/hide API (read `radar-loop.js`).

- [ ] **Step 3: Build + verify**

`bash build.sh`; run mock (moving CONUS cells); open the page.
Expected: CONUS blocks paint at SE-wide zoom; loop control animates them eastward; ownship visible; recenter works.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/radar-page.js
git commit -m "feat(radar): CONUS loop on the radar page"
```

---

### Task 8: MORE drawer entry + app wiring

**Files:**
- Modify: `web/app.js` (instantiate after FisbNexrad; add to TabBar components)
- Modify: `web/cockpit/tab-bar.js` (In-flight item)

- [ ] **Step 1: Instantiate + pass to TabBar**

In `app.js`, ensure `this.radarPage = new RadarPage(this.fisbNexrad, this.stratuxClient);` is created after `this.fisbNexrad`. In the `new TabBar({...})` components object add: `radarPage: this.radarPage,`

- [ ] **Step 2: Add the drawer item**

In `tab-bar.js` `_buildMoreDrawer()`, after the Approach Charts item (line ~173):

```js
            { icon: '🌧', label: 'Radar', action: () => {
                c.radarPage?.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
```

- [ ] **Step 3: Build + verify end-to-end**

`bash build.sh`; run mock; MORE → Radar.
Expected: page opens to SE-wide CONUS view with ownship + loop + badge; close returns to map; main map still Regional-only; airport tap on main map still works.

- [ ] **Step 4: Update user manual**

Add a "Radar (CONUS)" entry under the MORE/In-flight section of `docs/user-manual.md` describing the page, recenter, and loop.

- [ ] **Step 5: Commit**

```bash
git add web/app.js web/cockpit/tab-bar.js docs/user-manual.md
git commit -m "feat(radar): launch CONUS radar page from MORE drawer"
```

---

## PHASE 3 — Frame persistence + export (`radar.cacheHours`)

### Task 9: Wire `radar.*` config into `FisbNexrad`

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (constructor + snapshot cadence)

- [ ] **Step 1: Read config in the constructor**

Replace the hardcoded `this._maxFrames = 24;` with:

```js
        const intervalMin = CockpitConfig.get('radar.frameIntervalMinutes') || 10;
        const durationHr  = CockpitConfig.get('radar.loopDurationHours') || 2;
        this._cacheHours  = CockpitConfig.get('radar.cacheHours') || 3;
        this._snapIntervalMs = intervalMin * 60000;
        this._maxFrames = Math.max(2, Math.ceil(durationHr * 60 / intervalMin));
```

- [ ] **Step 2: Use the configured cadence for snapshots**

In `_handleNexrad`, replace the hardcoded `150000` with `this._snapIntervalMs`.

- [ ] **Step 3: Build + verify cadence unchanged behaviorally**

`bash build.sh`; run mock; confirm frames still accumulate (with defaults 10 min this is slow — temporarily set `frameIntervalMinutes:1` in config to verify accumulation, then revert).

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/fisb-nexrad.js
git commit -m "feat(radar): wire radar.frameInterval/loopDuration/cacheHours config"
```

---

### Task 10: Persist frames to IndexedDB

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (IDB open, write-on-snapshot, purge)

- [ ] **Step 1: Add an IDB helper (own DB `flytab_radar`)**

Add methods to `FisbNexrad`:

```js
    _openDb() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open('flytab_radar', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('nexradFrames'))
                    db.createObjectStore('nexradFrames', { keyPath: 'dataTime' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._dbPromise;
    }

    async _persistFrame(snap) {
        try {
            const db = await this._openDb();
            const blocks = [];
            for (const [, b] of snap.blocks) blocks.push({ ...b, intensity: Array.from(b.intensity) });
            const rec = { dataTime: snap.dataTime, time: snap.time, blocks };
            const tx = db.transaction('nexradFrames', 'readwrite');
            tx.objectStore('nexradFrames').put(rec);
            await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
            await this._purgeDb();
        } catch (err) {
            if (typeof DiagLog !== 'undefined') DiagLog.log('error', `radar persist failed: ${err.message}`);
        }
    }

    async _purgeDb() {
        const db = await this._openDb();
        const cutoff = Date.now() - this._cacheHours * 3600000;
        const tx = db.transaction('nexradFrames', 'readwrite');
        const store = tx.objectStore('nexradFrames');
        store.openCursor().onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) return;
            if ((cur.value.time || 0) < cutoff) cur.delete();
            cur.continue();
        };
    }
```

- [ ] **Step 2: Call `_persistFrame` from `_takeSnapshot`**

At the end of `_takeSnapshot(time, dataTime)`, after pushing to `_frameHistory`:

```js
        this._persistFrame(this._frameHistory[this._frameHistory.length - 1]);
```

- [ ] **Step 3: Build + verify persistence via CDP**

`bash build.sh`; run mock (set `frameIntervalMinutes:1` to accumulate); after a few minutes inspect IDB:
Run (CDP): evaluate `indexedDB.databases()` then read `flytab_radar` → `nexradFrames` count.
Expected: records present with `dataTime`, `blocks[]` (intensity as arrays, `radarType`/`scale` preserved).

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/fisb-nexrad.js
git commit -m "feat(radar): persist NEXRAD frames to IndexedDB (cacheHours retention)"
```

---

### Task 11: Hydrate frame history on startup

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (constructor calls `_hydrate`)

- [ ] **Step 1: Load persisted frames into `_frameHistory`**

```js
    async _hydrate() {
        try {
            const db = await this._openDb();
            const cutoff = Date.now() - this._cacheHours * 3600000;
            const tx = db.transaction('nexradFrames', 'readonly');
            const recs = await new Promise((res, rej) => {
                const r = tx.objectStore('nexradFrames').getAll();
                r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
            });
            const fresh = recs.filter(r => (r.time || 0) >= cutoff)
                              .sort((a, b) => a.dataTime - b.dataTime)
                              .slice(-this._maxFrames);
            for (const r of fresh) {
                const m = new Map();
                for (const b of r.blocks) m.set(`${b.latN},${b.lonW}`, b);
                this._frameHistory.push({ time: r.time, dataTime: r.dataTime, blocks: m });
            }
            // Seed live blocks + per-product age from the newest frame
            const last = fresh[fresh.length - 1];
            if (last) {
                for (const b of last.blocks) {
                    this._blocks.set(`${b.latN},${b.lonW}`, b);
                    const p = FisbNexrad._productOf(b);
                    this._newestAt[p] = Math.max(this._newestAt[p], last.time);
                }
            }
        } catch (err) {
            if (typeof DiagLog !== 'undefined') DiagLog.log('error', `radar hydrate failed: ${err.message}`);
        }
    }
```

Call `this._hydrate();` at the end of the constructor.

- [ ] **Step 2: Build + verify resume-after-restart**

`bash build.sh`; run mock to accumulate frames; force-stop FlyTab; reopen.
Expected: enabling the radar/loop shows prior frames immediately (no waiting to re-accumulate); main map Regional, page CONUS.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/fisb-nexrad.js
git commit -m "feat(radar): hydrate frame history from IDB on startup"
```

---

### Task 12: Export frames to NDJSON

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js` (`exportFrames`)
- Modify: `web/cockpit/radar-page.js` (Export button)

- [ ] **Step 1: `exportFrames()` writes NDJSON via the on-device file server**

```js
    /** Export cached frames as NDJSON to the on-device server (next to flight CSVs). */
    async exportFrames() {
        const lines = this._frameHistory.map(snap => {
            const NEXRAD = [];
            for (const [, b] of snap.blocks) NEXRAD.push({
                Radar_Type: b.radarType, Scale: b.scale,
                LatNorth: b.latN, LonWest: b.lonW, Height: b.height, Width: b.width,
                Intensity: Array.from(b.intensity),
            });
            return JSON.stringify({ Product_id: 63, NEXRAD,
                LocaltimeReceived: new Date(snap.dataTime).toISOString() });
        });
        const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const path = `flights/nexrad-${iso}.ndjson`;
        const resp = await fetch(`http://localhost:9090/${path}`,
            { method: 'PUT', body: lines.join('\n') });
        if (typeof DiagLog !== 'undefined')
            DiagLog.log('radar', `exportFrames → ${path} (${lines.length} frames, ok=${resp.ok})`);
        return path;
    }
```

- [ ] **Step 2: Add an Export control to the radar page header**

In `radar-page.js` `_buildDom()` add a button before close:

```html
                <button class="radar-page-export">Export</button>
```

Wire it:

```js
        this._el.querySelector('.radar-page-export')
            .addEventListener('click', () => this._fisb.exportFrames());
```

Style `.radar-page-export` like `.radar-page-close` (token-based; reuse class or add a rule).

- [ ] **Step 3: Build + verify export file**

`bash build.sh`; accumulate frames; open page → Export.
Run: `~/Android/Sdk/platform-tools/adb shell run-as app.flywhere.flytab ls -la files` (or pull via the on-device server) to confirm `nexrad-<iso>.ndjson` exists; inspect a line — must have `Radar_Type`, `Scale`, `LatNorth`, `LonWest`, `Height`, `Width`, `Intensity`.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/fisb-nexrad.js web/cockpit/radar-page.js web/style.css
git commit -m "feat(radar): export cached NEXRAD frames to NDJSON"
```

---

### Task 13: `mock-stratux.py --replay-nexrad`

**Files:**
- Modify: `tools/mock-stratux.py`

- [ ] **Step 1: Add the arg + replay loop**

```python
parser.add_argument('--replay-nexrad', help='Path to nexrad NDJSON to replay on /jsonio')
```

When set, instead of synthetic generation, read the file once into a list and, each tick, send the next line's JSON (loop at EOF), pacing by the configured tick interval:

```python
    if args.replay_nexrad:
        with open(args.replay_nexrad) as f:
            frames = [json.loads(l) for l in f if l.strip()]
        # in the send loop:
        await ws.send(json.dumps(frames[tick % len(frames)]))
```

- [ ] **Step 2: Verify with an exported file**

Run: `python3 tools/mock-stratux.py --replay-nexrad tools/nexrad-<iso>.ndjson` (copy an export to `tools/`).
Expected: the app renders the replayed Regional on the map and CONUS on the page, matching the captured flight.

- [ ] **Step 3: Commit**

```bash
git add tools/mock-stratux.py
git commit -m "test(radar): mock-stratux --replay-nexrad for ground replay of captures"
```

---

## Final verification (whole feature)

- [ ] Main map: Regional only, correctly scaled, no oversized squares; `Regional · <age>` badge; loop animates.
- [ ] MORE → Radar: CONUS page at SE-wide zoom; ownship centered; pan/zoom; Recenter; `CONUS · <age>` badge; loop animates; Export writes NDJSON.
- [ ] Restart app → both loops resume from IDB; frames > `cacheHours` purged.
- [ ] **Tap Handler Regression:** airport popup still opens on a normal tap on the main map.
- [ ] Internet/ground radar unchanged (verify on the ground with internet tiles).
- [ ] `node tools/test-productof.mjs` passes.
- [ ] `FLYTAB_VERSION` bumped; `bash build.sh` clean.

## Self-review notes (gaps to confirm during execution)

- **`fisb:nexrad` event source:** Task 6 assumes `FisbNexrad` re-emits `fisb:nexrad`. Verify — it currently listens to the *FisbClient's* `fisb:nexrad`. If `FisbNexrad` is not an `EventTarget`, subscribe the page to `this._fisb._fisb` (the FisbClient) instead; the `.addEventListener?.` guard degrades safely but confirm the live redraw fires.
- **`RadarLoop` show/hide API:** Task 7 references `_controlEl`, `show(map)`, `stop()`. Read `radar-loop.js` and match exact method names before wiring.
- **On-device file server PUT:** Task 12 assumes the NanoHTTPD server at `localhost:9090` accepts `PUT` to `flights/`. Confirm against how `FlightRecorder._flush` writes (it uses the same base); match its method/headers.
