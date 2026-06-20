# Flight Plan Save & Retrieve — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save full trips (1 or 2 legs) with computed performance data to IndexedDB, retrieve them from both the More drawer and route planner toolbar, and surface per-leg FAA field-15 route strings in the CLR clearance page.

**Architecture:** `TripStore` is a new IDB singleton sharing the existing `flypi-flights` database (version bumped from 4 → 5). `PlanSync` gains a CLOUD/DEVICE tab bar. `IfrClearance` gains a leg-selection toggle driven by GPS proximity. Auto-save fires on every Apply; a manual Save button fires on demand.

**Tech Stack:** Vanilla JS, IndexedDB (shared `flypi-flights` DB), existing `wireTap()` pattern for touch, `app.showToast()` for feedback.

---

## File Map

| File | Change |
|------|--------|
| `web/shared/trip-store.js` | **New** — IDB singleton; opens `flypi-flights` at v5 |
| `web/cockpit/logbook.js` | Bump `IDB_VERSION` 4→5; add `trips` store in upgrade handler |
| `web/index.html` | Add `<script src="./shared/trip-store.js">` before `logbook.js` |
| `web/cockpit/route-planner-panel.js` | `_saveCurrentTrip()`; Save + Plans toolbar buttons; auto-save in `_doApply()` |
| `web/cockpit/plan-sync.js` | CLOUD/DEVICE tab bar; Device tab with single/two-leg bottom sheet |
| `web/cockpit/tab-bar.js` | "Save Plan" item above "Load Plan" in More drawer |
| `web/app.js` | `saveCurrentPlan()` method; pass trip to `ifrClearance._flightPlan` after Device load |
| `web/cockpit/ifr-clearance.js` | `_activeLegIdx` state; `_getActiveLeg()`; leg toggle; GPS auto-select; update `_prefillDep()` + `_fillAsFiledRoute()` |
| `web/style.css` | Styles for Device tab, two-leg badge, leg toggle, Save/Plans toolbar buttons |

---

## Task 1: TripStore singleton + IDB version bump

**Files:**
- Create: `web/shared/trip-store.js`
- Modify: `web/cockpit/logbook.js` (lines 11, 1577–1594)
- Modify: `web/index.html` (after line 121)

### Context

`flypi-flights` IDB is currently at version 4, owned by `Logbook`. Both `Logbook` and `TripStore` open the same DB; whichever opens first runs the upgrade. Both must request version 5 and both must guard with `!db.objectStoreNames.contains('trips')`. `TripStore` self-initializes on first call with an internal `_ready` promise — the same queuing pattern used by `NasrDB`.

- [ ] **Step 1: Create `web/shared/trip-store.js`**

```javascript
'use strict';

const TripStore = (() => {
    const DB_NAME = 'flypi-flights';
    const DB_VERSION = 5;
    const STORE = 'trips';

    let _db = null;
    let _ready = null;

    function _open() {
        if (_ready) return _ready;
        _ready = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('created_at', 'created_at', { unique: false });
                }
            };
            req.onsuccess = () => { _db = req.result; resolve(_db); };
            req.onerror = () => reject(req.error);
        });
        return _ready;
    }

    async function save(trip) {
        const db = await _open();
        trip.updated_at = new Date().toISOString();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(trip);
            tx.oncomplete = () => resolve(trip);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function list() {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const index = tx.objectStore(STORE).index('created_at');
            const req = index.getAll();
            req.onsuccess = () => resolve((req.result || []).reverse());
            req.onerror = () => reject(req.error);
        });
    }

    async function get(id) {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(id);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    async function del(id) {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(id);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function rename(id, name) {
        const db = await _open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.get(id);
            req.onsuccess = () => {
                const trip = req.result;
                if (!trip) { reject(new Error('Trip not found')); return; }
                trip.name = name;
                trip.updated_at = new Date().toISOString();
                store.put(trip);
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    return { save, list, get, delete: del, rename };
})();
```

- [ ] **Step 2: Bump Logbook IDB_VERSION to 5 and add trips store guard**

In `web/cockpit/logbook.js`, change line 11:
```javascript
static IDB_VERSION = 5;
```

In the same file, inside the `req.onupgradeneeded` handler (around line 1580), add the `trips` guard **after** the existing store creation blocks:
```javascript
if (!db.objectStoreNames.contains('trips')) {
    const store = db.createObjectStore('trips', { keyPath: 'id' });
    store.createIndex('created_at', 'created_at', { unique: false });
}
```

The full updated `onupgradeneeded` block becomes:
```javascript
req.onupgradeneeded = (event) => {
    const db = event.target.result;
    const oldVersion = event.oldVersion;
    if (!db.objectStoreNames.contains(Logbook.IDB_STORE)) {
        const store = db.createObjectStore(Logbook.IDB_STORE, { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('created_at', 'created_at', { unique: false });
        store.createIndex('synced', 'synced', { unique: false });
    }
    if (oldVersion < 4 && !db.objectStoreNames.contains(Logbook.IDB_ML_STORE)) {
        db.createObjectStore(Logbook.IDB_ML_STORE, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('trips')) {
        const store = db.createObjectStore('trips', { keyPath: 'id' });
        store.createIndex('created_at', 'created_at', { unique: false });
    }
    for (const name of db.objectStoreNames) {
        if (name === 'flight_recordings' || name === 'flight_csvs') {
            db.deleteObjectStore(name);
        }
    }
};
```

