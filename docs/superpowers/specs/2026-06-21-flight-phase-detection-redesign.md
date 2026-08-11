# Flight Phase Detection Redesign — Design Spec

**Status:** RESOLVED — ready for implementation planning.
**Started:** 2026-06-21 (paused mid-brainstorm)
**Finalized:** 2026-07-13
**Author:** Dana + Claude (brainstorming sessions)
**Repos touched:** `~/flytab` (runtime) and `~/engine_analysis` (offline training/analysis)

---

## 1. Purpose of this document

Capture the resolved design for a from-scratch phase detector, replacing the three
divergent implementations that exist today (`PhaseDetector.java`, the JS GPS-phase
override in `engine-ml.js`, and `train_anomaly_model.detect_phases()`). Phase
detection is foundational infrastructure — most engine-health detection modes anchor
on it, not a single isolated feature. This doc records the problem, the resolved
architecture, the full phase taxonomy with rationale, the shared-spec/testing
strategy that keeps runtime and offline in parity, a training-pipeline bug found and
fixed along the way, and the rollout plan.

---

## 2. Problem statement

The most valuable phase detection is **real-time, in-flight**, because that is where
phase-aware anomaly detection can catch a developing problem while the pilot can
still act on it. The in-flight detector was the weakest of the three that existed,
and was blind to half the signals available.

Dana's requirement: phase detection must use **RPM, MP, Fuel Flow, GPS position
(lat/lon), altitude, and velocity** — and detect the full operational phase
sequence.

### Resolved phase taxonomy (12 phases)

```
startup → warmup → taxi_out → runup → takeoff → climb → cruise → descent → approach → landing → taxi_in → shutdown
```

Phase descriptions and the signals that define each:

