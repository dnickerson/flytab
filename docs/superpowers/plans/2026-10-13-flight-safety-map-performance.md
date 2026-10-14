# Flight safety + map performance — task list

Created 2026-10-13 from two code reviews plus on-device evidence (usagestats, DiagLog,
logcat, dumpsys) for the KCDN→KLKR flight. Work through it in order. Tick each box only
when its **Verify** step has passed with evidence. Don't skip the verify steps.

Every task follows the same rules:
- Write a failing test first (or a measurement for perf work).
- Then make the change, then pass the test.
- Never rename a `flypi_*` key or store without a migration (CLAUDE.md).
- Before each PR: run `npm test` and the JUnit suite, bump `FLYTAB_VERSION`, run `build.sh`,
  do a critical code review, and update the user manual if anything user-visible changed.

---

## Phase 0 — Before starting

- [x] **0.1 Decide the base branch.** Done 2026-10-13. Merged in order:
  - #169 → `0bbf450`
  - #170 → `756674c` (`main` merged in, version kept at v11.4)
  - #171 → `b830263` (retargeted to `main` via the REST API, `main` merged in, kept at v11.7)

  PR A starts on `fix/flight-safety` from `main` at `b830263`.
  - **Baseline on `main` after the merges:**
    - vitest 1432/1432, JUnit 14/14.
    - Playwright (components + smoke): **51 failed / 2 passed**. That's identical to `main`
      before the merges (`6854771`): same 51 tests, none new, none fixed. The list is at the end.
  - **Versions:** `main` is v11.7 (versionCode 1107). The combined test build was v11.8 (1108).
    The next build must be **v11.9 or later**, or the tablet refuses it as a downgrade.
- [ ] **0.5 Find out why the Playwright suite fails** (51/53, already failing before today):
  - 29 in route-planner-panel;
  - plus engine-box, engine-panel, layer-panel, mag-heading, wx-briefing;
  - plus 6 smoke tests.

  Likely environment (home server on :3000 / :8090, fixtures), but **unverified**. Needed
  before PR B: B0 measurements and the B2 airport-tap check rely on working browser tests.
  Fixing the suite itself is a separate PR.
- [ ] **0.2 Tablet test of v11.8** (combined build `flytab-debug-v11.8.apk`), using the
  checklist from the v11.8 build message.
- [ ] **0.3 Pilot question:** does a single tap tick a checklist item reliably on the tablet?
  - In Chromium touch emulation one tap toggles twice, and `main` does the same.
  - If the tablet shows it too, add it as a separate fix.
- [ ] **0.4 Pilot action:** keep ExpressVPN disabled for flying. Until A6 lands, avoid
  switching apps in flight; use split-screen.
  - Split-screen is untested: it isn't verified that it stops the freeze.

---

## PR A — Flight safety (protect recordings and engine alerts)

- [x] **A1 Recorder must not end a flight when the pilot switches apps.** Done in v11.9: on hide it always flushes, and stops only on fresh (< 5 s) shutdown evidence. 8 tests; the 10-13 12:11:50 replay failed before the fix. vitest 1440/1440.
  - **Where:** `flight-recorder.js:83-96`. On `visibilitychange: hidden` it calls `stop()` if
    `_gapTimer`, `_rpmZeroCount`, `_gsBelowCount`, `engineOff` or `gsStopped` is set.
  - **Evidence:** the 10-13 recording ended at 12:11:52, 2 s after FlyTab was backgrounded
    during a VPN dropout, about 10 min before landing.
  - **Fix:** on hide, only flush. Decide whether the flight is over after resume, from fresh
    data only.
  - **Verify:** a test that hides during a data gap and checks the recording continues; plus
    the normal engine-off stop still works.
- [x] **A2 Recorder rename can't delete the flight file.** Done in v11.10.
  - The original is deleted only after the copy reads back identical (TileServer PUT answers 201 even when it wrote nothing).
  - An existing file is never overwritten: a second same-route flight that day gets `_2`, `_3`, ...
  - The logbook filename fallback now handles `_2`.
  - 14 tests; the 6 data-loss cases failed before the fix. vitest 1454/1454.
  - **Where:** `flight-recorder.js:397-404`. It PUTs the copy without checking `resp.ok`, then
    DELETEs the original.
  - **Fix:** check the response, compare sizes, and only then delete.
  - **Verify:** a test where the PUT returns 500 and the original is kept.