- [ ] **Step 3: Add `<script>` tag in `index.html`**

In `web/index.html`, add the script tag **before** `logbook.js` (which is around line 121). The shared scripts section ends at `sync-shim.js`, `tap-utils.js`, etc. Add after `nasr-db.js`:

Find the line:
```html
    <script src="./cockpit/logbook.js"></script>
```
Add immediately before it:
```html
    <script src="./shared/trip-store.js"></script>
```

- [ ] **Step 4: Commit**

```bash
git add web/shared/trip-store.js web/cockpit/logbook.js web/index.html
git commit -m "feat: add TripStore IDB singleton for trip persistence"
```

---

## Task 2: `_saveCurrentTrip()` in route-planner-panel.js

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`

### Context

`_lastPlan.waypoints` holds the resolved waypoints array (from `_processFuelStopCandidates` or `open()`). Waypoints with `fuelStop: true` mark split points. `this._route` holds the pills array `[{id, type, ...}]` — `type: 'fuel'` pills mark the same split in the route string. `_buildField15String(pills)` calls `_collapseSameAirway` internally and produces the FAA route string. `this._planner.recomputeLegs({ waypoints }, null, opts)` computes CLB/CRZ/DES legs.

The method is called two ways:
1. **Auto-save** — fired (without await) from `_doApply()` after `this._currentPlan` is set
2. **Manual save** — fired by the Save toolbar button

- [ ] **Step 1: Add `_saveCurrentTrip()` method**

Add this method to `RoutePlannerPanel` after `_buildField15String()` (around line 2368):

```javascript
async _saveCurrentTrip() {
    if (!this._lastPlan?.waypoints?.length || !this._planner) return;

    const wps = this._lastPlan.waypoints;
    const recomputeOpts = {
        pctPower:    this._pctPower,
        cruiseAltFt: this._cruiseAltFt ?? undefined,
        winds:       this._lastWinds ?? undefined,
    };

    // Collect ALL fuel stop indices in both waypoints and pills arrays
    const fsWpIdxs   = wps.reduce((acc, wp, i) => { if (wp.fuelStop) acc.push(i); return acc; }, []);
    const fsPillIdxs = this._route.reduce((acc, p, i) => { if (p.type === 'fuel') acc.push(i); return acc; }, []);

    // Segment boundaries: [0, stop1, stop2, ..., last] — supports N legs
    const wpBounds   = [0, ...fsWpIdxs,   wps.length - 1];
    const pillBounds = [0, ...fsPillIdxs, this._route.length - 1];

    const tripLegs = [];
    for (let i = 0; i < wpBounds.length - 1; i++) {
        const legWps   = wps.slice(wpBounds[i], wpBounds[i + 1] + 1);
        const legPills = this._route.slice(pillBounds[i], pillBounds[i + 1] + 1);
        const legPlan  = this._planner.recomputeLegs({ waypoints: legWps }, null, recomputeOpts);
        const dep  = legWps[0].icao  || legWps[0].id;
        const dest = legWps[legWps.length - 1].icao || legWps[legWps.length - 1].id;
        tripLegs.push({
            dep,
            dest,
            flight_plan: {
                departure:   dep,
                destination: dest,
                route:       this._buildField15String(legPills),
                altitude:    this._altitude,
                legs:        legPlan.legs || [],
            },
            waypoints: legWps,
        });
    }

    const dep  = wps[0].icao  || wps[0].id;
    const dest = wps[wps.length - 1].icao || wps[wps.length - 1].id;
    const now  = new Date();
    const monthDay = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const autoName = `${dep} → ${dest} · ${monthDay}`;

    // Upsert: reuse id if a trip with same dep+dest was already saved today
    const todayStr = now.toISOString().slice(0, 10);
    let tripId = null;
    try {
        const existing = await TripStore.list();
        const match = existing.find(t =>
            t.dep === dep && t.dest === dest &&
            t.created_at && t.created_at.startsWith(todayStr)
        );
        if (match) tripId = match.id;
    } catch { /**/ }

    const trip = {
        id:         tripId || crypto.randomUUID(),
        name:       autoName,
        dep,
        dest,
        created_at: tripId ? undefined : now.toISOString(),  // preserve original on upsert
        updated_at: now.toISOString(),
        legs:       tripLegs,
    };

    // Preserve created_at on update
    if (tripId) {
        try {
            const old = await TripStore.get(tripId);
            if (old?.created_at) trip.created_at = old.created_at;
        } catch { /**/ }
    }
    if (!trip.created_at) trip.created_at = now.toISOString();

    await TripStore.save(trip);
}
```

- [ ] **Step 2: Add auto-save to `_doApply()`**

In `_doApply()`, after the block that sets `this._currentPlan` (around line 2348), add the auto-save call:

Current code (end of `_doApply`):
```javascript
        if (appliedPlan) {
            this._currentPlan = appliedPlan;
            this._updateStats(appliedPlan);
        }

        return true;
    }
```

Replace with:
```javascript
        if (appliedPlan) {
            this._currentPlan = appliedPlan;
            this._updateStats(appliedPlan);
        }

        this._saveCurrentTrip().catch(err => console.warn('[RPP] auto-save failed:', err));

        return true;
    }