| Phase | Definition / signal signature |
|---|---|
| `startup` | Engine running, stationary, RPM still climbing off a cold-start idle. Purpose: isolate the window where rising RPM should correlate with rising EGT/CHT per cylinder — a cylinder whose EGT fails to rise is the sticky/stuck-valve signature. Bounded by RPM trend flattening, not a fixed timer (see §5a). |
| `warmup` | Engine running, no movement (GPS position static), oil warming. **Only before the aircraft has moved once this flight** — see §5b. A stationary idle period after that (e.g. holding short after runup) is `taxi_out`/`taxi_in`, not `warmup`. |
| `taxi_out` | Low RPM, GPS position changing (creeping). |
| `runup` | RPM up to ~1800, no GPS movement, mag check (L → both → R → both — RPM dips on each mag). |
| `takeoff` | Maximum power (MP ≈ 26–30", FF ≈ 14–16 GPH here), speed building. |
| `climb` | Airborne, positive alt rate. |
| `cruise` | Level (±~300 fpm smoothed). |
| `descent` | Sustained alt loss en-route. |
| `approach` | Low AGL near field, speed reducing. |
| `landing` | On/near runway, decelerating. |
| `taxi_in` | Post-landing, low RPM, GPS moving. |
| `shutdown` | RPM ≈ 0, FF ≈ 0. |

---

## 3. Phase taxonomy & transition graph (resolved)

A phase may always transition to itself. Legal transitions:

| From → To | Rationale |
|---|---|
| `startup → warmup` | Only legal exit: engine now running, aircraft still stationary while checklist/avionics/oil-temp settle. |
| `warmup → taxi_out` | Pilot begins moving toward runup area / runway. |
| `warmup → runup` | Aircraft stops briefly while taxiing toward the runup pad (a legal `taxi_out → warmup` transition already covers the stop itself), then starts the mag check without resuming a distinct taxi segment first. Found missing during offline implementation (Plan 1 Task 4) — without it, a stop-then-runup sequence traps the FSM in `warmup`, mirroring the same "missing normal-path edge" class of bug as `taxi_out → takeoff` (§3 above). |
| `warmup → shutdown` | False start — engine started, issue caught during warmup, shut down without ever moving. |
| `taxi_out → runup` | Reaches the runup pad, holds to do the mag check. |
| `taxi_out → warmup` | Extended stationary hold during taxi (e.g. waiting for traffic) that outlasts the dwell tolerance — reverts to genuine idle rather than staying "taxi." |
| `taxi_out → shutdown` | Mechanical issue found while taxiing; abort before taking the runway. |
| `runup → taxi_out` | Runup complete, continuing to the hold-short line / runway. |
| `taxi_out → takeoff` | **The normal departure path**, not an edge case: real rolling takeoffs start moving (GPS delta exceeds the stationary threshold) several seconds before RPM/MP cross the takeoff threshold — the aircraft is a `taxi_out` candidate for that window. Found missing during offline implementation (Plan 1 Task 4): without this edge the FSM permanently traps in `taxi_out`/`warmup` for the rest of the flight, since no candidate can ever legally leave `taxi_out` except back to `runup`. Isolated fix measured 32.7% → 65.0% agreement against the golden fixture. |
| `runup → takeoff` | On a small field (e.g. KLKR) the runup pad often sits at the hold-short line — a pilot can roll straight onto the runway with no distinct taxi segment. Disallowing this forces a phantom `taxi_out` blip. |
| `runup → warmup` | RPM drops back to idle after completing checks, before moving again. |
| `runup → shutdown` | Mag check (or other runup finding) fails; engine shut down on the pad. |
| `takeoff → climb` | Normal progression once airborne with sustained positive climb rate. |
| `takeoff → taxi_out` | Rejected/aborted takeoff — power reduced, decelerating back through taxi speed on the runway. |
| `climb → cruise` | Levels off at cruise altitude — the common case. |
| `climb → descent` | Step-down or obstacle/traffic correction before ever reaching a stable cruise segment. |
| `climb → approach` | Touch-and-go pattern work: climb-out rolls directly into the pattern without a formal cruise segment. |
| `cruise → climb` | En-route step climb (altitude change, terrain, ATC). |
| `cruise → descent` | Starting down for landing or a step-down. |
| `cruise → approach` | Short local flights can go straight from cruise altitude into the pattern with no sustained-descent segment ever registering. Confirmed legal — no forced intervening `descent`. |
| `descent → cruise` | Leveling off mid-descent (step-down for traffic/terrain, or correcting an overshoot). |
| `descent → climb` | Correction back up before ever reaching approach. |
| `descent → approach` | Normal progression into the pattern. |
| `approach → landing` | Normal touchdown. |
| `approach → climb` | Go-around / missed approach. Confirmed legal. |
| `approach → cruise` | Aborted approach that climbs back to cruising flight rather than a tight-pattern go-around (e.g. diverting to another airport). |
| `approach → descent` | Kept for consistency with the example FSM's transition set — a stabilized approach can still show a distinct sustained-descent segment before `landing`. |
| `approach → taxi_in` | Defense-in-depth for a slow/mushy landing that never registers a distinct fast-rollout `landing` segment before dropping to taxi speed. Found missing during offline implementation (Plan 1 Task 4) alongside the ground-ops classifier's own gap (§9 below) — without it, a landing that skips straight past the rollout-speed cutoff traps the FSM in `approach`. |
| `landing → taxi_in` | Normal rollout, clears the runway. |
| `landing → takeoff` | Touch-and-go — power added again during rollout, back into a takeoff roll without ever reaching `taxi_in`. |
| `taxi_in → shutdown` | Normal end of flight — taxi to parking, shut down. |
| `taxi_in → warmup` | Taxi to parking but leave the engine idling before shutdown (e.g. cooling period). |
| `taxi_in → takeoff` | Touch-and-go where the aircraft briefly taxis (e.g. a short back-taxi) before departing again, without a `warmup`/`runup` segment in between. |
| `shutdown → ` *(none)* | Terminal. A later `startup` begins a fresh engine-start cycle rather than a transition out of `shutdown`. |

**Known coverage gap:** the curated ground-truth flight (`20260710_KLKR-KLKR.csv`)
has no touch-and-go, so `landing→takeoff` and `taxi_in→takeoff` have no real-flight
golden-file coverage yet — unit-level synthetic tests only, until a touch-and-go
flight is captured and curated.

---

## 4. Current architecture (as of design time — being replaced)

### 4a. Runtime (tablet)

```
engine-ml.js (1 Hz)
  → EngineML.processSample({ rpm, egt1-4, cht1-4, oil_temp, oil_press, fuel_flow,
                             altitude, mp, carb_temp, fuel_remaining,
                             ground_speed, distance_nm })          ← NO lat/lon
      → PhaseDetector.detect(rpm, altitude, groundSpeed)            ← ONLY 3 signals
      → threshold = thresholdAdapter.getThreshold(phase)            ← phase GATES anomaly
      → anomaly  = score > threshold
      → EngineAdvisor.advise(features, phase, …)                    ← phase gates advisories
  → (JS) if (_gpsPhaseThisSample) result.phase = _gpsPhaseThisSample ← OVERRIDE is COSMETIC
```

Verified by reading the code: the JS GPS-smoothed phase override
(`web/cockpit/engine-ml.js:295`) runs **after** `EngineMLPlugin.java`'s threshold
lookup (`EngineMLPlugin.java:150-151`, which reads `phaseDetector.detect(...)`
computed at line 130). The override changes only the *displayed/logged* `ml_phase`
— it never changes which threshold gated the anomaly. `PhaseDetector.java` uses only
RPM + altitude + ground speed, has 8 phases, no FSM/legal-transition enforcement,
and a fixed-window/fixed-timer startup and 10-sample alt-rate buffer (flicker-prone).

### 4b. Offline (`~/engine_analysis`)

- Canonical detector: `train_anomaly_model.detect_phases()`, imported by
  `run_ml_inference.py`, `compare_departures.py`, `cam_analysis.py`.
- Batch, whole-flight, can look ahead (±30-sample centered alt-rate window).
- 8 phases + `unknown`/`shutdown`. No FSM transition validation; default cases dump
  rows into `cruise`/`warmup`.
- Labels feed per-phase anomaly thresholds baked into `models/anomaly_v2_metadata.json`
  during `train_anomaly_model.py`, deployed to the tablet and consumed by
  `ThresholdAdapter` at runtime.

---

## 5. Resolved direction — one phase model, two implementations

1. **Canonical phase definition** — the 12-phase taxonomy (§2), the transition table
   (§3), and per-phase signal rules/dwell times, all encoded in a single checked-in
   **`phase_spec.json`**, present in both repos. Both implementations load it instead
   of hardcoding numbers — the one and only source for every tunable threshold.

2. **Causal runtime detector (JS, single source of truth)** — `engine-ml.js` gains a
   new phase-detection module, fed all six signals (lat/lon threaded from the
   existing Stratux `sit` object into `_computeGPSPhase()`, which doesn't read
   position today but has access to it). Uses a **GPS-position delta** (haversine
   over a short trailing window) rather than raw ground speed to separate *truly
   stationary* (`warmup`/`runup`) from *creeping* (`taxi_out`/`taxi_in`), since ground
   speed is noisy at a standstill. Enforces the §3 transition table. Uses forward-only
   dwell-time hysteresis (commit a transition only after N consecutive qualifying
   samples, plus a minimum-hold on the current phase) as the causal analog of the
   batch detector's look-ahead smoothing — no back-filling, since live data has no
   future to look ahead into. Exact per-phase dwell/hysteresis sample counts are a
   `phase_spec.json` value, not fixed by this doc — they get an initial value derived
   from the batch detector's existing min-duration constants (`phase_detection_fsm.py`'s
   `MIN_PHASE_DURATION`) and are tuned during implementation against the golden
   fixture (§7), not invented here.

   **Bridge change:** `phase` becomes an **input** field on `processSample()`,
   computed by the new JS module immediately before the call. `EngineMLPlugin.java`
   no longer calls a detector — it reads `phase` off the payload and uses it directly
   for `thresholdAdapter.getThreshold(phase)` and `EngineAdvisor.advise(...)`. A
   missing/unparseable `phase` defaults to `cruise` (least alarm-prone bucket) so a
   malformed sample degrades gracefully rather than dropping anomaly coverage.

   `PhaseDetector.java` is **deleted**, not deprecated in place. The
   `engine-ml.js:295` cosmetic override is deleted too — nothing left to override,
   since `result.phase` now just echoes what JS already computed and used for
   gating. This closes the "anomaly detection not actually bounded by displayed
   phase" bug directly.

