# Radar Source Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile FIS-B/internet auto-detection with a pilot-controlled tap-toggle on the radar badge, fixing five identified breakage risks without touching any working FIS-B path.

**Architecture:** Three files change — `fisb-nexrad.js` gains visibility control (`show`/`hide`) independent of DOM attachment (`_active`); `InetRadarSource` inside `map.js` gains configurable base opacity so `exitLoopMode()` doesn't flash the wrong tile; `CockpitMap` inside `map.js` gains explicit source state (`_radarSource`), a switching method (`_applyRadarSource`), and a badge tap handler. Auto-dim and auto-switch callbacks are removed or guarded.

**Tech Stack:** Vanilla JS, Leaflet, no bundler. All files loaded via `<script>` tags in `web/index.html`. No unit test suite for cockpit JS — verification is build + install + manual CDP confirmation.

## Global Constraints

- Never call `_fisbNexrad.remove()` on a source-mode toggle — only on full radar-off. `remove()` clears `_blocks` and `_frameHistory` and unregisters the FIS-B listener.
- `FisbNexrad.isActive` must remain tied to `_active` (canvas in DOM), not `_visible`. `RadarLoop.show()` checks `!isActive` to decide whether to call `addTo()`.
- `InetRadarSource` is always created on radar enable regardless of source mode (needed for CB building internet sampling fallback and for IEM tile preloading).
- `FisbNexrad.addTo()` is always called on radar enable — canvas is always attached to DOM so frame accumulation and CB building work regardless of which source is displayed.
- Internet tile (`radarLayer`) is always added to the Leaflet map — just at opacity 0 in FIS-B mode.
- Increment `FLYTAB_VERSION` in `web/app.js` and run `bash build.sh` once at the end (Task 5).
- No new CSS classes. Badge uses existing `.radar-badge` styling.
- No changes to `radar-loop.js`, `radar-page.js`, `layer-panel.js`, `app.js`, or any other file.

---

## File Map

| File | Role | What changes |
|------|------|-------------|
| `web/cockpit/fisb-nexrad.js` | FIS-B NEXRAD canvas renderer | Add `_visible` field, `show()`, `hide()`, guard `_draw()` |
| `web/cockpit/map.js` (InetRadarSource class, lines 13–102) | Internet tile frame source | Add `_baseOpacity`, `setBaseOpacity()`, fix `exitLoopMode()` and `drawLive()` |
| `web/cockpit/map.js` (CockpitMap class, lines 750–839) | Main map controller | Add `_radarSource`, `_applyRadarSource()`, `_toggleRadarSource()`, refactor `toggleRadar()`, guard `onFisbNexradLoopReady()`, trim `onFisbNexradData()`, rewrite `_updateRadarBadge()` |

---

## Task 1: FisbNexrad visibility toggle

**Files:**
- Modify: `web/cockpit/fisb-nexrad.js:7–68` (constructor + `_draw`)

**Interfaces:**
- Produces: `FisbNexrad.hide()` — hides canvas, sets `_visible = false`, does NOT change `_active`
- Produces: `FisbNexrad.show()` — shows canvas, sets `_visible = true`, redraws if not in loop mode
- `isActive` getter unchanged — still returns `_active`

- [ ] **Step 1: Add `_visible` field to constructor**

In `web/cockpit/fisb-nexrad.js`, find the constructor (line ~7). After the line `this._loopMode = false;` (line 35), add:

```javascript
        this._visible = true;   // false = canvas hidden for source toggle; _active still true
```

- [ ] **Step 2: Add `hide()` method after `get isActive()`**

Current `get isActive()` is at line ~169. After it, insert:

```javascript
    /** Hide canvas without detaching from DOM or stopping data accumulation. */
    hide() {
        this._visible = false;
        if (this._canvas) this._canvas.style.display = 'none';
    }

    /** Show canvas and redraw current blocks. */
    show() {
        this._visible = true;
        if (this._canvas) this._canvas.style.display = '';
        if (!this._loopMode) this._draw();
    }
```

- [ ] **Step 3: Guard `_draw()` with `_visible` check**

Current `_draw()` at line ~421:
```javascript
    _draw() {
        if (!this._active || !this._mainTarget) return;
        this._drawToTarget(this._mainTarget, 'regional', this._blocks);
    }
```

Replace with:
```javascript
    _draw() {
        if (!this._active || !this._mainTarget || this._visible === false) return;
        this._drawToTarget(this._mainTarget, 'regional', this._blocks);
    }
```

- [ ] **Step 4: Verify the guard does not affect `enterLoopMode` / `exitLoopMode`**

