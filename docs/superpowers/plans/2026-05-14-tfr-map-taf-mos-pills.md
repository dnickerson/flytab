# TFR Map Layer + TAF/MOS Pills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render NOTAM-sourced TFR polygons on the map (default ON, labeled "TFR"), and add TAF and MOS quick-look pills to METAR airport rows in WX Briefing.

**Architecture:** `wx-briefing.js` parses TFR geometry from NOTAM raw text and dispatches a `notam:tfrs` DOM event; `map.js` listens, clears a dedicated `_notamTfrGroup` layer group, and renders the shapes using the same red-dashed style as FIS-B TFRs. The TFR toggle in `layer-panel.js` is renamed "TFR" and defaults ON. The MOS/TAF pills are rendered in each airport's `.wx-card-hdr`; tapping them toggles an inline panel below the card body using `wireTap` + click stopPropagation.

**Tech Stack:** Vanilla JS, Leaflet, wireTap (tap-utils.js), CustomEvent, CSS variables

---

## Files Modified

| File | Change |
|------|--------|
| `web/cockpit/layer-panel.js` | Rename TFR label, default checkbox ON |
| `web/cockpit/map.js` | `_showTfrs = true`, `_notamTfrGroup`, `_notamTfrShapes`, `notam:tfrs` listener, `_addNotamTfrShape()` |
| `web/cockpit/wx-briefing.js` | `_parseTfrGeometry()`, dispatch `notam:tfrs` in `_fetchEnrouteNotams`, `_tafPillOpen`/`_mosPillOpen` Sets, pills in `_buildStationCard` |
| `web/style.css` | `.wx-pill`, `.wx-pill-taf`, `.wx-pill-mos`, `.wx-taf-panel`, `.wx-mos-panel` |
| `web/app.js` | Version bump |

---

### Task 1: Layer panel — rename TFR toggle and default ON

**Files:**
- Modify: `web/cockpit/layer-panel.js`

No tests (UI wiring). Verify by opening the layer panel — the toggle should be labeled "TFR" and start in the ON (checked) position.

- [ ] **Step 1: Rename the label text**

In `web/cockpit/layer-panel.js`, find line ~487:
```javascript
<span class="lp-row-label">TFRs (FIS-B)</span>
```
Replace with:
```javascript
<span class="lp-row-label">TFR</span>
```

- [ ] **Step 2: Default the checkbox to checked**

Find line ~226:
```javascript
tfrInput.checked = false;
```
Replace with:
```javascript
tfrInput.checked = true;
```

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/layer-panel.js
git commit -m "feat(layer-panel): rename TFR toggle, default ON"
```

---

### Task 2: map.js — NOTAM TFR layer group

**Files:**
- Modify: `web/cockpit/map.js`

This task:
- Changes the TFR default from OFF to ON (`_showTfrs = true`)
- Creates `_notamTfrGroup` layer group in `init()` and adds it to the map immediately (so NOTAM TFRs show without requiring FIS-B)
- Registers a `notam:tfrs` listener in `init()` that clears and re-renders NOTAM TFR shapes
- In `setFisbClient()`, adds `_tfrLayer` to map if `_showTfrs` is already true (so FIS-B TFRs also appear on startup)
- Adds `_addNotamTfrShape(shape)` method

No test suite available — validate by opening app and verifying a fetched en-route TFR appears on the map.

- [ ] **Step 1: Change `_showTfrs` default and add `_notamTfrShapes`**

In `web/cockpit/map.js`, find around line 137:
```javascript
        // TFR overlay (FIS-B NOTAMs product_id=8)
        this._tfrLayer = null;           // L.LayerGroup
        this._tfrShapes = new Map();     // raw → L.layer
        this._showTfrs = false;
