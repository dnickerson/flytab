# Voronoi Flight Category Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace transparent colored METAR text labels with (a) a Voronoi area fill layer that paints the map by flight category so the pilot gets an instant regional weather picture, and (b) uniform white opaque chip labels for all METAR data fields.

**Architecture:** The Voronoi cells are computed with the half-plane intersection algorithm directly in geographic (lat/lon) coordinates — no external library. Each airport with a flight category METAR becomes a site; its cell is the set of all map points closer to it than to any other site. Cells are rendered as semi-transparent `L.polygon` layers in a new `_wxVoronoiLayer` layer group. The layer is rebuilt whenever `_updateWxDots` finishes (same update cycle as airport dots/labels). All four METAR text fields (ceiling, visibility, wind, temp/dewpoint) switch from colored shadow-text to uniform white-background chips with black text, since the Voronoi background already communicates the category.

**Tech Stack:** Vanilla JS, Leaflet polygon API, CSS. No new libraries or `<script>` tags.

---

## File Map

| File | What changes |
|------|-------------|
| `web/style.css` | Replace `.wx-label-stack` / `.wx-lbl-*` transparent colored styles with white chip styles |
| `web/cockpit/vector-map-layers.js` | Add `_wxVoronoiLayer`, `_showVoronoi` flag, Voronoi computation methods, toggle API, rebuild call inside `_updateWxDots` |
| `web/cockpit/layer-panel.js` | Add "Flight Category Areas" toggle row in the Weather accordion; wire to `toggleVoronoi()` |
| `web/app.js` | Version bump only |

---

## Task 1: White chip METAR labels (CSS only)

**Files:**
- Modify: `web/style.css` lines 6981–7025

- [ ] **Step 1: Replace the wx label CSS block**

Find the block starting at `.wx-label-stack` and replace through `.wx-lbl-temp`. The new design: every label line has a white `rgba(255,255,255,0.92)` pill background, black text, and no color/shadow variation — uniformity lets the Voronoi layer do the communicating.

```css
/* Replace lines 6981–7025 with: */
.wx-label-stack {
    background: transparent;
    border: none;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-left: 12px;
    gap: 2px;
}

.wx-lbl-ceil,
.wx-lbl-vis,
.wx-lbl-wind,
.wx-lbl-temp {
    font-size: 13px;
    font-weight: 700;
    color: #000;
    line-height: 1;
    white-space: nowrap;
    background: rgba(255,255,255,0.92);
    border-radius: 3px;
    padding: 1px 4px;
}
```

- [ ] **Step 2: Verify no other rules reference the old per-field colors**

```bash
grep -n "wx-lbl-ceil\|wx-lbl-vis\|wx-lbl-wind\|wx-lbl-temp" /home/dananickerson/flytab/web/style.css
```

Expected: only the one block you just wrote. If any other rule sets `color` or `text-shadow` on these classes, remove it.

- [ ] **Step 3: Also remove the inline `style="color:..."` from `_upsertWxLabel`**

In `web/cockpit/vector-map-layers.js` around line 447, the ceiling row injects a dynamic color:

```javascript
html += `<div class="wx-lbl-ceil" style="color:${color}">${skyLabel}</div>`;
```

Change it to drop the inline style — the chip is always black now:

```javascript
html += `<div class="wx-lbl-ceil">${skyLabel}</div>`;
```

- [ ] **Step 4: Bump version, build, and visually confirm chips appear on the map**

```bash
# In web/app.js, increment FLYTAB_VERSION (e.g. v8.19 → v8.20)
bash build.sh 2>&1 | tail -8
```

Expected: APK built. Labels on map are small white pills with black text.

- [ ] **Step 5: Commit**

```bash
git add web/style.css web/cockpit/vector-map-layers.js web/app.js
git commit -m "style: white chip METAR labels — category color moves to Voronoi layer"
```

---

## Task 2: Voronoi layer — core computation

**Files:**
- Modify: `web/cockpit/vector-map-layers.js`

### 2a — Add static Voronoi geometry helpers

These two static methods live at the bottom of the `VectorMapLayers` class, before the closing `}`.

- [ ] **Step 1: Add `_clipPolygonToHalfPlane` static method**

Given a polygon (array of `[lat, lon]`) and two sites `p` and `q`, clips the polygon to the half-plane containing `p` (i.e., all points closer to p than to q). Uses Sutherland-Hodgman line clipping.