```

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat: add _saveCurrentTrip() with auto-save on Apply"
```

---

## Task 3: Toolbar Save + Plans buttons

**Files:**
- Modify: `web/cockpit/route-planner-panel.js`

### Context

Current toolbar (line 1083): Paste, Copy, Plan, Clear, Compact, Apply. The "Apply" button calls `_onApplyKeepOpenTap`. The Save button should be enabled only when `_lastPlan` is set; it must be updated whenever `_lastPlan` changes. The Plans button opens `planSync` on the Device tab — `planSync.showDeviceTab()` will be added in Task 4.

- [ ] **Step 1: Add `_saveBtn` and `_plansBtn` fields to constructor**

In the constructor, after `this._legBtnsEl = null;` (around line 55), add:
```javascript
this._saveBtn  = null;   // enabled when _lastPlan is set
this._plansBtn = null;
```

- [ ] **Step 2: Update `_buildToolbar()` to add Save and Plans buttons**

Replace the current `_buildToolbar` method (lines 1083–1113) with:
```javascript
_buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'rpp-toolbar';

    const mkBtn = (label, handler, extraClass = '') => {
        const btn = document.createElement('button');
        btn.className = 'rpp-tbtn' + (extraClass ? ' ' + extraClass : '');
        btn.textContent = label;
        wireTap(btn, handler);
        return btn;
    };

    bar.appendChild(mkBtn('Paste', () => this._onPasteTap()));
    bar.appendChild(mkBtn('Copy',  () => this._onCopyTap()));

    this._planBtn = mkBtn('Plan', () => this._onRecomputeTap());
    bar.appendChild(this._planBtn);

    bar.appendChild(mkBtn('Clear', () => this._onClearTap()));

    this._compactBtn = mkBtn('Compact',
        () => this._onCompactToggle(),
        this._compactView ? 'rpp-tbtn-active' : '');
    bar.appendChild(this._compactBtn);

    // Plans — opens PlanSync Device tab
    this._plansBtn = mkBtn('Plans', () => this._onPlansTap());
    bar.appendChild(this._plansBtn);

    // Save — disabled until _lastPlan is set
    this._saveBtn = mkBtn('Save', () => this._onSaveTap(), 'rpp-tbtn-save');
    this._saveBtn.disabled = true;
    bar.appendChild(this._saveBtn);

    bar.appendChild(mkBtn('Apply', () => this._onApplyKeepOpenTap(), 'rpp-tbtn-apply'));

    return bar;
}
```

- [ ] **Step 3: Add `_onSaveTap()` and `_onPlansTap()` methods**

Add these methods after `_buildToolbar()`:
```javascript
async _onSaveTap() {
    if (!this._lastPlan) return;
    try {
        await this._saveCurrentTrip();
        this._toast('Plan saved.');
    } catch (err) {
        this._toast('Save failed: ' + (err?.message || err), 4000);
    }
}

_onPlansTap() {
    if (typeof planSync !== 'undefined' && planSync?.showDeviceTab) {
        planSync.showDeviceTab();
    } else if (typeof planSync !== 'undefined' && planSync?.show) {
        planSync.show();
    } else {
        window.app?.planSync?.showDeviceTab?.() || window.app?.planSync?.show?.();
    }
}
```

- [ ] **Step 4: Enable/disable Save button when `_lastPlan` changes**

Add a helper method:
```javascript
_syncSaveBtnState() {
    if (this._saveBtn) this._saveBtn.disabled = !this._lastPlan;
}
```

Call it everywhere `_lastPlan` is set. Search for `this._lastPlan =` in the file:

1. In `open()` after `this._lastPlan = null;` (line ~108) — add `this._syncSaveBtnState();`
2. In `open()` after the synthesized `this._lastPlan = { ... };` block — add `this._syncSaveBtnState();`
3. In `_applyWindsToLastPlan()` wherever `this._lastPlan` is set (line ~1889 and ~1935) — add `this._syncSaveBtnState();`

