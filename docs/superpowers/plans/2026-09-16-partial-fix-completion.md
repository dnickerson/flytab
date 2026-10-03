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
- Modify: `web/app.js:1459-1528` (`_syncAircraftToPi`), `web/app.js:1263` (call site — add `await`)
- Test: `tests/shared/sync-aircraft-to-pi.test.js` (new)

**Interfaces:**
- Consumes: `CockpitConfig._diffAgainstBundle(saved, bundle)` (existing static method, `web/shared/cockpit-config.js:238-252`) — unchanged signature, already proven by the other two shadowing-fix vectors.
- Produces: no new exports. `_syncAircraftToPi` keeps its existing signature; its caller now `await`s it (previously fire-and-forget).

**Context:** `_syncAircraftToPi` currently builds a `merged` object (existing fields spread + selective Supabase-sourced overwrites), writes the **entire** `merged` object to `localStorage['flypi_cfg_aircraft_config_json']`, and sets `CockpitConfig._aircraft = merged` directly — with no diffing against the bundled default anywhere. This is a third, independent shadowing vector distinct from the two already-fixed ones (which both write to the separate `flypi_user_aircraft` key via `_diffAgainstBundle`).

**Redesigned twice during plan review — read this before implementing, both earlier drafts had real bugs.**

*First draft's bug:* it tried to fix this by diffing `merged` against a fresh bundle and persisting *that diff* to `flypi_cfg_aircraft_config_json` — the same key `_syncAircraftToPi` also *reads* from (as `existing`) at the start of every call. That creates a progressive data-loss bug: after the first sync, `flypi_cfg_aircraft_config_json` holds a partial diff instead of a full snapshot; the *next* sync reads that partial diff as `existing`, builds `merged` from it, and silently drops any field that matched the bundle last time — including from `CockpitConfig._aircraft` (still set to this now-incomplete `merged`). A pilot who syncs twice could end up with `CockpitConfig.aircraft('performance.cruise_speed_kt')` silently falling through to the generic `AIRCRAFT_DEFAULTS` placeholder (120kt) instead of the real aircraft's value (140kt) — a real, safety-relevant regression, and none of the first draft's tests caught it because they only called `_syncAircraftToPi` once each.

*The actual fix does not touch `flypi_cfg_aircraft_config_json`'s read or write at all* — leave `existing` (read) and the full-`merged` persist (write) to that key exactly as they are today; that key's round-trip already works and isn't worth risking. Instead, **also** write a bundle-diffed override to `flypi_user_aircraft` — the key `CockpitConfig.load()`/`_mergeUserOverrides` already read on every future app startup. That's what actually closes #112 for this vector: a later bundle update (e.g. corrected aircraft specs shipped in an app update) will no longer be permanently shadowed by a stale synced value, because the *next full app load* recomputes the effective aircraft config by merging this diff onto the (possibly-updated) bundle — while today's in-session behavior and the existing cache round-trip are both left completely alone.

**Where the pristine bundle comes from:** `config-editor.js._load()` (lines 37-69) already solves this exact problem — a fresh `fetch('aircraft-config.json', { signal: AbortSignal.timeout(3000) })` every time, with a comment explicitly noting it's the pristine bundle "#112" needs to diff against. Use the identical pattern here.

**Confirmed during plan review, not left as an open question:** `_syncAircraftToPi` is already `async` (`web/app.js:1459`) with zero internal `await`s today, which is why its call site (`web/app.js:1263`, inside `_applyPlan`) doesn't currently await it — the call completes same-tick regardless. Adding a real `await fetch(...)` inside it means that's no longer true: `CockpitConfig._aircraft` assignment (unchanged, still happens synchronously within the method) and this task's new `flypi_user_aircraft` write would now land up to 3 seconds after `_applyPlan` continues to its next line (`this.routeTable.loadPlan(normalized)`, which reads `CockpitConfig.aircraft(...)` for leg time/fuel). `_applyPlan` is itself already awaited by its own callers (`web/app.js:1065,1124`), so add `await` at the `web/app.js:1263` call site — cheap, and removes what would otherwise be a real stale-data-on-first-render bug.

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
// app.js has executable top-level code after the class (instantiates a real
// FlyTabApp, sets window.app/window.onerror, registers a DOMContentLoaded
// listener) — loading the whole file would run that for real as a side
// effect. Truncate at the class's end (confirmed during plan review: the
// instantiation starts with `const app = new FlyTabApp()`) so only the
// class definition itself is evaluated.
const appJsFull = read('web/app.js');
const appJsClassOnly = appJsFull.split('\nconst app = new FlyTabApp()')[0];
const FlyTabApp = new Function(appJsClassOnly + '\nreturn FlyTabApp;')();