```
Replace with:
```javascript
        // TFR overlay — FIS-B (via setFisbClient) + NOTAM (via notam:tfrs event)
        this._tfrLayer = null;           // L.LayerGroup (FIS-B TFRs, created in setFisbClient)
        this._tfrShapes = new Map();     // raw → L.layer (FIS-B)
        this._notamTfrGroup = null;      // L.LayerGroup (NOTAM TFRs, created in init)
        this._notamTfrShapes = new Map(); // raw → L.layer (NOTAM)
        this._showTfrs = true;           // default ON
```

- [ ] **Step 2: Create `_notamTfrGroup` in `init()` and register `notam:tfrs` listener**

In `web/cockpit/map.js`, in `init()`, find the last line before the closing `}` of `init()` — currently around line 230:
```javascript
        });
    }
```
Insert the following BEFORE the closing `}` of `init()`:

```javascript
        // NOTAM TFR layer — independent of FIS-B
        this._notamTfrGroup = L.layerGroup().addTo(this.map);
        this._onNotamTfrs = (e) => {
            if (!this._notamTfrGroup) return;
            // Always update shapes regardless of toggle state so they're ready when toggled on
            this._notamTfrShapes.clear();
            this._notamTfrGroup.clearLayers();
            for (const shape of (e.detail?.shapes || [])) {
                this._addNotamTfrShape(shape);
            }
        };
        document.addEventListener('notam:tfrs', this._onNotamTfrs);
```

- [ ] **Step 3: Remove `_onNotamTfrs` listener in `destroy()`**

In `web/cockpit/map.js`, find `destroy()` (around line 246). Add inside the method (anywhere near the top):
```javascript
        if (this._onNotamTfrs) {
            document.removeEventListener('notam:tfrs', this._onNotamTfrs);
            this._onNotamTfrs = null;
        }
```

- [ ] **Step 4: Add `_tfrLayer` to map on `setFisbClient` when TFRs are already ON**

In `setFisbClient()`, find (around line 434):
```javascript
        this._tfrLayer   = L.layerGroup();
```
Replace with:
```javascript
        this._tfrLayer = L.layerGroup();
        if (this._showTfrs && this.map) this._tfrLayer.addTo(this.map);
```

Then find the `if (on)` block inside `toggleTfrs()` that calls `this._tfrLayer.addTo(this.map)`. Verify it's still correct — no change needed there. Also update `toggleTfrs()` to show/hide `_notamTfrGroup` alongside `_tfrLayer`. Find `toggleTfrs(on)` (around line 489):

```javascript
    toggleTfrs(on) {
        this._showTfrs = on;
        if (!this._tfrLayer || !this.map) return;
        if (on) {
            this._tfrLayer.addTo(this.map);
            // Render any TFRs already in memory
            if (this._fisbClient) {
                this._tfrShapes.clear();
                this._tfrLayer.clearLayers();
                for (const n of this._fisbClient.notams) {
                    if (n.is_tfr) this._addTfrShape(n);
                }
            }
        } else {
            this.map.removeLayer(this._tfrLayer);
        }
    }
```
Replace with:
```javascript
    toggleTfrs(on) {
        this._showTfrs = on;
        if (!this.map) return;
        if (on) {
            if (this._tfrLayer) {
                this._tfrLayer.addTo(this.map);
                if (this._fisbClient) {
                    this._tfrShapes.clear();
                    this._tfrLayer.clearLayers();
                    for (const n of this._fisbClient.notams) {
                        if (n.is_tfr) this._addTfrShape(n);
                    }
                }
            }
            if (this._notamTfrGroup) this._notamTfrGroup.addTo(this.map);
        } else {
            if (this._tfrLayer) this.map.removeLayer(this._tfrLayer);
            if (this._notamTfrGroup) this.map.removeLayer(this._notamTfrGroup);
        }
    }
