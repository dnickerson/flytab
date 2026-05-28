# Layers Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the left-side LAYERS sliding panel with a right-side drawer triggered by a LAYERS tab at the far left of the tab bar, eliminating the panel-over-map UX problem and the gap between the panel bottom and the route table.

**Architecture:** The `.layer-panel` CSS is changed from `left: 0 / translateX(-100%)` to `right: 0 / translateX(100%)` matching the MORE drawer pattern exactly (`bottom: var(--tab-bar-height)`). A new `LAYERS` tab is prepended to the tab bar. TabBar handles open/close/tab-highlight lifecycle the same way it handles MORE. The ≡ button is removed from the left rail. `LayerPanel` gains a public `onClose` hook so TabBar can restore the MAP tab highlight when the backdrop closes the panel.

**Tech Stack:** Vanilla JS, CSS, no bundler. No new dependencies.

---

## File Map

| File | What changes |
|------|-------------|
| `web/style.css` | `.layer-panel` repositioned to right side; bottom fixed to `var(--tab-bar-height)` |
| `web/cockpit/layer-panel.js` | Add `onClose` callback called at end of `close()` |
| `web/cockpit/tab-bar.js` | Prepend LAYERS tab; handle `layers` in `_selectTab()`; add `_openLayersPanel()` and `_closeLayersPanel()`; set up `layerPanel.onClose` in `init()` |
| `web/app.js` | Remove ≡ button from `_buildLeftRail()`; add `layerPanel: this.layerPanel` to TabBar constructor call |

---

## Task 1: CSS — Reposition Layer Panel to Right Side

**Files:**
- Modify: `web/style.css` (`.layer-panel` rule ~line 6925)

### Overview
The current panel slides in from the left (`left: 0`, `transform: translateX(-100%)`). Change it to slide in from the right like the MORE drawer (`right: 0`, `transform: translateX(100%)`). Remove the complex `--bottom-chrome + --route-table-height` bottom formula — use `var(--tab-bar-height)` just like MORE does.

- [ ] **Step 1.1 — Replace `.layer-panel` positioning**

Find the `.layer-panel` rule (look for `position: fixed; top: 0; left: 0; bottom: calc`). Replace with:

```css
.layer-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: var(--tab-bar-height);
    width: 280px;
    z-index: 9500;
    background: var(--bg-surface);
    border-left: 1px solid var(--border-strong);
    transform: translateX(100%);
    transition: transform 0.2s ease;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
```

Key changes from before:
- `left: 0` → `right: 0`
- `bottom: calc(var(--bottom-chrome) + var(--route-table-height))` → `bottom: var(--tab-bar-height)`
- `border-right` → `border-left`
- `transform: translateX(-100%)` → `transform: translateX(100%)`
- `z-index: 1010` → `z-index: 9500` (matches MORE drawer)

The `.layer-panel.open` rule stays unchanged (`transform: translateX(0)`).

- [ ] **Step 1.2 — Commit CSS change**

```bash
git add web/style.css
git commit -m "style: reposition layer panel to right side, match MORE drawer pattern"
```

---

## Task 2: Layer Panel — Add onClose Callback

**Files:**
- Modify: `web/cockpit/layer-panel.js` (`close()` method ~line 686)

### Overview
TabBar needs to restore the MAP tab highlight when the layer panel closes via its internal backdrop tap or ✕ button. The cleanest hook is a public `onClose` property that `close()` calls if set.

- [ ] **Step 2.1 — Add `onClose` call to `close()`**

Find the `close()` method:

```javascript
close() {
    if (!this._panel.classList.contains('open')) return;
    this._panel.classList.remove('open');
    this._backdrop.classList.remove('open');
}
```

Replace with:

```javascript
close() {
    if (!this._panel.classList.contains('open')) return;
    this._panel.classList.remove('open');
    this._backdrop.classList.remove('open');
    if (typeof this.onClose === 'function') this.onClose();
}
```