```javascript
/**
 * Clip a polygon to the half-plane that contains site p = [py, px]
 * relative to site q = [qy, qx]. Uses Sutherland-Hodgman.
 * Polygon is array of [lat, lon] pairs.
 */
static _clipPolygonToHalfPlane(poly, py, px, qy, qx) {
    if (poly.length === 0) return [];
    // Perpendicular bisector midpoint
    const my = (py + qy) / 2;
    const mx = (px + qx) / 2;
    // Direction from p to q — the inside half is where dot <= 0
    const dy = qy - py;
    const dx = qx - px;
    // inside(pt): true if pt is on the p side (dot product <= 0)
    const inside = ([lat, lon]) => (lat - my) * dy + (lon - mx) * dx <= 0;
    // Intersection of segment a→b with the bisector line
    const intersect = ([ay, ax], [by, bx]) => {
        const da = (ay - my) * dy + (ax - mx) * dx;
        const db = (by - my) * dy + (bx - mx) * dx;
        const t = da / (da - db);
        return [ay + t * (by - ay), ax + t * (bx - ax)];
    };
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i];
        const nxt = poly[(i + 1) % poly.length];
        const ci = inside(cur);
        const ni = inside(nxt);
        if (ci) out.push(cur);
        if (ci !== ni) out.push(intersect(cur, nxt));
    }
    return out;
}
```

- [ ] **Step 2: Add `_computeVoronoiCells` static method**

Takes an array of sites `[{lat, lon, cat}]` and a bounding box, returns `[{cat, points:[lat,lon]}]`.

```javascript
/**
 * Compute Voronoi cells for an array of sites using half-plane intersection.
 * sites: [{lat, lon, cat}]
 * bounds: {south, west, north, east} — initial bounding polygon; add buffer before passing
 * Returns [{cat, points}] where points is array of [lat, lon].
 */
static _computeVoronoiCells(sites, bounds) {
    if (sites.length === 0) return [];
    const bbox = [
        [bounds.north, bounds.west],
        [bounds.north, bounds.east],
        [bounds.south, bounds.east],
        [bounds.south, bounds.west],
    ];
    const cells = [];
    for (let i = 0; i < sites.length; i++) {
        const p = sites[i];
        let cell = bbox.slice();
        for (let j = 0; j < sites.length; j++) {
            if (i === j) continue;
            const q = sites[j];
            cell = VectorMapLayers._clipPolygonToHalfPlane(cell, p.lat, p.lon, q.lat, q.lon);
            if (cell.length === 0) break;
        }
        if (cell.length >= 3) cells.push({ cat: p.cat, points: cell });
    }
    return cells;
}
```

- [ ] **Step 3: No test harness is needed for geometry helpers — verify manually after the layer is wired in Task 2b.**

---

### 2b — Add the Voronoi layer to VectorMapLayers

- [ ] **Step 4: Declare `_wxVoronoiLayer` and `_showVoronoi` in the constructor**

In the constructor (around line 17 where other layer groups are declared):

```javascript
this._wxVoronoiLayer = L.layerGroup();  // flight category area fills
this._showVoronoi = false;               // default off; pilot enables in layer panel
```

- [ ] **Step 5: Add `init()` wiring**

In `init()` after the other layers are added to the map (around line 155), add:

```javascript
// Voronoi layer sits below wx dots but above base tiles
this._wxVoronoiLayer.addTo(this._map);
```

Wait — the layer is added unconditionally but starts empty. `_showVoronoi` gates whether `_rebuildVoronoi` actually draws anything.

- [ ] **Step 6: Add toggle API methods (add near `showWxDots` / `hideWxDots` around line 268)**

```javascript
toggleVoronoi() {
    this._showVoronoi = !this._showVoronoi;
    if (this._showVoronoi) {
        this._rebuildVoronoi();
    } else {
        this._wxVoronoiLayer.clearLayers();
    }
    return this._showVoronoi;
}
get voronoiVisible() { return this._showVoronoi; }
```

- [ ] **Step 7: Add `_rebuildVoronoi()` method**

Add after the `toggleVoronoi` block:

```javascript
/** Rebuild Voronoi flight category fill polygons from current METAR positions. */
_rebuildVoronoi() {
    this._wxVoronoiLayer.clearLayers();
    if (!this._showVoronoi) return;

    // Collect sites: airports that have a current flight category
    const sites = [];
    for (const [icao, pos] of this._aptPositions) {
        const entry = this._getMetarEntry(icao);
        const cat = entry?.decoded?.flight_category;
        if (!cat) continue;
        sites.push({ lat: pos.lat, lon: pos.lon, cat });
    }
    if (sites.length < 2) return;

    // Expand bounds by ~2° buffer so edge cells fill to the viewport edge
    const b = this._map.getBounds();
    const buf = 2;
    const bounds = {
        north: b.getNorth() + buf,
        south: b.getSouth() - buf,
        west:  b.getWest()  - buf,
        east:  b.getEast()  + buf,
    };

    const COLOR = { LIFR: '#cc44ff', IFR: '#ff2222', MVFR: '#0099ff', VFR: '#22bb44' };
    const cells = VectorMapLayers._computeVoronoiCells(sites, bounds);

    for (const cell of cells) {
        const color = COLOR[cell.cat] || '#888888';
        L.polygon(cell.points, {
            color,
            weight: 0,
            fillColor: color,
            fillOpacity: 0.28,
            interactive: false,
        }).addTo(this._wxVoronoiLayer);
    }
}
```