The three locations with existing assignments:
```
// In open(), first null:
this._lastPlan    = null;
this._syncSaveBtnState();

// In open(), synthesized plan:
this._lastPlan = { departure: ..., destination: ..., waypoints: ... };
this._syncSaveBtnState();

// In _applyWindsToLastPlan() (line ~1889):
this._lastPlan = result;
this._syncSaveBtnState();

// In _processFuelStopCandidates() (line ~1935):
this._lastPlan = { ...result, waypoints: currentWaypoints, fuelStops };
this._syncSaveBtnState();
```

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-planner-panel.js
git commit -m "feat: add Save and Plans toolbar buttons to route planner"
```

---

## Task 4: PlanSync CLOUD/DEVICE tab bar and Device tab

**Files:**
- Modify: `web/cockpit/plan-sync.js`

### Context

`PlanSync._buildDOM()` currently produces one overlay with a header and body. The tab bar goes between header and body. The Device tab calls `TripStore.list()` and renders rows. Tapping a row shows a bottom-sheet overlay for load options. `planSync` is accessible as `window.planSync` or `window.app.planSync` from outside.

- [ ] **Step 1: Update `_buildDOM()` to add tab bar and `_activeTab` state**

Replace the current `_buildDOM()` method (starting at line 31):
```javascript
_buildDOM() {
    this._activeTab = 'cloud';  // 'cloud' | 'device'

    this._el = document.createElement('div');
    this._el.className = 'ps-overlay';
    this._el.style.display = 'none';
    this._el.innerHTML = `
        <div class="ps-container">
            <div class="ps-header">
                <span class="ps-title">FLIGHT PLANS</span>
                <button class="ep-close ps-close">✕</button>
            </div>
            <div class="ps-tabs">
                <button class="ps-tab ps-tab-active" data-tab="cloud">CLOUD</button>
                <button class="ps-tab" data-tab="device">DEVICE</button>
            </div>
            <div class="ps-body" id="ps-body">
                <div class="ps-spinner">Loading…</div>
            </div>
        </div>
    `;

    const closeBtn = this._el.querySelector('.ps-close');
    closeBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); this.hide(); }, { passive: true });
    closeBtn.addEventListener('click', () => this.hide());

    this._el.querySelectorAll('.ps-tab').forEach(tab => {
        tab.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    document.body.appendChild(this._el);
}
```

- [ ] **Step 2: Add `_switchTab()`, `showDeviceTab()`, and update `show()`**

After `_buildDOM()`, add:
```javascript
_switchTab(tab) {
    this._activeTab = tab;
    this._el.querySelectorAll('.ps-tab').forEach(t => {
        t.classList.toggle('ps-tab-active', t.dataset.tab === tab);
    });
    const body = document.getElementById('ps-body');
    if (tab === 'cloud') {
        this._fetchAndRender();
    } else {
        this._renderDeviceTab(body);
    }
}

show() {
    this._el.style.display = 'flex';
    this._visible = true;
    this._switchTab(this._activeTab || 'cloud');
}

showDeviceTab() {
    this._el.style.display = 'flex';
    this._visible = true;
    this._switchTab('device');
}
```

Note: The current `show()` method (lines 56–60) must be replaced with the new version above.

- [ ] **Step 3: Add `_renderDeviceTab()` method**

Add after `_renderOffline()`:
```javascript
async _renderDeviceTab(body) {
    body.innerHTML = '<div class="ps-spinner">Loading…</div>';
    let trips = [];
    try {
        if (typeof TripStore !== 'undefined') trips = await TripStore.list();
    } catch (err) {
        body.innerHTML = `<div class="ps-error">Could not read saved plans: ${err.message}</div>`;
        return;
    }

    if (!trips.length) {
        body.innerHTML = '<div class="ps-empty">No saved plans yet.<br>Use the Save button in the route planner, or "Save Plan" from the menu.</div>';
        return;
    }

    let html = '<div class="ps-list">';
    for (const t of trips) {
        const dateStr = t.created_at ? new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const badge   = t.legs?.length > 1 ? `<span class="ps-legs-badge">${t.legs.length} legs</span>` : '';
        const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += `
            <div class="ps-row" data-trip-id="${esc(t.id)}">
                <div class="ps-row-main">
                    <span class="ps-row-route">${esc(t.name)}</span>
                    ${badge}
                </div>
                <div class="ps-row-sub">
                    <span class="ps-row-date">${dateStr}</span>
                    <button class="ps-row-delete" data-trip-id="${esc(t.id)}" title="Delete">✕</button>
                </div>
            </div>`;
    }
    html += '</div>';
    body.innerHTML = html;

    body.querySelectorAll('.ps-row').forEach(row => {
        row.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        row.addEventListener('click', (e) => {
            if (e.target.closest('.ps-row-delete')) return;
            const id = row.dataset.tripId;
            const trip = trips.find(t => t.id === id);
            if (trip) this._showTripBottomSheet(trip);
        });
    });

    body.querySelectorAll('.ps-row-delete').forEach(btn => {
        btn.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.tripId;
            if (!confirm('Delete this saved plan?')) return;
            await TripStore.delete(id).catch(() => {});
            this._renderDeviceTab(body);
        });
    });
}
```

- [ ] **Step 4: Add `_showTripBottomSheet()` method**

Add after `_renderDeviceTab()`:
```javascript
_showTripBottomSheet(trip) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:20000;display:flex;align-items:flex-end;justify-content:center';

    const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Build one button per leg (N legs), plus replan for single-leg only
    let buttonsHtml = '';
    const legs = trip.legs || [];
    if (legs.length <= 1) {
        buttonsHtml = `
            <button class="ps-sheet-btn" data-action="load" data-leg-idx="0">Load as-is</button>
            <button class="ps-sheet-btn" data-action="replan" data-leg-idx="0">Replan with current winds</button>`;
    } else {
        buttonsHtml = legs.map((leg, i) =>
            `<button class="ps-sheet-btn" data-action="load" data-leg-idx="${i}">Load Leg ${i + 1}: ${esc(leg.dep)} → ${esc(leg.dest)}</button>`
        ).join('');
    }

    overlay.innerHTML = `
        <div class="ps-sheet">
            <div class="ps-sheet-title">${esc(trip.name)}</div>
            ${buttonsHtml}
            <button class="ps-sheet-btn ps-sheet-cancel" data-action="cancel">Cancel</button>
        </div>`;

    overlay.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
    overlay.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        overlay.remove();

        const action = btn.dataset.action;
        if (action === 'cancel') return;

        const legIdx = Number(btn.dataset.legIdx ?? 0);
        const leg = trip.legs?.[legIdx];
        if (!leg) return;

        const planToLoad = {
            departure:   leg.dep,
            destination: leg.dest,
            waypoints:   leg.waypoints,
            flight_plan: leg.flight_plan,
        };

        this.hide();
        await window.app?.applyRouteEdit(planToLoad);

        // Pass full trip to CLR page so leg toggle works for all legs
        if (window.app?.ifrClearance) {
            window.app.ifrClearance._flightPlan = trip;
        }

        if (action === 'replan') {
            window.app?.routePlannerPanel?.open(planToLoad);
            // Trigger replan after a tick so the panel is visible
            setTimeout(() => window.app?.routePlannerPanel?._onRecomputeTap(), 100);
        }

        window.app?.showToast(`Loaded: ${trip.name}`);
    });

    document.body.appendChild(overlay);
}
```

- [ ] **Step 5: Update `_fetchAndRender()` to not break with new show()**

The existing `_fetchAndRender` is still correct — it just renders the cloud body. No change needed.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/plan-sync.js
git commit -m "feat: add CLOUD/DEVICE tab bar and Device tab to PlanSync"
```