```

- [ ] **Step 5: Add `_addNotamTfrShape(shape)` method**

In `web/cockpit/map.js`, find `_addTfrShape(notam) {` (around line 516). Add the new method immediately before it:

```javascript
    _addNotamTfrShape(shape) {
        if (this._notamTfrShapes.has(shape.raw)) return;

        const fill   = 'rgba(220,38,38,0.15)';
        const stroke = '#dc2626';
        const weight = 2.5;

        let layer = null;

        if (shape.points?.length >= 3) {
            layer = L.polygon(shape.points, {
                color: stroke, fillColor: fill,
                weight, opacity: 1, fillOpacity: 0.2,
                dashArray: '6,4',
            });
        } else if (shape.radiusNm != null && shape.lat != null && shape.lon != null) {
            layer = L.circle([shape.lat, shape.lon], {
                radius: shape.radiusNm * 1852,
                color: stroke, fillColor: fill,
                weight, opacity: 1, fillOpacity: 0.2,
                dashArray: '6,4',
            });
        }

        if (!layer) return;

        const validStr = shape.validTo
            ? `Exp: ${new Date(shape.validTo).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L`
            : '';
        const popupHtml = `
            <div style="max-width:280px;font-family:monospace">
                <div style="font-weight:700;font-size:13px;color:#dc2626;margin-bottom:4px">
                    ⛔ TFR <span style="font-size:10px;color:#888">${validStr}</span>
                </div>
                <div style="font-size:11px;color:#444;word-break:break-all;white-space:pre-wrap">${shape.summary}</div>
            </div>`;
        layer.bindPopup(popupHtml, { maxWidth: 300 });
        layer.addTo(this._notamTfrGroup);
        this._notamTfrShapes.set(shape.raw, layer);
    }

```

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/map.js
git commit -m "feat(map): NOTAM TFR layer, default TFRs ON"
```

---

### Task 3: wx-briefing.js — parse TFR geometry and dispatch event

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

- [ ] **Step 1: Add `_parseTfrGeometry(raw)` method**

In `web/cockpit/wx-briefing.js`, find `_isEnrouteRelevant(raw) {` (around line 1974). Insert the new method immediately before it:

```javascript
    _parseTfrGeometry(raw) {
        // Polygon: DDMM(N|S)/DDDMM(W|E) coordinate pairs (same pattern as fisb-client.js)
        const points = [];
        const polyPat = /(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/g;
        let m;
        while ((m = polyPat.exec(raw)) !== null) {
            let lat = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
            if (m[3] === 'S') lat = -lat;
            let lon = parseInt(m[4], 10) + parseInt(m[5], 10) / 60;
            if (m[6] === 'W') lon = -lon;
            points.push([lat, lon]);
        }
        if (points.length >= 3) return { points };

        // Circle: "WITHIN n NM OF DDMM(N|S) DDDMM(W|E)" or "n-NM RADIUS OF ..."
        const circleMatch =
            raw.match(/WITHIN\s+(\d+(?:\.\d+)?)\s*NM\s+OF\s+(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i) ||
            raw.match(/(\d+(?:\.\d+)?)-NM\s+RADIUS.*?(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i);
        if (circleMatch) {
            const radiusNm = parseFloat(circleMatch[1]);
            let lat = parseInt(circleMatch[2], 10) + parseInt(circleMatch[3], 10) / 60;
            if (circleMatch[4] === 'S') lat = -lat;
            let lon = parseInt(circleMatch[5], 10) + parseInt(circleMatch[6], 10) / 60;
            if (circleMatch[7] === 'W') lon = -lon;
            return { lat, lon, radiusNm };
        }

        return null;
    }

```

- [ ] **Step 2: Dispatch `notam:tfrs` event after successful fetch**

In `_fetchEnrouteNotams()`, find (around line 1942):
```javascript
            this._enrouteNotams = notams;
            this._enrouteNotamFetchedAt = Date.now();
        } catch (err) {
```
Replace with:
```javascript
            this._enrouteNotams = notams;
            this._enrouteNotamFetchedAt = Date.now();

            // Dispatch parsed TFR shapes to map layer
            const tfrShapes = notams
                .filter(n => n.type === 'TFR')
                .map(n => {
                    const geo = this._parseTfrGeometry(n.raw);
                    if (!geo) return null;
                    return { raw: n.raw, summary: n.summary, validFrom: n.validFrom, validTo: n.validTo, ...geo };
                })
                .filter(Boolean);
            document.dispatchEvent(new CustomEvent('notam:tfrs', { detail: { shapes: tfrShapes } }));
        } catch (err) {
```

- [ ] **Step 3: Dispatch empty `notam:tfrs` on error and no-bbox early return**

In `_fetchEnrouteNotams()`, find the no-bbox early return (around line 1887):
```javascript
        if (!bbox) { this._enrouteNotams = []; this._renderNotamSection(); return; }
```
Replace with:
```javascript
        if (!bbox) {
            this._enrouteNotams = [];
            document.dispatchEvent(new CustomEvent('notam:tfrs', { detail: { shapes: [] } }));
            this._renderNotamSection();
            return;
        }
```

Then find the catch block (around line 1944):
```javascript
        } catch (err) {
            console.error('En-route NOTAM fetch failed:', err);
            this._enrouteNotamFetchError = err.message;
            this._enrouteNotams = [];
        }
```
Replace with:
```javascript
        } catch (err) {
            console.error('En-route NOTAM fetch failed:', err);
            this._enrouteNotamFetchError = err.message;
            this._enrouteNotams = [];
            document.dispatchEvent(new CustomEvent('notam:tfrs', { detail: { shapes: [] } }));
        }
```

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(wx-briefing): parse TFR geometry from NOTAM text, dispatch notam:tfrs"
```

---

### Task 4: CSS for pills and inline panels

**Files:**
- Modify: `web/style.css`

- [ ] **Step 1: Add pill and inline panel CSS**

In `web/style.css`, find `.wx-notam-lights-toggle:active { background: var(--hover-bg, rgba(0,0,0,0.05)); }` (the last line of the lights-toggle block, added in v8.34). Add immediately after:

```css
.wx-pill {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 18px;
    cursor: pointer;
    user-select: none;
    min-height: 20px;
    vertical-align: middle;
    margin-left: 4px;
}
.wx-pill-taf { background: #1a6bbf; color: #fff; }
.wx-pill-mos { background: #0f8a6e; color: #fff; }
.wx-pill:active { opacity: 0.75; }

.wx-taf-panel, .wx-mos-panel {
    display: none;
    padding: 6px 14px 10px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    background: var(--bg, #fff);
}
.wx-taf-panel.open, .wx-mos-panel.open { display: block; }

.wx-mos-panel-row {
    display: flex;
    gap: 10px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
}
.wx-mos-panel-row:last-child { border-bottom: none; }
.wx-mos-panel-time {
    min-width: 90px;
    color: var(--text-muted);
    font-size: 11px;
}
.wx-mos-panel-cat {
    min-width: 36px;
    font-weight: 700;
    font-size: 11px;
}
.wx-mos-panel-detail { color: var(--text-secondary, #444); font-size: 11px; }
```

- [ ] **Step 2: Commit**

```bash
git add web/style.css
git commit -m "feat(css): wx-pill, wx-taf-panel, wx-mos-panel styles"
```

---

### Task 5: TAF and MOS pills in airport METAR cards

**Files:**
- Modify: `web/cockpit/wx-briefing.js`

Context: `_buildStationCard(icao, metar, isOnRoute)` in `wx-briefing.js` (around line 1427) builds each airport card. The `.wx-card-hdr` contains ICAO, prox label, obs time, flight cat, and chevron. We add TAF and MOS pills to the header and toggle inline panels below the card body.

The pills use `wireTap` for tap handling and a `click` listener with `e.stopPropagation()` to prevent the tap from also triggering the header's card-body toggle. `_tafPillOpen` and `_mosPillOpen` are Sets on `this` (keyed by ICAO) that persist across re-renders.

- [ ] **Step 1: Add `_tafPillOpen` and `_mosPillOpen` to the constructor**

In the constructor (around line 15), find:
```javascript
        this._lightsExpanded = false;
```
Replace with:
```javascript
        this._lightsExpanded = false;
        this._tafPillOpen = new Set();
        this._mosPillOpen = new Set();
```

- [ ] **Step 2: Clear pill state in `hide()`**

Find `hide()` (around line 65):
```javascript
    hide() {
        this._el?.classList.remove('visible');
        this.visible = false;
    }
```
Replace with:
```javascript
    hide() {
        this._el?.classList.remove('visible');
        this.visible = false;
        this._tafPillOpen.clear();
        this._mosPillOpen.clear();
    }
```

- [ ] **Step 3: Add pills to `_buildStationCard` header**

In `_buildStationCard`, find the `card.innerHTML = ` block (around line 1448):
```javascript
        card.innerHTML = `
            <div class="wx-card-hdr">
                <span class="wx-card-icao">${icao}</span>
                <span class="wx-card-prox${proxLabel === 'DEPARTURE' ? ' departure' : proxLabel === 'DEST' ? ' dest' : isOnRoute ? ' on-route' : ''}">${proxLabel}</span>
                <span class="wx-card-obs">${obsTime}</span>
                <span class="wx-card-cat ${cat}">${d.flight_category || '—'}</span>
                <span class="wx-card-chevron">›</span>
            </div>
            <div class="wx-card-body"></div>
        `;
```
Replace with:
```javascript
        const hasTaf = !!(this._tafData?.[icao]?.fcsts?.length);
        const hasMos = !!(this._mosData?.stations?.[icao]?.periods?.length);

        card.innerHTML = `
            <div class="wx-card-hdr">
                <span class="wx-card-icao">${icao}</span>
                <span class="wx-card-prox${proxLabel === 'DEPARTURE' ? ' departure' : proxLabel === 'DEST' ? ' dest' : isOnRoute ? ' on-route' : ''}">${proxLabel}</span>
                <span class="wx-card-obs">${obsTime}</span>
                <span class="wx-card-cat ${cat}">${d.flight_category || '—'}</span>
                ${hasTaf ? '<span class="wx-pill wx-pill-taf" data-action="taf-pill">TAF</span>' : ''}
                ${hasMos ? '<span class="wx-pill wx-pill-mos" data-action="mos-pill">MOS</span>' : ''}
                <span class="wx-card-chevron">›</span>
            </div>
            <div class="wx-card-body"></div>
            ${hasTaf ? `<div class="wx-taf-panel${this._tafPillOpen.has(icao) ? ' open' : ''}"></div>` : ''}
            ${hasMos ? `<div class="wx-mos-panel${this._mosPillOpen.has(icao) ? ' open' : ''}"></div>` : ''}
        `;
```

- [ ] **Step 4: Wire pill taps after `card.innerHTML`**

Immediately after the block that wires the header click (around line 1468), add the following pill wiring. The existing header-wiring block ends around line 1476 with:
```javascript
        });

        return card;
```
Insert pill wiring before `return card;`:

```javascript
        // TAF pill toggle
        const tafPill = card.querySelector('[data-action="taf-pill"]');
        const tafPanel = card.querySelector('.wx-taf-panel');
        if (tafPill && tafPanel) {
            tafPill.addEventListener('click', (e) => e.stopPropagation());
            wireTap(tafPill, () => {
                const open = tafPanel.classList.toggle('open');
                if (open) {
                    this._tafPillOpen.add(icao);
                    if (!tafPanel.innerHTML.trim()) this._populateTafPanel(tafPanel, icao);
                } else {
                    this._tafPillOpen.delete(icao);
                }
            });
            // Restore open state across re-renders
            if (tafPanel.classList.contains('open') && !tafPanel.innerHTML.trim()) {
                this._populateTafPanel(tafPanel, icao);
            }
        }

        // MOS pill toggle
        const mosPill = card.querySelector('[data-action="mos-pill"]');
        const mosPanel = card.querySelector('.wx-mos-panel');
        if (mosPill && mosPanel) {
            mosPill.addEventListener('click', (e) => e.stopPropagation());
            wireTap(mosPill, () => {
                const open = mosPanel.classList.toggle('open');
                if (open) {
                    this._mosPillOpen.add(icao);
                    if (!mosPanel.innerHTML.trim()) this._populateMosPanel(mosPanel, icao);
                } else {
                    this._mosPillOpen.delete(icao);
                }
            });
            // Restore open state across re-renders
            if (mosPanel.classList.contains('open') && !mosPanel.innerHTML.trim()) {
                this._populateMosPanel(mosPanel, icao);
            }
        }

```

- [ ] **Step 5: Add `_populateTafPanel(panel, icao)` helper**

Find `_buildStationCard(icao, metar, isOnRoute) {` (around line 1427). Add the new method immediately after the closing `}` of `_buildStationCard`:

```javascript
    _populateTafPanel(panel, icao) {
        const taf = this._tafData?.[icao];
        if (!taf?.fcsts?.length) { panel.innerHTML = '<div class="wx-taf-no">No TAF periods available.</div>'; return; }
        const issued = taf.issued
            ? new Date(taf.issued).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' L'
            : '—';
        const vFrom = taf.valid_from
            ? new Date(taf.valid_from * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
            : '—';
        const vTo = taf.valid_to
            ? new Date(taf.valid_to * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
            : '—';
        let html = `<div class="wx-taf-issued">TAF · Issued ${issued} · Valid ${vFrom} → ${vTo}</div>`;
        for (const f of taf.fcsts) html += this._buildTafRow(f);
        panel.innerHTML = html;
    }

    _populateMosPanel(panel, icao) {
        const sd = this._mosData?.stations?.[icao];
        if (!sd?.periods?.length) { panel.innerHTML = '<div class="wx-taf-no">No MOS data.</div>'; return; }
        const now = new Date();
        const future = sd.periods.filter(p => p.valid_time && new Date(p.valid_time) >= now);
        const shown = future.slice(0, 4);
        if (!shown.length) { panel.innerHTML = '<div class="wx-taf-no">No upcoming MOS periods.</div>'; return; }
        let html = '';
        for (const p of shown) {
            const vt = new Date(p.valid_time);
            const timeStr = vt.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ' L';
            const cat = p.flight_cat || '—';
            const catClass = (cat || 'unknown').toLowerCase();
            const cig = p.cig_label ?? (p.cld === 'BK' ? 'BKN' : p.cld === 'OV' ? 'OVC' : '—');
            const vis = p.vis_label || '—';
            const wdStr = p.wdr != null ? String(Math.round(p.wdr / 10) * 10).padStart(3, '0') : null;
            const wind = (wdStr != null && p.wsp != null) ? `${wdStr}/${p.wsp}kt` : '—';
            const tmp = p.tmp != null ? `${p.tmp}°F` : '—';
            html += `
                <div class="wx-mos-panel-row">
                    <span class="wx-mos-panel-time">${timeStr}</span>
                    <span class="wx-mos-panel-cat wx-cat-${catClass}">${cat}</span>
                    <span class="wx-mos-panel-detail">${cig} · ${vis} · ${wind} · ${tmp}</span>
                </div>`;
        }
        panel.innerHTML = html;
    }

```

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/wx-briefing.js
git commit -m "feat(wx-briefing): TAF and MOS pills on METAR airport rows"
```

---

### Task 6: Version bump and build

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Bump version**

In `web/app.js`, find:
```javascript
const FLYTAB_VERSION = 'v8.34';
```
Replace with:
```javascript
const FLYTAB_VERSION = 'v8.35';
```

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: `APK: flytab-debug-v8.35.apk`

- [ ] **Step 3: Commit**

```bash
git add web/app.js
git commit -m "build: v8.35 — TFR map layer from NOTAMs, TAF/MOS pills"
```
