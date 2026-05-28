# Route Display Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-state route table with a free-drag sheet, fix map/table touch overlap via in-flow layout, pin the WPT column width, add landscape compact mode, and clean up the MORE drawer.

**Architecture:** The route table sheet moves from `position: fixed` (overlaying the Leaflet map) to an in-flow flex child of `#cockpitContainer`, so the map physically shrinks when the table is open. Drag is handled by native touch events on the handle; `--route-table-height` is kept live on every `touchmove` so sidebar CSS variables track the position in real time.

**Tech Stack:** Vanilla JS, CSS, no bundler. Tested via APK on Lenovo Yoga Tab Plus (Android). No new dependencies.

---

## File Map

| File | What changes |
|------|-------------|
| `web/style.css` | `.route-table-sheet` in-flow, handle layout, drag pill/close/hint CSS, `.layer-panel`/`.airport-panel` sidebar bottoms, `table-layout: fixed`, compact-mode CSS |
| `web/cockpit/route-table.js` | Drag mechanics, new `toggle()`, WPT colgroup, `setCompact()`, GPS position storage, constructor clean-up, DOM restructure |
| `web/cockpit/tab-bar.js` | Replace TMR tab → CMPCT, `_toggleCompactStrips()`, MORE drawer rewrite (13 items, 3 sections) |
| `web/app.js` | Delete orphaned `saveCurrentPlan()` |
| `web/cockpit/track-log.js` | Delete orphaned `exportGpx()` and `exportCsv()` |

---

## Task 1: CSS — Layout Foundation and Visual Changes

**Files:**
- Modify: `web/style.css`

### Overview
Change `.route-table-sheet` from `position: fixed` to in-flow. Add drag pill, close button, and hint CSS. Update sidebars. Remove obsolete transition.

- [ ] **Step 1.1 — Change `.route-table-sheet` from fixed to in-flow**

Find the `.route-table-sheet` rule (line ~2253) and replace the positioning block:

```css
/* BEFORE */
.route-table-sheet {
    position: fixed;
    bottom: var(--tab-bar-height);
    left: 0;
    right: 0;
    z-index: 500;
    background: var(--bg-surface);
    border-top: 2px solid var(--accent);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -2px 12px rgba(0,0,0,0.3);
}

/* AFTER */
.route-table-sheet {
    position: relative;
    width: 100%;
    flex-shrink: 0;
    background: var(--bg-surface);
    border-top: 2px solid var(--accent);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -2px 12px rgba(0,0,0,0.3);
}
```

- [ ] **Step 1.2 — Add `min-height: 0` to `.map-area`**

Find `.map-area` (line ~6527). Add `min-height: 0` to the rule (required so flex child can shrink below its content size):

```css
.map-area {
    flex: 1;
    position: relative;
    overflow: hidden;
    min-width: 0;
    min-height: 0;    /* add this */
}
```

- [ ] **Step 1.3 — Change `.route-table-handle` to flex column with drag pill support**

Replace the existing `.route-table-handle` rule (line ~2265):

```css
/* BEFORE */
.route-table-handle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    cursor: pointer;
    min-height: 48px;
    touch-action: manipulation;
}

/* AFTER */
.route-table-handle {
    display: flex;
    flex-direction: column;
    padding: 8px 16px 10px;
    cursor: grab;
    min-height: 48px;
    touch-action: none;     /* prevent Leaflet scroll conflict during drag */
    user-select: none;
    -webkit-user-select: none;
}
```

- [ ] **Step 1.4 — Add new CSS for drag pill, handle row, close button, and open hint**

Insert after the `.route-table-handle` rule:

```css
.rt-drag-pill {
    width: 40px;
    height: 4px;
    background: var(--border-strong, #bbb);
    border-radius: 2px;
    align-self: center;
    margin-bottom: 8px;
    flex-shrink: 0;
}

.rt-handle-row {
    display: flex;
    align-items: center;
    gap: 8px;
}

.rt-close-btn {
    min-width: 44px;
    min-height: 44px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
    padding: 0 8px;
    flex-shrink: 0;
}
.rt-close-btn:active {
    background: var(--border);
}

.rt-open-hint {
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 18px;
    flex-shrink: 0;
    pointer-events: none;
}
```

- [ ] **Step 1.5 — Remove `transition` from `.route-table-body` and remove old handle border rule**

