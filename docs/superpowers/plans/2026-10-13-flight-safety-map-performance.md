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
- [x] **A4 Engine monitoring must not wait on the NASR database.** Done in v11.13.
  - Moved, unchanged and in the same order, before `await this._ensureNasrData`: EngineClient, StickyValve (monitor + banner), EngineGpsBridge, EnginePanel, EmergencyGlide, EngineML (+ flightsync logging hooks), EngineOverlay, EnginePage, FlightRecorder, and the Logbook (it turns the recorder's stopped event into the logbook entry). A dependency sweep found nothing in them that needs anything created after the NASR wait; no stacking change (z-indexes differ).
  - `NasrDB.open()`: 10 s timeout (`OPEN_TIMEOUT_MS`), `onblocked` logged, concurrent callers share one request, a late success is kept, a failed/stuck request is retried on the next call.
  - `_ensureNasrData` skips the check/import when the DB can't be opened.
  - Chromium boot, IDB stuck: before, nothing engine-side existed at 30 s and init never finished; after, all present at 5 s and init completes after the 10 s timeout. Normal boot: engine side at 5 s (was: not at 20 s).
  - Tests: `tests/shared/nasr-db-open.test.js` (7; the 6 original failed or hung before), `tests/shared/app-init-order.test.js` (17; 15 fail on the old app.js). vitest 1492/1492.
  - **Where:** `app.js:478`, `await this._ensureNasrData()`, runs before EngineClient,
    StickyValve, EngineML and FlightRecorder are created. `NasrDB.open()` has no `onblocked`
    handler and no timeout; CLAUDE.md documents IDB hangs.
  - **Fix:** wire the engine, sticky-valve, ML and recorder before the NASR await. Add a
    timeout and `onblocked` to the NASR open.
  - **Verify:** a full-app boot in Chromium (where NASR stalls today) shows the engine client,
    sticky-valve and recorder present. Add a test for a hung open.
- [x] **A4b A WebView renderer crash no longer takes FlyTab down (added 2026-10-14 after the in-flight crash).** Done in v11.15.
  - Cause of the 12:11:53 EDT crash: the renderer of WebView 155.0.8059.43 (auto-updated 10-13 20:39) hit SIGSEGV. The pointer was V8's `kTracedHandleMinorGCWeakResetZapValue`, a GC bug. Capacitor 8.5's `onRenderProcessGone` returns false unless a listener handles it, so Chromium aborted the app. Evidence is in `~/flights/diag-20261014/`.
  - `MainActivity` handles it:
    - on screen: restart in a fresh process (`RestartActivity`, `:restart`, ProcessPhoenix pattern);
    - off screen: end cleanly (Android blocks background activity starts);
    - more than 2 restarts in 5 min: give up rather than loop (`RendererRecoveryLogic`).
    - Events are passed to JS via `AppHealth.takeRendererEvents`.
  - The recorder keeps a localStorage marker (`flytab_recording_active`). A relaunch within 10 min of the last save carries on in the same file; an older one is closed out (rename + logbook). `_recoverAfterRestart` logs it and shows one toast. The FIS-B logger starts if a resumed recording is already running.
  - Tests: JUnit `RendererRecoveryLogicTest` (8); vitest `flight-recorder-resume` (9), `app-restart-report` (7), and `app-init-order` (+2). vitest 1510/1510.
  - On the tablet, crashes forced with CDP `Page.crash`:
    - on screen: restarted in ~0.2 s to a new process; the recording resumed in the same file with no second header; toast shown;
    - background: closed; the relaunch resumed the recording;
    - third crash in 5 min: gave up;
    - no FlyTab entry in the crash log;
    - the v11.15 retest confirmed weather logging restarts.
  - Follow-ups (not done):
    - a weather logger restarted in the same UTC minute appends a second header line to the same `_weather.ndjson`, and a later restart starts a separate weather file; continuing the weather file properly is still to do;
    - the 10-14 first segment `20261014_1555Z.csv` was never closed out: v11.13 wrote no marker;
    - TileServer `Failed to fetch` (hypothesis: NanoHTTPD `SOCKET_READ_TIMEOUT` of 5000 ms racing the 5 s saves) is still to be investigated.
    - Closing out an old unfinished recording names its destination from the last GPS point. If the recording died in the air, that's whichever airport is nearest the cut-off point. The 10-14 segment 1 ended at 2,392 ft, 141 kt. Close-out should drop or flag the destination when the last point was airborne.
    - When the rename fails, the logbook takes its airports from the active flight plan. On 10-14 that made the draft KCDN→KLKR for a KLKR→KLKR local flight, because the rename copy hit `Failed to fetch`. Dana chose to fix that draft by hand.
- [x] **A5 Overheating must not let the screen time out in flight.** Done in v11.16.
  - Screen kept on only by the WebView Screen Wake Lock. Verified on the tablet: `dumpsys power` shows `SCREEN_BRIGHT_WAKE_LOCK 'WindowManager/displayId:0'` for FlyTab. Screen timeout setting: 10 min. No brightness API anywhere in FlyTab.
  - At ≥ 50 °C, heat now releases the lock only when no flight is being recorded. A flight starting re-takes it; a flight ending while still hot releases it again. Returning to FlyTab no longer re-takes a lock that heat released.
  - The warning reads *SHADE THE TABLET* in flight, *SCREEN OFF OK* on the ground.
  - `_acquireWakeLock` holds one lock at most (overlapping requests used to leak one), and a release during a pending request wins.
  - Dana chose **no dimming** (2026-10-14): heat usually comes with direct sun, when brightness matters most.
  - Not seen in the saved 10-13/10-14 logs; preventive.
  - Tests: `tests/shared/app-thermal-wakelock.test.js` (8, through the real `_poll` path). Mutation checks: old release rule 3 fail; no flight-start re-check 3 fail; old acquire 2 fail; old text 1 fail. vitest 1518/1518.
  - Tablet, simulated 52/55/40 °C readings, with Android's screen lock checked at each step: ground hot → released; flight start → held; flight hot → held; flight end → released; cooled → held.
  - Not tested: a real hot tablet.
- [x] **A6 The pilot knows when FlyTab was paused, and it pauses less.** Done in v11.19.
  - **Root cause (measured on the tablet, v11.16):** it isn't Android. About 30–40 s after FlyTab is hidden (Home, or screen off), **Chromium freezes the page**: a document `freeze` event fires and no JS runs until FlyTab is shown again (`resume`). Meanwhile Android keeps the renderer perceptible (`prcp`), in the foreground cpuset, `isFrozen=false`. Capacitor doesn't pause it either (`KeepRunning` defaults to true).
  - So (b) `setRendererPriorityPolicy` was **not done**: it only changes process priority, and the renderer wasn't demoted.
  - **Fix:**
    - `KeepAliveWebView` (`CapacitorWebView` subclass, via a `res/layout/capacitor_bridge_layout_main.xml` override) always reports its window as VISIBLE to Chromium, so the page isn't frozen. Dana chose "always", not only in flight.
    - `MainActivity` reports the real on-screen state: event `flytab:screen`, plus `AppHealth.isOnScreen()`. The rAF hang watchdog uses it; without that, the spike logged a false "JS hang" every ~12 s with the screen off (49 in 9 min).
    - (a) `PauseDetector` (`web/shared/pause-detector.js`): a 1 s tick on `performance.now()`. A gap of 15 s or more gives a DiagLog error plus a toast, e.g. "FlyTab wasn't running for 4 min (12:13–12:17). Engine alerts and the flight recording were off."
  - Tablet, v11.18/19:
    - screen off for 3 min: 180/180 heartbeats, no freeze, `_onScreen=false`, 0 hang entries;
    - `Debugger.pause` for 20 s: toast and log "wasn't running for 21 s";
    - renderer crash still handled (background path).
    - Before, v11.16 with Home: frozen at 32 s and 40 s.
  - Tests: `pause-detector` (6) and `app-watchdog-onscreen` (4; 2 failed before the fix). vitest 1528/1528.
  - **Not tested on the tablet with the fix:** the screen-on app switch (Home), because the tablet was locked. It's the same window-visibility path as screen off. Also not tested: a real flight.
  - Side effects:
    - `document.visibilityState` is always 'visible' now, so the A1 hide-flush and the logbook's hidden-page path no longer trigger. They aren't needed, since JS keeps running.
    - FlyTab works in the background (FlightService already holds the CPU awake); the manual tells the pilot to close it with Back after flying.
  - New finding: at home with no Stratux, the Stratux reconnect messages fill the 200-entry DiagLog within minutes, now also in the background. Added to the backlog.
- [x] **A7 The FlightService CPU wake lock never silently expires.** Done in v11.20.
  - It was taken once in `onCreate` with an 8 h timeout. `onCreate` runs only on a cold start, so FlyTab opened at 07:00 had no CPU lock for a 16:00 flight.
  - `WakeLockKeeper`:
    - the lock is now non-reference-counted (checked in AOSP `PowerManager.WakeLock`: re-acquiring re-arms the timeout, and one release fully releases);
    - 60 min timeout as a backstop, renewed every 20 min while the service runs;
    - also renewed in `onStartCommand`, released in `onDestroy`;
    - a lapse is logged.
  - JUnit `WakeLockKeeperTest` (7): held across 24 h; stop releases and cancels. Mutation checks: no re-acquire 2 fail; no release 3 fail.
  - Tablet: `dumpsys power` shows `FlyTab::Flight` held after install, and logcat shows "CPU wake lock held for the next 60 min".
- [x] **A8 EngineML can't run two inferences on one model.** Done in v11.21.
  - The bug: on a 500 ms timeout, `future.cancel(true)` can't stop a native `interpreter.run()`. The next sample, 1 s later, started a new thread on the same (not thread-safe) Interpreter while the first was still running: a native crash risk in FlyTab's process, and a leaked thread per timeout.
  - Fix:
    - one persistent `tflite-inference` thread;
    - `InferenceGate`: run if idle, skip the sample if a run is still going, and turn ML inference off for the session if a run hasn't returned after 10 s;
    - the gate is released only when the native run returns; the Interpreter is never closed under a running inference.
  - The plugin returns `mlState`: ok, busy, timeout, error or disabled. The badge shows **ML:OFF**, logged once, instead of a misleading green when ML is disabled. Rule-based advisories are unaffected.
  - Tests: JUnit `InferenceGateTest` (5) and vitest `engine-ml-badge-state` (4; the ML:OFF case failed before). vitest 1532/1532.
  - Tablet:
    - NNAPI/NPU delegate loaded;
    - 75 synthetic samples under the made-up phase `a8test` (< 100, so `ThresholdAdapter` saves nothing): 59 filling, 16/16 scored (`mlState: ok`) at 0.9–3.2 ms, no warnings, exactly one `tflite-inference` thread;
    - `threshold_adapter.xml` has the same MD5 before and after; FlyTab was restarted to clear the in-memory samples.
  - Not reproducible on the tablet: a run that never returns (unit tests only).
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

## PR C — CB building detection (added 2026-10-14 at Dana's request)

Dana: "currently it shows CB building when nexrad radar shows slight returns. CB building
should be biased to look for red areas (pixels) building, not random scattered returns."

- [ ] **C1 CB↑ only for red cores that are building.**
  - **Where:** `web/cockpit/fisb-nexrad.js`: `_updateCbFromFisb` :651, `_clusterBlocks` :808,
    `_findBuildingCells` :918, `_expandToLightEchoes` :694, `_sampleInternetTiles` :731.
  - **Why it fires on light returns:** from reading the code; not yet checked against
    recorded frames.
    1. The "core" threshold is level 3 (yellow, 35–40 dBZ; `MIN_LEVEL = 3` at :809 and
       `>= 3` at :752-753), not red. Red is level 5 (50–55 dBZ) and 6 (55–65 dBZ); see
       `COLORS` :72 and `_rgbToNexradIntensity` :1050.
    2. Growth is relative: `max(areaGrowth, intGrowth) >= 0.25` (:944-946). A 2-cell cluster
       that becomes 3 cells counts as 50 % growth, so tiny clusters trip it.
    3. Any "new" cluster of ≥ 3 cells with max ≥ 3 is flagged (:933-937). With FIS-B, blocks
       arrive piecemeal, so an area that simply wasn't received in the previous snapshot may
       look new. To be confirmed.
    4. Clusters are matched by nearest centroid within 1.5° (~90 nm, :919). That can pair
       unrelated cells.
    5. The outline drawn is expanded into every adjacent light echo, level ≥ 1, by
       `_expandToLightEchoes` :694. A small yellow core is drawn as a large outline over
       green returns, which matches "slight returns".
    6. The cluster grid is 0.25° (~15 nm) cells (:809), and scattered pixels in the same
       cell merge.
  - **Fix direction:** to agree with Dana before coding.
    - Core = red and above (level ≥ 5).
    - Require a minimum contiguous red area.
    - "Building" means the red area or its max level grows by an absolute amount between
      frames that cover the same blocks, not a % of a tiny base.
    - Ignore clusters only in areas missing from the previous frame.
    - Draw the outline around the red core, not the light-echo halo.
    - Same rules for the ground-mode internet tiles.
  - **Verify:**
    - Replay real frames: FisbLogger recordings, and the internet n0q 10-min pairs.
    - Scattered green and yellow returns produce no CB↑.
    - A growing red core produces CB↑.
    - Inspect the real FIS-B NEXRAD block data first (CLAUDE.md: inspect external data before
      fixing display bugs).
    - Update the manual's CB building description.

---

## Backlog (not scheduled)
- DiagLog churn: with no Stratux (at home), "Situation WS closed / Failed to connect" lines fill the 200-entry DiagLog within minutes and push out useful entries (crash/pause/recorder). Rate-limit or collapse repeated link messages.
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