---

## Task 5: "Save Plan" in More drawer + `app.saveCurrentPlan()`

**Files:**
- Modify: `web/cockpit/tab-bar.js`
- Modify: `web/app.js`

### Context

More drawer rows are defined in `tab-bar.js` around line 123. "Load Plan" is at line 132. The new "Save Plan" item goes immediately above it. `app.saveCurrentPlan()` delegates to `routePlannerPanel._saveCurrentTrip()` if a plan is computed, otherwise builds and saves from `_currentTrip` directly. `tab-bar.js` calls `c.ifrClearance.show()` at line 98 with no arguments — add `currentPos` here.

- [ ] **Step 1: Add "Save Plan" row to More drawer in `tab-bar.js`**

In `tab-bar.js`, find the "Load Plan" row (around line 132):
```javascript
{ icon: '✈', label: 'Load Plan', action: () => {
    if (c.planSync?.show) c.planSync.show();
    this._hideRadarControls();
    this._closeMoreDrawer();
}},
```

Insert the following row **immediately before** it:
```javascript
{ icon: '💾', label: 'Save Plan', action: () => {
    this._closeMoreDrawer();
    c.app?.saveCurrentPlan?.() || window.app?.saveCurrentPlan?.();
}},
```

Note: `c` is the components object (`this._comps`). `app` may be accessible as `c.app` or as `window.app`.

- [ ] **Step 2: Update CLR show() call in `tab-bar.js` to pass GPS position**

In `tab-bar.js`, find the line (around line 98):
```javascript
if (c.ifrClearance) c.ifrClearance.show();
```

Replace with:
```javascript
if (c.ifrClearance) c.ifrClearance.show(null, null, window.app?.stratuxClient?.situation);
```

- [ ] **Step 3: Add `saveCurrentPlan()` to `app.js`**

In `app.js`, add this method near other plan-management methods (near `openRoutePlanner`, around line 1079):
```javascript
async saveCurrentPlan() {
    if (this.routePlannerPanel?._lastPlan && this.routePlannerPanel._saveCurrentTrip) {
        try {
            await this.routePlannerPanel._saveCurrentTrip();
            this.showToast('Plan saved.');
        } catch (err) {
            this.showToast('Save failed: ' + (err?.message || err));
        }
        return;
    }
    if (this._currentTrip?.waypoints?.length >= 2) {
        const wps = this._currentTrip.waypoints;
        const dep  = wps[0].icao || wps[0].id;
        const dest = wps[wps.length - 1].icao || wps[wps.length - 1].id;
        const now  = new Date();
        const monthDay = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const trip = {
            id:         crypto.randomUUID(),
            name:       `${dep} → ${dest} · ${monthDay}`,
            dep,
            dest,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
            legs: [{
                dep,
                dest,
                flight_plan: this._currentTrip.flight_plan || { departure: dep, destination: dest, route: '', altitude: 0, legs: [] },
                waypoints:   wps,
            }],
        };
        try {
            await TripStore.save(trip);
            this.showToast('Plan saved.');
        } catch (err) {
            this.showToast('Save failed: ' + (err?.message || err));
        }
        return;
    }
    this.showToast('No plan to save.');
}
```

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/tab-bar.js web/app.js
git commit -m "feat: add Save Plan drawer item and app.saveCurrentPlan()"
```

---

## Task 6: IfrClearance multi-leg support

**Files:**
- Modify: `web/cockpit/ifr-clearance.js`

### Context

Current `show(flightPlan, departureAirport)` signature becomes `show(flightPlan, departureAirport, currentPos)`. `_flightPlan` now holds either the legacy single-plan or a full trip object. `_getActiveLeg()` detects which shape it is. The leg toggle is only visible when `trip.legs.length > 1`. Auto-select: distance from `currentPos` to the fuel stop airport is compared to 5 nm; if within 5 nm, switch to leg 2. Haversine formula computes the distance.

- [ ] **Step 1: Add `_activeLegIdx` and `_legToggleEl` to constructor**

In the constructor (around line 14), after `this._departureAirport = null;`, add:
```javascript
this._activeLegIdx = 0;
this._legToggleEl  = null;
```

- [ ] **Step 2: Add `_getActiveLeg()` method**

Add after the `hide()` method (around line 67):
```javascript
_getActiveLeg() {
    const fp = this._flightPlan;
    if (!fp) return null;
    if (fp.legs) return fp.legs[this._activeLegIdx] || fp.legs[0]; // trip object
    return fp; // legacy single-plan — unchanged
}
```

- [ ] **Step 3: Update `show()` to accept `currentPos` and auto-select leg**

Replace the current `show(flightPlan, departureAirport)` method (lines 51–60):
```javascript
async show(flightPlan, departureAirport, currentPos) {
    if (flightPlan) this._flightPlan = flightPlan;
    if (departureAirport) this._departureAirport = departureAirport;

    // Auto-select leg based on GPS proximity to fuel stop
    if (this._flightPlan?.legs?.length > 1) {
        const leg1 = this._flightPlan.legs[0];
        const fuelStopWp = leg1.waypoints?.[leg1.waypoints.length - 1];
        if (currentPos?.lat != null && fuelStopWp?.lat != null &&
            (currentPos.gps_fix_quality == null || currentPos.gps_fix_quality >= 1)) {
            const distNm = this._haversineNm(currentPos.lat, currentPos.lon, fuelStopWp.lat, fuelStopWp.lon);
            this._activeLegIdx = distNm <= 5 ? 1 : 0;
        } else {
            this._activeLegIdx = 0;
        }
    } else {
        this._activeLegIdx = 0;
    }

    this._visible = true;
    this._el.style.display = 'flex';
    this._renderLegToggle();
    if (this._mode === 'dep') {
        await this._prefillDep();
    }
    this._renderActiveMode();
}
```

- [ ] **Step 4: Add `_haversineNm()` helper**

Add before `_buildDom()`:
```javascript
_haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius in nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 +
              Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

