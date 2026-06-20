# Radar Source Toggle — Design Spec

**Date:** 2026-06-19  
**Status:** Approved for implementation

## Problem

The existing auto-detection logic that tries to switch between FIS-B and internet NEXRAD is unreliable. It uses three callbacks (`onFisbNexradData`, `onFisbNexradLoopReady`, a startup block-count check) with timing dependencies that produce cases where the wrong source is displayed silently. The internet tile is always loaded and sometimes visually overlaps the FIS-B canvas at incorrect opacities.

## Solution

Replace auto-detection with an explicit pilot-controlled toggle. The pilot taps the existing radar badge to switch between FIS-B and internet. No new UI element — the badge is already contextually correct.

---

## State

### New field: `CockpitMap._radarSource`

```
'fisb' | 'inet'
```

- Persisted to `localStorage` under key `flytab_radar_source`
- Loaded at `toggleRadar(true)` time; defaults to `'fisb'` if not set
- Only read/written by `CockpitMap`

---

## Badge / Toggle

### Visual

The existing `_radarBadge` div (lazy-created in `_updateRadarBadge()`, child of `this.container`) becomes the toggle. It is always visible while radar is on; hidden when radar is off (unchanged).

Text by mode:

| Mode | Badge text |
|------|-----------|
| FIS-B | `FIS-B · Regional · 2 min  ⇄` |
| FIS-B, no data yet | `FIS-B · Regional · --  ⇄` |
| Internet | `Internet · NEXRAD  ⇄` |

The `⇄` signals tappability. Styling: inherit the existing `.radar-badge` CSS; no new class needed.

### Touch handler

Applied once in `_updateRadarBadge()` at lazy-create time (the `||` branch). Uses the standard project pattern:

```javascript
let _badgeTapStart = null;
el.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1)
        _badgeTapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    else _badgeTapStart = null;
}, { capture: true, passive: true });
el.addEventListener('touchend', (e) => {
    if (!_badgeTapStart || e.changedTouches.length !== 1) { _badgeTapStart = null; return; }
    const s = _badgeTapStart; _badgeTapStart = null;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (dx*dx + dy*dy > 400) return;   // >20px = drag
    if (Date.now() - s.t > 500) return; // >500ms = long-press
    this._toggleRadarSource();
}, { passive: true });
```

`touchstart` uses `capture: true` to fire before Leaflet's drag handler.

### `_toggleRadarSource()` (new private method on `CockpitMap`)

```javascript
_toggleRadarSource() {
    this._radarSource = (this._radarSource === 'fisb') ? 'inet' : 'fisb';
    localStorage.setItem('flytab_radar_source', this._radarSource);
    this._applyRadarSource(this._radarSource);
    this._updateRadarBadge();
}
```

---

## `_applyRadarSource(source)` — new private method on `CockpitMap`

Central switching logic. Called at radar enable time and on every tap.

```javascript
_applyRadarSource(source) {
    if (source === 'fisb') {
        // Show FIS-B canvas
        if (this._fisbNexrad) this._fisbNexrad.show();
        // Hide internet tile
        if (this._inetRadarSource) this._inetRadarSource.setBaseOpacity(0);
        if (this.radarLayer) this.radarLayer.setOpacity(0);
        // Switch loop source to FIS-B if enough frames; otherwise stay on internet
        // until onFisbNexradLoopReady fires
        if (this._radarLoop && this._fisbNexrad) {
            if ((this._fisbNexrad.frameHistory.length ?? 0) >= 2) {
                this._radarLoop.setNexrad(this._fisbNexrad);
            }
            // else: loop stays on _inetRadarSource until onFisbNexradLoopReady() fires
        }
    } else {
        // Hide FIS-B canvas
        if (this._fisbNexrad) this._fisbNexrad.hide();
        // Show internet tile
        const opacity = Settings.radarOpacity || 0.5;
        if (this._inetRadarSource) this._inetRadarSource.setBaseOpacity(opacity);
        if (this.radarLayer) this.radarLayer.setOpacity(opacity);
        // Switch loop source to internet
        if (this._radarLoop && this._inetRadarSource) {
            this._radarLoop.setNexrad(this._inetRadarSource);
        }
    }
}
```

---

## Changes to `toggleRadar(on)` in `CockpitMap`

### On enable (`on === true`)

Replace the `fisbHasBlocks` opacity block and the auto-switch logic with:

1. Load `_radarSource` from localStorage (`'fisb'` default)
2. `_fisbNexrad.addTo(map)` — always attach canvas to DOM (needed for CB building and frame accumulation regardless of display mode)
3. Create `radarLayer` (IEM tile) at **opacity 0** always — actual opacity set by `_applyRadarSource`
4. Create `_inetRadarSource = new InetRadarSource(map, radarLayer)`
5. `_radarLoop.setNexrad(_inetRadarSource)` — safe starting point; `_applyRadarSource` switches immediately if source is FIS-B with frames
6. Call `_applyRadarSource(this._radarSource)` — sets correct opacity and loop source
7. Start badge refresh timer as before

### On disable (`on === false`)

Unchanged except: call `_fisbNexrad.remove()` (full teardown — stops canvas, clears blocks). `hide()` is only for the source toggle while radar is on.

---

## Changes to `FisbNexrad`

### New field: `_visible` (boolean, default `true`)

Tracks whether the canvas should draw. Independent of `_active` (which tracks whether the canvas is attached to the DOM).

### New method: `hide()`

