# Partial-Fix Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the 5 issues from the 2026-09-16 issue-sweep that were left open despite real, partial progress: #112 (config overrides), #52 + #53 (Leaflet tap-handler reliability), #10 (misleading NASR-not-loaded error), and #104 (data-gap hardening — verification only, no code).

**Architecture:** Five independent gaps, no shared code between them except #52/#53 both extending this repo's established custom-touch-handler pattern (CLAUDE.md's "Leaflet Touch Handling" section) to spots that never got it. Tasks 1, 2, 5, 6, 7 are independent and can run in any order/in parallel. Task 4 depends on Task 3 (both edit `vector-map-layers.js`'s `_onMapClick`) and must run after it — see Self-Review for detail.

**Tech Stack:** Vanilla JS, no bundler, `<script>`-tag loading. Vitest (jsdom) for anything not requiring real touch/SVG geometry; Leaflet 1.x (vendored).

**Spec:** No single spec — each task's requirements come directly from this repo's own issue tracker (#112, #52, #53, #10, #104) plus verified current-code research done during planning (exact file:line citations below were re-verified against `main` at plan-writing time, not carried over from memory).

## Global Constraints

- No `flypi_` prefix on any new storage key — that prefix is legacy-only (see this repo's CLAUDE.md). New keys/properties use plain, current naming.
- Leaflet's `.on('click')` / `.bindPopup()` alone are unreliable on Android tablets — never rely on them without the custom touchstart/touchend + hit-test pattern.
- **Correction to CLAUDE.md's documented pattern, discovered during planning research:** CLAUDE.md says polygon hit-testing should use SVG `getScreenCTM()`. The actual shipped, working code (`fisb-weather.js:_handleAdvisoryTap`) does NOT use that — it does geographic ray-casting on lat/lon instead, with a code comment explaining `getScreenCTM()` is unreliable on Android WebView under Leaflet's CSS pan transforms. Tasks 3 and 4 below follow the ray-casting approach (proven working), not CLAUDE.md's stale SVG-CTM description. Flag to the user separately that CLAUDE.md's Leaflet Touch Handling section needs a correction — out of scope for this plan to fix the doc itself.
- Per CLAUDE.md's Tap Handler Regression Rule (which names `onAirportClick`/`onNavaidClick`/`onFixClick` specifically, but the same logic applies to every tap target touched here): **no automated test can verify real touch/SVG hit-testing in this repo today** (verified during planning — grepped all of `tests/` for `touchstart|touchend|dispatchEvent.*Touch|isPointInFill|_findNearestMarker|_handleAdvisoryTap`: zero matches; the one Playwright suite that loads the real map, `tests/smoke/visual-map.spec.js`, only does tile-pixel screenshot diffs). Tasks 3, 4, and 5 each include a source-inspection-style automated test (the `tests/cockpit/route-table-plan-picker.test.js` pattern — regex/string assertions against the source text, not real interaction) as a lightweight regression net, **plus a required manual on-device verification step that is not optional and not satisfied by the automated test passing.**
- Run `bash build.sh` after code changes are complete (bumping `FLYTAB_VERSION` in `web/app.js` first, per this repo's Build Policy) — not part of individual tasks below since it's a repo-wide post-implementation step, not per-task.

---

## Task 1: Fix `_syncAircraftToPi` to diff against bundle (closes #112, part A)

**Files:**
- Modify: `web/app.js:1459-1528` (`_syncAircraftToPi`)
- Test: `tests/shared/sync-aircraft-to-pi.test.js` (new)

**Interfaces:**
- Consumes: `CockpitConfig._diffAgainstBundle(saved, bundle)` (existing static method, `web/shared/cockpit-config.js:238-252`) — unchanged signature, already proven by the other two shadowing-fix vectors.
- Produces: no new exports. `_syncAircraftToPi` keeps its existing signature and call site (`web/app.js:1263`); only its internal persistence changes.

**Context:** `_syncAircraftToPi` currently builds a `merged` object (existing fields spread + selective Supabase-sourced overwrites) and writes the **entire** `merged` object to `localStorage['flypi_cfg_aircraft_config_json']` unconditionally, and sets `CockpitConfig._aircraft = merged` directly — with no diffing against the bundled default. This is a third, independent shadowing vector distinct from the two already-fixed ones (which both write to the separate `flypi_user_aircraft` key via `_diffAgainstBundle`). The fix: diff `merged` against the current bundle before persisting, exactly like the other two vectors do, so fields that end up matching the bundle don't get permanently pinned to a stale synced value.

**Where the pristine bundle actually comes from (resolved during plan review — an earlier draft of this task got this wrong):** `flypi_cfg_aircraft_config_json` is *not* a usable bundle source — it's the same key `_syncAircraftToPi` itself overwrites, so after the first sync it no longer holds the pristine bundle. `config-editor.js._load()` (lines 37-69) already solves exactly this problem: it does a fresh `fetch('aircraft-config.json', { signal: AbortSignal.timeout(3000) })` every time, with a comment explicitly noting this is the pristine bundle "#112" needs to diff against. Use the identical pattern here rather than inventing a new cache key.

- [ ] **Step 1: Write the failing test**

```js
// tests/shared/sync-aircraft-to-pi.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Load the real CockpitConfig (we want the real _diffAgainstBundle, not a stub).
globalThis.CockpitConfig = new Function(read('web/shared/cockpit-config.js') + '\nreturn CockpitConfig;')();
// Defining the class (not instantiating it) is safe even though app.js has many
// other top-level dependencies — class bodies don't execute until called.
const FlyTabApp = new Function(read('web/app.js') + '\nreturn FlyTabApp;')();

describe('_syncAircraftToPi diffs against bundle', () => {
    let app;

    beforeEach(() => {
        localStorage.clear();
        app = Object.create(FlyTabApp.prototype);
    });

    const mockBundleFetch = (bundle) => {
        globalThis.fetch = async (url) => {
            if (String(url).includes('aircraft-config.json')) {
                return { ok: true, json: async () => bundle };
            }
            throw new Error(`unexpected fetch: ${url}`);
        };
    };

    it('does not persist fields that end up matching the fresh-fetched bundle', async () => {
        const bundle = { id: 'N194JT', performance: { cruise_speed_kt: 140, cruise_gph: 9.5 } };
        localStorage.setItem('flypi_cfg_aircraft_config_json', JSON.stringify({ stale: 'previous sync result' }));
        mockBundleFetch(bundle);

        const supaPerf = { cruise_speed_kt: 140 }; // Supabase says the same as bundle
        await app._syncAircraftToPi({ id: 'N194JT', performance: supaPerf });

        const persisted = JSON.parse(localStorage.getItem('flypi_cfg_aircraft_config_json'));
        // cruise_speed_kt matches the bundle, so a diff-based persist should not
        // treat it as a real override needing to survive a future bundle update.
        expect(CockpitConfig._diffAgainstBundle(persisted, bundle).performance?.cruise_speed_kt).toBeUndefined();
    });

    it('still persists a field that genuinely differs from the bundle', async () => {
        const bundle = { id: 'N194JT', performance: { cruise_speed_kt: 140 } };
        mockBundleFetch(bundle);

        await app._syncAircraftToPi({ id: 'N194JT', performance: { cruise_speed_kt: 148 } });

        const persisted = JSON.parse(localStorage.getItem('flypi_cfg_aircraft_config_json'));
        expect(persisted.performance.cruise_speed_kt).toBe(148);
    });

    it('falls back to persisting merged as-is if the bundle fetch fails (fail open, not worse than pre-fix behavior)', async () => {
        globalThis.fetch = async () => { throw new Error('offline'); };

        await app._syncAircraftToPi({ id: 'N194JT', performance: { cruise_speed_kt: 148 } });

        const persisted = JSON.parse(localStorage.getItem('flypi_cfg_aircraft_config_json'));
        expect(persisted.performance.cruise_speed_kt).toBe(148);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/sync-aircraft-to-pi.test.js`
Expected: FAIL — today's code never fetches a bundle at all, so it persists `merged` (including `cruise_speed_kt: 140`) unconditionally; the first test's assertion that this field is diffed away fails.

**Verify-before-trusting note for the implementer:** confirm `app.js` actually declares `class FlyTabApp { ... }` at the top level (not inside an IIFE or assigned to a differently-named const) before relying on this loading pattern — grep `class FlyTabApp` in `web/app.js` first. If it's structured differently, adjust the `new Function(...)` extraction accordingly; the rest of this test is unaffected.

- [ ] **Step 3: Write minimal implementation**

Read the current full body of `_syncAircraftToPi` (`web/app.js:1459-1528`) before editing — this step assumes its existing shape (builds `merged` via spreads, ends with the two lines below) and only changes the persistence tail. Locate these two lines near the end of the method (per plan-time research, ~1518 and ~1523):

```js
localStorage.setItem('flypi_cfg_aircraft_config_json', JSON.stringify(merged));
if (typeof CockpitConfig !== 'undefined') CockpitConfig._aircraft = merged;
```

Replace with:

```js
let bundle = {};
try {
    const bundleResp = await fetch('aircraft-config.json', { signal: AbortSignal.timeout(3000) });
    if (bundleResp.ok) bundle = await bundleResp.json();
} catch { /* offline/timeout — fall back to persisting merged as-is, same as pre-fix behavior */ }
const toPersist = (typeof CockpitConfig !== 'undefined')
    ? CockpitConfig._diffAgainstBundle(merged, bundle)
    : merged;
localStorage.setItem('flypi_cfg_aircraft_config_json', JSON.stringify(toPersist));
if (typeof CockpitConfig !== 'undefined') CockpitConfig._aircraft = merged;
```

This mirrors `config-editor.js._load()`'s exact fetch pattern (same URL, same timeout) rather than introducing a new storage key — no `flypi_`-prefix conflict, no dependency on state nothing else sets.

**Implementer note:** confirm `_syncAircraftToPi`'s current signature is (or can safely become) `async` — the existing code (per plan-time research) builds `merged` via synchronous object spreads with no `await`, so check whether making it `async` changes anything for its caller at `web/app.js:1263` (inside plan-apply logic). A Pi-sync operation not blocking its caller on completion is very unlikely to be a problem, but verify rather than assume — if the caller does need to await it, add `await` there too.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/sync-aircraft-to-pi.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/app.js tests/shared/sync-aircraft-to-pi.test.js
git commit -m "fix(#112): diff _syncAircraftToPi's write against the aircraft bundle"
```

---

## Task 2: Add "revert to bundled default" UI to config-editor.js (closes #112, part B)

**Files:**
- Modify: `web/cockpit/config-editor.js` (constructor ~6-15, `_render()` ~71-361, `_save()` ~428-534)
- Test: `tests/cockpit/config-editor-revert.test.js` (new)

**Interfaces:**
- Consumes: `CockpitConfig._diffAgainstBundle` (existing, unchanged).
- Produces: no new public API — this is a self-contained UI addition to an existing panel.

**Context:** Confirmed during planning research: no revert-to-default UI exists anywhere in this repo (`grep -ni "revert|reset.*default|restore.*default"` across all of `web/`: zero matches). The existing RELOAD button (`.ce-reload-btn`) just re-fetches and re-merges — since `_load()` re-applies stored overrides on top of the bundle, RELOAD does **not** clear an override; it just redisplays bundle+override. This task adds a per-field "revert" affordance.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/config-editor-revert.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.CockpitConfig = new Function(read('web/shared/cockpit-config.js') + '\nreturn CockpitConfig;')();
const ConfigEditor = new Function(read('web/cockpit/config-editor.js') + '\nreturn ConfigEditor;')();

describe('ConfigEditor revert-to-default', () => {
    let editor;

    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = '<div id="config-editor-root"></div>';
        editor = Object.create(ConfigEditor.prototype);
        editor._el = document.getElementById('config-editor-root');
        editor._cockpitBundle = { someField: 'bundled-value' };
        editor._aircraftBundle = { performance: { cruise_speed_kt: 140 } };
        editor._cockpitConfig = { someField: 'pilot-edited-value' };
        editor._aircraftConfig = { performance: { cruise_speed_kt: 148 } };
    });

    it('exposes a revert method that restores a single field to its bundled value', () => {
        expect(typeof editor._revertField).toBe('function');
        editor._revertField('aircraft', 'performance.cruise_speed_kt');
        expect(editor._aircraftConfig.performance.cruise_speed_kt).toBe(140);
    });

    it('revert has no effect on a field that was never overridden', () => {
        editor._revertField('cockpit', 'someField');
        editor._revertField('cockpit', 'someField'); // idempotent
        expect(editor._cockpitConfig.someField).toBe('bundled-value');
    });

    it('does not blank a device-specific field with no bundle counterpart', () => {
        // homeServer/flightUpload-style fields: _diffAgainstBundle's own doc comment
        // says these are "always kept" since there's nothing bundled to compare
        // against. Reverting one must leave it alone, not null it out.
        editor._cockpitConfig.homeServer = { host: '192.168.1.50' };
        // _cockpitBundle has no homeServer key at all.
        editor._revertField('cockpit', 'homeServer.host');
        expect(editor._cockpitConfig.homeServer.host).toBe('192.168.1.50');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/config-editor-revert.test.js`
Expected: FAIL with `TypeError: editor._revertField is not a function`

- [ ] **Step 3: Write minimal implementation**

Add a new method to `ConfigEditor` (place near `_save()`, `web/cockpit/config-editor.js:428`):

```js
_revertField(scope, dottedPath) {
    const bundle = scope === 'aircraft' ? this._aircraftBundle : this._cockpitBundle;
    const config = scope === 'aircraft' ? this._aircraftConfig : this._cockpitConfig;
    const keys = dottedPath.split('.');
    let bundleNode = bundle;
    for (const k of keys) bundleNode = bundleNode?.[k];
    // No bundle counterpart at all — a device-specific field (homeServer,
    // flightUpload) per _diffAgainstBundle's own doc comment. Nothing to
    // revert to; leave it alone rather than blanking it to undefined.
    if (bundleNode === undefined) return;
    let node = config;
    for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
    node[keys[keys.length - 1]] = bundleNode;
}
```

Then wire a revert control per rendered field inside `_render()` (`web/cockpit/config-editor.js:71-361`). Read the existing field-rendering loop first to match its structure exactly (this plan doesn't assume the loop's precise variable names — implementer fills in the per-field revert button using whatever loop variable currently identifies the field's scope and dotted path, calling `this._revertField(scope, path)` on tap, then re-running the same render call the field's own input's change-handler already triggers). Show the button only when **both** (a) the bundle actually has a defined value at that path (same traversal `_revertField` does — if `bundleNode === undefined`, don't show the button at all, matching the guard above) **and** (b) the field's current value differs from its bundled value (reuse `CockpitConfig._diffAgainstBundle({[lastKey]: node[lastKey]}, {[lastKey]: bundleNode})` returning a non-empty object as the "is overridden" check, or a simpler direct `!==`/`JSON.stringify` comparison — either is correct; pick whichever matches the surrounding render loop's existing style most closely).

Follow this repo's Design Token Standards for the button (`min-height: var(--touch-min, 56px)`, no hardcoded hex colors) since this is new cockpit UI.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/config-editor-revert.test.js`
Expected: PASS

- [ ] **Step 5: Manual verification**

Open the Settings/config editor panel on-device or in the browser dev build, change one aircraft performance field, save, reopen the editor, tap the new revert control on that field, confirm the displayed value returns to the bundled default and Save persists that reversion (re-open once more to confirm it stuck).

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/config-editor.js tests/cockpit/config-editor-revert.test.js
git commit -m "feat(#112): add per-field revert-to-bundled-default control to config editor"
```

---

## Task 3: Route waypoint, TFR, and PIREP tap dispatch via VectorMapLayers' existing pipeline (closes #52, and 3 of 6 spots in #53)

**Redesigned during plan review.** The original draft of this task gave `CockpitMap` its own independent touchstart/touchend pair. A critical-review pass caught that `VectorMapLayers` is constructed on the exact same Leaflet map instance (`web/app.js:445`, `new VectorMapLayers(this.cockpitMap.map, nasrDb)`) and already owns its own touchstart(capture:true)/touchend pipeline on that same container (`vector-map-layers.js:109-143`). Two independent listener pairs on the same container means a single tap can be evaluated by both state machines — e.g. tapping a route waypoint that sits near a real airport marker could open two different popups from two unrelated pipelines, neither aware of the other. Fixed by extending `VectorMapLayers`' existing single pipeline with one more fallback callback, mirroring the exact pattern already used for traffic taps (`_onTrafficTap`), instead of adding a competing listener.

**Files:**
- Modify: `web/cockpit/vector-map-layers.js` (constructor ~line 50, `_onMapClick` ~1619-1664)
- Modify: `web/cockpit/map.js` (route-waypoint building ~1393-1415, `_addTfrShape` ~642-699, `_addPirepMarker` ~701-749 — read-only context for these, plus a new method near `_onTrafficTap` at ~1241)
- Modify: `web/app.js` (~504-505, alongside the existing `_onTrafficTap` wiring)
- Test: `tests/cockpit/map-layer-tap-dispatch.test.js` (new, source-inspection style)

**Interfaces:**
- Consumes: Leaflet's `L.Circle`/`L.Polygon`/`L.Marker` (vendored, already used throughout `map.js`); `VectorMapLayers`' existing `_onMapClick(e)` fallback chain and its established `_onTrafficTap` callback-wiring pattern (`web/app.js:504-505`).
- Produces: `VectorMapLayers._onOtherLayerTap` — a new callback property (`null` until wired, same pattern as `_onTrafficTap`), called as `this._onOtherLayerTap(containerPt, latlng)` and expected to return a truthy value if it handled the tap (stopping the fallback chain before it reaches `_onTrafficTap`). `CockpitMap._handleLayerTap(containerPt, latlng)` — new method implementing that callback, returns `true`/falsy. Does **not** modify `_onTrafficTap` itself or its existing wiring — that path is unchanged, just now tried after this new check instead of immediately after the marker passes.

**Context (verified during planning, not assumed):** Three marker/shape sets CockpitMap owns, three different hit-test needs:

- **Route waypoints** (`this._wpMarkers`, a plain array, rebuilt every `setRoute()` call, `map.js:1393-1415`) — point markers, pixel-distance hit-test (matches the existing convention in `vector-map-layers.js:_findNearestMarker`).
- **TFR shapes** (`this._tfrShapes`, a `Map` keyed by `notam.raw`, populated by `_addTfrShape`, `map.js:642-699`) — **mixed** shape types: `L.polygon` when `notam.points?.length >= 3`, `L.circle` when a radius is known, `L.marker` otherwise. Each needs its own hit-test: polygon → ray-cast (same algorithm as `fisb-weather.js:_pointInPolygon`, duplicated locally rather than introducing a cross-file dependency — `web/shared/geo-utils.js` does not exist on `main` yet, it's only on the still-open PR #145 branch); circle → exact geo-distance (`shape.getLatLng().distanceTo(tapLatLng) <= shape.getRadius()`, both in meters, zoom-invariant and exact — no pixel approximation needed); marker → pixel-distance, same as route waypoints.
- **PIREP markers** (`this._pirepMarkers`, a `Map` keyed by `pirep.raw`, populated by `_addPirepMarker`, `map.js:701-749`) — point markers, pixel-distance.

- [ ] **Step 1: Write the failing test**

Given no automated test can exercise real Leaflet touch/SVG behavior in this repo today (see Global Constraints), this is a source-inspection test — it asserts the new code exists and is wired, not that taps behave correctly (that's the required manual step, Step 4).

```js
// tests/cockpit/map-layer-tap-dispatch.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const MAP_SRC = readFileSync('web/cockpit/map.js', 'utf8');
const VML_SRC = readFileSync('web/cockpit/vector-map-layers.js', 'utf8');
const APP_SRC = readFileSync('web/app.js', 'utf8');

describe('route/TFR/PIREP taps dispatch through VectorMapLayers\' existing pipeline', () => {
    it('VectorMapLayers checks the new callback before falling through to traffic', () => {
        const onMapClickStart = VML_SRC.indexOf('_onMapClick(');
        const trafficCall = VML_SRC.indexOf('this._onTrafficTap(pt)');
        const otherLayerCheck = VML_SRC.indexOf('_onOtherLayerTap', onMapClickStart);
        expect(otherLayerCheck).toBeGreaterThan(onMapClickStart);
        expect(otherLayerCheck).toBeLessThan(trafficCall);
    });

    it('does not add a second touchstart/touchend pair to map.js', () => {
        // Regression guard for the double-fire bug caught in plan review — CockpitMap
        // must NOT register its own listeners on this.map.getContainer().
        expect(MAP_SRC).not.toMatch(/this\.map\.getContainer\(\)\.addEventListener\(\s*['"]touchstart['"]/);
    });

    it('CockpitMap implements the hit-test dispatch', () => {
        expect(MAP_SRC).toMatch(/_handleLayerTap\s*\(/);
        expect(MAP_SRC).toMatch(/_wpMarkers/);
        expect(MAP_SRC).toMatch(/_tfrShapes/);
        expect(MAP_SRC).toMatch(/_pirepMarkers/);
    });

    it('app.js wires the new callback alongside the existing _onTrafficTap wiring', () => {
        expect(APP_SRC).toMatch(/vectorLayers\._onOtherLayerTap\s*=/);
    });

    it('does not remove or alter the existing _onTrafficTap method or its wiring', () => {
        expect(MAP_SRC).toMatch(/_onTrafficTap\(containerPt\)\s*\{/);
        expect(APP_SRC).toMatch(/vectorLayers\._onTrafficTap\s*=/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/map-layer-tap-dispatch.test.js`
Expected: FAIL — `_onOtherLayerTap` doesn't exist yet anywhere, `_handleLayerTap` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `VectorMapLayers`' constructor, alongside the existing `this._onTrafficTap = null; // fallback for traffic markers (from CockpitMap)` (`vector-map-layers.js:50`), add a sibling property:

```js
this._onOtherLayerTap = null; // fallback for route-waypoint/TFR/PIREP markers (from CockpitMap)
```

In `_onMapClick` (`vector-map-layers.js:1619-1664`), read the method in full before editing — this step assumes its existing tail ends with the traffic fallback shown in Global Constraints' research (`if (this._onTrafficTap) { this._onTrafficTap(pt); }`). Insert immediately before that block:

```js
if (this._onOtherLayerTap && this._onOtherLayerTap(pt, e.latlng)) {
    return;
}
```

So the tail becomes: two marker passes (unchanged) → new `_onOtherLayerTap` check → existing `_onTrafficTap` fallback (unchanged, now just tried second instead of first). This rides on `VectorMapLayers`' existing touchstart handler, which already guards against taps starting inside `.leaflet-popup` (`vector-map-layers.js:111-119`) — the new dispatch inherits that guard for free, so a popup's close button can't re-trigger a route-waypoint/TFR/PIREP hit-test underneath it.

In `map.js`, add the dispatch + hit-test methods (place near `_onTrafficTap`, `map.js:1241` — this task does not touch `_onTrafficTap` itself):

```js
_handleLayerTap(containerPt, latlng) {
    const wp = this._findNearestPointMarker(this._wpMarkers, containerPt, 30);
    if (wp) { wp.fire('click'); return true; }

    for (const shape of this._tfrShapes.values()) {
        if (shape instanceof L.Circle) {
            if (shape.getLatLng().distanceTo(latlng) <= shape.getRadius()) { shape.openPopup(); return true; }
        } else if (shape instanceof L.Polygon) {
            // Leaflet nests polygon rings even for a simple flat-array input —
            // verify this against the real vendored Leaflet build during Step 5.
            const ring = shape.getLatLngs()[0];
            const pts = ring.map(ll => [ll.lat, ll.lng]);
            if (CockpitMap._pointInPolygon(latlng.lat, latlng.lng, pts)) { shape.openPopup(); return true; }
        } else if (shape instanceof L.Marker) {
            const pt = this.map.latLngToContainerPoint(shape.getLatLng());
            if (containerPt.distanceTo(pt) < 30) { shape.openPopup(); return true; }
        }
    }

    const pirep = this._findNearestPointMarker([...this._pirepMarkers.values()], containerPt, 30);
    if (pirep) { pirep.openPopup(); return true; }

    return false;
}

_findNearestPointMarker(markers, containerPt, maxPx) {
    let best = null, bestDist = maxPx;
    for (const marker of markers) {
        const pt = this.map.latLngToContainerPoint(marker.getLatLng());
        const dist = containerPt.distanceTo(pt);
        if (dist < bestDist) { bestDist = dist; best = marker; }
    }
    return best;
}

// Ray-casting point-in-polygon for [lat, lon] pairs — same proven algorithm as
// fisb-weather.js's static _pointInPolygon, duplicated here rather than adding
// a cross-file dependency (no shared geo-utils.js exists on main yet).
static _pointInPolygon(lat, lon, points) {
    let inside = false;
    const n = points.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const [yi, xi] = points[i];
        const [yj, xj] = points[j];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}
```

Note on the route-waypoint branch: it calls `wp.fire('click')` (the marker itself, since `_wpMarkers` is a plain array of markers, not `{marker}` wrapper objects) rather than duplicating the existing click handler's logic, so the one real behavior (opening the airport popup, `map.js:1408-1411`) stays defined in exactly one place. Confirm `L.Marker`/`L.CircleMarker`'s `.fire('click')` actually invokes a handler registered via `.on('click', ...)` — this is standard Leaflet event-emitter behavior and should work, but verify in Step 5 rather than assuming.

In `web/app.js`, alongside the existing traffic-tap wiring (~line 504-505, `this.vectorLayers._onTrafficTap = (containerPt) => { this.cockpitMap._onTrafficTap(containerPt); };`), add:

```js
this.vectorLayers._onOtherLayerTap = (containerPt, latlng) => this.cockpitMap._handleLayerTap(containerPt, latlng);
```

No changes needed to `map.js`'s constructor, `init()`, or `destroy()` — this task adds no new listeners, so there's nothing new to set up or tear down there.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/map-layer-tap-dispatch.test.js`
Expected: PASS

- [ ] **Step 5: Required manual on-device verification**

This is not optional — the automated test in Step 1 only confirms the code exists and is wired, not that taps behave correctly. On-device or in a real browser (not jsdom):
1. Load a route with at least 2 waypoints; tap a route waypoint marker (not an airport/navaid marker underneath it) — confirm the airport popup opens, same as before this change, and **confirm only one popup opens, not two** (this is the specific double-fire bug an earlier draft of this task had — tap a waypoint that sits near a real airport/navaid marker specifically, since that's the scenario most likely to trigger it).
2. Enable a TFR overlay with at least one polygon-shaped TFR (or simulate via `tools/mock-stratux.py`); tap inside the polygon (not just on its border) — confirm its popup opens. Tap well outside it — confirm nothing opens.
3. If a circle-shaped TFR is available (radius-only, no polygon points), tap inside and outside its visible circle — confirm correct open/no-open.
4. Enable PIREPs; tap a PIREP marker — confirm its popup opens.
5. Tap a traffic marker — confirm the existing traffic-tap behavior is completely unaffected (it's now tried after the new check instead of before, so confirm it still fires when nothing else is under the tap).
6. Tap a normal airport/navaid/fix marker (unrelated to this task, but shares the same `_onMapClick` method that was edited) — confirm no regression, per CLAUDE.md's Tap Handler Regression Rule.

Record the result (pass/fail per sub-case) — do not report this task complete without having actually run through these six checks.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/vector-map-layers.js web/cockpit/map.js web/app.js tests/cockpit/map-layer-tap-dispatch.test.js
git commit -m "fix(#52,#53): dispatch route-waypoint, TFR, and PIREP taps through VectorMapLayers' existing pipeline"
```

---

## Task 4: SUA polygon tap fix in VectorMapLayers (closes 1 of 6 spots in #53)

**Files:**
- Modify: `web/cockpit/vector-map-layers.js` (`_onMapClick` fallback chain, SUA polygon construction ~1062-1114)
- Test: `tests/cockpit/vector-map-layers-sua-tap.test.js` (new, source-inspection style)

**Interfaces:**
- Consumes: `this._suaPolygons` (existing `Map` keyed by `sua.id`, already populated at `vector-map-layers.js:1087`).
- Produces: nothing new externally — extends the existing `_onMapClick` dispatch that `VectorMapLayers` already owns (no new listener needed; this class already has a working touchstart/touchend pipeline, per its constructor lines 109-143).

**Context:** `VectorMapLayers` already runs a two-pass hit-test (`_findNearestMarker` at 30px, then 60px) inside `_onMapClick` before falling through to `_onTrafficTap`. SUA polygons currently just call `polygon.bindPopup(popupHtml, ...)` (`vector-map-layers.js:1084`) with no tap wiring at all. Add a SUA ray-cast check to the same dispatch chain, using the identical duplicated `_pointInPolygon` approach as Task 3 (same reasoning: no shared `geo-utils.js` on `main` yet).

**Depends on Task 3 — do not run in parallel.** After Task 3's redesign, both tasks now edit `_onMapClick` in the same file near the same anchor (the fallback chain right before `_onTrafficTap`). Run Task 3 first. This task's insertion point below assumes Task 3's `if (this._onOtherLayerTap && this._onOtherLayerTap(pt, e.latlng)) { return; }` check is already present — insert the SUA check immediately before that line (order between the two checks doesn't matter functionally; this just gives a concrete, unambiguous anchor instead of two tasks guessing at the same insertion point independently).

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/vector-map-layers-sua-tap.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SRC = readFileSync('web/cockpit/vector-map-layers.js', 'utf8');

describe('VectorMapLayers SUA polygon tap dispatch', () => {
    it('_onMapClick checks SUA polygons before falling through to traffic', () => {
        const onMapClickStart = SRC.indexOf('_onMapClick(');
        const onTrafficTapCall = SRC.indexOf('this._onTrafficTap(pt)');
        const suaCheck = SRC.indexOf('_suaPolygons', onMapClickStart);
        expect(suaCheck).toBeGreaterThan(onMapClickStart);
        expect(suaCheck).toBeLessThan(onTrafficTapCall);
    });

    it('keeps a point-in-polygon helper available for SUA hit-testing', () => {
        expect(SRC).toMatch(/_pointInPolygon\s*\(/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/vector-map-layers-sua-tap.test.js`
Expected: FAIL — no `_suaPolygons` reference inside `_onMapClick` today, no `_pointInPolygon` helper in this file.

- [ ] **Step 3: Write minimal implementation**

Read `_onMapClick` in full before editing — it now includes Task 3's `_onOtherLayerTap` check (confirm this is present; if it isn't, Task 3 hasn't landed yet and must go first). Add, immediately before that check:

```js
for (const polygon of this._suaPolygons.values()) {
    const latlngs = polygon.getLatLngs()[0]; // Leaflet nests polygon rings — verify in Step 5
    const pts = latlngs.map(ll => [ll.lat, ll.lng]);
    if (VectorMapLayers._pointInPolygon(e.latlng.lat, e.latlng.lng, pts)) {
        polygon.openPopup();
        return;
    }
}
```

Add the static helper (same algorithm as `fisb-weather.js:_pointInPolygon` and Task 3's `CockpitMap._pointInPolygon` — duplicated per-class rather than shared, consistent with this task's own reasoning above):

```js
static _pointInPolygon(lat, lon, points) {
    let inside = false;
    const n = points.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const [yi, xi] = points[i];
        const [yj, xj] = points[j];
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/vector-map-layers-sua-tap.test.js`
Expected: PASS

- [ ] **Step 5: Required manual on-device verification**

Enable the SUA layer (off by default per `cockpit-config.json`). Tap inside a rendered SUA polygon — confirm its popup opens. Tap outside it, and confirm normal airport/navaid/fix taps still work unaffected (this shares the existing pipeline, so a regression here would be more consequential than Task 3's new one — test airport tap explicitly, per CLAUDE.md's Tap Handler Regression Rule).

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/vector-map-layers.js tests/cockpit/vector-map-layers-sua-tap.test.js
git commit -m "fix(#53): add tap hit-testing for SUA polygons"
```

---

## Task 5: Wind/METAR, PIREP, and NOTAM marker tap fix in FisbWeatherDisplay (closes remaining 3 of 6 spots in #53)

**Files:**
- Modify: `web/cockpit/fisb-weather.js` (`_handleAdvisoryTap` ~387-417, marker construction at ~255/607/961)
- Test: `tests/cockpit/fisb-weather-marker-tap.test.js` (new, source-inspection style)

**Interfaces:**
- Consumes: `this._windMarkers`, `this._pirepMarkers`, `this._notamMarkers` (existing collections — note `_windMarkers` is a `Map` keyed by station, `_pirepMarkers`/`_notamMarkers` are arrays of `{marker, ...}` objects, per plan-time research — do not conflate these with `CockpitMap`'s separately-named, differently-shaped `_pirepMarkers` `Map` from Task 3; they are different classes' own properties).
- Produces: nothing new externally — extends the existing `_handleAdvisoryTap`, which `FisbWeatherDisplay` already owns a touchstart/touchend pipeline for (no new listener needed).

**Context:** `_handleAdvisoryTap` currently only checks polygon-shaped advisories (SIGMET/AIRMET/CWA). Wind/METAR, PIREP, and NOTAM markers in this same class still use plain `.bindPopup()` with zero tap wiring. Extend the same method to also do a pixel-distance check against these three marker collections when no polygon is hit.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/fisb-weather-marker-tap.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SRC = readFileSync('web/cockpit/fisb-weather.js', 'utf8');

describe('FisbWeatherDisplay marker tap dispatch', () => {
    it('_handleAdvisoryTap also checks wind/PIREP/NOTAM markers', () => {
        const methodStart = SRC.indexOf('_handleAdvisoryTap(');
        const methodBody = SRC.slice(methodStart, methodStart + 2000);
        expect(methodBody).toMatch(/_windMarkers/);
        expect(methodBody).toMatch(/_pirepMarkers/);
        expect(methodBody).toMatch(/_notamMarkers/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/fisb-weather-marker-tap.test.js`
Expected: FAIL — `_handleAdvisoryTap` today only references polygon collections.

- [ ] **Step 3: Write minimal implementation**

Read `_handleAdvisoryTap` in full (`fisb-weather.js:387-417`) before editing. After the existing polygon-hit check (the `if (hits.length) this._openAdvisoryPopup(...)` block) and before the method returns with no hit, add a marker pixel-distance fallback. This method receives `clientX, clientY` (screen coordinates) and already computes `rect`/`latlng` internally — reuse `rect` to get a container point for pixel-distance marker checks, since the existing polygon path is lat/lon-based but marker hit-testing (matching every other marker-tap precedent in this repo) should be pixel-distance-based:

```js
const containerPt = L.point(clientX - rect.left, clientY - rect.top);
const markerHit = (map) => {
    let best = null, bestDist = 30;
    for (const entry of map instanceof Map ? map.values() : map) {
        const marker = entry.marker || entry; // _windMarkers stores markers directly; PIREP/NOTAM store {marker, ...}
        const pt = this._map.latLngToContainerPoint(marker.getLatLng());
        const dist = containerPt.distanceTo(pt);
        if (dist < bestDist) { bestDist = dist; best = marker; }
    }
    return best;
};
const windHit = markerHit(this._windMarkers);
if (windHit) { windHit.openPopup(); return; }
const pirepHit = markerHit(this._pirepMarkers);
if (pirepHit) { pirepHit.openPopup(); return; }
const notamHit = markerHit(this._notamMarkers);
if (notamHit) { notamHit.openPopup(); return; }
```

Place this immediately after the existing `if (hits.length) { this._openAdvisoryPopup(hits, clientX, clientY); }` line, before the method implicitly returns.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/fisb-weather-marker-tap.test.js`
Expected: PASS

- [ ] **Step 5: Required manual on-device verification**

With FIS-B data flowing (real or via `tools/mock-stratux.py` replay per `reference_mock_stratux` — see this repo's tooling), tap a wind-barb marker, a PIREP marker, and a NOTAM marker in turn — confirm each opens its popup. Confirm SIGMET/AIRMET polygon tapping (the already-working path) still works unaffected.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/fisb-weather.js tests/cockpit/fisb-weather-marker-tap.test.js
git commit -m "fix(#53): add tap hit-testing for wind, PIREP, and NOTAM markers"
```

---

## Task 6: NASR-readiness guard in route-table.js's paste-route-string path (closes #10)

**Files:**
- Modify: `web/cockpit/route-table.js` (`_resolveToken` ~893-925, `_parseRouteString` ~927-989)
- Test: `tests/cockpit/route-table-nasr-guard.test.js` (new)

**Interfaces:**
- Consumes: `this._nasrDb` (existing property, `null` until `setNasrDb(db)` is called — `route-table.js:90,113-116`).
- Produces: nothing new externally.

**Context (verified during planning):** `_resolveToken` has no guard on `this._nasrDb`. If it's `null`, every `this._nasrDb.getAirport(t)`-style call throws synchronously, which is swallowed by a bare `catch {}` (5 of them in this method) — so it silently returns `null` for every token, indistinguishable from "genuinely not found." `_parseRouteString` then renders `Not found: KLKR` via `this._resultsEl.innerHTML` (this file has no `_toast` method — confirmed by grep, zero matches). The sibling single-token method `_doSearch` (991-999) does guard (`if (!this._nasrDb) return;`) but fails **silently** with no message at all — a different, milder gap, not this task's target.

**Important — do not early-return before the existing retry (caught in plan review):** `_parseRouteString` already has self-healing logic for exactly this race (`route-table.js:955-961`): if nothing resolves, it shows "Retrying...", waits 1.5s, and re-runs resolution — which succeeds silently if NASR finishes loading in that window (a realistic startup race: pilot pastes a route right as the app launches). An early `if (!this._nasrDb) return;` at the top of the method would skip that retry entirely, making a pilot who pastes 1 second before NASR finishes loading get a hard failure message where today they'd get a silent successful resolution 1.5s later — a regression, not a fix. The correct fix only changes the **final** message (after the existing retry has already run and still found nothing unresolved), not whether the retry happens.

- [ ] **Step 1: Write the failing test**

Follow the `tests/cockpit/route-table-planning-guard.test.js` pattern exactly (confirmed during planning as the closest existing behavioral-test precedent for this file): `Object.create(RouteTable.prototype)` + manual field assignment, no real constructor call.

```js
// tests/cockpit/route-table-nasr-guard.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();

describe('_parseRouteString distinguishes "still loading" from "not found"', () => {
    let table;

    beforeEach(() => {
        table = Object.create(RouteTable.prototype);
        table._nasrDb = null; // simulates NASR still loading, and staying that way
        table._resultsEl = { innerHTML: '' };
    });

    it('shows a distinct "still loading" message only after the existing retry still finds nothing', async () => {
        vi.useFakeTimers();
        const done = table._parseRouteString('KLKR');
        // The existing retry logic (route-table.js:955-961) waits 1.5s before
        // re-checking — advance past it rather than skipping straight to a result,
        // so this test actually exercises the retry path, not just the guard.
        await vi.advanceTimersByTimeAsync(1500);
        await done;
        expect(table._resultsEl.innerHTML).toMatch(/navigation database.*loading/i);
        expect(table._resultsEl.innerHTML).not.toMatch(/Not found/);
        vi.useRealTimers();
    });
});
```

**Manual spot-check, not automated here:** the existing self-healing case (NASR becomes available *during* the 1.5s retry wait, so resolution succeeds silently with no error shown at all) is unchanged by this fix and isn't given its own automated test — fully mocking `_resolveToken`'s NASR lookup chain for that scenario is more machinery than this specific bug fix warrants. Spot-check it manually once during Step 5-equivalent verification: paste a route string in the brief window right after app launch before NASR finishes loading, and confirm it still silently resolves once loading completes, exactly as today.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/route-table-nasr-guard.test.js`
Expected: FAIL — current code renders `Not found: KLKR` after the retry, not a "still loading" message.

- [ ] **Step 3: Write minimal implementation**

Read `_parseRouteString` in full (`route-table.js:927-989`) before editing. Find where it builds the final `warnHtml` from `unresolved` (per plan-time research, around lines 967-969):

```js
const warnHtml = unresolved.length > 0
    ? `<div class="route-token-warn">Not found: ${unresolved.map(t => `<span class="route-token-bad">${t}</span>`).join(' ')}</div>`
    : '';
```

Replace with:

```js
const warnHtml = unresolved.length > 0
    ? (!this._nasrDb
        ? '<div class="route-search-empty">Navigation database still loading — try again in a moment</div>'
        : `<div class="route-token-warn">Not found: ${unresolved.map(t => `<span class="route-token-bad">${t}</span>`).join(' ')}</div>`)
    : '';
```

This runs *after* the existing "Retrying..." wait-and-recheck (`route-table.js:955-961`) has already had its chance to resolve everything — it only changes which message displays for whatever is still unresolved at that point, not whether the retry happens. Same message text as the existing `route-planner-panel.js:_onAddTap` guard (`this._toast('Navigation database still loading — try again in a moment', 3500)`), adapted to this file's `_resultsEl.innerHTML` presentation instead of a toast (route-table.js has no `_toast` method).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/route-table-nasr-guard.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-table.js tests/cockpit/route-table-nasr-guard.test.js
git commit -m "fix(#10): guard paste-route-string parsing against NASR not yet loaded"
```

---

## Task 7: Real-flight verification of #104's shipped hardening (not a code task)

**Files:** none — this task produces a verification record, not code.

**Context:** #104 ("Intermittent data gaps in flight recordings") already has real hardening shipped: a 2-minute data-gap auto-stop with 10-second freshness gating in `web/cockpit/flight-recorder.js` (`_gapTimer`, confirmed live at plan-writing time), plus half-open-WebSocket detection and reconnect-race fixes in `engine-client.js`/`stratux-client.js`. This is mitigation of the described symptoms, not a fix to the underlying WiFi/environmental cause, and nothing has re-verified it against real flight data since — the original issue was based on a 6-flight sample showing gaps.

This can't be closed by writing more code; it needs actual flight data. This task is a checklist, not a diff.

- [ ] **Step 1: Confirm the baseline to compare against**

Read the original issue #104 in full (`gh issue view 104`) and locate the 6-flight sample it references (check `engine-monitor/` or wherever flight recordings are archived, per this repo's data locations) — note exact flight dates/files and what gap pattern each showed (duration, frequency), so the post-fix comparison is apples-to-apples.

- [ ] **Step 2: Fly with the current build and capture recordings**

Fly at least 2-3 flights (more if the original gaps were infrequent — matching or exceeding the original 6-flight sample size is the honest bar) with the current app build (confirm the build actually includes the `_gapTimer`/half-open-detection commits — check `FLYTAB_VERSION` against the commit history, don't assume). Use normal WiFi/network conditions, not a specially clean environment — the point is to see if real-world intermittency still produces gaps.

- [ ] **Step 3: Compare gap patterns**

For each new flight recording, check for: (a) any gap at all, (b) if present, whether it now shows as a clean stop/resume (the intended new behavior) rather than the old "duplicate rows then silent gap" pattern the original issue described. Compare gap frequency/duration against the Step 1 baseline.

- [ ] **Step 4: Decide and act on the result**

If gaps are meaningfully reduced and/or now show the clean stop/resume pattern: close #104 with a comment citing the specific flights/dates compared and the observed improvement — be specific, not just "seems better." If gaps persist unchanged: leave #104 open, and add a comment with the new data so the next person doesn't have to redo this comparison from scratch — this is genuinely useful even if the answer isn't "it's fixed."

---

## Self-Review

**Critical-review pass (after initial draft):** ran `/code-review` against this document before execution. It found 6 real problems, all fixed in place rather than left as findings: (1) Task 3's original design gave `CockpitMap` a second, independent touchstart/touchend pair on the same container `VectorMapLayers` already listens on — a verified double-popup risk, not hypothetical — fixed by redesigning Task 3 to extend `VectorMapLayers`' existing single pipeline via a new callback instead. (2) Task 6's guard was an early return that bypassed the existing "Retrying..." self-healing logic, which would have been a real regression for the NASR-loads-mid-paste race — fixed by moving the distinguishing check to after the existing retry, changing only the final message. (3)+(4) Task 1's fix was a literal no-op in production (diffed against an unset property, always falling back to `{}`) and its fallback path would have introduced a `flypi_`-prefixed key violating this plan's own Global Constraints — fixed by using `config-editor.js`'s already-established fresh-fetch pattern for the pristine bundle instead of inventing a new cache key. (5) Task 3's original design lacked the `.leaflet-popup` closest-check guard `VectorMapLayers` uses to stop a popup's close button from re-triggering a hit-test underneath it — resolved as a side effect of fix (1), since riding on `VectorMapLayers`' existing pipeline inherits that guard for free. (6) Task 2's `_revertField` would have blanked device-specific fields with no bundle counterpart (e.g. `homeServer.host`) to `undefined` instead of leaving them alone — fixed with an explicit guard, matching `_diffAgainstBundle`'s own documented "always kept" behavior for such fields.

**Spec coverage:** All 5 issues covered — #112 (Tasks 1-2), #52 (Task 3), #53 (Tasks 3-5, all 6 flagged spots), #10 (Task 6), #104 (Task 7).

**Placeholder scan:** No TBD/TODO markers. A few spots are flagged as implementer-must-verify rather than asserted as fact (Task 1's `_syncAircraftToPi` async/caller-await question, Task 3/4's Leaflet `getLatLngs()` nesting depth, `.fire('click')` behavior) — these are honest uncertainty flags with a concrete verification instruction attached, not vague hand-waves, per this repo's own "flag uncertainty explicitly" convention.

**Type consistency:** `_pointInPolygon(lat, lon, points)` signature matches across Task 3, Task 4, and the original `fisb-weather.js` reference exactly. `CockpitMap._pointInPolygon` (Task 3) and `VectorMapLayers._pointInPolygon` (Task 4) are same-named static methods on different classes — fine, no shared namespace. `VectorMapLayers._onOtherLayerTap(containerPt, latlng)`'s signature and truthy-return contract (Task 3) matches how it's called in `_onMapClick` and implemented in `CockpitMap._handleLayerTap` exactly.

**Cross-task dependencies — corrected during this review.** Tasks 1, 2, 5, 6, 7 remain independent of everything else and can run in any order/in parallel. **Task 4 now depends on Task 3 and must run after it** — both edit `_onMapClick` in `vector-map-layers.js` near the same anchor point (a dependency introduced by Task 3's redesign; noted explicitly in Task 4 above so subagent-driven-development doesn't parallelize them). Tasks 3 and 5 don't share a file but do share the same underlying map container at runtime — running their manual-verification steps together at the end, rather than in isolation, is more likely to catch any interaction between the two independent pipelines (`VectorMapLayers`' extended one and `FisbWeatherDisplay`'s own) that remain after Task 3's redesign collapsed what would have been three down to two.