3. **Offline batch detector (Python)** — `train_anomaly_model.detect_phases()`
   rewritten to the same canonical 12-phase model, reading `phase_spec.json`,
   retaining the batch/look-ahead smoothing appropriate to whole-flight analysis.
   Used to relabel all training data for retraining `anomaly_v2`.

### Parity strategy (chosen over doc-only sync or full codegen)

Rejected: (a) doc-only hand-sync — this is how the two existing implementations
already ended up disagreeing on thresholds despite nominally sharing logic; (b) full
codegen from one source — the causal (forward-only) vs. batch (look-ahead) control
flow genuinely differ per the translation table below, so a shared AST doesn't
actually fit both, and the toolchain cost isn't justified for a phase classifier.

**Chosen:** `phase_spec.json` eliminates threshold drift by construction (both
implementations load the same numbers). A **golden parity test** (§7) catches
control-flow drift in CI by running the same fixture through both implementations
and asserting matching output.

### Causal translation of the batch detector's three passes

| Batch (Python, look-ahead) | Causal runtime equivalent (JS) |
|---|---|
| Centered ±window alt-rate | Trailing window alt-rate |
| Airborne hysteresis with back-fill | Forward-only counter; transition on N consecutive matching samples (no back-fill) |
| Legal-transition validation | Identical — already causal |
| Min-duration smoothing (look-ahead) | Dwell time: require N seconds in a candidate before committing; minimum-hold on current phase |
| Field elevation = median of pre-flight | Running estimate (already implemented in `engine-ml.js`) |

