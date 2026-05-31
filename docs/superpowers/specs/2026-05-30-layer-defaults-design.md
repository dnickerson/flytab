# Layer Defaults — Design Spec

**Date:** 2026-05-30  
**Status:** Approved

## Overview

Add a "Save as Defaults" button and a "Reset to Defaults" button to the Layers panel. Pressing "Save as Defaults" snapshots every current layer state (base chart, overlays, weather/action toggles, airport sub-filters) into a single localStorage key. On next startup, if that key exists, it takes precedence over `cockpit-config.json` and hardcoded defaults. "Reset to Defaults" replays the saved snapshot live on the current map. Also removes the unused "Data & Maps" button.

## Data Model

**localStorage key:** `flypi_layer_defaults`  
**Value:** JSON object with three top-level fields:

```json
{
  "baseLayer": "vector",
  "overlays": {
    "airports": true,
    "navaids": true,
    "fixes": false,
    "airways": true,
    "airspace": true,
    "sua": false
  },
  "actions": {
    "ifr-area": false,
    "tfrs": true,
    "rwy-ext": false,
    "traffic-alt-bypass": false,
    "traffic-alt": false,
    "fuel-gauges": true,
    "radar": false,
    "cb-building": false,
    "conv-intel": false,
    "cb-tcu": false,
    "wx-dots": true,
    "wx-voronoi": false,
    "wx-ceil": false,
    "wx-vis": false,
    "wx-wind": false,
    "wx-temp": false,
    "winds-aloft": false,
    "pireps": false,
    "sigmets": true,
    "airmets-tango": true,
    "airmets-zulu": true,
    "airmets-sierra": true,
    "airmets-other": true,
    "lightning": false,
    "aptfilter-minRunwayFt": 0,
    "aptfilter-pavedOnly": false,
    "aptfilter-showHeliports": false,
    "aptfilter-showSeaplaneBases": false,
    "aptfilter-showUltralight": false
  }
}
```

- `overlays` keys match `data-overlay` attributes on checkboxes in the panel
- `actions` keys match `data-action` attributes on checkboxes; airport sub-filter values use the `aptfilter-<key>` prefix
- If `flypi_layer_defaults` is absent, all existing default logic runs unchanged (no regression)

## Save as Defaults

New method `_saveAsDefaults()` in `LayerPanel`:

1. Read `this._cockpitMap._activeBaseLayer` → `baseLayer`
2. Iterate every `input[data-overlay]` checkbox in the panel DOM → build `overlays` map
3. Iterate every `input[data-action]` checkbox → build `actions` map
4. Iterate every `select[data-aptfilter]` and `input[data-aptfilter]` → add to `actions` as `aptfilter-<key>`
5. Write `localStorage.setItem('flypi_layer_defaults', JSON.stringify({ baseLayer, overlays, actions }))`
6. Set `#lpDefaultsConfirm` text to "Defaults saved" and fade it out after 2 seconds

## Apply on Startup

`_syncOverlayStates()` is extended:

```
saved = JSON.parse(localStorage.getItem('flypi_layer_defaults') || 'null')
if saved:
    use saved.overlays[key] for each data-overlay checkbox (replaces cockpit-config + hardcoded defaults)
else:
    existing fallback logic (cockpit-config → hardcoded defaults) — unchanged
```

The `data-action` init block inside `init()` gets the same pattern:

```
if saved:
    use saved.actions[key] to set initial checked state for each data-action input
    fire corresponding handler to activate the layer
else:
    existing hardcoded defaults — unchanged
```

Base chart init in `open()`:

```
if saved:
    use saved.baseLayer instead of this._cockpitMap._activeBaseLayer
```

The base chart is also applied during init (not just when the panel opens) so the correct chart loads from startup.

## Reset to Defaults

New method `_resetToDefaults()` in `LayerPanel`:

1. Read `flypi_layer_defaults` — if absent, return immediately (button is visually muted when key absent)
2. For each key in `saved.overlays`: set checkbox `.checked`, call `_toggleOverlay(key, val)`
3. For each key in `saved.actions`: set checkbox `.checked` (or select `.value`), fire the corresponding action handler (same path as user tap)
4. Call `this._cockpitMap.switchBaseLayer(saved.baseLayer)` and update radio button active state

Reset is live — the map updates immediately, not just on next restart.

## UI Changes

### Remove

Remove the "Data & Maps" button (line 618–620 of `layer-panel.js`):
```html
<button class="lp-cache-page-btn" id="lpOpenDataMaps">Data &amp; Maps &#9776;</button>
```
Remove the corresponding `click` handler wired in `init()`.

### Add

Replace with, at the bottom of `.layer-panel-body`:
```html
<div class="lp-defaults-row">
  <button class="lp-defaults-save" id="lpSaveDefaults">Save as Defaults</button>
  <button class="lp-defaults-reset" id="lpResetDefaults">Reset to Defaults</button>
</div>
<div class="lp-defaults-confirm" id="lpDefaultsConfirm"></div>
```

### Styles (in `web/style.css`)

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
.lp-defaults-reset.lp-defaults-reset--no-saved {
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
.lp-defaults-confirm.lp-defaults-confirm--visible {
  opacity: 1;
}
```

## Files Changed

| File | Change |
|------|--------|
| `web/cockpit/layer-panel.js` | Add `_saveAsDefaults()`, `_resetToDefaults()`, extend `_syncOverlayStates()` and `init()` action defaults, replace Data & Maps button with defaults row, wire button handlers |
| `web/style.css` | Add `.lp-defaults-*` styles |

No changes to `vector-map-layers.js`, `map.js`, `fisb-weather.js`, `cockpit-config.json`, or `app.js`.

## Out of Scope

- Syncing defaults across devices
- Named saved configurations (only one default slot)
- Exporting/importing defaults as a file