- [ ] **Step 5: Add `_renderLegToggle()` method**

The CLR header HTML (from `_buildDom()`) has:
```html
<div class="clr-header">
    <div class="clr-mode-tabs">...</div>
    <button class="ep-close clr-close">✕</button>
</div>
```

Add a container between mode-tabs and close button in `_buildDom()`. Find this inner HTML:
```html
            <div class="clr-mode-tabs">
                <button class="clr-mode-tab active" data-mode="dep">DEP</button>
                <button class="clr-mode-tab" data-mode="apch">APCH</button>
            </div>
            <button class="ep-close clr-close">✕</button>
```

Replace with:
```html
            <div class="clr-mode-tabs">
                <button class="clr-mode-tab active" data-mode="dep">DEP</button>
                <button class="clr-mode-tab" data-mode="apch">APCH</button>
            </div>
            <div class="clr-leg-toggle" id="clr-leg-toggle" style="display:none"></div>
            <button class="ep-close clr-close">✕</button>
```

The toggle container starts empty — `_renderLegToggle()` stamps buttons into it each time. No static buttons; no event wiring needed in `_buildDom()`.

Store a ref in `_buildDom()` after the overlay is created:
```javascript
this._legToggleEl = el.querySelector('#clr-leg-toggle');
```

Add the `_renderLegToggle()` method. It re-generates buttons on every call (N buttons for N legs), then wires their events:
```javascript
_renderLegToggle() {
    if (!this._legToggleEl) return;
    const legs = this._flightPlan?.legs;
    if (!legs || legs.length <= 1) {
        this._legToggleEl.style.display = 'none';
        this._legToggleEl.innerHTML = '';
        return;
    }
    this._legToggleEl.style.display = 'flex';
    this._legToggleEl.innerHTML = legs.map((_, i) =>
        `<button class="clr-leg-btn${i === this._activeLegIdx ? ' clr-leg-active' : ''}" data-leg="${i}">Leg ${i + 1}</button>`
    ).join('');
    this._legToggleEl.querySelectorAll('.clr-leg-btn').forEach(btn => {
        btn.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        btn.addEventListener('click', () => {
            this._activeLegIdx = Number(btn.dataset.leg);
            this._renderLegToggle();
            if (this._mode === 'dep') this._prefillDep();
        });
    });
}
```

- [ ] **Step 6: Update `_prefillDep()` to use `_getActiveLeg()`**

Replace the current `_prefillDep()` method (lines 476–519):
```javascript
async _prefillDep() {
    const leg = this._getActiveLeg();
    if (!leg) return;
    const plan = leg.flight_plan || leg;

    // C — destination (clearance limit)
    const destIcao = (leg.dest) || plan.destination || '';
    if (destIcao) {
        let name = '';
        if (this._nasrDb) {
            try { const apt = await this._nasrDb.getAirport(destIcao); name = apt?.name || ''; } catch { /**/ }
        }
        const inp = this._el.querySelector('#clr-c');
        if (inp && !inp.value) inp.value = name ? `${destIcao} — ${name}` : destIcao;
    }

    // R — route
    const routeInp = this._el.querySelector('#clr-r');
    if (routeInp && !routeInp.value) {
        const routeStr = plan.route || '';
        if (routeStr) {
            routeInp.value = routeStr;
        } else if (leg.waypoints?.length > 0) {
            routeInp.value = leg.waypoints.map(w => w.icao || w.name).filter(Boolean).join(' ');
        }
    }

    // A — filed altitude
    const altInp = this._el.querySelector('#clr-a');
    if (altInp && !altInp.value) {
        const alt = plan.altitude || plan.cruise_altitude;
        if (alt) altInp.value = String(alt);
    }

    // F — departure frequency from airport
    const freqInp = this._el.querySelector('#clr-f');
    if (freqInp && !freqInp.value) {
        const freq = this._getDeparureFreq();
        if (freq) freqInp.value = freq;
    }

    this._updateCdPhone();
    this._updateDepReadback();
}
```

