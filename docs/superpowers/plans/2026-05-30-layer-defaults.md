# Layer Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Save as Defaults" and "Reset to Defaults" buttons to the Layers panel so the pilot can define which layers are on at startup, and remove the unused "Data & Maps" button.

**Architecture:** All changes are self-contained in `layer-panel.js` and `style.css`. A single localStorage key `flypi_layer_defaults` stores a JSON snapshot of all layer states. On startup, `init()` reads this key and applies it before any hardcoded defaults. The reset button replays the snapshot live on the current map.

**Tech Stack:** Vanilla JS, CSS custom properties, localStorage, existing `VectorMapLayers` / `CockpitMap` / `FisbWeatherDisplay` APIs already wired in the panel.

**Note on testing:** `layer-panel.js` has no automated test suite (only `web/shared/planning/` does). Each task uses manual verification steps on the running app instead.

---

### Task 1: Add CSS styles

**Files:**
- Modify: `web/style.css`

- [ ] **Step 1: Find the existing `.lp-cache-page-btn` style in `web/style.css`**

Run: `grep -n "lp-cache-page-btn" web/style.css`

Note the line number — add new styles near it.

- [ ] **Step 2: Add new styles after `.lp-cache-page-btn`**

Add this block immediately after the existing `.lp-cache-page-btn` rule:

```css
.lp-defaults-row {
    display: flex;
    gap: 8px;
    padding: 12px 16px 8px;
}
.lp-defaults-save,
.lp-defaults-reset {
    flex: 1;
    min-height: var(--touch-min, 56px);
    border-radius: 6px;
    font-family: var(--font-ui);
    font-weight: 700;
    font-size: 14px;
    border: none;
    cursor: pointer;
}
.lp-defaults-save {
    background: var(--accent);
    color: #fff;
}
.lp-defaults-reset {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
}
.lp-defaults-reset--no-saved {
    opacity: 0.4;
    cursor: default;
}
.lp-defaults-confirm {
    text-align: center;
    font-family: var(--font-ui);
    font-size: 13px;
    color: var(--color-success);
    font-weight: 700;
    min-height: 20px;
    padding-bottom: 8px;
    opacity: 0;
    transition: opacity 0.3s;
}
.lp-defaults-confirm--visible {
    opacity: 1;
}
```

- [ ] **Step 3: Commit**

```bash
git add web/style.css
git commit -m "style(layer-panel): add lp-defaults-row, save/reset button, confirm styles"
```

---

### Task 2: Replace the "Data & Maps" button in `_buildHtml()`

**Files:**
- Modify: `web/cockpit/layer-panel.js`

The "Data & Maps" button is at the bottom of `_buildHtml()` return value, just before `</div>` (closing `.layer-panel-body`). It currently reads:

```html
            <button class="lp-cache-page-btn" id="lpOpenDataMaps">
                Data &amp; Maps &#9776;
            </button>
```

- [ ] **Step 1: Replace the Data & Maps button with the defaults row**

In `web/cockpit/layer-panel.js`, find and replace exactly:

Old:
```javascript
            <button class="lp-cache-page-btn" id="lpOpenDataMaps">
                Data &amp; Maps &#9776;
            </button>
```

New:
```javascript
            <div class="lp-defaults-row">
                <button class="lp-defaults-save" id="lpSaveDefaults">Save as Defaults</button>
                <button class="lp-defaults-reset" id="lpResetDefaults">Reset to Defaults</button>
            </div>
            <div class="lp-defaults-confirm" id="lpDefaultsConfirm"></div>
```

- [ ] **Step 2: Remove the Data & Maps wiring block from `init()`**

In `init()`, find and delete this block entirely (lines ~427–433):