- [x] **A3 Recorder flush gets a timeout and an in-flight guard.** Done in v11.11; rename timeouts added in v11.12.
  - Each save is abandoned after 10 s (`LOCAL_TIMEOUT_MS`); its rows go back to the front of the buffer.
  - One save in flight per file (NanoHTTPD 2.3.1 runs each request on its own thread); requests meanwhile share one follow-up, so a stall doesn't pile up PUTs.
  - `stop()` now reports `flushOk=false` when the final save fails (it was always true), and can't hang on a stuck save.
  - Known trade-off: a save that wrote but answered after 10 s is repeated (duplicate rows, not lost ones).
  - 8 tests; 7 failed before the fix. vitest 1462/1462.
  - v11.12 (Dana: "add to A3 now"): the rename inside `stop()` can't hang either. Every TileServer request goes through `_local()` (10 s, body read included); the nearest-airport NASR lookups time out after 5 s (`NASR_TIMEOUT_MS`).
  - `_moveFile` never throws. Once the copy is verified, a failed or stuck delete of the original still counts as moved. Before, a throw there (or in the traffic move) made the rename report null after the CSV had already been renamed: the stopped event lost the route.
  - 6 more tests, all failed before. vitest 1468/1468.
  - **Where:** `flight-recorder.js:133-136, 335-353`. If NanoHTTPD stalls, PUTs pile up and
    re-buffered rows go out of order.
  - **Fix:** `AbortSignal.timeout`, a busy flag, and keep row order.
  - **Verify:** a test with a stalled PUT.
- [ ] **A4 Engine monitoring must not wait on the NASR database.**
  - **Where:** `app.js:478`, `await this._ensureNasrData()`, runs before EngineClient,
    StickyValve, EngineML and FlightRecorder are created. `NasrDB.open()` has no `onblocked`
    handler and no timeout; CLAUDE.md documents IDB hangs.
  - **Fix:** wire the engine, sticky-valve, ML and recorder before the NASR await. Add a
    timeout and `onblocked` to the NASR open.
  - **Verify:** a full-app boot in Chromium (where NASR stalls today) shows the engine client,
    sticky-valve and recorder present. Add a test for a hung open.
- [ ] **A5 Overheating must not let the screen time out in flight.**
  - **Where:** `app.js:1458-1463` releases the screen wake lock at surfaceTemp ≥ 50 °C.
  - **Fix:** keep the screen on while airborne, and dim instead. Check first which brightness
    API is available.
  - **Verify:** a test of the thermal branch while airborne versus on the ground.
- [ ] **A6 The pilot knows when FlyTab was paused, and it pauses less.**
  - **Evidence:** about 90 s after backgrounding, all JS stops: engine alerts, recorder and
    traffic. Seen 12:13–12:27 in flight (usagestats).
  - **Fix:**
    - (a) On resume, show a banner "FlyTab was paused N min — engine alerts and recording
      were off" and add it to the position-health history and DiagLog.
    - (b) Try `WebView.setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)` in
      `MainActivity`.
  - **Verify:** (a) a test; (b) on the tablet, background FlyTab for 3 min with ADB attached
    and check DiagLog for a "JS was suspended" line and that recorder rows keep coming. If (b)
    doesn't help, say so and keep only (a).
- [ ] **A7 The FlightService CPU wake lock never silently expires.**
  - **Where:** `FlightService.java:43` acquires it once in `onCreate` with an 8 h timeout.
  - **Fix:** re-acquire in `onStartCommand`, or renew on a schedule.
  - **Verify:** JUnit test or code-path review; check `dumpsys power` on the tablet.
- [ ] **A8 EngineML can't run two inferences on one model.**
  - **Where:** `InferenceEngine.java:270-289`. `future.cancel` can't stop a native run, and a
    new thread is started on the same Interpreter.
  - **Fix:** one persistent executor, skip the sample if busy, and disable ML after a timeout.
  - **Verify:** JUnit for the busy/skip logic. On the tablet, logcat shows inference still
    running (NNAPI line).