describe('_syncAircraftToPi diffs against bundle without corrupting the round-trip', () => {
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

    it('writes a bundle-diffed override to flypi_user_aircraft', async () => {
        const bundle = { id: 'N194JT', performance: { cruise_speed_kt: 140, cruise_gph: 9.5 } };
        mockBundleFetch(bundle);

        const supaPerf = { cruise_speed_kt: 148 }; // genuinely differs from bundle
        await app._syncAircraftToPi({ id: 'N194JT', performance: supaPerf });

        const override = JSON.parse(localStorage.getItem('flypi_user_aircraft') || 'null');
        expect(override.performance.cruise_speed_kt).toBe(148);
    });

    it('does not write a field to the override that ends up matching the bundle', async () => {
        const bundle = { id: 'N194JT', performance: { cruise_speed_kt: 140 } };
        mockBundleFetch(bundle);

        await app._syncAircraftToPi({ id: 'N194JT', performance: { cruise_speed_kt: 140 } }); // matches bundle

        const override = JSON.parse(localStorage.getItem('flypi_user_aircraft') || 'null');
        expect(override?.performance?.cruise_speed_kt).toBeUndefined();
    });

    it('regression guard: flypi_cfg_aircraft_config_json still holds a full snapshot after two syncs, not a progressively-shrinking diff', async () => {
        // This is the exact bug an earlier draft of this fix introduced —
        // diffing what gets written to flypi_cfg_aircraft_config_json itself,
        // which is also this method's own read-back source, silently dropped
        // fields on the second call. The real fix never changes that key at
        // all; this test exists to keep it that way.
        const bundle = { id: 'N194JT', performance: { cruise_speed_kt: 140, cruise_gph: 9.5 } };
        mockBundleFetch(bundle);

        await app._syncAircraftToPi({ id: 'N194JT', performance: { cruise_speed_kt: 140, cruise_gph: 9.5 } });
        await app._syncAircraftToPi({ id: 'N194JT', performance: { cruise_speed_kt: 140, cruise_gph: 9.5 } });

        const snapshot = JSON.parse(localStorage.getItem('flypi_cfg_aircraft_config_json'));
        expect(snapshot.performance.cruise_speed_kt).toBe(140);
        expect(snapshot.performance.cruise_gph).toBe(9.5);
        expect(CockpitConfig._aircraft.performance.cruise_speed_kt).toBe(140);
    });

    it('fails open — skips the override write if the bundle fetch fails, does not throw', async () => {
        globalThis.fetch = async () => { throw new Error('offline'); };

        await expect(app._syncAircraftToPi({ id: 'N194JT', performance: { cruise_speed_kt: 148 } })).resolves.not.toThrow();
        const snapshot = JSON.parse(localStorage.getItem('flypi_cfg_aircraft_config_json'));
        expect(snapshot.performance.cruise_speed_kt).toBe(148); // existing persist behavior, unchanged
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/sync-aircraft-to-pi.test.js`
Expected: FAIL — today's code never fetches a bundle or writes `flypi_user_aircraft` at all; the first two tests fail on a null/missing override.

- [ ] **Step 3: Write minimal implementation**

Read the current full body of `_syncAircraftToPi` (`web/app.js:1459-1528`) before editing. Leave the existing `existing`/`merged` construction, the `flypi_cfg_aircraft_config_json` read and write, and the `CockpitConfig._aircraft = merged` assignment **completely untouched** — do not diff what's read from or written to that key (see the data-loss correction above). Note the real persist block is a `try`/`catch` around `setItem` and a braced `if`, not two bare lines — read it as it actually is rather than assuming a specific literal form to replace. Add new code **after** that existing persist block, before the method ends:

```js
let bundle = {};
try {
    const bundleResp = await fetch('aircraft-config.json', { signal: AbortSignal.timeout(3000) });
    if (bundleResp.ok) bundle = await bundleResp.json();
} catch { /* offline/timeout — skip the override write this cycle, try again next sync */ }
if (Object.keys(bundle).length && typeof CockpitConfig !== 'undefined') {
    const override = CockpitConfig._diffAgainstBundle(merged, bundle);
    localStorage.setItem('flypi_user_aircraft', JSON.stringify(override));
}
```

This mirrors `config-editor.js._load()`'s exact fetch pattern (same URL, same timeout) and writes to the same key `CockpitConfig.load()`/`_mergeUserOverrides` already read on every future app startup — no new storage key, no `flypi_`-prefix conflict.

At `web/app.js:1263`, change `this._syncAircraftToPi(plan.aircraft);` to `await this._syncAircraftToPi(plan.aircraft);` (per the confirmed synchronous-order dependency above — `_applyPlan`'s own callers already await it, so this is safe).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/sync-aircraft-to-pi.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/app.js tests/shared/sync-aircraft-to-pi.test.js
git commit -m "fix(#112): persist a bundle-diffed aircraft override from _syncAircraftToPi"
```

---

## Task 2: Add "revert to bundled default" UI to config-editor.js (closes #112, part B)

**Files:**
- Modify: `web/cockpit/config-editor.js` (constructor ~6-15, `_render()` ~71-361, `_save()` ~428-534)
- Test: `tests/cockpit/config-editor-revert.test.js` (new)

**Interfaces:**
- Consumes: `CockpitConfig._diffAgainstBundle` (existing, unchanged).
- Produces: no new public API — this is a self-contained UI addition to an existing panel.

**Context:** The existing RELOAD button (`.ce-reload-btn`) just re-fetches and re-merges — since `_load()` re-applies stored overrides on top of the bundle, RELOAD does **not** clear an override; it just redisplays bundle+override. This task adds a per-field "revert" affordance.

**Correction, caught in plan review:** an earlier draft claimed no revert-to-default UI exists anywhere in this repo — that's wrong. `web/cockpit/layer-panel.js` has a real `_resetToDefaults()` (confirm-dialog UX, button greys out when there's nothing to reset — around line 746, wired ~455-458) and `web/cockpit/tab-bar.js` has "Reset all adapted thresholds" confirm-dialogs. Neither is per-field (both reset a whole panel/model at once), so the actual gap this task closes — per-field revert — is still real, but `layer-panel.js`'s `_resetToDefaults()` is a closer UX precedent to look at (confirm-dialog pattern, disabled/greyed state when nothing to reset) than building from nothing.

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
        // flightUpload/homeServer-style fields: _diffAgainstBundle's own doc comment
        // says these are "always kept" since there's nothing bundled to compare
        // against. Reverting one must leave it alone, not null it out.
        editor._cockpitConfig.flightUpload = { host: '192.168.1.50' };
        // _cockpitBundle has no flightUpload key at all.
        editor._revertField('cockpit', 'flightUpload.host');
        expect(editor._cockpitConfig.flightUpload.host).toBe('192.168.1.50');
    });

    it('does not throw if config does not mirror the bundle shape at an intermediate path', () => {
        // _revertField is normally only called for paths _render() itself drew a
        // button for, which guarantees the intermediate objects exist — but
        // defend against a mismatched/hand-constructed case anyway rather than
        // assume that invariant always holds.
        editor._aircraftConfig = {}; // no `performance` object at all
        expect(() => editor._revertField('aircraft', 'performance.cruise_speed_kt')).not.toThrow();
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
    for (let i = 0; i < keys.length - 1; i++) {
        // Defensive: _render() only ever offers this path when the config
        // mirrors the bundle shape, but don't assume that invariant holds —
        // bail rather than throw if an intermediate object is missing.
        if (node == null || typeof node !== 'object') return;
        node = node[keys[i]];
    }
    if (node == null || typeof node !== 'object') return;
    node[keys[keys.length - 1]] = bundleNode;
}
```

Then wire a revert control per rendered field inside `_render()` (`web/cockpit/config-editor.js:71-366`). Read the existing field-rendering loop first to match its structure exactly (this plan doesn't assume the loop's precise variable names — implementer fills in the per-field revert button using whatever loop variable currently identifies the field's scope and dotted path, calling `this._revertField(scope, path)` on tap). The existing per-input change-handler (`config-editor.js:357-360`) only sets `this._dirty = true` — it does not re-render, so there is no existing render call to reuse. After calling `_revertField`, explicitly call `this._render()` to reflect the reverted value (confirm `_render()` is safe to call standalone, i.e. it doesn't redo the `_load()`/fetch cycle — it shouldn't, since `_load()` and `_render()` are already separate methods). Show the button only when **both** (a) the bundle actually has a defined value at that path (same traversal `_revertField` does — if `bundleNode === undefined`, don't show the button at all, matching the guard above) **and** (b) the field's current value differs from its bundled value (reuse `CockpitConfig._diffAgainstBundle({[lastKey]: node[lastKey]}, {[lastKey]: bundleNode})` returning a non-empty object as the "is overridden" check, or a simpler direct `!==`/`JSON.stringify` comparison — either is correct; pick whichever matches the surrounding render loop's existing style most closely).

Follow this repo's Design Token Standards for the button: `min-height: var(--touch-min, 56px)`; no hardcoded hex colors; the button's visible label text must use `font-weight: 700` or higher (CLAUDE.md: "Never use font-weight: 600 or lower in cockpit UI"), `var(--font-ui)`; light theme only, do not set `data-mode="cockpit"` on anything this task touches.

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
- **TFR shapes** (`this._tfrShapes`, a `Map` keyed by `notam.raw`, populated by `_addTfrShape`, `map.js:642-699`) — **mixed** shape types: `L.polygon` when `notam.points?.length >= 3`, `L.circle` when a radius is known, `L.marker` otherwise. Each needs its own hit-test: polygon → ray-cast via the existing `FisbWeatherDisplay._pointInPolygon` (`fisb-weather.js:420`), called directly rather than duplicated locally (see the reuse note in Step 3 — this repo already has 3 copies of this algorithm on `main`, no need for a 4th); circle → exact geo-distance (`shape.getLatLng().distanceTo(tapLatLng) <= shape.getRadius()`, both in meters, zoom-invariant and exact — no pixel approximation needed); marker → pixel-distance, same as route waypoints.
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

    it('reuses FisbWeatherDisplay._pointInPolygon rather than defining a local copy', () => {
        expect(MAP_SRC).toMatch(/FisbWeatherDisplay\._pointInPolygon\s*\(/);
        expect(MAP_SRC).not.toMatch(/static _pointInPolygon/);
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
            // confirmed against the vendored build during plan review.
            const ring = shape.getLatLngs()[0];
            const pts = ring.map(ll => [ll.lat, ll.lng]);
            if (FisbWeatherDisplay._pointInPolygon(latlng.lat, latlng.lng, pts)) { shape.openPopup(); return true; }
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
```

No `_pointInPolygon` helper defined here — this calls the existing `FisbWeatherDisplay._pointInPolygon` (`fisb-weather.js:420`) directly. Caught in plan review: this repo already has 3 independent copies of this exact ~10-line ray-cast algorithm on `main` (`route-table.js`, `wx-briefing.js`, `fisb-weather.js`) — adding a 4th here (and a 5th in Task 4) would make a future bugfix to the algorithm a 5-file change instead of 1, and works against the still-open PR #145 (`airspace-frequency-alert-runtime`), whose own stated purpose is consolidating those exact 3 copies into a shared `geo-utils.js`. Calling the existing `fisb-weather.js` copy directly avoids adding to that pile without waiting on `geo-utils.js` to land.

Note on the route-waypoint branch: it calls `wp.fire('click')` (the marker itself, since `_wpMarkers` is a plain array of markers, not `{marker}` wrapper objects) rather than duplicating the existing click handler's logic, so the one real behavior (opening the airport popup, `map.js:1408-1411`) stays defined in exactly one place. `L.Marker`/`L.CircleMarker`'s `.fire('click')` invoking a handler registered via `.on('click', ...)` is confirmed standard Leaflet event-emitter behavior (verified against the vendored build during plan review).

**Known limitation, surfaced during plan review — not fixed here, scope stays narrow to what #52 asked for.** `_routeIcaos` (`vector-map-layers.js:1221`) only suppresses a route waypoint's *tooltip label* when it coincides with a real airport/navaid/fix, not the underlying marker itself — so for a departure/destination waypoint (the common case), the pre-existing 30px/60px marker-hit passes in `_onMapClick` catch it *before* reaching this task's new `_onOtherLayerTap` check, and the airport popup opens via that older path instead. The new dispatch only actually gets exercised for waypoints that aren't independently rendered as their own marker (e.g. filtered out at the current zoom). The end result a pilot sees is the same either way (airport popup opens), so this isn't a user-facing bug — but it does mean Step 5's manual check #1 below needs to specifically target a waypoint that *isn't* also an independently-rendered marker, or it will pass without ever touching the new code. Separately, and out of scope for #52: the route-waypoint's own click handler (`map.js:1408-1413`) always shows the airport popup, with no check for `routeTable?.isEditing()` the way the normal airport-marker tap path has (`app.js:478-485`) — that inconsistency predates this task and isn't something #52 (a tap-*reliability* issue, not a tap-*behavior* issue) asks to reconcile.

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
1. Load a route with at least 2 waypoints; tap a route waypoint marker that sits near/on a real airport/navaid marker (the common case — e.g. departure or destination) — confirm the airport popup opens, and **confirm only one popup opens, not two** (this is the specific double-fire bug an earlier draft of this task had). Note this exercises the *pre-existing* airport-marker path, not this task's new dispatch (see the known-limitation note above) — that's expected, still worth checking for the double-fire regression.
1b. Separately, tap a route waypoint that is **not** independently rendered as its own airport/navaid/fix marker (e.g. zoom out until the underlying marker would be filtered out, or use an enroute fix-type waypoint) — confirm the airport popup still opens. This is the case that actually exercises the new `_handleLayerTap`/`wp.fire('click')` code path; 1 alone would not catch a bug specific to it.
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
- Consumes: `this._suaPolygons` — **not purely polygons, caught in plan review.** This `Map` also stores altitude-label `L.marker` instances under a `sua.id + '_lbl'` key (`vector-map-layers.js:1115`); existing cleanup code (line 1120) explicitly strips the `_lbl` suffix to tell the two apart. A loop over `.values()` that assumes every entry is a polygon will hit a label marker and crash (`L.Marker` has no `getLatLngs()`) — see Step 3.
- Produces: nothing new externally — extends the existing `_onMapClick` dispatch that `VectorMapLayers` already owns (no new listener needed; this class already has a working touchstart/touchend pipeline, per its constructor lines 109-143).

**Context:** `VectorMapLayers` already runs a two-pass hit-test (`_findNearestMarker` at 30px, then 60px) inside `_onMapClick` before falling through to `_onTrafficTap`. SUA polygons currently just call `polygon.bindPopup(popupHtml, ...)` (`vector-map-layers.js:1084`) with no tap wiring at all. Add a SUA ray-cast check to the same dispatch chain. Reuses `FisbWeatherDisplay._pointInPolygon` directly rather than defining another local copy — caught in plan review that this repo already has 3 independent copies of the same ~10-line ray-cast algorithm on `main` (`route-table.js`, `wx-briefing.js`, `fisb-weather.js`); Task 3 was about to add a 4th and this task a 5th. Calling the existing one is a plain cross-class static-method call, safe regardless of `<script>` load order since it only executes at tap-time, well after every script has loaded.

**Depends on Task 3 — do not run in parallel.** After Task 3's redesign, both tasks now edit `_onMapClick` in the same file near the same anchor. Run Task 3 first.

**Ordering, corrected during plan review — this is NOT functionally neutral, contrary to an earlier draft's claim.** SUA polygons are large-area (MOAs, restricted areas) and frequently overlap smaller, more specific targets — a TFR, a PIREP, or a route waypoint routinely sits inside one. Checking SUA *first* means a tap on that more specific target gets swallowed by the broad SUA check before it ever reaches Task 3's dispatch, silently denying the pilot the popup they actually meant to tap (e.g. a TFR issued inside a MOA becomes untappable the whole time both layers are visible). The SUA check must run **after** Task 3's `_onOtherLayerTap` check, not before — insert it immediately after that line (right before the `_onTrafficTap` fallback), not before it.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/vector-map-layers-sua-tap.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SRC = readFileSync('web/cockpit/vector-map-layers.js', 'utf8');

describe('VectorMapLayers SUA polygon tap dispatch', () => {
    it('_onMapClick checks SUA polygons after the route/TFR/PIREP check, before traffic', () => {
        const onMapClickStart = SRC.indexOf('_onMapClick(');
        const otherLayerCheck = SRC.indexOf('_onOtherLayerTap', onMapClickStart);
        const onTrafficTapCall = SRC.indexOf('this._onTrafficTap(pt)');
        const suaCheck = SRC.indexOf('_suaPolygons', otherLayerCheck);
        // Order matters (caught in plan review): SUA is a broad-area check that
        // must not run before the more specific route/TFR/PIREP dispatch, or it
        // silently swallows taps on anything smaller sitting inside a SUA shape.
        expect(suaCheck).toBeGreaterThan(otherLayerCheck);
        expect(suaCheck).toBeLessThan(onTrafficTapCall);
    });

    it('skips non-polygon entries in _suaPolygons (label markers) rather than assuming every value is a polygon', () => {
        const suaLoopStart = SRC.indexOf('_suaPolygons.values()');
        const loopBody = SRC.slice(suaLoopStart, suaLoopStart + 300);
        expect(loopBody).toMatch(/instanceof L\.Polygon/);
    });

    it('reuses FisbWeatherDisplay._pointInPolygon rather than adding another local copy', () => {
        expect(SRC).toMatch(/FisbWeatherDisplay\._pointInPolygon\s*\(/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/vector-map-layers-sua-tap.test.js`
Expected: FAIL — no `_suaPolygons` reference inside `_onMapClick` today, no `FisbWeatherDisplay._pointInPolygon` call in this file.

- [ ] **Step 3: Write minimal implementation**

Read `_onMapClick` in full before editing — it now includes Task 3's `_onOtherLayerTap` check (confirm this is present; if it isn't, Task 3 hasn't landed yet and must go first). Add, immediately **after** that check (between it and the `_onTrafficTap` fallback — see the ordering correction above):

```js
for (const polygon of this._suaPolygons.values()) {
    if (!(polygon instanceof L.Polygon)) continue; // this Map also holds altitude-label markers, not just polygons
    const latlngs = polygon.getLatLngs()[0]; // Leaflet nests polygon rings — confirmed against the vendored build during plan review
    const pts = latlngs.map(ll => [ll.lat, ll.lng]);
    if (FisbWeatherDisplay._pointInPolygon(e.latlng.lat, e.latlng.lng, pts)) {
        polygon.openPopup();
        return;
    }
}
```

No new helper method needed — this calls the existing `FisbWeatherDisplay._pointInPolygon` (`fisb-weather.js:420`) directly rather than adding another duplicate.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cockpit/vector-map-layers-sua-tap.test.js`
Expected: PASS

- [ ] **Step 5: Required manual on-device verification**

Enable the SUA layer (off by default per `cockpit-config.json`). Tap inside a rendered SUA polygon — confirm its popup opens. Tap on the SUA's altitude-label text specifically (not the polygon fill) — confirm no crash (this is the label-marker guard from Step 3; catching it here means the `instanceof` check is missing or wrong). If a TFR or PIREP is available inside the SUA's boundary, tap it — confirm the TFR/PIREP popup opens, not the SUA's (the ordering fix above). Tap outside it, and confirm normal airport/navaid/fix taps still work unaffected (this shares the existing pipeline, so a regression here would be more consequential than Task 3's new one — test airport tap explicitly, per CLAUDE.md's Tap Handler Regression Rule).

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

**Correction to Step 3, made during plan review — this is a full method restructure, not an insertion.** The original draft of this task misread the real control flow. `_handleAdvisoryTap`'s actual body is two early-return guard clauses, not an if-block:
```js
_handleAdvisoryTap(clientX, clientY) {
    const allPolygons = [...this._sigmetPolygons, ...];
    if (!allPolygons.length) return;                    // returns BEFORE rect/latlng are even computed
    const rect = this._map.getContainer().getBoundingClientRect();
    const latlng = this._map.containerPointToLatLng(...);
    const hits = allPolygons.filter(...);
    if (!hits.length) return;                            // returns BEFORE _openAdvisoryPopup
    this._openAdvisoryPopup(hits, clientX, clientY);
}
```
Appending marker-check code "after the `if (hits.length) {...}` line" (the original instruction) doesn't work: whenever `allPolygons` is empty — the common case, since wind/PIREP/NOTAM markers routinely exist with no SIGMET/AIRMET/CWA anywhere nearby — the method already returned at the first guard, before the appended code could ever run. And whenever a polygon *is* hit, the appended code would run unconditionally right after `_openAdvisoryPopup(...)`, opening a second, possibly conflicting marker popup on top of the one just opened. The fix needs `rect`/`containerPt`/`latlng` computed unconditionally up front, and the marker checks placed where the method would otherwise fall through with nothing to show — not appended after a line that doesn't reliably run.

- [ ] **Step 1: Write the failing test**

```js
// tests/cockpit/fisb-weather-marker-tap.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const SRC = readFileSync('web/cockpit/fisb-weather.js', 'utf8');

describe('FisbWeatherDisplay marker tap dispatch', () => {
    const methodStart = SRC.indexOf('_handleAdvisoryTap(');
    const methodBody = SRC.slice(methodStart, methodStart + 2500);

    it('_handleAdvisoryTap also checks wind/PIREP/NOTAM markers', () => {
        expect(methodBody).toMatch(/_windMarkers/);
        expect(methodBody).toMatch(/_pirepMarkers/);
        expect(methodBody).toMatch(/_notamMarkers/);
    });

    it('marker checks are reachable when there are no polygons at all — regression guard for the control-flow bug caught in plan review', () => {
        // The original draft appended marker code after a line that only ran
        // when a polygon WAS hit, making it unreachable whenever allPolygons
        // was empty (the common case). Guard against that regressing: the
        // rect/containerPt/latlng computation must not be gated behind an
        // early return on allPolygons.length.
        const guardIdx = methodBody.indexOf('allPolygons.length');
        const rectIdx = methodBody.indexOf('getBoundingClientRect');
        expect(rectIdx).toBeGreaterThan(-1);
        expect(rectIdx).toBeLessThan(guardIdx === -1 ? Infinity : guardIdx);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cockpit/fisb-weather-marker-tap.test.js`
Expected: FAIL — `_handleAdvisoryTap` today only references polygon collections.

- [ ] **Step 3: Write minimal implementation**

Read `_handleAdvisoryTap` in full (`fisb-weather.js:387-417`) before editing — this is a full replacement of the method body, not an insertion, per the correction above. Replace the entire method with:

```js
_handleAdvisoryTap(clientX, clientY) {
    const rect = this._map.getContainer().getBoundingClientRect();
    const containerPt = L.point(clientX - rect.left, clientY - rect.top);
    const latlng = this._map.containerPointToLatLng(containerPt);

    const allPolygons = [...this._sigmetPolygons, ...this._airmetPolygons.filter(e => !e.isLine && e.layer && this._map.hasLayer(e.layer)), ...this._cwaPolygons];
    const hits = allPolygons.length
        ? allPolygons.filter(entry => entry.advisory?.points?.length >= 3 &&
            FisbWeatherDisplay._pointInPolygon(latlng.lat, latlng.lng, entry.advisory.points))
        : [];
    if (hits.length) {
        this._openAdvisoryPopup(hits, clientX, clientY);
        return;
    }

    // No polygon hit (or none exist) — fall through to markers. Polygon
    // takes priority when both are hit at the same point, matching the
    // method's pre-existing behavior for polygons alone.
    const markerHit = (collection) => {
        let best = null, bestDist = 30;
        for (const entry of collection instanceof Map ? collection.values() : collection) {
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
}
```

The `allPolygons`/`hits` computation and the `_pointInPolygon`/`_openAdvisoryPopup` calls are unchanged from the original method — only the control flow around them changed (guard clauses replaced with an explicit `if (hits.length) { ...; return; }`, and marker checks now genuinely reachable in the fallthrough case instead of appended after a line that doesn't always execute).

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

## Task 6: NASR-readiness guard in route-table.js's paste-route-string path (closes the live descendant of #10)

**Scope honesty, caught in plan review:** issue #10's literal repro — a `"Could not find fix: {id}"` message from a `lookupFix()` function in a "Calculate" flow — no longer exists anywhere in the current codebase (confirmed via grep: zero hits for either string). The app has been refactored since #10 was filed; `route-planner-panel.js`'s `_onAddTap` already carries its own NASR guard independently. This task closes the one remaining path found during the issue-sweep that reproduces the *same class* of bug (a misleading "not found" message when the real cause is NASR not being loaded yet), not the issue's original literal repro. Worth citing this distinction in the closing comment rather than claiming a precise 1:1 fix.

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
        // _parseRouteString unconditionally calls this._resultsEl.querySelector(...)
        // (route-table.js:979) regardless of whether anything resolved — stub it,
        // or the test crashes on that call before the guard logic is ever reached.
        table._resultsEl = { innerHTML: '', querySelector: () => null };
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
git commit -m "fix: guard route-table paste-string parsing against NASR not yet loaded (#10 descendant)"
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

**Review pass 1 (after initial draft):** ran `/code-review` against this document. Found and fixed 6 problems: Task 3's original design double-listened on the same container as `VectorMapLayers` (redesigned to extend its existing pipeline via a callback instead); Task 6's guard bypassed the existing NASR-load retry (moved to only affect the final message); Task 1's fix was a no-op that also would have violated the plan's own `flypi_`-prefix rule (redesigned to reuse `config-editor.js`'s fetch pattern); Task 2's revert could blank device-specific fields (guarded).

**Review pass 2 (independent re-review, multiple parallel verification agents against real source):** found substantially more, including issues introduced *by* pass 1's fixes. All fixed in place:
- **Task 5 — critical control-flow bug.** The original Step 3 misread `_handleAdvisoryTap`'s real structure (two early-return guard clauses, not an if-block) — the marker-check code would have been unreachable whenever no polygon advisories existed (the common case) and would have caused a double-popup when a polygon *was* hit. Fixed with a full method restructure, not an insertion.
- **Task 1 — critical, worse than pass 1's fix.** Diffing what gets *written* to `flypi_cfg_aircraft_config_json` — while that same key is also this method's own *read* source on the next call — creates progressive data loss: a field that matched the bundle on sync N silently disappears from both the persisted value and `CockpitConfig._aircraft` on sync N+1, falling through to generic hardcoded defaults instead of the real aircraft's numbers. Redesigned again: that key's read and write are now left completely untouched; the fix instead additionally writes a bundle-diffed override to `flypi_user_aircraft`, the key `CockpitConfig.load()` already consults on next startup, which is what actually closes #112's cross-session shadowing without touching a working round-trip.
- **Task 1 — missing `await`.** Confirmed `_syncAircraftToPi` is already `async` with no internal awaits (so its unawaited call site currently completes same-tick); adding a real `await fetch(...)` inside it without also awaiting the call site would let `_applyPlan` continue to `routeTable.loadPlan()` against stale aircraft config. Added `await` at the call site — safe, since `_applyPlan`'s own callers already await it.
- **Task 4 — confirmed crash bug.** `_suaPolygons` also stores altitude-label `L.marker` instances under `id + '_lbl'` keys, not just polygons; the original loop would call `.getLatLngs()` on a marker (no such method) the first time any SUA rendered. Fixed with an `instanceof L.Polygon` guard.
- **Task 3 + Task 4 — wrong check ordering.** The original ordering put Task 4's broad-area SUA check *before* Task 3's more specific route/TFR/PIREP check, meaning a tap on a TFR or PIREP sitting inside a SUA polygon (common — MOAs and restricted areas are large) would always yield the SUA popup instead. Swapped: specific targets now checked first, SUA last (still before traffic).
- **Reuse — this repo already has 3 copies of the `_pointInPolygon` ray-cast algorithm on `main`** (`route-table.js`, `wx-briefing.js`, `fisb-weather.js`), and pass 1's Tasks 3/4 were each about to add a 4th/5th duplicate — directly working against the still-open PR #145, whose own purpose is consolidating those exact 3 copies. Both tasks now call `FisbWeatherDisplay._pointInPolygon` directly instead.
- **Task 2 — false claims corrected.** "No revert-to-default UI exists anywhere" was wrong (`layer-panel.js._resetToDefaults()` is a real, closer precedent, now cited); the instruction to "reuse the existing render call" pointed at a change-handler that only sets a dirty flag and never re-renders (now calls `this._render()` explicitly); `_revertField` gained a defensive guard against a config object that doesn't mirror the bundle's shape.
- **Task 1's test — false claim about `new Function(read('web/app.js'))` safety.** `app.js` has real executable top-level code after the class (instantiates `FlyTabApp`, sets `window.app`) that does run, contrary to the original comment's reasoning — it happened not to break the test, but for the wrong reason. Test now truncates the source at the class boundary instead of relying on that being harmless.
- **Task 6's test — scaffolding bug.** `_parseRouteString` unconditionally calls `this._resultsEl.querySelector(...)`; the test's `_resultsEl` mock had no such method and would have crashed before the real assertions ran. Added the stub.
- **Task 6 — scope-honesty correction.** #10's literal repro (`"Could not find fix"`, `lookupFix()`) no longer exists in the codebase at all; this task closes an analogous-but-distinct gap found during the issue-sweep, not the issue's original repro verbatim — now stated plainly rather than claimed as an exact match.

**Not fixed here — surfaced for your decision instead, per the standing instruction to flag overlapping unmerged work before touching main:** review pass 2 found that **PR #145** (`airspace-frequency-alert-runtime`, open) directly overlaps Tasks 3, 4, 5, and 6's target code, not just the `geo-utils.js` file already discussed above. Its commit `9805a2c` deletes the local `_pointInPolygon` copies from `fisb-weather.js` and `route-table.js` (the same methods this plan now calls into or edits) and edits `vector-map-layers.js`'s touchstart handler (adding an `.airspace-alert-popup` closest-check next to the one this plan's Task 3 relies on). If #145 merges before or during this plan's execution, Tasks 3-6 will hit direct merge conflicts on `_pointInPolygon`, `_onMapClick`, and `_handleAdvisoryTap`. This plan does not decide whether to wait for #145, rebase onto it, or proceed and accept conflict-resolution risk — that's a sequencing call this document can't make on its own. Separately: `web/app.js`'s `FLYTAB_VERSION` bump (`v10.47`→`v10.57`) is currently uncommitted on `main` — per CLAUDE.md's "Worktree version drift" section, commit that first if executing this plan from a worktree.

**Spec coverage:** All 5 issues covered — #112 (Tasks 1-2), #52 (Task 3), #53 (Tasks 3-5, all 6 flagged spots), #10-descendant (Task 6), #104 (Task 7).

**Placeholder scan:** No TBD/TODO markers remain that weren't resolved to verified fact during the two review passes.

**Type consistency:** `FisbWeatherDisplay._pointInPolygon(lat, lon, points)` is now the single implementation Tasks 3 and 4 both call — signature and behavior confirmed identical to what Task 5 continues to use in place. `VectorMapLayers._onOtherLayerTap(containerPt, latlng)`'s signature and truthy-return contract (Task 3) matches how it's called in `_onMapClick` and implemented in `CockpitMap._handleLayerTap` exactly.

**Cross-task dependencies.** Tasks 1, 2, 5, 6, 7 remain independent and can run in any order/in parallel. **Task 4 depends on Task 3 and must run after it** — both edit `_onMapClick` in `vector-map-layers.js` near the same anchor point. Tasks 3 and 5 don't share a file but do share the same map container at runtime — run their manual-verification steps together at the end rather than in isolation.