```javascript
        // Wire Data & Maps button
        const dataMapsBtn = this._panel.querySelector('#lpOpenDataMaps');
        if (dataMapsBtn) {
            wireTap(dataMapsBtn, () => {
                this.close();
                window.app?.dataStatus?.show();
            });
        }
```

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/layer-panel.js
git commit -m "feat(layer-panel): replace Data & Maps button with Save/Reset defaults row"
```

---

### Task 3: Add `_saveAsDefaults()`, `_resetToDefaults()`, and `_updateResetBtnState()` methods

**Files:**
- Modify: `web/cockpit/layer-panel.js`

Add these three methods to the `LayerPanel` class, between `_toggleRadar()` (ends ~line 673) and `open()` (~line 675).

- [ ] **Step 1: Add `_updateResetBtnState()` helper**

This method greys out the Reset button when no defaults have been saved yet.

```javascript
    _updateResetBtnState() {
        const btn = this._panel?.querySelector('#lpResetDefaults');
        if (!btn) return;
        const hasSaved = !!localStorage.getItem('flypi_layer_defaults');
        btn.classList.toggle('lp-defaults-reset--no-saved', !hasSaved);
    }
```

- [ ] **Step 2: Add `_saveAsDefaults()` method**

```javascript
    _saveAsDefaults() {
        const snapshot = {
            baseLayer: this._cockpitMap._activeBaseLayer || 'vector',
            overlays: {},
            actions: {}
        };

        this._panel.querySelectorAll('input[data-overlay]').forEach(input => {
            snapshot.overlays[input.dataset.overlay] = input.checked;
        });

        this._panel.querySelectorAll('input[data-action]').forEach(input => {
            snapshot.actions[input.dataset.action] = input.checked;
        });

        this._panel.querySelectorAll('[data-aptfilter]').forEach(el => {
            const key = 'aptfilter-' + el.dataset.aptfilter;
            if (el.type === 'checkbox') snapshot.actions[key] = el.checked;
            else snapshot.actions[key] = parseInt(el.value, 10) || 0;
        });

        localStorage.setItem('flypi_layer_defaults', JSON.stringify(snapshot));

        const confirm = this._panel.querySelector('#lpDefaultsConfirm');
        if (confirm) {
            confirm.textContent = 'Defaults saved';
            confirm.classList.add('lp-defaults-confirm--visible');
            setTimeout(() => confirm.classList.remove('lp-defaults-confirm--visible'), 2000);
        }

        this._updateResetBtnState();
    }
```

- [ ] **Step 3: Add `_resetToDefaults()` method**

This method applies the saved snapshot live to the map. Toggle-style layers (those whose change handlers call `toggleX()` instead of reading `.checked`) are handled by comparing current state to desired state.

```javascript
    _resetToDefaults() {
        const raw = localStorage.getItem('flypi_layer_defaults');
        if (!raw) return;
        const saved = JSON.parse(raw);
        const act = saved.actions || {};

        // Base layer
        if (saved.baseLayer) {
            this._cockpitMap.switchBaseLayer(saved.baseLayer);
            this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(b => {
                b.classList.toggle('active', b.dataset.layer === saved.baseLayer);
            });
        }

        // Overlay layers (airports, navaids, fixes, airways, airspace, sua)
        this._panel.querySelectorAll('input[data-overlay]').forEach(input => {
            const key = input.dataset.overlay;
            if (key in (saved.overlays || {})) {
                input.checked = saved.overlays[key];
                this._toggleOverlay(key, saved.overlays[key]);
            }
        });

        // Actions whose handlers read input.checked — dispatch change to reuse existing logic
        const dispatchable = [
            'traffic-alt-bypass', 'traffic-alt', 'rwy-ext', 'radar',
            'cb-building', 'conv-intel', 'pireps', 'sigmets',
            'airmets-tango', 'airmets-zulu', 'airmets-sierra', 'airmets-other',
            'ifr-area', 'tfrs', 'lightning', 'fuel-gauges'
        ];
        for (const key of dispatchable) {
            if (key in act) {
                const input = this._panel.querySelector(`input[data-action="${key}"]`);
                if (input) {
                    input.checked = act[key];
                    input.dispatchEvent(new Event('change'));
                }
            }
        }

        // Toggle-style layers — only call toggle if current state differs from desired
        const toggleLayers = [
            { key: 'cb-tcu',     getV: () => this._vectorLayers?.cbTcuVisible ?? false,         toggle: () => this._vectorLayers?.toggleCbTcu()          },
            { key: 'wx-dots',    getV: () => this._vectorLayers?.wxDotsVisible ?? true,          toggle: () => this._vectorLayers?.toggleWxDots()          },
            { key: 'wx-voronoi', getV: () => this._vectorLayers?.voronoiVisible ?? false,        toggle: () => this._vectorLayers?.toggleVoronoi()         },
            { key: 'wx-ceil',    getV: () => this._vectorLayers?.ceilVisible ?? false,           toggle: () => this._vectorLayers?.toggleCeil()            },
            { key: 'wx-vis',     getV: () => this._vectorLayers?.visVisible ?? false,            toggle: () => this._vectorLayers?.toggleVis()             },
            { key: 'wx-wind',    getV: () => this._vectorLayers?.windVisible ?? false,           toggle: () => this._vectorLayers?.toggleWind()            },
            { key: 'wx-temp',    getV: () => this._vectorLayers?.tempVisible ?? false,           toggle: () => this._vectorLayers?.toggleTemp()            },
            { key: 'winds-aloft',getV: () => window.app?.fisbWeather?.windsVisible ?? false,    toggle: () => window.app?.fisbWeather?.toggleWinds()      },
        ];
        for (const { key, getV, toggle } of toggleLayers) {
            if (key in act) {
                const input = this._panel.querySelector(`input[data-action="${key}"]`);
                const desired = act[key];
                if (input) input.checked = desired;
                if (getV() !== desired) toggle();
            }
        }

        // Airport filters
        this._panel.querySelectorAll('[data-aptfilter]').forEach(el => {
            const key = 'aptfilter-' + el.dataset.aptfilter;
            if (key in act) {
                if (el.type === 'checkbox') el.checked = act[key];
                else el.value = String(act[key]);
                el.dispatchEvent(new Event('change'));
            }
        });
    }