- [ ] **Step 2.2 — Commit**

```bash
git add web/cockpit/layer-panel.js
git commit -m "feat(layer-panel): add onClose callback for tab state restoration"
```

---

## Task 3: Tab Bar — LAYERS Tab and Wiring

**Files:**
- Modify: `web/cockpit/tab-bar.js`

### Overview
Prepend `{ id: 'layers', icon: '≡', label: 'LAYERS' }` to the tabs array. In `_selectTab()`, close the layer panel when leaving (just as MORE drawer closes when leaving), open it when `layers` is selected. Add `_openLayersPanel()` and `_closeLayersPanel()` methods mirroring `_openMoreDrawer()` / `_closeMoreDrawer()`. Register the `onClose` callback in `init()`.

- [ ] **Step 3.1 — Prepend LAYERS tab to `tabs` array**

Find `_buildTabBar()`. The `tabs` array currently starts with `{ id: 'map', ... }`. Prepend the LAYERS entry:

```javascript
const tabs = [
    { id: 'layers', icon: '≡', label: 'LAYERS' },
    { id: 'map',   icon: '🗺', label: 'MAP'   },
    { id: 'apt',   icon: '✈',  label: 'APT'   },
    { id: 'eng',   icon: '⚙️',  label: 'ENG'   },
    { id: 'chk',   icon: '✅', label: 'CHK'   },
    { id: 'clr',   icon: '📻', label: 'CLR'   },
    { id: 'cmpct', icon: '⊟', label: 'CMPCT' },
    { id: 'more',  icon: '⋯',  label: 'MORE'  },
];
```

- [ ] **Step 3.2 — Close layer panel when leaving it**

In `_selectTab()`, find the line:

```javascript
if (tabId !== 'more') this._closeMoreDrawer();
```

Add a parallel line immediately after it:

```javascript
if (tabId !== 'more') this._closeMoreDrawer();
if (tabId !== 'layers') this._comps.layerPanel?.close();
```

- [ ] **Step 3.3 — Add `layers` to radar-controls guard**

Find:

```javascript
if (tabId !== 'map' && tabId !== 'cmpct' && tabId !== 'more') {
```

Replace with:

```javascript
if (tabId !== 'map' && tabId !== 'cmpct' && tabId !== 'more' && tabId !== 'layers') {
```

- [ ] **Step 3.4 — Add `layers` handler in the tab dispatch block**

Find the dispatch block near the end of `_selectTab()`:

```javascript
if (tabId === 'map') {
    // Already closed everything above — just return to map
} else if (tabId === 'eng') {
    ...
} else if (tabId === 'more') {
    this._openMoreDrawer();
}
```

Add the `layers` case before `map`:

```javascript
if (tabId === 'layers') {
    this._openLayersPanel();
} else if (tabId === 'map') {
    // Already closed everything above — just return to map
} else if (tabId === 'eng') {
    ...
} else if (tabId === 'more') {
    this._openMoreDrawer();
}
```

- [ ] **Step 3.5 — Add `_openLayersPanel()` method**

Add after `_closeMoreDrawer()`:

```javascript
_openLayersPanel() {
    this._comps.layerPanel?.open();
}

_closeLayersPanel() {
    // Called when layer panel closes (backdrop tap or ✕) — restore MAP highlight
    const activeBtn = this._tabBar?.querySelector('.tab-btn.active[data-tab="layers"]');
    if (activeBtn) {
        this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        this._tabBar.querySelector('[data-tab="map"]')?.classList.add('active');
    }
}
```

- [ ] **Step 3.6 — Register `onClose` callback in `init()`**

In `init()`, after `this._buildMoreDrawer()`:

```javascript
// Layer panel close → restore MAP tab highlight
if (this._comps.layerPanel) {
    this._comps.layerPanel.onClose = () => this._closeLayersPanel();
}
```

- [ ] **Step 3.7 — Commit**