### Ground-ops classifier addendum (found during offline implementation)

The ground-ops branch of the row classifier must distinguish `landing` (post-touchdown,
still decelerating from touchdown speed) from `taxi_in` (slow enough to be taxiing) —
not collapse straight from "airborne" into `taxi_in`. `landing` was originally only
reachable from the airborne branch's near-field/slow check, but actual touchdown happens
below the airborne-AGL cutoff, where the row classifier had entered ground-ops branch
logic with no `landing` candidate at all. Fix: in the ground-ops branch, `has_taken_off
and not stationary and speed > speed_taxi_max_kts` (new threshold, 20kt — derived from
this flight's own curated taxi-speed distribution, max observed 20.6kt) yields `landing`;
otherwise `taxi_in`. Both runtime and offline implementations must include this branch —
see the `approach → taxi_in` transition (§3) added as defense-in-depth for the same gap.

### Startup-boundary redefinition (found during offline implementation)

`startup` and `warmup` share identical per-row signals (engine running, RPM low,
stationary) — the only real difference is elapsed time since engine start, so a purely
signal-based classifier can't distinguish them without *some* notion of "how long has
the engine been idling." The original plan (§2, prior revision) left this as "ends on
sustained movement, not a fixed timer," which is incomplete: it either never exits
`startup` until movement (swallowing `warmup` entirely, since both phases look
identical while stationary) or — when a CSV/recording starts after the engine's
already idling, with no captured RPM 0→800+ transition to anchor a timer to — defaults
straight to `warmup` and never detects `startup` at all (this is not a hypothetical:
the golden fixture, `20260710_KLKR-KLKR.csv`, does exactly this).

Clarified purpose (Dana): `startup`'s real job is to isolate the window where rising
RPM should correlate with rising EGT/CHT per cylinder, for the sticky/stuck-valve
check — not "the first N seconds." `detect_phases()` deliberately doesn't consume
EGT/CHT (reserved as ML features, not phase-detection signals, per §7's verified
facts) — plumbing them into phase detection to bound `startup` directly was
considered and rejected: it would expand both implementations' signal set beyond the
six already scoped (RPM/MP/FuelFlow/GPS-position/altitude/velocity) and ripple into
the runtime detector's `processSample` bridge, which is a bigger change than this
bug-fix pass. Instead, `startup` is now bounded by **RPM trend**, a proxy already
available to phase detection: it persists while a rolling RPM slope (trailing window,
`startup_rpm_slope_window_s`) is still positive above `startup_rpm_slope_flatten_rpm`
(RPM still climbing off the cold-start idle), and exits to `warmup` once RPM
flattens. `detect_phases()` can now always initialize to `startup` (rather than
gating on a found engine-start transition) and let the slope naturally hand off —
this is causal-safe (trailing-only), so both offline and runtime implementations use
the identical rule. The actual per-cylinder EGT/CHT trend comparison remains the
sticky-valve check's own job (§4, `EngineAdvisor.java`), operating *within* whatever
window gets labeled `startup`, not `detect_phases()`'s.

### `warmup` is pre-first-movement only (found during offline implementation)

`warmup` and a stationary ground hold *after* the aircraft has moved (e.g. sitting at
idle for takeoff clearance after runup) are also signal-identical (stationary, low
RPM) — the same ambiguity class as the startup/warmup boundary above, one level later
in the sequence. Verified against the golden fixture's curated labels: every `warmup`
row (88 of them, deduped) falls at indices 53-140, strictly before the first `taxi`
row (141) — the curator never labels a post-movement stationary hold as `warmup`,
regardless of how long the aircraft sits still (one observed case: 35 consecutive
seconds idle after runup, waiting for takeoff clearance, labeled `taxi` throughout).
This isn't a dwell-time/threshold question — the hold genuinely lasts longer than any
reasonable `dwell_seconds['warmup']` minimum, so numeric tuning can't merge it away
without also destroying real standalone `warmup` segments elsewhere.

Fix: a `has_left_ramp` flag (parallel to the existing `has_taken_off` flag), set once
the aircraft has ever produced a `taxi_out` candidate. Once true, a stationary
ground-ops candidate that doesn't otherwise qualify as `runup`/`takeoff` returns
`taxi_out`/`taxi_in` (by the existing `has_taken_off` split) instead of `warmup`. This
makes `warmup` reachable only in the flag's initial `false` state — before first
movement — matching the curated data exactly. Both offline and runtime
implementations need this flag; it composes with `has_taken_off` and doesn't reset
mid-flight (this fixture has no touch-and-go to test a reset-on-landing case — flag as
a known gap if one is captured later, same as §3's touch-and-go coverage note).

---

## 6. Data skew bug found and fixed (training pipeline)

**Symptom (known before this project):** `anomaly_v2` over-alarms in transient
phases — takeoff 60% false-positive rate, climb 37%.

**Root cause (verified by reading `train_anomaly_model.py`, not assumed):**
minority-phase windows (e.g. only 34 original `takeoff` windows in one flight) are
oversampled with replacement to match the cruise count *before* the train/val/test
split is drawn. Because the split is a random permutation of the already-duplicated
pool, the same exact window can land in both the training set and the test set. Per-
phase thresholds are computed from test-set reconstruction error — but for minority
phases that test set is largely memorized duplicates of training examples, so their
reconstruction error is artificially low, producing a threshold too tight for
genuinely novel data at inference. Cruise, with thousands of naturally distinct
windows, is barely duplicated and doesn't exhibit this failure mode — which matches
the observed lopsided false-alarm rates exactly.

**Fix (two parts, both required):**
1. **Split before balancing.** Partition the *original* unbalanced windows into
   train/val/test first. Any balancing is applied only within the training split.
   Test/val thresholds are computed exclusively from windows the model never trained
   on.
2. **Class-weighted loss instead of duplication.** Train on the original windows
   with `sample_weight` inversely proportional to phase frequency (Keras), rather
   than duplicating minority-phase windows. The model sees every real example once
   per epoch, weighted more heavily for rare phases, instead of memorizing a small
   set of exact duplicates — directly benefits generalization on `startup`/`runup`
   and the new sticky-valve check, which depends on `startup` reconstruction fidelity
   being real, not memorized.

---

## 7. Testing strategy

- **Fixture:** `tests/fixtures/20260710_KLKR-KLKR_curated.csv` in `~/engine_analysis`
  — extracted columns (`Zulu_Time, RPM, MP, Fuel Flow, altitude_ft, speed_kts,
  longitude, latitude, Currated_phase`) from the curated flight, decoupled from the
  raw flight CSV churn in the repo root.
- **`tests/test_detect_phases.py`** (new, follows the existing `tests/test_load_flight.py`
  pattern) — asserts the rewritten Python `detect_phases()` agrees with the curated
  labels above a threshold (target ≥90%), with named exceptions for known-ambiguous
  boundary seconds.
- **Golden parity test** — runs the same fixture through both the Python detector and
  a Node-invokable build of the JS FSM module; asserts matching phase sequences
  within tolerance. This is the enforcement mechanism for §5's parity strategy, not
  optional.
- Synthetic/hand-crafted unit cases cover `landing→takeoff` and `taxi_in→takeoff`
  until a real touch-and-go flight is captured (see §3 known gap).

---

## 8. Consumers of phase

| Consumer | Location | How it uses phase | Status |
|---|---|---|---|
| **ML anomaly threshold** | `ThresholdAdapter` / `EngineMLPlugin.java` | Per-phase threshold gates `anomaly = score > threshold` | Live — now genuinely gated by the phase JS computed (bridge change, §5) |
| **Engine advisories** | `EngineAdvisor.java` | Branches on `cruise`/`climb`/`descent` for trend alerts, correlated alerts, mixture/LOP, carb-ice, fuel-range, normal messages | Live |
| **Sticky/stuck-valve check** | `EngineAdvisor.java`, new branch gated on `phase == STARTUP` | Compares per-cylinder EGT rise across the (now dwell-exited, not 60-sample-clocked) startup window; flags a cylinder whose EGT rise lags significantly as a cold-cylinder/sticky-valve signature | **In scope for this project** |
| **Emergency glide (engine failure + direction)** | `web/cockpit/emergency-glide.js` (Scenario 6) | Triggered by physics + ML anomaly; logs `ml_phase`; computes reachable airports, headings, descent profiles | Live, unaffected |
| **Cam / lifter spalling trend** | `~/engine_analysis/cam_analysis.py` | Cross-flight EGT/CHT trend analysis; relies on `detect_phases()` segmentation | Live (offline) — needs audit for hardcoded 8-phase assumptions (§9) |
| **Exhaust-valve deterioration** | (future) | EGT pattern / spread per cylinder, phase-anchored | Future — out of scope, not foreclosed |
| **Post-flight engine review** | `post-flight-engine-review` skill, `run_ml_inference.py`, `compare_departures.py` | Phase-annotated reports | Live (offline) — needs audit for hardcoded 8-phase assumptions (§9) |

---

## 9. Rollout / migration

1. Land `phase_spec.json` + rewritten `detect_phases()` + fixed retrain pipeline
   (§6) in `~/engine_analysis`; verify against the golden fixture (§7).
2. Retrain `anomaly_v2` with the new 12-phase labels, class-weighted loss, leak-free
   thresholds. Verify shape/dtype (`float32`, `[1,60,12]`, `n_features=12`) per the
   existing pre-deploy checklist — unchanged, since this redesign only touches phase
   labels, not ML feature count.
3. Land the JS FSM module + `phase_spec.json` copy + bridge signature change in
   `~/flytab`. Delete `PhaseDetector.java` and the `engine-ml.js:295` override in the
   same change — no dead-code interim.
4. Copy the retrained `.tflite`/`metadata.json` to
   `flytab/android/app/src/main/assets/`, run the on-device CDP score test before
   flying, per existing procedure.
5. **Audit** `run_ml_inference.py`, `compare_departures.py`, `cam_analysis.py` for
   any hardcoded 8-phase lists (report templates, segmentation groupings) — these
   import `detect_phases()` by name and don't need interface changes, but will now
   see 12 phase values instead of 8.
6. `engine_anomaly_detector_v2.py` is rule-based and doesn't import `detect_phases()`
   — unaffected, out of scope.
7. Update both CLAUDE.md files per their existing convention (the FlyTab one already
   has a template for flagging `N_FEATURES` changes — same pattern applies to the
   phase taxonomy and bridge signature change).

---

## 10. Out of scope

- Exhaust-valve deterioration detection (future consumer, not foreclosed by this
  design).
- Any UI/display change beyond phase string values changing (badge, log format
  already handle arbitrary phase strings).
- `engine_anomaly_detector_v2.py` (rule-based, independent of `detect_phases()`).

---

## 11. Next step

Invoke `writing-plans` to produce the implementation plan (offline relabel/retrain
first, then runtime detector + bridge change + `PhaseDetector.java` retirement, in
dependency order — offline must land first since the runtime bridge change depends
on the retrained per-phase thresholds existing).