- [ ] **Step 7: Update `_fillAsFiledRoute()` to use `_getActiveLeg()`**

Replace the current `_fillAsFiledRoute()` method (lines 521–534):
```javascript
_fillAsFiledRoute() {
    const leg  = this._getActiveLeg();
    const plan = leg ? (leg.flight_plan || leg) : null;
    const inp  = this._el.querySelector('#clr-r');
    if (!inp) return;
    if (plan?.route) {
        inp.value = plan.route;
    } else if (leg?.waypoints?.length > 0) {
        inp.value = leg.waypoints.map(w => w.icao || w.name).filter(Boolean).join(' ');
    } else {
        inp.value = 'AS FILED';
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
}
```

- [ ] **Step 8: Commit**

```bash
git add web/cockpit/ifr-clearance.js
git commit -m "feat: add multi-leg support to IfrClearance with GPS auto-select"
```

---

## Task 7: CSS styles

**Files:**
- Modify: `web/style.css`

### Context

New elements needing styles:
- `.ps-tabs` — tab bar in PlanSync overlay
- `.ps-tab`, `.ps-tab-active` — tab buttons
- `.ps-legs-badge` — "N legs" badge on Device tab rows
- `.ps-row-main`, `.ps-row-sub` — two-row Device tab row layout
- `.ps-row-delete` — delete button in row
- `.ps-sheet`, `.ps-sheet-btn`, `.ps-sheet-cancel`, `.ps-sheet-title` — bottom sheet
- `.clr-leg-toggle` — leg toggle container in CLR header
- `.clr-leg-btn`, `.clr-leg-active` — leg toggle buttons
- `.rpp-tbtn-save` — Save button variant

The app is **light-theme only** (sunlight-readable on a Lenovo Yoga Tab). CSS tokens: `--bg-primary: #ffffff`, `--bg-surface: #f5f5f5`, `--text-primary: #1a1a2e`, `--accent: #0066cc`. The route planner toolbar uses `background: #fff; color: #0a0c0f; border: 1.5px solid #b0bac6`. Follow these patterns — do NOT use dark panel backgrounds. Minimum 44px touch targets on all interactive elements. Match the patterns from existing `.ps-row` and `.clr-mode-tab` styles.

- [ ] **Step 1: Add all new styles to `web/style.css`**

Append the following to the end of `web/style.css`:

```css
/* ── PlanSync tab bar ─────────────────────────────────── */
.ps-tabs {
    display: flex;
    border-bottom: 2px solid var(--border);
    background: var(--bg-surface-raised);
    margin-bottom: 12px;
}
.ps-tab {
    flex: 1;
    padding: 10px 0;
    background: none;
    border: none;
    border-bottom: 3px solid transparent;
    margin-bottom: -2px;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: .06em;
    cursor: pointer;
    min-height: 44px;
    font-family: inherit;
}
.ps-tab-active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
}

/* ── PlanSync Device tab rows ─────────────────────────── */
.ps-row-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
}
.ps-row-sub {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}
.ps-legs-badge {
    font-size: 10px;
    font-weight: 700;
    background: var(--accent);
    color: var(--text-on-accent);
    border-radius: 3px;
    padding: 2px 6px;
    letter-spacing: .04em;
    white-space: nowrap;
}
.ps-row-delete {
    background: none;
    border: none;
    color: var(--status-danger);
    font-size: 16px;
    padding: 4px 8px;
    min-height: 44px;
    min-width: 44px;
    cursor: pointer;
    flex-shrink: 0;
}

/* ── PlanSync load bottom sheet ───────────────────────── */
.ps-sheet {
    background: var(--bg-primary);
    border-radius: 12px 12px 0 0;
    width: 100%;
    max-width: 500px;
    padding: 0 0 env(safe-area-inset-bottom, 12px);
    border-top: 2px solid var(--border-strong);
}
.ps-sheet-title {
    padding: 14px 20px 10px;
    font-size: var(--text-base);
    font-weight: 700;
    color: var(--text-primary);
    border-bottom: 1px solid var(--border);
}
.ps-sheet-btn {
    display: block;
    width: 100%;
    background: none;
    border: none;
    border-top: 1px solid var(--border-light);
    color: var(--text-primary);
    font-size: var(--text-base);
    font-weight: 600;
    padding: 16px 20px;
    text-align: left;
    cursor: pointer;
    min-height: 52px;
    font-family: inherit;
}
.ps-sheet-btn:active { background: var(--bg-surface); }
.ps-sheet-cancel {
    color: var(--text-secondary);
    border-top: 2px solid var(--border);
    margin-top: 4px;
}

/* ── CLR leg toggle ───────────────────────────────────── */
.clr-leg-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-surface);
    border-radius: 6px;
    padding: 2px;
    border: 1px solid var(--border);
}
.clr-leg-btn {
    background: none;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 700;
    padding: 6px 12px;
    min-height: 36px;
    cursor: pointer;
    font-family: inherit;
    letter-spacing: 0.04em;
}
.clr-leg-active {
    background: var(--status-ok);
    color: #000;
}

/* ── Route planner Save button ────────────────────────── */
.rpp-tbtn-save {
    background: #e8f7ec;
    color: #1a6b2e;
    border-color: #4caa5c;
    font-weight: 700;
}
.rpp-tbtn-save:active { background: #c8ecd1; border-color: #2a8a3e; }
.rpp-tbtn-save:disabled {
    background: #f0f0f0;
    color: #999;
    border-color: #ccc;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/style.css
git commit -m "feat: add CSS for Device tab, leg toggle, Save button, and bottom sheet"
```