Find `.route-table-body` (line ~2294). Remove the `transition: max-height 0.3s ease` line (height is now set directly via JS, not max-height):

```css
.route-table-body {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    /* no transition — height set directly */
}
```

Delete the now-unused rule `.route-table-expanded .route-table-handle` entirely (it was the border-bottom for the 3-state toggle).

Delete the now-unused rule `.rt-toggle-btn { ... }` entirely.

- [ ] **Step 1.6 — Update `.layer-panel` to stop above the route table**

Find `.layer-panel` (line ~6899). Change `bottom: 0` to:

```css
.layer-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: calc(var(--bottom-chrome) + var(--route-table-height));   /* was: bottom: 0 */
    width: 280px;
    z-index: 1010;
    background: var(--bg-surface);
    border-right: 1px solid var(--border-strong);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
```

(`--bottom-chrome` is already defined as `calc(var(--tab-bar-height) + 64px)` — tab bar + instrument strip.)

- [ ] **Step 1.7 — Update `.airport-panel` to stop at map edge (not hardcoded 164px)**

Find `.airport-panel` (line ~7359). Change `bottom: 164px` to `bottom: 0`:

```css
.airport-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;    /* was: 164px — in-flow layout means mapContainer bottom IS the route table top */
    width: 300px;
    z-index: 600;
    background: var(--bg-surface);
    border-left: 1px solid var(--border-strong);
    transform: translateX(100%);
    transition: transform 0.2s ease, bottom 0.2s ease;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
```

- [ ] **Step 1.8 — Add `table-layout: fixed` to `.route-table-content`**

Find `.route-table-content` (line ~2302). Add `table-layout: fixed`:

```css
.route-table-content {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;    /* add this — enables colgroup column widths */
    font-family: var(--font-instrument);
    font-size: 16px;
}
```

- [ ] **Step 1.9 — Add compact-mode CSS**

Add near the bottom of `style.css` (before existing `body.route-editing-mode` rules):

```css
body.compact-strips #instrumentStrip,
body.compact-strips .route-table-sheet {
    display: none !important;
}
```

- [ ] **Step 1.10 — Commit CSS changes**

```bash
git add web/style.css
git commit -m "style: route table in-flow layout, sidebar fixes, drag/compact CSS"
```

---

## Task 2: Route Table DOM — Handle Rebuild and Container Move

**Files:**
- Modify: `web/cockpit/route-table.js` (lines ~2065–2250)

### Overview
Replace the handle's inner HTML with the new pill + row layout. Remove the old tap-to-toggle listeners. Move the `.route-table-sheet` element from `#primaryView` into `#cockpitContainer`.

- [ ] **Step 2.1 — Replace handle innerHTML**

In `_buildDOM()`, find the handle `innerHTML` assignment (the block starting `this._handleEl.innerHTML = \``). Replace it with:

```javascript
this._handleEl.innerHTML = `
    <div class="rt-drag-pill"></div>
    <div class="rt-handle-row">
        <span class="handle-summary"></span>
        <button class="rt-profile-btn" title="Terrain profile" style="min-width:44px;min-height:44px;font-size:18px;background:none;border:none;color:inherit;cursor:pointer;padding:0 8px">&#x26F0;</button>
        <button class="route-table-edit-btn">EDIT</button>
        <button class="rt-close-btn" title="Close route table">&#x2715;</button>
        <span class="rt-open-hint" hidden>&#x2191;</span>
    </div>
`;
```

- [ ] **Step 2.2 — Remove old tap-to-toggle listeners from the handle**

Delete the following block (it follows the old `innerHTML` assignment):

```javascript
// DELETE all of this:
let touchStartY = 0;
this._handleEl.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
}, { passive: true });
this._handleEl.addEventListener('touchend', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (dy < 10) {
        e.preventDefault();
        this.toggle();
    }
});
this._handleEl.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    this.toggle();
});
```

- [ ] **Step 2.3 — Wire close button; remove toggle button wiring**

After the new `innerHTML`, update the button references:

```javascript
// Keep these (buttons still exist):
this._editBtn = this._handleEl.querySelector('.route-table-edit-btn');
wireTap(this._editBtn, () => {
    if (typeof app !== 'undefined') {
        app.openRoutePlanner(app._currentTrip);
    }
});

this._profileBtn = this._handleEl.querySelector('.rt-profile-btn');
wireTap(this._profileBtn, () => this._openProfileView());

// NEW: close button
this._closeBtn = this._handleEl.querySelector('.rt-close-btn');
wireTap(this._closeBtn, () => this._closeBody());

// NEW: open hint element
this._openHintEl = this._handleEl.querySelector('.rt-open-hint');

// DELETE: this._toggleBtn and its wireTap — the button no longer exists
// DELETE: this._toggleBtn = this._handleEl.querySelector('.rt-toggle-btn');
// DELETE: wireTap(this._toggleBtn, () => this.toggle());
```

- [ ] **Step 2.4 — Move element append from `#primaryView` to `#cockpitContainer`**

At the end of `_buildDOM()`, find:

```javascript
this._container.appendChild(this._el);
// Append altitude picker to container (needs to float above table)
this._container.appendChild(this._altPicker);
```

Replace with:

```javascript
const cockpitContainer = document.getElementById('cockpitContainer');
cockpitContainer.appendChild(this._el);
// Alt picker floats above the table — append to cockpitContainer too
cockpitContainer.appendChild(this._altPicker);
```

- [ ] **Step 2.5 — Update alt picker positioning reference**

In `_showAltPicker()` (line ~675), find:

```javascript
const containerRect = this._container.getBoundingClientRect();
```

Replace with:

```javascript
const containerRect = document.getElementById('cockpitContainer').getBoundingClientRect();
```

- [ ] **Step 2.6 — Call `_initDragHandlers()` at end of `_buildDOM()`**

Add this call at the very end of `_buildDOM()` (after `_buildEngineStatusCard()`):

```javascript
this._initDragHandlers();
```

- [ ] **Step 2.7 — Commit DOM restructure**

```bash
git add web/cockpit/route-table.js
git commit -m "feat(route-table): rebuild handle DOM, move sheet into cockpitContainer"
```

---

## Task 3: Route Table — State Changes and GPS Tracking

**Files:**
- Modify: `web/cockpit/route-table.js` (constructor, ~lines 62–90, 218, 514, 398)

### Overview
Remove the 3-state `_expandState`/`_expanded` variables. Add GPS position tracking for auto-pan. Fix the two places that check `_expandState` before opening.

- [ ] **Step 3.1 — Clean up constructor**

Find the constructor (line ~62). Remove:

```javascript
this._expanded = false;   // kept for back-compat checks
this._expandState = 0;    // 0=closed, 1=partial(~25%), 2=full(~50%)
```

Add these three lines in their place:

```javascript
this._lastGpsPosition = null;  // for auto-pan after drag
this._preCompactHeight = null; // for compact-mode height restore
```

- [ ] **Step 3.2 — Fix `_toggleEditMode()` height check**

Find line ~514:

```javascript
if (this._expandState === 0) this.toggle();
```

Replace with:

```javascript
if ((this._bodyEl?.offsetHeight || 0) === 0) this.toggle();
```

- [ ] **Step 3.3 — Fix `loadPlan()` height check (two locations)**

Find the two places in `loadPlan()` that check `_expandState`:

```javascript
// Location 1 (~line 218):
if (this._expandState === 0) this.toggle?.();

// Location 2 (~line 514, duplicate in auto-edit-mode block):
if (this._expandState === 0) this.toggle?.();
```

Replace both with:

```javascript
if ((this._bodyEl?.offsetHeight || 0) === 0) this.toggle?.();
```

- [ ] **Step 3.4 — Store GPS position in `updateLive()`**

Find `updateLive(situation)` (line ~398). After the null check at the top:

```javascript
updateLive(situation) {
    if (!situation || this._waypoints.length === 0) return;
    this._lastSituation = situation;
    // ADD these two lines:
    if (situation.lat && situation.lon) {
        this._lastGpsPosition = { lat: situation.lat, lng: situation.lon };
    }
    // ... rest of method unchanged
```

- [ ] **Step 3.5 — Commit state changes**

```bash
git add web/cockpit/route-table.js
git commit -m "refactor(route-table): remove _expandState, add GPS position tracking"
```

---

## Task 4: Route Table — Drag Mechanics

**Files:**
- Modify: `web/cockpit/route-table.js`

### Overview
Add `_initDragHandlers()` with full drag logic. Add `_closeBody()`, `_updateOpenHint()`, `_autoPanOwnship()` helpers. Reimplement `toggle()`.