Read `enterLoopMode()` (~line 474) and `exitLoopMode()` (~line 481). They set `_loopMode` and call `_draw()`. The new `_visible` guard stacks alongside `_loopMode` — both must allow drawing for `_draw()` to run. In normal operation `_visible` is `true`, so behavior is identical to before when radar is in FIS-B mode. Confirm neither method references `_visible`. No code changes needed here.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/fisb-nexrad.js
git commit -m "feat(radar): add visibility toggle to FisbNexrad (show/hide)"
```

---

## Task 2: InetRadarSource base opacity control

**Files:**
- Modify: `web/cockpit/map.js:13–102` (InetRadarSource class)

**Interfaces:**
- Produces: `InetRadarSource.setBaseOpacity(opacity: number)` — sets the opacity that `exitLoopMode()` and `drawLive()` restore to. Call with `0` in FIS-B mode, `Settings.radarOpacity || 0.5` in internet mode.

- [ ] **Step 1: Add `_baseOpacity` field in constructor**

In `web/cockpit/map.js`, find `InetRadarSource` constructor (line ~29). After the line `this._loopActive = false;` (line 34), add:

```javascript
        this._baseOpacity = Settings.radarOpacity || 0.5;
```

- [ ] **Step 2: Add `setBaseOpacity()` method**

After the `cleanup()` method (line ~95, end of InetRadarSource), add before the closing `}`:

```javascript
    setBaseOpacity(opacity) {
        this._baseOpacity = opacity;
        if (!this._loopActive && this._radarLayer) {
            this._radarLayer.setOpacity(opacity);
        }
    }
```

- [ ] **Step 3: Fix `exitLoopMode()` to restore to `_baseOpacity`**

Current `exitLoopMode()` (line ~58):
```javascript
    exitLoopMode() {
        this._loopActive = false;
        this._layers.forEach(l => l.setOpacity(0));
        if (this._radarLayer) this._radarLayer.setOpacity(Settings.radarOpacity || 0.5);
    }
```

Replace with:
```javascript
    exitLoopMode() {
        this._loopActive = false;
        this._layers.forEach(l => l.setOpacity(0));
        if (this._radarLayer) this._radarLayer.setOpacity(this._baseOpacity ?? Settings.radarOpacity ?? 0.5);
    }
```

- [ ] **Step 4: Fix `drawLive()` to restore to `_baseOpacity`**

Current `drawLive()` (line ~47):
```javascript
    drawLive() {
        if (!this._loopActive && this._radarLayer) {
            this._radarLayer.setOpacity(Settings.radarOpacity || 0.5);
        }
    }
```

Replace with:
```javascript
    drawLive() {
        if (!this._loopActive && this._radarLayer) {
            this._radarLayer.setOpacity(this._baseOpacity ?? Settings.radarOpacity ?? 0.5);
        }
    }
```

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/map.js
git commit -m "feat(radar): add setBaseOpacity to InetRadarSource to prevent opacity flash"
```

---

## Task 3: CockpitMap source state, switching, and refactored enable/disable

**Files:**
- Modify: `web/cockpit/map.js:104–170` (CockpitMap constructor — add `_radarSource`)
- Modify: `web/cockpit/map.js:750–824` (toggleRadar, onFisbNexradData, onFisbNexradLoopReady)

**Interfaces:**
- Produces: `CockpitMap._radarSource` — `'fisb' | 'inet'`, persisted to `localStorage` key `flytab_radar_source`
- Produces: `CockpitMap._applyRadarSource(source)` — switches display to FIS-B or internet, updates tile opacity and loop source
- Produces: `CockpitMap._toggleRadarSource()` — flips `_radarSource`, persists, calls `_applyRadarSource`, calls `_updateRadarBadge`
- Consumes (Task 1): `FisbNexrad.show()`, `FisbNexrad.hide()`
- Consumes (Task 2): `InetRadarSource.setBaseOpacity(opacity)`

- [ ] **Step 1: Add `_radarSource` to CockpitMap constructor**

In `web/cockpit/map.js`, find the CockpitMap constructor body (line ~104). After the line `this.radarLayer = null;` (line ~115), add:

```javascript
        this._radarSource = 'fisb';   // 'fisb' | 'inet'; loaded from localStorage at radar enable
        this._inetRadarSource = null;
```

(Note: `_inetRadarSource` may already be assigned elsewhere as a property — if it appears in the constructor body already, skip adding it here to avoid duplication.)

- [ ] **Step 2: Add `_applyRadarSource()` method**

After `setRadarTileOpacity()` (~line 846), add:

```javascript
    _applyRadarSource(source) {
        if (source === 'fisb') {
            if (this._fisbNexrad) this._fisbNexrad.show();
            if (this._inetRadarSource) this._inetRadarSource.setBaseOpacity(0);
            if (this.radarLayer) this.radarLayer.setOpacity(0);
            if (this._radarLoop && this._fisbNexrad &&
                    (this._fisbNexrad.frameHistory.length ?? 0) >= 2) {
                this._radarLoop.setNexrad(this._fisbNexrad);
            }
            // else: loop stays on _inetRadarSource until onFisbNexradLoopReady() fires
        } else {
            if (this._fisbNexrad) this._fisbNexrad.hide();
            const opacity = Settings.radarOpacity || 0.5;
            if (this._inetRadarSource) this._inetRadarSource.setBaseOpacity(opacity);
            if (this.radarLayer) this.radarLayer.setOpacity(opacity);
            if (this._radarLoop && this._inetRadarSource) {
                this._radarLoop.setNexrad(this._inetRadarSource);
            }
        }
    }
```

- [ ] **Step 3: Add `_toggleRadarSource()` method**

Directly after `_applyRadarSource()`, add:

```javascript
    _toggleRadarSource() {
        this._radarSource = (this._radarSource === 'fisb') ? 'inet' : 'fisb';
        localStorage.setItem('flytab_radar_source', this._radarSource);
        this._applyRadarSource(this._radarSource);
        this._updateRadarBadge();
    }
```

- [ ] **Step 4: Refactor `toggleRadar(on)` — enable branch**

Replace the entire `if (on && !this.radarLayer)` block (lines 751–787) with:

```javascript
        if (on && !this.radarLayer) {
            // Load persisted source preference; default to FIS-B
            this._radarSource = localStorage.getItem('flytab_radar_source') || 'fisb';

            // Always attach FIS-B canvas to DOM so frame accumulation and CB building work
            // regardless of which source is currently displayed.
            if (this._fisbNexrad) this._fisbNexrad.addTo(this.map);

            // Internet tile — always added to map; opacity set by _applyRadarSource below
            this.radarLayer = L.tileLayer(
                'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
                {
                    opacity: 0,   // _applyRadarSource sets correct opacity immediately after
                    minNativeZoom: 6,
                    maxZoom: 14,
                    updateWhenZooming: false,
                    attribution: 'NEXRAD © Iowa State Mesonet',
                }
            );
            this.radarLayer.addTo(this.map);

            // Tell FisbNexrad about the internet tile so CB building can sample it
            if (this._fisbNexrad) this._fisbNexrad.setCbInternetLayer(this.radarLayer);

            // Internet source — always created; preloads 12 IEM tile layers at opacity 0
            this._inetRadarSource = new InetRadarSource(this.map, this.radarLayer);

            // Start loop on internet (safe starting point — IEM always has 12 frames)
            if (this._radarLoop) this._radarLoop.setNexrad(this._inetRadarSource);

            // Apply the correct source immediately (sets opacities, switches loop if FIS-B ready)
            this._applyRadarSource(this._radarSource);

            // Badge — show immediately, refresh every 30 s
            this._updateRadarBadge();
            if (!this._radarBadgeTimer) {
                this._radarBadgeTimer = setInterval(() => this._updateRadarBadge(), 30000);
            }
```

- [ ] **Step 5: Leave `toggleRadar(on)` disable branch unchanged**

The `else if (!on && this.radarLayer)` block (lines 788–802) is correct as-is. Confirm it still contains:
```javascript
            if (this._fisbNexrad) {
                this._fisbNexrad.setCbInternetLayer(null);
                this._fisbNexrad.remove();
            }
            if (this._inetRadarSource) {
                this._inetRadarSource.cleanup();
                this._inetRadarSource = null;
            }
            this.map.removeLayer(this.radarLayer);
            this.radarLayer = null;
            if (this._radarBadge) this._radarBadge.style.display = 'none';
            clearInterval(this._radarBadgeTimer); this._radarBadgeTimer = null;
```
No changes needed here.

- [ ] **Step 6: Trim `onFisbNexradData()` — remove auto-dim**

Current (line ~810):
```javascript
    onFisbNexradData() {
        if (this.radarLayer) this.radarLayer.setOpacity(0.3);
        if (this.radarLayer) this._updateRadarBadge();
    }
```

Replace with (keep badge refresh, remove opacity change):
```javascript
    onFisbNexradData() {
        if (this.radarLayer) this._updateRadarBadge();
    }
```

- [ ] **Step 7: Guard `onFisbNexradLoopReady()` by source**