---

## Task 8: Build and verify

**Files:**
- Modify: `web/app.js` (version bump)

- [ ] **Step 1: Increment FLYTAB_VERSION**

In `web/app.js`, find the version constant at the top of the file and bump it. If current version is `v7.93`, change to `v7.94`.

- [ ] **Step 2: Build**

```bash
bash build.sh
```

Expected: BUILD SUCCESSFUL, APK copied to `data/`.

- [ ] **Step 3: Deploy and smoke-test on tablet**

Install the APK, then verify the following golden paths:

**Save + Device tab:**
1. Open route planner → plan a route → tap Apply
2. More drawer → "Save Plan" → verify toast "Plan saved."
3. More drawer → "Load Plan" → tap DEVICE tab → saved trip appears in list
4. Tap the trip row → bottom sheet appears → tap "Load as-is" → route loads

**Multi-leg trip:**
1. Plan a long route with a fuel stop → run Plan → accept fuel stop → tap Apply (or Save button)
2. More drawer → Load Plan → DEVICE → trip row shows "2 legs" badge
3. Tap trip → bottom sheet shows one "Load Leg N" button per leg (e.g. "Load Leg 1: KLUK → KERI" and "Load Leg 2: KERI → KBOS")
4. Load Leg 1, then open CLR page (tab bar bottom) → CLR shows "Leg 1 | Leg 2" toggle
5. "R" field shows Leg 1 route string; tap "Leg 2" toggle → "R" field updates to Leg 2 route string
6. (Optional) Add a second fuel stop to create a 3-leg trip → verify "3 legs" badge and three load buttons

**GPS auto-select (simulated):**
- When GPS is unavailable, CLR should default to Leg 1

**Regression checks:**
- Load Plan CLOUD tab still works (flywhere.app plans load normally)
- Single-leg trips load fine with no leg toggle in CLR
- AS FILED button in CLR fills R field from active leg route string

- [ ] **Step 4: Commit if any last-minute fixes**

```bash
git add -p   # stage only the fix
git commit -m "fix: ..."
```

---

## Self-review checklist

**Spec coverage:**

| Spec section | Task |
|---|---|
| TripStore IDB singleton | Task 1 |
| Data model (trip.legs[].flight_plan.route) | Task 2 |
| Save button in toolbar | Task 3 |
| Auto-save on Apply | Task 2 |
| Plans button → Device tab | Task 3 + Task 4 |
| PlanSync CLOUD/DEVICE tabs | Task 4 |
| Device tab two-leg bottom sheet | Task 4 |
| Save Plan in More drawer | Task 5 |
| app.saveCurrentPlan() | Task 5 |
| CLR leg toggle | Task 6 |
| CLR GPS auto-select | Task 6 |
| _getActiveLeg() shape-agnostic | Task 6 |
| _prefillDep() reads active leg | Task 6 |
| _fillAsFiledRoute reads active leg | Task 6 |
| CSS for all new elements | Task 7 |
| Long-press rename on Device tab | ⚠ Not implemented — spec mentions it but is a low-priority enhancement |

**Interface contracts:**
- `TripStore.save(trip)` expects `trip.id` (string), `trip.created_at` (ISO string), `trip.legs` (array)
- `_getActiveLeg()` returns `trip.legs[_activeLegIdx]` for trip objects; returns `_flightPlan` directly for legacy single-plan objects
- `leg.flight_plan.route` is the FAA field-15 string built at save time
- `leg.flight_plan.altitude` is in feet (same as `this._altitude`)

**N-leg generalization:** All three hotspots are now N-leg safe:
- `_saveCurrentTrip()` uses `reduce` to collect all fuel stop indices, then a `for` loop over `[0, ...fsIdxs, last]` boundaries — produces one `tripLegs` entry per segment regardless of count
- Bottom sheet loops `trip.legs.map(...)` — renders one "Load Leg N" button per leg
- CLR toggle calls `_renderLegToggle()` which re-stamps N buttons and re-wires events each render

**Potential issues:**
- `_onPlansTap()` references `planSync` as a global — in `app.js`, `planSync` is instantiated as `this.planSync`. The method falls back to `window.app?.planSync`. Verify in smoke test.
- `_prefillDep()` now reads `leg.dest` for the clearance limit C field; for legacy single-plan objects `_getActiveLeg()` returns the plan itself and `leg.dest` will be undefined — falls back to `plan.destination` which is correct.
- The long-press rename feature from the spec is deferred. The Device tab shows a delete (✕) button but not a rename inline field. This can be added in a follow-up.