- [ ] **Step 4.1 — Add `_closeBody()` helper**

Add this method after `_broadcastHeight()` (line ~1774):

```javascript
_closeBody() {
    if (!this._bodyEl) return;
    this._bodyEl.style.height = '0px';
    this._broadcastHeight();
    this._updateOpenHint(0);
    this._map?.invalidateSize();
}
```

- [ ] **Step 4.2 — Add `_updateOpenHint()` helper**

Add after `_closeBody()`:

```javascript
_updateOpenHint(heightPx) {
    if (!this._openHintEl) return;
    this._openHintEl.hidden = heightPx > 0;
}
```

- [ ] **Step 4.3 — Add `_autoPanOwnship()` helper**

Add after `_updateOpenHint()`:

```javascript
_autoPanOwnship() {
    if (!this._lastGpsPosition || !this._map) return;
    const mapHeight = this._map.getSize().y;
    const tableH   = this._el?.offsetHeight || 0;
    const pt = this._map.latLngToContainerPoint([
        this._lastGpsPosition.lat, this._lastGpsPosition.lng
    ]);
    // If ownship is in the lower third of the visible map, pan it up
    if (pt.y > mapHeight * 0.66) {
        this._map.panBy([0, -(tableH / 2)], { animate: true, duration: 0.3 });
    }
}
```

- [ ] **Step 4.4 — Add `_initDragHandlers()` method**

Add this full method after `_autoPanOwnship()`:

```javascript
_initDragHandlers() {
    let dragStartY  = 0;
    let dragStartH  = 0;
    let dragStartT  = 0;
    let lastClientY = 0;

    this._handleEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        dragStartY  = e.touches[0].clientY;
        dragStartH  = this._bodyEl?.offsetHeight || 0;
        dragStartT  = Date.now();
        lastClientY = dragStartY;
    }, { passive: true });

    this._handleEl.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        // touch-action:none on the element suppresses browser scroll
        const clientY = e.touches[0].clientY;
        lastClientY   = clientY;

        const dy      = dragStartY - clientY;  // positive = dragging up
        const isPortrait = window.innerWidth <= window.innerHeight;
        const maxH = isPortrait
            ? Math.min(window.innerHeight * 0.40, window.innerHeight - 200)
            : Math.min(window.innerHeight * 0.65, window.innerHeight - 200);
        const newH = Math.max(0, Math.min(maxH, dragStartH + dy));

        this._bodyEl.style.height = newH + 'px';
        this._broadcastHeight();        // keep --route-table-height live for sidebar CSS
        this._updateOpenHint(newH);
    }, { passive: false });

    this._handleEl.addEventListener('touchend', (e) => {
        const elapsed = Math.max(1, Date.now() - dragStartT);
        const totalDy = dragStartY - (e.changedTouches[0]?.clientY ?? lastClientY);
        const velocity = (totalDy / elapsed) * 1000;  // px/s; negative = downward swipe

        if (velocity < -300) {
            // Fast flick down — close regardless of position
            this._closeBody();
            return;
        }

        const h = this._bodyEl?.offsetHeight || 0;
        if (h === 0) {
            this._closeBody();
            return;
        }

        // Dragged to a valid open position
        localStorage.setItem('flypi_route_table_height', String(h));
        this._map?.invalidateSize();
        this._broadcastHeight();
        this._autoPanOwnship();
    }, { passive: true });
}
```

- [ ] **Step 4.5 — Reimplement `toggle()`**

Find the current `toggle()` method (line ~1757) and replace it entirely:

```javascript
/**
 * Open/close the route table body.
 * Called externally by app.js:992 (left rail ≡ button) and internally.
 */
toggle() {
    const h = this._bodyEl?.offsetHeight ?? 0;
    if (h > 0) {
        this._closeBody();
    } else {
        const saved = parseInt(localStorage.getItem('flypi_route_table_height'), 10) || 120;
        if (this._bodyEl) {
            this._bodyEl.style.height = saved + 'px';
            this._broadcastHeight();
            this._updateOpenHint(saved);
        }
        this._map?.invalidateSize();
        this._autoPanOwnship();
    }
}
```

- [ ] **Step 4.6 — Commit drag mechanics**

```bash
git add web/cockpit/route-table.js
git commit -m "feat(route-table): free-drag sheet with velocity close and auto-pan"
```

---

## Task 5: Route Table — WPT Column Fix