Current (line ~820):
```javascript
    onFisbNexradLoopReady() {
        if (this._radarLoop && this._fisbNexrad) {
            this._radarLoop.setNexrad(this._fisbNexrad);
        }
    }
```

Replace with:
```javascript
    onFisbNexradLoopReady() {
        if (this._radarSource !== 'fisb') return;
        if (this._radarLoop && this._fisbNexrad) {
            this._radarLoop.setNexrad(this._fisbNexrad);
        }
    }
```

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/map.js
git commit -m "feat(radar): add explicit source toggle (_applyRadarSource, _toggleRadarSource)"
```

---

## Task 4: Badge tap handler and dual-mode text

**Files:**
- Modify: `web/cockpit/map.js:826–839` (`_updateRadarBadge`)

**Interfaces:**
- Consumes (Task 3): `CockpitMap._radarSource`, `CockpitMap._toggleRadarSource()`
- Produces: `_radarBadge` element — always visible while radar on, shows current source + `⇄`, tappable to toggle

- [ ] **Step 1: Rewrite `_updateRadarBadge()`**

Replace the entire method (lines 826–839):

```javascript
    _updateRadarBadge() {
        if (!this._fisbNexrad) return;
        const el = this._radarBadge || (this._radarBadge = (() => {
            const d = document.createElement('div');
            d.className = 'radar-badge';
            this.container.appendChild(d);

            // Tap handler — standard project pattern (touchstart capture + touchend bubble)
            let _tapStart = null;
            d.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1)
                    _tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
                else _tapStart = null;
            }, { capture: true, passive: true });
            d.addEventListener('touchend', (e) => {
                if (!_tapStart || e.changedTouches.length !== 1) { _tapStart = null; return; }
                const s = _tapStart; _tapStart = null;
                const dx = e.changedTouches[0].clientX - s.x;
                const dy = e.changedTouches[0].clientY - s.y;
                if (dx * dx + dy * dy > 400) return;   // >20px = drag
                if (Date.now() - s.t > 500) return;     // >500ms = long-press
                this._toggleRadarSource();
            }, { passive: true });

            return d;
        })());

        el.style.display = 'block';   // always visible while radar is on

        if (this._radarSource === 'inet') {
            el.textContent = 'Internet · NEXRAD  ⇄';
            return;
        }
        // FIS-B mode
        const ageMs = this._fisbNexrad.getDataAgeMs('regional');
        const age = ageMs == null ? '--' : Math.round(ageMs / 60000);
        el.textContent = `FIS-B · Regional · ${age} min  ⇄`;
    }
```

- [ ] **Step 2: Confirm touch target is adequate**

The `.radar-badge` element in `style.css` already has enough padding for tap use. Check:

```bash
grep -n "radar-badge" /home/dananickerson/flytab/web/style.css
```

If the element has `padding` of at least 8px vertical, no change needed. If it has `height` hardcoded smaller than 36px, add `padding: 8px 10px` to make it fingerable. (Do not add `min-height` to the CSS if it would break existing layout — just ensure the text + padding puts it over 36px rendered height.)

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/map.js
git commit -m "feat(radar): badge tap toggles FIS-B/internet source with dual-mode text"
```

---

## Task 5: Version bump, build, install, and verify

**Files:**
- Modify: `web/app.js` (version bump)

- [ ] **Step 1: Increment FLYTAB_VERSION in `web/app.js`**

Find the version constant at the top of `web/app.js` (first line or near it):
```javascript
const FLYTAB_VERSION = 'vX.XX';
```
Increment the minor version by 1.

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: APK written to `data/`. No build errors.

- [ ] **Step 3: Install on tablet**

```bash
~/Android/Sdk/platform-tools/adb install -r data/app-debug.apk
```

If ADB hangs >30s, kill and retry or sideload from `data/` directly.

- [ ] **Step 4: Verify FIS-B radar still works (primary path)**

Connect tablet to Stratux WiFi. In FlyTab, enable the NEXRAD radar toggle in the layer panel. Confirm:

- FIS-B canvas appears on map (coloured radar blocks from Stratux)
- Badge shows `FIS-B · Regional · X min  ⇄`
- Badge is visible (not hidden)
- Radar loop controls appear at bottom of map

Run in CDP console (see CLAUDE.md ADB section for port setup):
```javascript
window.app.cockpitMap._radarSource   // should be 'fisb'
window.app.cockpitMap._fisbNexrad.isActive   // should be true
window.app.cockpitMap._fisbNexrad._visible   // should be true
window.app.cockpitMap.radarLayer.options.opacity  // initial value 0 (set by _applyRadarSource)
```