- [ ] **A9 Ship PR A:**
  - [ ] update the manual (A1, A5, A6 are user-visible);
  - [ ] bump the version and build;
  - [ ] critical review, then fix findings;
  - [ ] open the PR;
  - [ ] tablet test.

---

## PR B — Map performance (less work per message)

- [ ] **B0 Baseline measurement before changing anything.**
  - Run `tools/mock-stratux.py` with about 100 traffic targets and NEXRAD in sim mode
    (see reference_mock_stratux memory).
  - Record: long tasks per minute, `setIcon` calls/s, `moveend` events/s,
    `_updateDynamicLayers` calls/min, and the route-table `updateLive` rate.
  - Save the numbers in this file.
- [ ] **B1 Traffic drawn at most twice a second, only icons that changed.**
  - **Where:** `map.js:257` rebuilds every target's icon (`setIcon` → innerHTML) on every
    traffic message.
  - **Fix:** a dirty flag plus rAF/2 Hz render; cache colour, label and track per marker; cache
    `Settings.ownshipModeS` (`stratux-client.js:344`).
  - **Verify:** B0 numbers before and after; traffic popups and colours unchanged.
- [ ] **B2 Re-centre only when needed.**
  - **Where:** `map.js:1054`, an animated `panTo` on every situation (~10–12 Hz). That causes
    a `moveend` storm, a full vector redraw, NEXRAD redrawn every frame, and possibly
    debounced layers that never fire in flight.
  - **Fix:**
    - pan when ownship drifts more than about 20 px, at most 2 Hz, no animation;
    - give the debounces a max-wait (`vector-map-layers.js:82,851`, `map.js:1771`);
    - redraw NEXRAD on `move` at most once per rAF.
  - **Verify:** B0 numbers; airspace and airports refresh during a simulated flight. The
    airport popup still opens on a normal tap; that's a manual check (tap-handler rule,
    CLAUDE.md).
- [ ] **B3 The route table updates at most once a second, only when visible.**
  - **Where:** `app.js:710-714` → `routeTable.updateLive` and `_checkFuelStopProximity` on
    every situation message.
  - **Fix:** throttle, skip when collapsed, and compare cached cell strings instead of reading
    `innerHTML`.
  - **Verify:** the route-table tests still pass; B0 numbers.
- [ ] **B4 Track log stored per flight, appended, not rewritten.**
  - **Where:** `track-log.js` rewrites about 400 KB to localStorage every 10 s; `reset()` is
    never called.
  - **Fix:** per-flight IndexedDB, append-only, and `addLatLng` on the map.
  - **Must:** migrate the existing `flypi_track` data (dual-read), and don't drop the old key.
  - **Verify:** migration test; the track survives an app restart.
- [ ] **B5 Smaller items.**
  - [ ] Skip non-FIS-B `/jsonio` messages before `JSON.parse` (`stratux-client.js:589`).
  - [ ] DiagLog: buffer in memory, save to localStorage at most every few seconds, and raise
    the cap. The 10-13 dropouts pushed the earlier flight out of the 200 entries.
  - [ ] Cache convective clustering per snapshot (`convective-intelligence.js:507`).
- [ ] **B6 Ship PR B:**
  - [ ] measure again against B0 and record the before/after table here;
  - [ ] update the manual if auto-pan behaviour is noticeably different;
  - [ ] bump the version and build;
  - [ ] critical review;
  - [ ] open the PR;
  - [ ] tablet test, including a manual airport-tap check.

---

## Backlog (not scheduled)
- Move engine-limit alerts and the flight recorder into the native FlightService, so they
  survive any WebView pause. This is the real fix behind A6, and it's a bigger change.
- Coalesce queued native WS messages while JS is frozen (`StratuxWsPlugin.java:97-101`), so a
  resume doesn't replay a burst of old positions.
- Back-off in the UDP receive loop (`StratuxUdpPlugin.java:118-136`).
- A spatial index for `getAirspaceInBounds` / `getSuaInBounds` (`nasr-db.js:450-520`).
- Pause map rendering while the ENG or other full-screen pages cover the map.
- Guard `Settings.set` and fuel-overlay localStorage writes against quota errors.
- Pilot: check for a Lenovo ZUI update. `vendor.qti.qvirt-service_rs` fails every 5 s
  (firmware, not FlyTab).