```

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/layer-panel.js
git commit -m "feat(layer-panel): add _saveAsDefaults, _resetToDefaults, _updateResetBtnState"
```

---

### Task 4: Wire buttons and apply saved defaults on startup in `init()`

**Files:**
- Modify: `web/cockpit/layer-panel.js`

This task wires the two new buttons and changes the action init blocks to check `flypi_layer_defaults` before falling back to hardcoded defaults.

- [ ] **Step 1: Load saved defaults at the top of `init()`**

At the very top of `init()`, immediately after the line `this._backdrop = document.createElement('div');` setup (around line 56), add:

```javascript
        const saved = JSON.parse(localStorage.getItem('flypi_layer_defaults') || 'null');
```

- [ ] **Step 2: Apply saved base layer at startup**

Replace the existing base layer sync block in `init()`:

Old (around lines 97–100):
```javascript
        // Sync initial base layer state
        const currentLayer = this._cockpitMap._activeBaseLayer || 'vector';
        const activeBtn = this._panel.querySelector(`.lp-radio-btn[data-layer="${currentLayer}"]`);
        if (activeBtn) activeBtn.classList.add('active');
```

New:
```javascript
        // Apply saved or current base layer
        const baseLayerToApply = saved?.baseLayer || this._cockpitMap._activeBaseLayer || 'vector';
        if (saved?.baseLayer) this._cockpitMap.switchBaseLayer(saved.baseLayer);
        this._panel.querySelectorAll('.lp-radio-btn[data-layer]').forEach(b => {
            b.classList.toggle('active', b.dataset.layer === baseLayerToApply);
        });
```

- [ ] **Step 3: Apply saved defaults to each action init block (checkbox state only)**

For each action init block in `init()`, replace the hardcoded default with a saved-first pattern for the `input.checked` assignment only. Setting the checkbox correctly here ensures the panel UI reflects the saved state. The *live layer state* will be applied in Step 5 by calling `_resetToDefaults()`.

Make these exact replacements in `init()`:

```javascript
// traffic-alt-bypass (was: taltBypassInput.checked = this._cockpitMap._trafficAltBypass || false)
taltBypassInput.checked = saved?.actions?.['traffic-alt-bypass'] ?? this._cockpitMap._trafficAltBypass ?? false;

// traffic-alt (was: taltInput.checked = this._cockpitMap._showTrafficAlt || false)
taltInput.checked = saved?.actions?.['traffic-alt'] ?? this._cockpitMap._showTrafficAlt ?? false;

// rwy-ext (was: rwyExtInput.checked = true)
rwyExtInput.checked = saved?.actions?.['rwy-ext'] ?? true;

// cb-building (was: cbBuildInput.checked = false)
cbBuildInput.checked = saved?.actions?.['cb-building'] ?? false;

// conv-intel (was: convIntelInput.checked = CockpitConfig.get('convective.enabled') || false)
convIntelInput.checked = saved?.actions?.['conv-intel'] ?? CockpitConfig.get('convective.enabled') ?? false;

// cb-tcu (was: cbTcuInput.checked = this._vectorLayers?.cbTcuVisible ?? false)
cbTcuInput.checked = saved?.actions?.['cb-tcu'] ?? this._vectorLayers?.cbTcuVisible ?? false;

// wx-dots (was: wxDotsInput.checked = this._vectorLayers?.wxDotsVisible ?? true)
wxDotsInput.checked = saved?.actions?.['wx-dots'] ?? this._vectorLayers?.wxDotsVisible ?? true;

// wx-voronoi (was: voronoiInput.checked = this._vectorLayers?.voronoiVisible ?? false)
voronoiInput.checked = saved?.actions?.['wx-voronoi'] ?? this._vectorLayers?.voronoiVisible ?? false;

// winds-aloft (was: windsInput.checked = window.app?.fisbWeather?.windsVisible ?? false)
windsInput.checked = saved?.actions?.['winds-aloft'] ?? window.app?.fisbWeather?.windsVisible ?? false;

// pireps (was: pirepInput.checked = false)
pirepInput.checked = saved?.actions?.['pireps'] ?? false;

// sigmets (was: sigmetInput.checked = true)
sigmetInput.checked = saved?.actions?.['sigmets'] ?? true;

// airmets — in the airmetTypes loop, replace: input.checked = true
// with: input.checked = saved?.actions?.[action] ?? true;

// ifr-area (was: ifrAreaInput.checked = false)
ifrAreaInput.checked = saved?.actions?.['ifr-area'] ?? false;

// tfrs (was: tfrInput.checked = true)
tfrInput.checked = saved?.actions?.['tfrs'] ?? true;

// lightning (was: lightningInput.checked = false)
lightningInput.checked = saved?.actions?.['lightning'] ?? false;

// fuel-gauges (was: localStorage.getItem('flypi_fuel_widget_visible') !== 'false')
fuelGaugesInput.checked = saved?.actions?.['fuel-gauges'] ?? localStorage.getItem('flypi_fuel_widget_visible') !== 'false';

// wx-ceil (was: this._vectorLayers?.ceilVisible ?? false)
ceilInput.checked = saved?.actions?.['wx-ceil'] ?? this._vectorLayers?.ceilVisible ?? false;

// wx-vis (was: this._vectorLayers?.visVisible ?? false)
visInput.checked = saved?.actions?.['wx-vis'] ?? this._vectorLayers?.visVisible ?? false;

// wx-wind (was: this._vectorLayers?.windVisible ?? false)
windInput.checked = saved?.actions?.['wx-wind'] ?? this._vectorLayers?.windVisible ?? false;

// wx-temp (was: this._vectorLayers?.tempVisible ?? false)
tempInput.checked = saved?.actions?.['wx-temp'] ?? this._vectorLayers?.tempVisible ?? false;
```

- [ ] **Step 4: Update `_syncOverlayStates()` call to pass `saved`**

Change the call at the bottom of `init()` from:
```javascript
        this._syncOverlayStates();
```
To:
```javascript
        this._syncOverlayStates(saved);
```

- [ ] **Step 5: Update `_syncOverlayStates()` signature and body**

Replace the entire `_syncOverlayStates()` method:

Old:
```javascript
    _syncOverlayStates() {
        // Read from cockpit config overlay defaults
        const overlays = (typeof CockpitConfig !== 'undefined')
            ? (CockpitConfig.get('map.overlays') || {})
            : {};

        const defaults = {
            airports: true,
            navaids: true,
            fixes: false,
            airways: true,
            airspace: true,
            sua: false,
        };

        this._panel.querySelectorAll('.lp-toggle input[data-overlay]').forEach(input => {
            const key = input.dataset.overlay;
            const enabled = overlays[key]?.enabled ?? defaults[key] ?? true;
            input.checked = enabled;
            this._toggleOverlay(key, enabled);
        });
    }
```