- [ ] **Step 5: Verify toggle switches to Internet**

Tap the badge. Confirm:

- FIS-B canvas disappears (blocks no longer drawn on map)
- Internet IEM tile appears at full opacity
- Badge shows `Internet · NEXRAD  ⇄`
- Radar loop continues playing (now IEM frames)

CDP:
```javascript
window.app.cockpitMap._radarSource   // 'inet'
window.app.cockpitMap._fisbNexrad._visible   // false
window.app.cockpitMap._fisbNexrad.isActive   // still true (canvas still in DOM)
window.app.cockpitMap._fisbNexrad._blocks.size  // still accumulating — should be > 0 if in flight
```

- [ ] **Step 6: Verify toggle switches back to FIS-B**

Tap badge again. Confirm:

- FIS-B canvas reappears with current blocks
- Internet tile disappears (opacity 0)
- Badge shows `FIS-B · Regional · X min  ⇄`

CDP:
```javascript
window.app.cockpitMap._radarSource   // 'fisb'
window.app.cockpitMap._fisbNexrad._visible   // true
```

- [ ] **Step 7: Verify preference persists across app restart**

Toggle to Internet mode. Force-stop FlyTab. Reopen. Enable radar. Confirm badge shows `Internet · NEXRAD  ⇄` immediately — not FIS-B.

CDP:
```javascript
localStorage.getItem('flytab_radar_source')  // 'inet'
```

- [ ] **Step 8: Verify loop mode transition (FIS-B → Internet → loop open → toggle)**

Enable radar. Open radar loop (tap the loop button). While loop is playing:
1. Tap badge to switch to Internet — loop should continue on IEM frames
2. Tap badge again to switch back to FIS-B — loop should switch to FIS-B frames if 2+ are available

If FIS-B has fewer than 2 frames, loop stays on IEM until `onFisbNexradLoopReady` fires and source is still `'fisb'`.

- [ ] **Step 9: Verify radar disable clears state cleanly**

Toggle radar off via layer panel. Confirm:
- Badge disappears
- `_inetRadarSource` is null
- FIS-B canvas is removed from DOM (but `_fisbNexrad` instance still exists)

CDP:
```javascript
window.app.cockpitMap.radarLayer    // null
window.app.cockpitMap._inetRadarSource  // null
window.app.cockpitMap._fisbNexrad.isActive  // false (remove() was called)
```

Re-enable radar. Confirm it returns to whichever source was last persisted.

- [ ] **Step 10: Final commit**

```bash
git add web/app.js
git commit -m "chore: bump version for radar source toggle"
```

---

## Self-Review Checklist

- [x] Spec §State → Task 3 Step 1 (constructor field), Task 3 Step 4 (localStorage load)
- [x] Spec §Badge/Toggle → Task 4 (touch handler, dual-mode text, `⇄`)
- [x] Spec §`_applyRadarSource` → Task 3 Step 2
- [x] Spec §`_toggleRadarSource` → Task 3 Step 3
- [x] Spec §toggleRadar enable → Task 3 Step 4
- [x] Spec §toggleRadar disable → Task 3 Step 5 (unchanged, confirmed)
- [x] Spec §FisbNexrad `_visible` → Task 1 Steps 1–3
- [x] Spec §FisbNexrad `hide()`/`show()` → Task 1 Step 2
- [x] Spec §`_draw()` guard → Task 1 Step 3
- [x] Spec §InetRadarSource `_baseOpacity`/`setBaseOpacity()` → Task 2 Steps 1–2
- [x] Spec §InetRadarSource `exitLoopMode()` fix → Task 2 Step 3
- [x] Spec §InetRadarSource `drawLive()` fix → Task 2 Step 4
- [x] Spec §`onFisbNexradData()` trim → Task 3 Step 6
- [x] Spec §`onFisbNexradLoopReady()` guard → Task 3 Step 7
- [x] Spec §`_updateRadarBadge()` rewrite → Task 4 Step 1
- [x] Risk 1 (InetRadarSource opacity flash) → Task 2 + Task 3 Step 2 (`setBaseOpacity(0)`)
- [x] Risk 2 (`onFisbNexradData` wrong opacity) → Task 3 Step 6
- [x] Risk 3 (`onFisbNexradLoopReady` override) → Task 3 Step 7
- [x] Risk 4 (`isActive` vs `_visible` separation) → Task 1 Steps 1–3
- [x] Risk 5 (source-switch during open loop) → covered by Risk 1 fix (`_baseOpacity = 0` in FIS-B mode means `exitLoopMode()` restores to 0)