---

## Appendix — Playwright failures on `main` (identical before and after the 10-13 merges)

```
[components] › tests/components/engine-box.spec.js:15:5 › Map Engine Box picker @map › starts with CARB TEMP on, showing the Pi value
[components] › tests/components/engine-box.spec.js:21:5 › Map Engine Box picker @map › turning values on adds cards immediately, in catalog order, with real values
[components] › tests/components/engine-box.spec.js:32:5 › Map Engine Box picker @map › turning CARB TEMP off removes its card
[components] › tests/components/engine-box.spec.js:39:5 › Map Engine Box picker @map › at 6 values the rest are disabled until one is turned off
[components] › tests/components/engine-panel.spec.js:15:5 › engine panel @engine › renders all four EGT bars with non-zero height
[components] › tests/components/engine-panel.spec.js:29:5 › engine panel @engine › renders fuel endurance from Gallons_Rem and Fuel_Flow
[components] › tests/components/engine-panel.spec.js:37:5 › engine panel @engine › shows DISCONNECTED status on engine:disconnect
[components] › tests/components/engine-panel.spec.js:45:5 › engine panel @engine › shows STALE status on engine:stale
[components] › tests/components/engine-panel.spec.js:8:5 › engine panel @engine › renders RPM from canonical Pi engine data
[components] › tests/components/layer-panel.spec.js:14:5 › layer panel @map › closes when close is called
[components] › tests/components/layer-panel.spec.js:22:5 › layer panel @map › backdrop is shown on open and hidden on close
[components] › tests/components/layer-panel.spec.js:7:5 › layer panel @map › opens when triggered
[components] › tests/components/mag-heading.spec.js:11:5 › magnetic heading in the browser @planner-ui › planning module reaches the WMM loaded as a classic script
[components] › tests/components/route-planner-panel.spec.js:111:5 › Victor airway retention @airway-retention › airways inferred from NASR when saved route lacks airway tokens
[components] › tests/components/route-planner-panel.spec.js:182:5 › approach insertion @planner-ui › KLKR → KLKR: approach goes before the destination, not the departure
[components] › tests/components/route-planner-panel.spec.js:200:5 › approach insertion @planner-ui › approach anchors on a mid-route fuel-stop pill when the airport is not the destination
[components] › tests/components/route-planner-panel.spec.js:220:5 › approach insertion @planner-ui › a VOR pill sharing the airport bare id (GSO vs KGSO) is not used as the anchor
[components] › tests/components/route-planner-panel.spec.js:247:5 › approach insertion @planner-ui › KCLT → KLKR: approach and missed approach bracket the destination
[components] › tests/components/route-planner-panel.spec.js:28:5 › route-planner-panel @planner-ui › init() builds panel DOM
[components] › tests/components/route-planner-panel.spec.js:294:5 › destination with a loaded missed approach @planner-ui › reopening a saved KLKR → KLKR plan keeps KLKR as the destination, not CORON
[components] › tests/components/route-planner-panel.spec.js:307:5 › destination with a loaded missed approach @planner-ui › reopening a plan saved without a destination field still treats the last id as the destination
[components] › tests/components/route-planner-panel.spec.js:318:5 › destination with a loaded missed approach @planner-ui › typing a new DEST replaces the destination pill, not the trailing missed-approach fix
[components] › tests/components/route-planner-panel.spec.js:343:5 › destination with a loaded missed approach @planner-ui › stats bar measures the direct-distance delta to the destination, not the missed-approach hold
[components] › tests/components/route-planner-panel.spec.js:35:5 › route-planner-panel @planner-ui › panel contains dep/dest inputs after init
[components] › tests/components/route-planner-panel.spec.js:359:5 › destination with a loaded missed approach @planner-ui › stats bar shows the to-destination summary and the ETA at the destination, not at the hold
[components] › tests/components/route-planner-panel.spec.js:385:5 › destination with a loaded missed approach @planner-ui › fuel-stop recheck plans to the destination, not the missed-approach hold
[components] › tests/components/route-planner-panel.spec.js:395:5 › destination with a loaded missed approach @planner-ui › reopening does not tag missed-approach fixes with the enroute airway
[components] › tests/components/route-planner-panel.spec.js:412:5 › destination with a loaded missed approach @planner-ui › Add inserts a new fix before the destination, not between it and the missed approach
[components] › tests/components/route-planner-panel.spec.js:41:5 › route-planner-panel @planner-ui › close() clears the route array
[components] › tests/components/route-planner-panel.spec.js:422:5 › destination with a loaded missed approach @planner-ui › auto-saved trip is KLKR → KLKR, keeps the missed approach, and reopens with KLKR as destination
[components] › tests/components/route-planner-panel.spec.js:463:5 › Plan button @planner-ui › typing KLKR in DEP and tapping Plan plans from KLKR, not the previous trip
[components] › tests/components/route-planner-panel.spec.js:472:5 › Plan button @planner-ui › reserve warning uses fuel at the destination, not after the missed approach
[components] › tests/components/route-planner-panel.spec.js:505:5 › waypoints handed to the planner @planner-ui › only the DEST pill's waypoint is marked isDest, so the descent ends at the arrival KLKR
[components] › tests/components/route-planner-panel.spec.js:516:5 › waypoints handed to the planner @planner-ui › a fix inserted after the DEST pill does not become the destination
[components] › tests/components/route-planner-panel.spec.js:531:5 › waypoints handed to the planner @planner-ui › Plan keeps the previous plan when a pill cannot be located
[components] › tests/components/route-planner-panel.spec.js:550:5 › waypoints handed to the planner @planner-ui › Plan waits for a recompute already in flight, and leaves its own for Apply to await
[components] › tests/components/route-planner-panel.spec.js:558:5 › waypoints handed to the planner @planner-ui › while the winds load, the stats bar shows calm-air figures, not 0 nm
[components] › tests/components/route-planner-panel.spec.js:579:5 › fuel stops survive reopen @planner-ui › a saved fuel stop reopens as a fuel-stop pill
[components] › tests/components/route-planner-panel.spec.js:586:5 › fuel stops survive reopen @planner-ui › reopening a fuel-stop trip does not warn below reserve at the final destination
[components] › tests/components/route-planner-panel.spec.js:594:5 › fuel stops survive reopen @planner-ui › a leg that ends at its own fuel stop still warns below reserve on arrival
[components] › tests/components/route-planner-panel.spec.js:609:5 › fuel stops survive reopen @planner-ui › Plan on a reopened trip still plans the fuel stop
[components] › tests/components/route-planner-panel.spec.js:62:5 › Victor airway retention @airway-retention › V-airway pills survive close/reopen when route was saved with airway IDs
[components] › tests/components/wx-briefing.spec.js:13:5 › wx-briefing NOTAMs @notam › injects NOTAMs and counts them
[components] › tests/components/wx-briefing.spec.js:22:5 › wx-briefing NOTAMs @notam › NOTAM section renders after injection
[components] › tests/components/wx-briefing.spec.js:31:5 › wx-briefing NOTAMs @notam › tier-0 TFR is sorted before tier-3 OBST_LGT
[smoke] › tests/smoke/engine.spec.js:9:5 › engine panel smoke @smoke @engine › engine client connects to fake-engine and receives data
[smoke] › tests/smoke/planning.spec.js:31:5 › route planning smoke @smoke @nasr › route planner closes and removes route-editing class
[smoke] › tests/smoke/planning.spec.js:9:5 › route planning smoke @smoke @nasr › route planner opens and cockpitContainer gets route-editing class
[smoke] › tests/smoke/startup.spec.js:85:5 › app startup @smoke @nasr › NasrDB class exists and app initializes cockpit
[smoke] › tests/smoke/visual-map.spec.js:13:5 › map tile rendering @visual @smoke @visual-map › VFR sectional tiles render at z8 around KLKR
[smoke] › tests/smoke/visual-map.spec.js:30:5 › map tile rendering @visual @smoke @visual-map › IFR low tiles render at z8 around KLKR
```