New:
```javascript
    _syncOverlayStates(saved) {
        const overlays = (typeof CockpitConfig !== 'undefined')
            ? (CockpitConfig.get('map.overlays') || {})
            : {};

        const hardcoded = {
            airports: true,
            navaids: true,
            fixes: false,
            airways: true,
            airspace: true,
            sua: false,
        };

        this._panel.querySelectorAll('.lp-toggle input[data-overlay]').forEach(input => {
            const key = input.dataset.overlay;
            let enabled;
            if (saved?.overlays && key in saved.overlays) {
                enabled = saved.overlays[key];
            } else {
                enabled = overlays[key]?.enabled ?? hardcoded[key] ?? true;
            }
            input.checked = enabled;
            this._toggleOverlay(key, enabled);
        });
    }
```

- [ ] **Step 5a: Apply live layer state from saved defaults**

After the `_syncOverlayStates(saved)` call at the end of `init()`, add:

```javascript
        // If saved defaults exist, apply live layer state (idempotent for already-correct layers)
        if (saved) this._resetToDefaults();
```

`_resetToDefaults()` handles all action layers uniformly — it dispatches change events for handlers that read `.checked`, and uses the `getV() !== desired` pattern for toggle-style layers. Calling it here ensures every layer matches its checkbox state on startup, including ones that default to off but were saved as on (radar, ifr-area, lightning, etc.). The overlay layers handled by `_syncOverlayStates()` are idempotent when re-applied (Leaflet's `show()`/`hide()` are no-ops on already-correct state).

- [ ] **Step 6: Wire the Save and Reset buttons in `init()`**

Add this block in `init()`, after the cancel/region/zip/server button wiring and before the call to `_syncOverlayStates(saved)`:

```javascript
        // Wire Save as Defaults button
        const saveDefaultsBtn = this._panel.querySelector('#lpSaveDefaults');
        if (saveDefaultsBtn) {
            wireTap(saveDefaultsBtn, () => this._saveAsDefaults());
        }

        // Wire Reset to Defaults button
        const resetDefaultsBtn = this._panel.querySelector('#lpResetDefaults');
        if (resetDefaultsBtn) {
            wireTap(resetDefaultsBtn, () => this._resetToDefaults());
        }

        // Grey out Reset button if no defaults saved yet
        this._updateResetBtnState();
```

- [ ] **Step 7: Commit**

```bash
git add web/cockpit/layer-panel.js
git commit -m "feat(layer-panel): apply flypi_layer_defaults on startup, wire save/reset buttons"
```



---

### Task 5: Build and verify

**Files:** None changed in this task.

- [ ] **Step 1: Increment version in `web/app.js`**

Open `web/app.js` and increment `FLYTAB_VERSION` by one patch (e.g. `v7.12` → `v7.13`).

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: Build completes, APK copied to `data/`.

- [ ] **Step 3: Install on tablet**

```bash
~/Android/Sdk/platform-tools/adb install -r data/flytab-latest.apk
```

- [ ] **Step 4: Verify Data & Maps button is gone**

Open the app, tap LAYERS. Confirm the "Data & Maps" button is no longer at the bottom. Confirm you see "Save as Defaults" and "Reset to Defaults" buttons instead.

- [ ] **Step 5: Verify Reset button is greyed out on fresh install**

On first open (no `flypi_layer_defaults` key), the Reset button should appear muted/faded. Save as Defaults should be active/blue.

- [ ] **Step 6: Verify Save as Defaults**

1. Toggle a layer off (e.g. turn off Navaids)
2. Tap "Save as Defaults"
3. Confirm "Defaults saved" label appears and fades
4. Close the app fully (Recent Apps → swipe away)
5. Reopen app
6. Open LAYERS panel — Navaids should still be off and the map should not show navaids

- [ ] **Step 7: Verify Reset to Defaults**

1. Toggle Navaids back on (different from saved state)
2. Open LAYERS panel — tap "Reset to Defaults"
3. Navaids toggle should flip back off immediately
4. Map should update live (no navaids visible)

- [ ] **Step 8: Verify base chart default**

1. Switch to SEC chart, then tap "Save as Defaults"
2. Switch to VEC chart, close app fully
3. Reopen — map should load on SEC chart

- [ ] **Step 9: Commit version bump**

```bash
git add web/app.js
git commit -m "chore: bump version for layer defaults feature"
```