```javascript
hide() {
    this._visible = false;
    if (this._canvas) this._canvas.style.display = 'none';
}
```

### New method: `show()`

```javascript
show() {
    this._visible = true;
    if (this._canvas) this._canvas.style.display = '';
    if (!this._loopMode) this._draw();
}
```

### Guard in `_draw()`

```javascript
_draw() {
    if (!this._active || !this._mainTarget || this._visible === false) return;
    this._drawToTarget(this._mainTarget, 'regional', this._blocks);
}
```

### No change to `_active`, `isActive`, `addTo()`, or `remove()`

`isActive` continues to reflect DOM attachment. `RadarLoop.show()` checks `!isActive` to decide whether to call `addTo()` — this logic is unchanged.

### `enterLoopMode()` and `exitLoopMode()` unchanged

They suppress/resume `_draw()` via `_loopMode`. The `_visible` guard sits alongside `_loopMode` — both must be false for `_draw()` to run.

---

## Changes to `InetRadarSource`

### New field: `_baseOpacity` (default `Settings.radarOpacity || 0.5`)

### New method: `setBaseOpacity(opacity)`

```javascript
setBaseOpacity(opacity) {
    this._baseOpacity = opacity;
    if (!this._loopActive && this._radarLayer) {
        this._radarLayer.setOpacity(opacity);
    }
}
```

### Update `exitLoopMode()` — restore to `_baseOpacity` instead of hardcoded opacity

```javascript
exitLoopMode() {
    this._loopActive = false;
    this._layers.forEach(l => l.setOpacity(0));
    if (this._radarLayer) this._radarLayer.setOpacity(this._baseOpacity ?? Settings.radarOpacity ?? 0.5);
}
```

### Update `drawLive()` — same fix

```javascript
drawLive() {
    if (!this._loopActive && this._radarLayer) {
        this._radarLayer.setOpacity(this._baseOpacity ?? Settings.radarOpacity ?? 0.5);
    }
}
```

---

## Removals / Guards in `CockpitMap`

### `onFisbNexradData()` — remove opacity-change side effect

This callback used to auto-dim the internet tile when FIS-B got its first block. The pilot controls source now; the tile opacity is set by `_applyRadarSource` and stays there. Remove the `radarLayer.setOpacity(0.3)` call. The badge update call (`_updateRadarBadge()`) can remain.

### `onFisbNexradLoopReady()` — guard by `_radarSource`

```javascript
onFisbNexradLoopReady() {
    if (this._radarSource !== 'fisb') return;
    if (this._radarLoop && this._fisbNexrad) {
        this._radarLoop.setNexrad(this._fisbNexrad);
    }
}
```

Prevents FIS-B from silently overriding the pilot's internet choice when frames accumulate.

---

## Badge refresh: `_updateRadarBadge()`

Updated to handle both modes and never hide while radar is on:

```javascript
_updateRadarBadge() {
    const el = this._radarBadge || (this._radarBadge = (() => {
        const d = document.createElement('div');
        d.className = 'radar-badge';
        this.container.appendChild(d);
        // wire touch toggle (once) — see Badge section above for full handler
        return d;
    })());

    el.style.display = 'block'; // always shown while radar is on

    if (this._radarSource === 'inet') {
        el.textContent = 'Internet · NEXRAD  ⇄';
        return;
    }
    // FIS-B mode
    const ageMs = this._fisbNexrad?.getDataAgeMs('regional');
    const age = ageMs == null ? '--' : Math.round(ageMs / 60000);
    el.textContent = `FIS-B · Regional · ${age} min  ⇄`;
}
```

---

## Files Changed

| File | Change |
|------|--------|
| `web/cockpit/map.js` | `toggleRadar()` rewrite, `_applyRadarSource()` new, `_toggleRadarSource()` new, `_updateRadarBadge()` updated, `onFisbNexradData()` trimmed, `onFisbNexradLoopReady()` guarded |
| `web/cockpit/fisb-nexrad.js` | `_visible` field, `hide()`, `show()`, `_draw()` guard |
| `web/cockpit/map.js` (InetRadarSource) | `_baseOpacity` field, `setBaseOpacity()`, `exitLoopMode()` fix, `drawLive()` fix |

No changes to: `radar-loop.js`, `radar-page.js`, `layer-panel.js`, `app.js`, `fisb-client.js`, `style.css`.

---

## What Is Preserved (Verified Safe)

| Component | Status |
|-----------|--------|
| FisbNexrad canvas `_draw()` on map move/zoom | Safe — `_active && !_loopMode && _visible !== false` |
| RadarLoop FIS-B path (`drawFrame` via canvas) | Safe — `_nexrad === _fisbRenderer` check unchanged |
| RadarLoop Internet path (tile opacity) | Safe — `exitLoopMode()` uses `_baseOpacity` |
| RadarLoop source-switch while open | Safe — `setNexrad()` calls `exitLoopMode()` on old, `enterLoopMode()` on new; `_baseOpacity` prevents flash |
| RadarPage CONUS view | Safe — independent instance, reads `fisbNexrad` directly, unaffected |
| CB building (FIS-B path) | Safe — `_handleNexrad()` runs regardless of `_visible` |
| CB building (Internet fallback) | Safe — `_cbInetLayer` still set via `setCbInternetLayer()` |
| Frame accumulation in internet mode | Safe — `FisbNexrad` stays `_active`; listener registered; blocks/history accumulate |
| `isActive` used by RadarLoop.show() | Safe — still tied to `_active`, not `_visible` |