**Files:**
- Modify: `web/cockpit/route-table.js` (line ~2556 `_renderTable()`)

### Overview
`table-layout: fixed` is set in CSS (Task 1). Here we inject a `<colgroup>` so the browser uses explicit widths instead of content-driven auto-sizing.

- [ ] **Step 5.1 — Add colgroup HTML generation in `_renderTable()`**

In `_renderTable()` (line ~2556), find the `let html = '<thead><tr>';` line. Insert the colgroup generation immediately before it:

```javascript
// Map from column key → explicit width (overrides the auto-widths in cockpit-config.json)
const COL_WIDTHS = {
    wpt: '52px', alt: '7%', hdg: '7%', brg: '7%',
    dist: '8%',  ete: '8%', gs:  '7%', fuel: '8%',
};

let colgroupHtml = '<colgroup>';
if (this._editMode) colgroupHtml += '<col style="width:36px">';   // reorder handle
for (const col of columns) {
    const w = COL_WIDTHS[col.key];
    colgroupHtml += w ? `<col style="width:${w}">` : '<col>';
}
if (this._editMode) colgroupHtml += '<col style="width:36px">';   // delete button
colgroupHtml += '</colgroup>';

let html = '<thead><tr>';
```

Then at the end of the method, before `this._tableEl.innerHTML = html`:

Find the line: `this._tableEl.innerHTML = html;`

Replace with:

```javascript
this._tableEl.innerHTML = colgroupHtml + html;
```

Wait — because `html` is already being built incrementally and set at the end, it's simpler to prepend the colgroup in the final assignment. Find where `this._tableEl.innerHTML` is set at the end of `_renderTable()` and replace it:

```javascript
// BEFORE:
this._tableEl.innerHTML = html;

// AFTER:
this._tableEl.innerHTML = colgroupHtml + html;
```

- [ ] **Step 5.2 — Verify `colgroupHtml` is accessible at the assignment point**

The variable `colgroupHtml` is declared at the top of `_renderTable()`, so it is in scope for the final assignment. Double-check by reading a few lines around the `this._tableEl.innerHTML = html` assignment to ensure no inner scope issue.

- [ ] **Step 5.3 — Commit WPT column fix**

```bash
git add web/cockpit/route-table.js
git commit -m "fix(route-table): pin WPT column width via table-layout:fixed + colgroup"
```

---

## Task 6: Compact Mode

**Files:**
- Modify: `web/cockpit/route-table.js` (add `setCompact()`)
- Modify: `web/cockpit/tab-bar.js` (replace TMR with CMPCT, add `_toggleCompactStrips()`)

### Overview
CMPCT tab replaces TMR. Tapping it calls `_toggleCompactStrips()` in TabBar which calls `routeTable.setCompact(bool)`. The Timer is moved to the MORE drawer (in Task 7).

- [ ] **Step 6.1 — Add `setCompact()` to RouteTable**

Add this method after `toggle()` in `route-table.js`:

```javascript
/**
 * Called by TabBar CMPCT toggle.
 * compact=true: save current height and let CSS hide the sheet.
 * compact=false: restore saved height.
 */
setCompact(compact) {
    if (compact) {
        this._preCompactHeight = this._bodyEl?.offsetHeight || 0;
    } else {
        const restoreH = this._preCompactHeight ??
            (parseInt(localStorage.getItem('flypi_route_table_height'), 10) || 0);
        this._preCompactHeight = null;
        if (this._bodyEl) {
            this._bodyEl.style.height = restoreH + 'px';
            this._updateOpenHint(restoreH);
        }
    }
    // CSS handles display:none via body.compact-strips class.
    // After class toggle, offsetHeight changes — broadcast the new value.
    setTimeout(() => {
        this._map?.invalidateSize();
        this._broadcastHeight();
    }, 0);
}
```

- [ ] **Step 6.2 — Replace TMR tab with CMPCT in `tab-bar.js`**

In `_buildTabBar()`, find the `tabs` array. Change the TMR entry:

```javascript
// BEFORE:
{ id: 'tmr',  icon: '⏱', label: 'TMR'  },

// AFTER:
{ id: 'cmpct', icon: '⊟', label: 'CMPCT' },
```

- [ ] **Step 6.3 — Update `_selectTab()` to handle CMPCT**

In `_selectTab()`, find the block:

```javascript
if (tabId !== 'map' && tabId !== 'tmr' && tabId !== 'more') {
    this._hideRadarControls();
} else if (tabId === 'map') {
    this._restoreRadarControls();
}

if (tabId === 'tmr') {
    // Timer is a floating popup — toggle without closing other views
    this._toggleTimer();
    // Restore previous tab highlight
    this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const prev = this._tabBar.querySelector('.tab-btn[data-tab="map"]');
    if (prev) prev.classList.add('active');
    return;
}
```

Replace `'tmr'` references:

```javascript
if (tabId !== 'map' && tabId !== 'cmpct' && tabId !== 'more') {
    this._hideRadarControls();
} else if (tabId === 'map') {
    this._restoreRadarControls();
}

if (tabId === 'cmpct') {
    this._toggleCompactStrips();
    // Restore previous tab highlight — CMPCT is a toggle action, not a destination
    this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const prev = this._tabBar.querySelector('.tab-btn[data-tab="map"]');
    if (prev) prev.classList.add('active');
    return;
}
```

- [ ] **Step 6.4 — Add `_toggleCompactStrips()` to TabBar**

Add this method to `TabBar` (e.g. after `_toggleTimer()`):

```javascript
_toggleCompactStrips() {
    const isNowCompact = !document.body.classList.contains('compact-strips');
    document.body.classList.toggle('compact-strips', isNowCompact);

    // Update CMPCT button label/icon
    const btn = this._tabBar?.querySelector('.tab-btn[data-tab="cmpct"]');
    if (btn) {
        btn.querySelector('.tab-btn-icon').textContent = isNowCompact ? '⊞' : '⊟';
        btn.lastChild.textContent = isNowCompact ? 'MAP' : 'CMPCT';
    }

    // Tell route table to save/restore height
    this._comps.routeTable?.setCompact(isNowCompact);

    // Persist
    localStorage.setItem('flypi_compact_strips', isNowCompact ? '1' : '0');
}
```

- [ ] **Step 6.5 — Restore compact state on init**

In the TabBar constructor (or `init()`, wherever init happens), add after `_buildTabBar()` is called:

```javascript
// Restore compact mode from last session
if (localStorage.getItem('flypi_compact_strips') === '1') {
    document.body.classList.add('compact-strips');
    const btn = this._tabBar?.querySelector('.tab-btn[data-tab="cmpct"]');
    if (btn) {
        btn.querySelector('.tab-btn-icon').textContent = '⊞';
        btn.lastChild.textContent = 'MAP';
    }
}
```

Find the `TabBar` constructor: it calls `this._buildTabBar()` and `this._buildMoreDrawer()`. Add the restoration block after these two calls.

- [ ] **Step 6.6 — Commit compact mode**

```bash
git add web/cockpit/route-table.js web/cockpit/tab-bar.js
git commit -m "feat: CMPCT tab replaces TMR, compact-strips toggle with height restore"
```

---

## Task 7: MORE Drawer Cleanup

**Files:**
- Modify: `web/cockpit/tab-bar.js` (rewrite `_buildMoreDrawer()`)
- Modify: `web/app.js` (delete `saveCurrentPlan()`)
- Modify: `web/cockpit/track-log.js` (delete `exportGpx()` and `exportCsv()`)

### Overview
Replace the 19-item flat drawer with 13 items in 3 labelled sections. Delete 5 orphaned methods. Move Timer to the drawer.

- [ ] **Step 7.1 — Rewrite `_buildMoreDrawer()` rows in `tab-bar.js`**

In `_buildMoreDrawer()`, find the `const rows = [...]` array and replace it entirely. Also update the rendering loop to support `type: 'section'` entries. Here is the full replacement:

```javascript
const rows = [
    { type: 'section', label: 'In-flight' },
    { icon: '⏱', label: 'Timer', action: () => {
        this._closeMoreDrawer();
        this._toggleTimer();
    }},
    { icon: '⛽', label: 'Fuel Entry', action: () => {
        if (c.fuelOverlay?.show) c.fuelOverlay.show();
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '📊', label: 'Approach Charts', action: () => {
        if (c.approachCharts) {
            c.approachCharts._currentPlate
                ? c.approachCharts._showPlate(c.approachCharts._plateIdx)
                : c.approachCharts.showForRoute();
        }
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '🧠', label: 'Engine ML', action: () => {
        this._closeMoreDrawer();
        this._hideRadarControls();
        this._showMLMonitor();
    }},
    { icon: '📡', label: 'Stratux Status', action: () => {
        const ip = c.stratuxIp || '192.168.10.1';
        window.open(`http://${ip}`, '_blank');
        this._closeMoreDrawer();
    }},

    { type: 'section', label: 'Pre / Post flight' },
    { icon: '✈️', label: 'Plan on flywhere.app', action: () => {
        window.open('https://flywhere.app/plan', '_blank');
        this._closeMoreDrawer();
    }},
    { icon: '⛅', label: 'Weather Briefing', action: () => {
        if (c.wxBriefing?.show) c.wxBriefing.show();
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '📋', label: 'Logbook', action: () => {
        if (c.logbook?.show) c.logbook.show();
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '📤', label: 'Flight Upload', action: () => {
        if (c.flightUpload?.show) c.flightUpload.show();
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '📖', label: 'User Manual', action: () => {
        this._closeMoreDrawer();
        this._showManual();
    }},

    { type: 'section', label: 'Admin' },
    { icon: '🗄', label: 'Data Status', admin: true, action: () => {
        if (c.dataStatus?.show) c.dataStatus.show();
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '⚙', label: 'Configuration', admin: true, action: () => {
        if (c.configEditor?.show) c.configEditor.show();
        this._hideRadarControls();
        this._closeMoreDrawer();
    }},
    { icon: '🔄', label: 'Reset NASR Data', admin: true, action: () => {
        this._closeMoreDrawer();
        window.app?.showToast('Delete and reimport all NASR data? This will reload the page.', [
            { label: 'Reset', action: () => {
                const req = indexedDB.deleteDatabase('flypi');
                req.onsuccess = () => location.reload();
                req.onerror  = () => location.reload();
                req.onblocked = () => location.reload();
            }},
        ]);
    }},
];
```

- [ ] **Step 7.2 — Update the row rendering loop to support sections and admin items**

Find the rendering loop that creates `.md-row` elements for each row. Replace it:

```javascript
const body = this._moreDrawer.querySelector('.more-drawer-body');
for (const row of rows) {
    if (row.type === 'section') {
        const sec = document.createElement('div');
        sec.className = 'md-section-label';
        sec.textContent = row.label;
        body.appendChild(sec);
        continue;
    }
    const el = document.createElement('div');
    el.className = 'md-row' + (row.admin ? ' md-row-admin' : '');
    const labelText = typeof row.label === 'function' ? row.label() : row.label;
    el.innerHTML = `<span class="md-icon">${row.icon}</span><span class="md-label">${labelText}</span><span class="md-chevron">›</span>`;
    wireTap(el, row.action);
    body.appendChild(el);
}
```

- [ ] **Step 7.3 — Add CSS for section labels and admin rows**

Add to `web/style.css` (near the existing `.md-row` rules at line ~7324):

```css
.md-section-label {
    padding: 10px 12px 4px;
    color: #888;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-top: 1px solid var(--border);
}
.md-section-label:first-child {
    border-top: none;
    padding-top: 6px;
}
.md-row-admin {
    opacity: 0.7;
}
```

- [ ] **Step 7.4 — Delete `_showNewRouteConfirm()` from `tab-bar.js`**

Find `_showNewRouteConfirm()` (~line 266–294 in `tab-bar.js`). Delete the entire method.

- [ ] **Step 7.5 — Delete `_showHelp()` from `tab-bar.js`**

Find `_showHelp()` (~line 712–780 in `tab-bar.js`). Delete the entire method.

- [ ] **Step 7.6 — Delete `saveCurrentPlan()` from `app.js`**

Find `saveCurrentPlan()` (~line 1136–1160 in `app.js`). Delete the entire method.

- [ ] **Step 7.7 — Delete `exportGpx()` and `exportCsv()` from `track-log.js`**

Find `exportGpx()` (~line 115–140 in `track-log.js`) and `exportCsv()` (~line 90–114 in `track-log.js`). Delete both methods.

- [ ] **Step 7.8 — Search for any remaining references to deleted methods**

```bash
grep -rn "saveCurrentPlan\|exportGpx\|exportCsv\|_showNewRouteConfirm\|_showHelp" \
    web/app.js web/cockpit/tab-bar.js web/cockpit/track-log.js
```

Expected output: empty. If anything is found, delete those call sites too.

- [ ] **Step 7.9 — Commit MORE drawer cleanup**

```bash
git add web/cockpit/tab-bar.js web/app.js web/cockpit/track-log.js web/style.css
git commit -m "feat: MORE drawer 13-item layout with sections; delete 5 orphaned methods"
```

---

## Task 8: Build, Version Bump, and Smoke Test

**Files:**
- Modify: `web/app.js` (FLYTAB_VERSION increment)

- [ ] **Step 8.1 — Increment `FLYTAB_VERSION` in `web/app.js`**

Find the `FLYTAB_VERSION` constant at the top of `web/app.js`. Increment it (e.g. `v7.5` → `v7.6`). This must be done before running `build.sh`.

- [ ] **Step 8.2 — Build the APK**

```bash
bash build.sh
```

Expected: build completes with no errors; APK copied to `data/`.

- [ ] **Step 8.3 — Install and smoke test**

Install on the Yoga Tab Plus. Verify these interactions in order:

1. **Route table drag** — open a route, drag the handle up; table expands, map shrinks. Drag down to 0; table closes. ↑ hint appears in handle when closed.
2. **Fast flick** — quick swipe down on handle; table closes instantly.
3. **✕ button** — tap ✕; table body closes. Tap area must be ≥44px (try with gloved-hand / fat-finger).
4. **Left-rail ≡ button** — the menu button on the left rail should still open/close the route table (calls `toggle()` externally).
5. **Airport tap** — tap an airport on the map while the route table is at mid-height. Verify the airport popup opens (primary tap handler regression check).
6. **Airport side panel** — with airport panel open, drag route table up. Side panel should NOT cover the route table.
7. **Layer panel** — open layers panel; it should stop above the route table, not cover it.
8. **WPT column** — add a multi-hop route with a fuel stop. WPT column should be narrow (~52px); fuel stop message should wrap.
9. **CMPCT** — tap CMPCT; both instrument strip and route table hide. Map fills screen. Tab label changes to MAP. Tap MAP; strips and table reappear at previous heights.
10. **MORE drawer** — open MORE drawer; verify 3 sections (In-flight / Pre / Post flight / Admin). Verify Timer, Fuel Entry, Approach Charts, Engine ML, Stratux Status, Plan on flywhere.app, Weather Briefing, Logbook, Flight Upload, User Manual, Data Status, Configuration, Reset NASR Data (13 items). Verify New Route / Save Plan / Load Plan / FIS-B Status / Export GPX / Export CSV / Help are gone.

- [ ] **Step 8.4 — Commit version bump**

```bash
git add web/app.js
git commit -m "chore: bump version for route-display-redesign"
```

---

## Self-Review Checklist

| Spec requirement | Task covering it |
|-----------------|-----------------|
| Free-drag with X close | Tasks 2, 4 |
| Drag pill visual | Tasks 1, 2 |
| ⛰ stays in handle | Task 2 |
| ✕ button 44px touch target | Task 1 CSS |
| ↑ hint when closed (44px, #999) | Tasks 1, 2, 4 |
| Velocity close >300px/s | Task 4 |
| Orientation-aware max height | Task 4 |
| `_broadcastHeight()` on touchmove | Task 4 |
| `toggle()` reimplemented (app.js:992 compat) | Task 4 |
| Remove `_expandState`/`_expanded` | Task 3 |
| Remove `rt-toggle-btn` | Task 2 |
| In-flow layout (no position:fixed) | Tasks 1, 2 |
| `#mapContainer` min-height:0 | Task 1 |
| `.layer-panel` bottom = --bottom-chrome + --route-table-height | Task 1 |
| `.airport-panel` bottom = 0 | Task 1 |
| Alt picker positioning uses cockpitContainer | Task 2 |
| Auto-pan ownship after resize | Task 4 |
| WPT column 52px fixed via colgroup | Tasks 1, 5 |
| Compact mode CSS | Task 1 |
| `setCompact()` with height restore | Tasks 6 |
| CMPCT tab replaces TMR | Task 6 |
| Label toggles CMPCT ↔ MAP | Task 6 |
| Timer moves to MORE drawer | Task 7 |
| MORE drawer 13 items, 3 sections | Task 7 |
| 7 drawer items removed | Task 7 |
| 5 orphaned methods deleted | Task 7 |
| `_toggleEditMode` / `loadPlan` height check updated | Task 3 |