- [ ] **Step 8: Call `_rebuildVoronoi()` at the end of `_updateWxDots`**

At the very end of `_updateWxDots` (after the `for (const [id] of this._aptPositions)` cleanup loop, around line 1155), add:

```javascript
        this._rebuildVoronoi();
```

This ensures the Voronoi rebuilds every time airport positions or METARs change.

- [ ] **Step 9: Also call `_rebuildVoronoi()` from `_refreshWxLabels`** so toggling a METAR field (ceil/vis/etc.) re-triggers the rebuild when new data arrives.

In `_refreshWxLabels` (around line 416), append after the `for` loop:

```javascript
    this._rebuildVoronoi();
```

- [ ] **Step 10: Bump version, build, verify no JS errors in logcat**

```bash
# Increment FLYTAB_VERSION in web/app.js
bash build.sh 2>&1 | tail -8
```

Install and check: the map should show no colored overlay yet (toggle is off by default). Logcat should show no exceptions.

- [ ] **Step 11: Commit**

```bash
git add web/cockpit/vector-map-layers.js web/app.js
git commit -m "feat: Voronoi flight category area overlay — off by default, layer panel toggle pending"
```

---

## Task 3: Layer panel toggle

**Files:**
- Modify: `web/cockpit/layer-panel.js`

- [ ] **Step 1: Add "Flight Category Areas" row to the Weather accordion HTML**

In `layer-panel.js`, find the Weather accordion body (around line 509). Insert a new row directly after the "Flight Category" (wx-dots) row:

```javascript
// Find this existing row:
//   <div class="lp-row">
//       <span class="lp-row-label">Flight Category</span>
//       <label class="lp-toggle"><input type="checkbox" data-action="wx-dots" checked>...
//   </div>
// INSERT the new row immediately after it:
                    <div class="lp-row">
                        <span class="lp-row-label">Category Areas</span>
                        <label class="lp-toggle"><input type="checkbox" data-action="wx-voronoi"><span class="lp-toggle-track"></span></label>
                    </div>
```

- [ ] **Step 2: Wire the toggle in the JS section of `layer-panel.js`**

Near the `wxDotsInput` wiring block (around line 150), add after it:

```javascript
        const voronoiInput = this._panel.querySelector('.lp-toggle input[data-action="wx-voronoi"]');
        if (voronoiInput) {
            voronoiInput.checked = this._vectorLayers?.voronoiVisible ?? false;
            voronoiInput.addEventListener('change', () => {
                this._vectorLayers?.toggleVoronoi();
            });
        }
```

- [ ] **Step 3: Bump version, build, install**

```bash
# Increment FLYTAB_VERSION in web/app.js
bash build.sh 2>&1 | tail -8
```

Expected: "Category Areas" toggle appears in the layer panel under Weather. Enabling it paints semi-transparent colored regions on the map matching flight categories.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/layer-panel.js web/app.js
git commit -m "feat: add Category Areas toggle to layer panel for Voronoi flight category overlay"
```

---

## Self-Review

**Spec coverage:**
- ✅ Voronoi area fill by flight category — Task 2
- ✅ ~35% opacity (using 0.28 fill opacity) — Task 2 step 7
- ✅ LIFR/IFR/MVFR/VFR colors matching map conventions — Task 2 step 7
- ✅ Redraws on pan/zoom — Task 2 step 8 (called from `_updateWxDots`)
- ✅ Toggleable in layer panel — Task 3
- ✅ Default off — Task 2 step 4 (`_showVoronoi = false`)
- ✅ White chip labels for all METAR fields (ceil, vis, wind, temp) — Task 1
- ✅ Inline color removed from ceiling label — Task 1 step 3

**Placeholder scan:** None found — all steps contain actual code.

**Type consistency:**
- `_wxVoronoiLayer` declared in constructor, used in `_rebuildVoronoi`, `toggleVoronoi` — consistent
- `_showVoronoi` boolean declared in constructor, read in `_rebuildVoronoi`, toggled in `toggleVoronoi` — consistent
- `voronoiVisible` getter used in layer-panel.js `voronoiInput.checked` — consistent
- `VectorMapLayers._computeVoronoiCells` and `VectorMapLayers._clipPolygonToHalfPlane` — both static, called from `_rebuildVoronoi` as `VectorMapLayers._*` — consistent