```bash
git add web/cockpit/tab-bar.js
git commit -m "feat: LAYERS tab replaces left-rail ≡ button, right-side drawer with MAP restore"
```

---

## Task 4: app.js — Remove ≡ Button, Wire LayerPanel into TabBar

**Files:**
- Modify: `web/app.js`

### Overview
The ≡ button in `_buildLeftRail()` is now redundant. Remove it and its separator. Add `layerPanel` to the comps object passed to `new TabBar(...)`.

- [ ] **Step 4.1 — Remove ≡ button from `_buildLeftRail()`**

In `_buildLeftRail()`, find and delete these lines (~line 967-972):

```javascript
// ≡ Layers
rail.appendChild(makeBtn('&#x2630;', 'Layer panel', () => {
    if (this.layerPanel) this.layerPanel.toggle();
}));

rail.appendChild(sep());
```

Delete both the button block and the `sep()` call that follows it.

- [ ] **Step 4.2 — Add `layerPanel` to TabBar comps**

Find the `new TabBar({...})` call (~line 897). Add `layerPanel: this.layerPanel` to the object:

```javascript
this.tabBar = new TabBar({
    enginePage: this.enginePage,
    checklist: this.checklist,
    logbook: this.logbook,
    approachCharts: this.approachCharts,
    fuelOverlay: this.fuelOverlay,
    dataStatus: this.dataStatus,
    fisbStatus: this.fisbStatus,
    configEditor: this.configEditor,
    ifrClearance: this.ifrClearance,
    wxBriefing: this.wxBriefing,
    trackLog: this.trackLog,
    airportPopup: this.airportPopup,
    stratuxIp: Settings.stratuxIp || '192.168.10.1',
    planSync: this.planSync,
    radarLoop: this.radarLoop,
    flightUpload: this.flightUpload,
    routeTable: this.routeTable,
    layerPanel: this.layerPanel,   // ADD THIS
});
```

- [ ] **Step 4.3 — Increment `FLYTAB_VERSION`**

Find `const FLYTAB_VERSION` at top of `web/app.js`. Increment (e.g. `v9.23` → `v9.24`).

- [ ] **Step 4.4 — Build**

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL`, APK copied to `data/`.

- [ ] **Step 4.5 — Commit**

```bash
git add web/app.js
git commit -m "feat: remove left-rail ≡ button, wire layerPanel into TabBar comps; v9.24"
```

---

## Smoke Test

Install `flytab-debug-v9.24.apk` on the Yoga Tab Plus and verify:

1. **LAYERS tab visible** — leftmost tab in bar shows ≡ / LAYERS
2. **Tap LAYERS** — right-side drawer slides in from the right; MAP tab loses highlight, LAYERS highlights
3. **Tap backdrop** — drawer closes; LAYERS loses highlight, MAP highlights
4. **Tap ✕ in header** — same as backdrop tap
5. **No left-rail ≡ button** — only zoom, SRC, and route table ≡ remain in left rail
6. **Layer toggles work** — NEXRAD on/off, base chart change, all toggles function as before
7. **MORE still works** — tap MORE, right drawer opens with 3 sections
8. **Gap is gone** — no vertical gap between layer panel bottom and route table; panel stops at the tab bar

---

## Self-Review Checklist

| Requirement | Task |
|------------|------|
| Remove left-side layer panel | Task 1 CSS |
| No gap to route table | Task 1 (`bottom: var(--tab-bar-height)`) |
| LAYERS tab leftmost | Task 3.1 |
| LAYERS tab opens panel | Task 3.4 / 3.5 |
| LAYERS stays highlighted while open | Task 3.4 (`_openLayersPanel` doesn't restore MAP) |
| Backdrop/✕ close restores MAP highlight | Tasks 2 + 3.6 (`onClose` callback) |
| Closing any other tab closes layer panel | Task 3.2 |
| ≡ button removed from left rail | Task 4.1 |
| `layerPanel` wired into TabBar comps | Task 4.2 |
| Radar controls guard updated | Task 3.3 |
