# FlyTab Engine ML

# Technical Implementation

**From:** Dana Nickerson  
**Date:** May 2026  
**Subject:** On-device real-time engine anomaly detection — implementation details

---

*© 2026 Dana Nickerson. All rights reserved. This document and the implementation details described herein are proprietary and confidential. Sharing or reproduction without written permission is prohibited.*

---

## Background: FlyTab and the Integration Gap

### FlyTab

FlyTab is a custom electronic flight bag built specifically for N194JT, an RV-9A with a Lycoming O-360 A1A, constant speed prop with about 1100 hours tach time. The app runs as a Capacitor Android app on a Lenovo Yoga Tab Plus mounted in the cockpit, and replaces ForeFlight as the primary navigation and situational awareness tool.

The app includes the full set of features a cross-country VFR and IFR pilot needs in one place: an offline moving map with terrain, approach plates via PDFs, ADS-B traffic and FIS-B weather from Stratux, a full route planner and optimizer, wx briefing (METARs, TAFs, G-AIRMETs, winds aloft, NOTAMs), weight and balance, checklists, a flight logbook, and real-time engine monitoring. Everything runs offline except weather. No data subscription, no cloud dependency in flight. The app connects to my website http://flywhere.app to retrieve weather data and store logbook entries.

### The Integration Gap

ForeFlight and every other popular EFB treat flight planning and engine monitoring as completely separate solutions, separate apps, separate data streams, no connection between them. You plan a route in ForeFlight using generic performance numbers from the POH or a pilot-entered profile. Then you watch engine data on a separate EFIS or handheld device with no awareness of where you are in the flight plan, what power setting you're running, or whether current fuel burn matches the plan.

This separation has a real cost. The two most useful things a pilot wants to know in cruise — *am I going to arrive on time and with how much fuel* — require combining real-time engine data with the active flight plan. Without that combination, ETE and fuel estimates are based on planning-time guesses. With it, they update continuously from measured values.

The second motivation was Savvy-compatible recording. I upload every flight to SavvyAnalysis for trend monitoring. Most pilots do this with a standalone EDM download after the flight. I wanted it automatic — every engine-on period recorded, GPS-correlated, and ready to upload without any post-flight workflow.

### The Incident That Made This Personal

In April 2002, I was departing KARW in a 1980 Mooney M20J. The engine quit at 500 feet AGL. I got it down safely, but 500 feet is not a margin that leaves room for deliberation.

I have never been able to answer the question that followed: was there something anomalous on the prior flight that I missed, or that no instrumentation of that era would have caught? Engine failures at low altitude on departure are rarely instantaneous, they are typically the endpoint of a degradation sequence. A carb ice event, a fuel delivery problem, a valve issue, a magneto dropping out under load, most of these produce subtle signatures in EGT, CHT, RPM, or fuel flow before they produce silence.

In 2002 there was no practical way to know. We did have an engine monitor, but the continuous recording, the baseline comparison, and the pattern recognition that could have surfaced a warning did not exist.

That question is part of why this system exists. The ML layer is specifically designed to catch the things that don't cross hard limits such as gradual drift, the cylinder running slightly cooler than it should, the fuel flow that is two tenths of a GPH below where it was for the last hundred hours of cruise. The physics rules catch emergencies in progress. The ML layer is meant to catch what comes before.

### Could Anomaly Detection Have Caught It?

The M20J uses a dual-magneto assembly on a single drive shaft — both left and right magneto are housed in one unit, driven by a single gear on the accessory case. The aircraft was 10 hours out of an annual. My working hypothesis is that the A&P set the mag timing  during the annual inspection and the retaining bolt was not properly torqued, allowing the housing to rotate on the shaft and progressively retard ignition timing. At some point between the annual and that departure, or during the takeoff roll itself, the timing slipped enough to produce complete ignition loss.

The single-shaft design makes this failure mode particularly dangerous. On a conventional two-magneto installation, one mag going out produces rough running and a noticeable RPM drop, something a pilot can detect and investigate. On a dual-mag single-shaft system, both ignition circuits are affected simultaneously by the same mechanical failure. The engine does not run rough before it stops.

**What the physics rules would have seen:** At the moment of failure — MAP and RPM collapsing simultaneously — Layer 1 would have fired immediately: MAP drop > 3 in Hg/sec, RPM drop > 200 RPM/sec. The emergency trigger would have activated within one second. That is not useful at 500 feet AGL with zero time margin. The physics rules are for emergencies already in progress.

**What the ML layer might have seen on the prior flight:** This is the more interesting question. Ignition timing retard has a characteristic signature: combustion happens later in the power stroke, more heat exits through the exhaust rather than being converted to mechanical work. The result is elevated EGTs for a given power setting, reduced TAS and MAP for the same throttle position, and slightly reduced CHTs as the combustion event moves later. The ML model, trained on this engine's normal reconstruction patterns, would have seen increasing reconstruction error as the timing drifted from its trained baseline. Whether that error exceeded the cruise-phase threshold (0.036 MSE) depends on how far the timing had slipped by the prior flight.

There is one important limitation: the run-up mag check is the direct test for this exact failure mode. A properly executed mag check — hold full RPM, switch to each mag individually, compare RPM drop — would have detected severely retarded timing as an excessive drop on both positions. If the timing had already slipped enough to cause the departure failure, a careful run-up the flight before should have flagged it. The anomaly detection is a supplementary signal, not a substitute for standard procedures.

The ML layer *might* have flagged elevated EGTs and anomalous power output on the prior flight. The run-up mag check *should* have caught it. Neither is a guarantee. But both together — continuous monitoring that flags a drift and a pilot who acts on it — is better than either alone. That combination is what this system tries to provide.

### Flight Profiles from Measured Data

The performance numbers FlyTab uses for route planning and fuel burn estimation are not from the POH. They are derived from 33 flights of EDM + GPS data from N194JT specifically. The `aircraft-config.json` power settings table:

| % Power | RPM  | MAP (in Hg) | TAS (kt) | GPH | Samples |
| ------- | ---- | ----------- | -------- | --- | ------- |
| 55%     | 2390 | 19.4        | 128      | 6.5 | 149     |
| 60%     | 2390 | 21.3        | 140      | 7.3 | 329     |
| 65%     | 2390 | 22.1        | 153      | 8.1 | 1,120   |
| 70%     | 2400 | 23.6        | 156      | 8.7 | 359     |
| 75%     | 2410 | 24.5        | 161      | 8.9 | 47      |

I run the engine aggressively LOP. The 65% row has 1,120 samples because that is the normal cruise power setting. The GPH standard deviations are also tracked (0.42–1.13 GPH depending on power setting) and inform the fuel reserve estimates. These numbers reflect this specific airframe — the same engine type on a different airframe, or the same airframe after a prop change, would produce different numbers.

The route optimizer uses these profiles to compute ETE and fuel per leg at the selected power setting. When the engine monitor is live, it substitutes measured TAS and fuel flow from the current cruise segment rather than the profile table, so the route table reflects what the aircraft is actually doing rather than what it was doing the last time the profile was measured.

### Where the ML Engine Analysis Lives in the App

The ML anomaly detection is not a standalone screen — it is woven into the existing instrument layout:

- **Engine panel badge:** An `ML:OK` / `ML:ALERT` / `ML:cruise` indicator sits in the engine data panel header, updating at 1 Hz. Long-pressing it for 2 seconds triggers a full anomaly simulation for pre-flight testing.
- **Advisory banner:** A dismissible overlay banner appears on any visible screen when an advisory fires. Severity (act-now vs. monitor) determines color and whether it flashes.
- **Emergency glide overlay:** Full-screen takeover on joint physics + ML trigger, with ranked airport list and live approach guidance. The map shrinks to a floating panel when approach detail is open so the pilot can see the glide-path track line.
- **Savvy CSV:** The four ML columns (`ml_phase`, `ml_score`, `ml_anomaly`, `ml_latency_ms`) are appended to every recorded row. The Pi also adds five derived columns to every row: `Final_Percent_Power`, `Operating_Condition` (ROP/LEAN/PEAK), `Percent` (deviation from peak EGT), and `SFC` (specific fuel consumption in lbs/HP/hr). These derived fields are what make the Savvy upload useful for trend analysis — not just raw temperatures but the operating context in which they occurred.
- **Logbook entry:** Each recorded flight's logbook entry includes a post-flight ML summary (anomaly count, anomaly percentage, average latency, phase distribution, advisory count) alongside the standard flight time, route, and fuel data.

The goal is that the engine analysis data is always present when you look at any flight record, without requiring a separate workflow to connect it.

---

## 1. Hardware and Software Stack

**Aircraft:** RV-9A N194JT, Lycoming O-360 A1A, fixed-pitch prop  
**Engine instrument:** Dynon D-180 (EGT/CHT/RPM/MP/fuel flow/oil), serial output via USB-serial adapter  
**Edge compute:** Raspberry Pi 4 — runs `engine_monitor.py`, also hosts Stratux ADS-B/GPS receiver  
**Display/compute tablet:** Lenovo Yoga Tab Plus (Snapdragon 870 SoC with Hexagon 780 NPU)  
**App framework:** Capacitor Android wrapper over a vanilla JavaScript web app (no framework, no bundler)  
**ML runtime:** TFLite via a native Capacitor plugin (`EngineML`) — the plugin is invoked from JavaScript at 1 Hz and returns results as a JSON object  

Data path:

```
D-180 serial → Pi USB → engine_monitor.py → WebSocket (:8080) → tablet JS
Stratux       → Pi WiFi AP             → WebSocket (:30000) → tablet JS
```

The tablet has no internet connection in flight. All inference is local.

---

## 2. Architecture Overview

The system uses a deliberate dual-layer design. Neither layer acts alone on anything consequential.

**Layer 1 (physics rules):** Deterministic hard-limit checks. Run every second with no ML dependency. Designed to fire immediately when something is unambiguously wrong. Zero latency, zero false negatives on threshold crossings.

**Layer 2 (ML inference):** 1D CNN autoencoder running at 1 Hz. Detects patterns that deviate from what this specific engine normally does at this phase of flight — subtle anomalies that don't cross hard limits yet.

**Advisory system:** Either layer can generate a pilot advisory independently. Advisories are rate-limited to prevent nuisance chatter.

**Emergency trigger:** Requires both layers to agree simultaneously. The joint confirmation requirement is the primary false-alarm suppression mechanism for the emergency overlay.

This layering mirrors how a careful pilot thinks: hard limits are non-negotiable (Layer 1), but experienced judgment about what "sounds wrong" operates on softer pattern recognition (Layer 2). Neither is sufficient alone for an emergency declaration.

---

## 3. Layer 1 — Physics Rules

Runs on every engine data sample, before the ML call. Returns an array of advisory objects (may be empty).

| Rule               | Threshold                      | Severity | Notes                                                           |
| ------------------ | ------------------------------ | -------- | --------------------------------------------------------------- |
| Oil pressure low   | < 25 PSI                       | act-now  | Skips zero (sensor dropout)                                     |
| CHT exceedance     | > 420°F cruise / > 440°F climb | act-now  | Phase-aware limit; climb relaxed to account for normal CHT rise |
| MAP sudden drop    | > 3 in Hg in one second        | act-now  | Compares against previous sample                                |
| RPM sudden drop    | > 200 RPM in one second        | act-now  | Guards RPM > 500 to avoid ground noise                          |
| Fuel flow collapse | < 2 GPH at RPM > 2000          | act-now  | Cruise-power guard prevents false alert at idle                 |

Advisory rate limiting: act-now advisories repeat no more than once per 5 seconds per type. Monitor-severity advisories are limited to once per 30 seconds.

---

## 4. Layer 2 — ML Inference

Each engine data frame is flattened and passed to the TFLite plugin:

```javascript
await this._plugin.processSample({
    rpm, egt1, egt2, egt3, egt4,
    cht1, cht2, cht3, cht4,
    oil_temp, oil_press, fuel_flow,
    altitude, mp, carb_temp,
    fuel_remaining, ground_speed, distance_nm
});
```

The plugin returns:

```json
{ "score": 0.047, "anomaly": true, "phase": "cruise", "latencyMs": 9 }
```

When `anomaly` is true, the JS layer compares the current 13-parameter set against a rolling 60-sample (60-second) baseline average to identify the most-deviated parameter:

```
deviation = |current - baseline| / baseline
```

The parameter with the highest deviation triggers an advisory, provided it exceeds 5%. The advisory text is generated from pre-written templates keyed on parameter and direction (e.g., `ml_egt3_high`, `ml_oil_press_trending`). Severity escalates to `act-now` if the raw value also exceeds a hard threshold (EGT > 1650°F, CHT > 400°F, oil pressure < 40 PSI).

The rolling baseline is intentional: it adapts to this specific engine on this specific flight, rather than comparing against fleet averages. A cylinder that normally runs 30°F hotter than the others won't trigger on that alone.

---

## 5. TFLite Model — Training Pipeline

### Training Data

The model was trained exclusively on flight data from N194JT — 102 flights between May 2024 and May 2026, all Lycoming O-360 A1A on the same airframe (79 merged CSVs plus 23 recent flights added during a May 2026 retraining). Total: approximately 167,000+ rows at 1 Hz. Data source: Savvy-format CSVs exported from the Pi's `engine_monitor.py`, merged with GPS/attitude data from Stratux.

This is intentional. The model does not need to generalize across aircraft types or engine variants — it needs to know what *this engine* looks like in each phase of flight. Training on a mixed fleet would require the model to accommodate inter-aircraft variance that isn't present here, raising the anomaly threshold and reducing sensitivity.

### Feature Set

13 parameters used for training:

```
RPM, EGT 1, EGT 2, EGT 3, EGT 4,
CHT 1, CHT 2, CHT 3, CHT 4,
Oil Temp, Oil Pressure, Fuel Flow, altitude_ft
```

Normalization statistics derived from training data (z-score, per feature):

| Feature       | Mean     | Std    |
| ------------- | -------- | ------ |
| RPM           | 1932     | 657    |
| EGT 1–4 (avg) | ~1227 °F | ~168   |
| CHT 1–4 (avg) | ~325 °F  | ~45    |
| Oil Temp      | 177 °F   | 37     |
| Oil Pressure  | 70.5 PSI | 8.7    |
| Fuel Flow     | 6.25 GPH | 4.1    |
| Altitude      | 1501 ft  | 12,975 |

### Architecture: 1D CNN Autoencoder

The model is a convolutional autoencoder operating on 60-second time windows. An autoencoder is the right choice here because the training data is entirely *normal* flight data — there are no labeled anomalies. The model learns to reconstruct normal engine patterns. Anomaly score = MSE between input and reconstruction. A pattern the model cannot reconstruct well, by definition, is something it has not seen before in normal operation.

```
Input: (60 timesteps × 13 features)

Encoder:
  Conv1D(64, kernel=5, padding=same, relu)
  MaxPool1D(2)                               → (30, 64)
  Conv1D(64, kernel=5, padding=same, relu)
  MaxPool1D(2)                               → (15, 64)
  Conv1D(64, kernel=5, padding=same, relu)
  MaxPool1D(3)                               → (5, 64)
  Flatten                                    → 320
  Dense(8, relu) ← bottleneck

Decoder:
  Dense(320, relu)
  Reshape(5, 64)
  UpSample(3)                                → (15, 64)
  Conv1D(64, kernel=5, padding=same, relu)
  UpSample(2)                                → (30, 64)
  Conv1D(64, kernel=5, padding=same, relu)
  UpSample(2)                                → (60, 64)
  Conv1D(13, kernel=1, padding=same)         → (60, 13)

Loss: MSE(input, reconstruction)
Optimizer: Adam, early stopping (patience=10), ReduceLROnPlateau (factor=0.5)
```

The 8-dimensional bottleneck compresses 780 input values (60×13) into 8 latent features. This compression forces the encoder to discard noise and retain only the dominant patterns of normal engine behavior.

### Windowing

- Window size: 60 samples (60 seconds at 1 Hz)
- Stride: 30 samples (50% overlap)
- Windows where RPM mean < 100 (engine off) are excluded
- Dominant phase assigned per window (most common phase label across 60 samples)
- Shutdown/unknown windows excluded from training

### Phase Detection During Training

Eight phases are labeled algorithmically from RPM, GPS altitude rate (60-second smoothed), and ground speed:

| Phase   | Labeling rule                                  |
| ------- | ---------------------------------------------- |
| startup | RPM 0→800+, first 60s after engine start       |
| warmup  | RPM < 1400, speed < 30 kt, post-startup        |
| runup   | RPM 1600–2100, speed < 15 kt, AGL < 300 ft     |
| takeoff | RPM > 2400, AGL ≤ 1000 ft, positive alt rate   |
| climb   | RPM > 2100, alt rate > +300 fpm                |
| cruise  | RPM 2100–2550,                                 |
| descent | alt rate < −300 fpm                            |
| landing | AGL < 800 ft, descending or slow, post-takeoff |

Altitude rate uses a ±30-sample (60-second) window to suppress turbulence and GPS noise. An earlier ±5-sample window caused cruise windows to oscillate into climb/descent on normal GPS altitude jitter, contaminating the cruise training distribution.

Training row counts by phase across 79 flights:

| Phase   | Rows   |
| ------- | ------ |
| warmup  | 47,131 |
| cruise  | 51,113 |
| takeoff | 28,911 |
| descent | 23,576 |
| landing | 5,875  |
| climb   | 4,558  |
| startup | 3,232  |
| runup   | 2,630  |

### Per-Phase Anomaly Thresholds

After training, thresholds are computed per phase as mean + 3σ of reconstruction error on a held-out 10% test set:

| Phase             | Threshold (MSE) |
| ----------------- | --------------- |
| startup           | 3.7148          |
| warmup            | 1.1656          |
| runup             | 0.1357          |
| takeoff           | 0.0840          |
| climb             | 0.0251          |
| cruise            | 0.0356          |
| descent           | 0.0648          |
| landing           | 0.0924          |
| global (fallback) | 0.8815          |

The takeoff threshold (0.084) was corrected in the May 2026 retraining. A bug in the on-device `PhaseDetector` had been misclassifying the takeoff ground roll as cruise: the 10-sample altitude-rate buffer reads ~0 fpm at throttle advance because all prior samples are stationary, so the takeoff branch never fired during the ground roll and those windows were labeled cruise. The fix added ground speed > 20 kt as an OR condition so the ground roll is correctly identified before the altitude-rate buffer catches up. The contaminated training distribution had set the takeoff threshold at 0.047 — nearly the same as cruise (0.036) — producing excessive false alarms on departure. The corrected threshold is 0.084.

The startup threshold (3.71) is roughly 100× higher than the cruise threshold (0.035). This reflects the genuine variance in cold-start behavior — EGTs spread unevenly, oil temperature rising, RPM hunting — all of which produce high reconstruction error without being anomalies. A model that held startup to cruise-level tolerances would produce constant false alarms during the first minute of every flight.

### Export and Quantization

The model is exported to TFLite with INT8 quantization using a representative dataset of 500 training windows for calibration:

| Artifact                                | Size     |
| --------------------------------------- | -------- |
| `anomaly_v2.tflite` (INT8)              | 127.9 KB |
| `anomaly_v2_float32.tflite` (reference) | 380.2 KB |

The INT8 model runs on the Snapdragon 870's Hexagon 780 NPU. Inference latency on device: **8–12 ms** average at 1 Hz. The float32 model is retained for validation and threshold recomputation without retraining.

---

## 6. Flight Phase Detection (Runtime)

At runtime, the phase used for threshold selection and advisory context is determined through a three-tier priority stack:

**Tier 1 — GPS altitude rate (highest priority when airborne):**
A 60-sample (60-second) circular buffer of MSL altitudes feeds a smoothed altitude rate in fpm. Thresholds match training: climb > +300 fpm, descent < −300 fpm, cruise = within ±300 fpm. Field elevation is estimated as the running minimum of the first 300 ground samples (speed < 20 kt, RPM < 2000). AGL is derived from MSL minus field elevation.

This tier overrides the model's phase output when the aircraft is airborne. Without this, turbulence that produces a 35 ft GPS altitude change over 10 seconds would flip the model's phase estimate, destabilizing CHT limits and baseline comparisons that depend on knowing the current phase.

**Tier 2 — Model phase output:**
Used when GPS data is unavailable or the aircraft is still on the ground.

**Tier 3 — MAP/RPM heuristic:**
Final fallback when neither GPS nor model phase is available:

- RPM < 1000 → ground
- MAP > 26 in Hg and RPM > 2400 → climb
- MAP < 22 in Hg and RPM < 2400 → descent
- Otherwise → cruise

The GPS phase override is also written to the `ml_phase` column in the Savvy CSV, replacing the raw model output with the smoothed value. This makes the phase column more meaningful for post-flight correlation.

---

## 7. Startup Sticky Valve Detection

This feature runs independently of the ML layer. It is implemented in both the Pi-side Python (`engine_monitor.py`) and the tablet JS frontend (`engine-page.js`) — the Pi version exposes it over the existing HTTP API; the tablet version runs client-side as a fallback if the Pi connection is lost.

### Detection Logic

- **Window:** First 10 minutes after engine start (RPM > 500)
- **Trigger condition:** One cylinder EGT < 50% of the mean of the other three, persisting continuously for ≥ 30 seconds
- **Auto-clear:** Alert clears immediately if the cylinder recovers above the ratio threshold
- **Dismissible:** Pilot can acknowledge and suppress for the remainder of the flight

Formally: for cylinder i,

```
ratio_i = egt_i / mean(egt_j for j ≠ i)

if ratio_i < 0.50, for ≥ 30 continuous seconds → STICKY VALVE ALERT: Cylinder i
```

The 30-second persistence requirement prevents spurious alerts during the brief EGT transient immediately after start, when cylinder combustion is still stabilizing. The 50% ratio threshold was chosen empirically: a sticky exhaust valve that is holding the valve open produces near-zero combustion in that cylinder, so the affected EGT typically runs 60–80% below the others — not marginally low.

### What It Is Detecting

An exhaust valve that sticks open during cold starts prevents the cylinder from building compression. The cylinder misfires, the EGT stays cold, and the engine runs rough at low RPM. This is Lycoming's "morning sickness" — well-documented in SB 388C (exhaust valve-to-guide clearance). It is most common on engines that sit for extended periods, particularly in cold or humid conditions.

If the valve frees itself as the engine warms, no action is needed. If it persists through the 10-minute window, the alert remains visible.

### Cam Degradation Signal

A single occurrence is a morning-sickness event. Repeated occurrences across multiple flights — visible in the FlyTab logbook, which records whether a sticky valve alert fired during each flight — are the early signature of cam and lifter wear. The Lycoming O-360 has a known cam/lifter degradation failure mode: a spalled cam lobe reduces lift, causing the exhaust valve to open incompletely. Early manifestation is intermittent cold starts; late manifestation is persistent misfires, rough running at all power settings, and eventual engine failure.

The current implementation does not automatically cross-correlate across flights — it requires the pilot to notice the pattern in the logbook. Cross-flight trend tracking (e.g., "sticky valve fired on 3 of the last 5 flights") is an obvious enhancement that would turn this from a single-flight alert into a degradation trend detector.

---

## 8. Emergency Trigger (Joint Physics + ML)

The emergency glide overlay fires only when both of the following are true in the same 1-second cycle:

**Physics alarm (any one sufficient):**

- MAP drop > 5 in Hg since previous sample
- RPM drop > 300 RPM since previous sample
- Oil pressure < 20 PSI

**ML confirmation:**

- `result.anomaly === true`

The joint requirement means a sensor glitch that trips one physics rule without the ML model also seeing an anomaly does not trigger the overlay. Similarly, a high ML anomaly score during an aggressive LOP lean-out does not trigger the overlay unless a physics rule also fires. In practice this means the overlay has not had a single false trigger in flight testing.

### Glide Computation

On trigger, the system computes:

```
altAgl = altMSL - terrainElevation(lat, lon)
glideRangeNm = (altAgl × glideRatio) / 6076
adjustedRangeNm = glideRangeNm × clamp(groundSpeed / 80, 0.6, 1.3)
```

Glide ratio: 10.0 (RV-9A, configurable). Best glide: 80 kt. The wind adjustment uses ground speed vs. nominal best-glide as a proxy for headwind/tailwind effect, clamped to 0.6–1.3× to prevent unrealistic results.

Terrain elevation is sampled from a pre-loaded terrain grid (offline mbtiles). Terrain along the direct route to each candidate airport is sampled at 10 equidistant points to check for obstacle clearance.

### Airport Ranking

All airports within `adjustedRangeNm` are retrieved from the local NASR IndexedDB and scored:

| Factor            | Points                                           |
| ----------------- | ------------------------------------------------ |
| Runway length     | 0–40 (scaled to 5,000 ft)                        |
| Paved surface     | 20                                               |
| Wind alignment    | 0–15 (from FIS-B METAR or nearest METAR)         |
| Terrain clearance | 0–15 (proportional to overhead clearance margin) |
| Proximity         | 0–10 (10 − distance_nm)                          |

Reachable airports (overhead altitude > required, no terrain obstacle within 500 ft margin) sort above unreachable ones within the same tier.

### Approach Guidance Panel

Tapping an airport opens a live panel (1 Hz updates):

- Heading and distance to threshold (great-circle, from current GPS)
- Target altitude overhead (airport elevation + 500 ft threshold clearance + 2 nm pattern allowance × ft/nm from glide ratio)
- Profile status: ON PROFILE / HIGH (S-turns or slip needed) / LOW (fly best glide)
- Required V/S to arrive overhead at target altitude
- Best runway based on FIS-B METAR wind (fallback to nearest airport with valid wind data)
- CTAF / Tower frequencies from NASR

The map shrinks to a floating panel when approach guidance is active, keeping the current-position-to-airport track line visible.

A 60-second cooldown prevents re-triggering. Test mode (long-press on the ML badge for 2 seconds) bypasses the cooldown and uses a configurable simulated AGL altitude (default 5,000 ft) when on the ground.

---

## 9. Advisory System

Both layers dispatch advisories through a shared `_dispatchAdvisory()` method:

1. **Rate limit check:** Suppress if same advisory type fired within 5s (act-now) or 30s (monitor).
2. **Ring buffer:** Append to 20-entry post-flight advisory log (persists until next engine start).
3. **Display:** Banner with 15-second auto-dismiss; color and animation vary by severity.
4. **Event dispatch:** `engineml:advisory` CustomEvent on `document` for any other module to consume.

Advisory severity tiers:

| Tier      | Color         | Use                                              |
| --------- | ------------- | ------------------------------------------------ |
| `act-now` | Red, flashing | Requires immediate pilot response                |
| `monitor` | Amber         | Track and evaluate; no immediate action required |

The ML layer (Layer 2) generates `monitor` by default. Severity escalates to `act-now` only when the ML-flagged value also exceeds a hard limit (e.g., ML flags EGT #3 elevated, and that value is also > 1650°F).

---

## 10. Savvy CSV Integration

Four ML columns are appended to every row of the standard Savvy format:

```
..., ml_phase, ml_score, ml_anomaly, ml_latency_ms
```

| Column          | Format       | Notes                                                                          |
| --------------- | ------------ | ------------------------------------------------------------------------------ |
| `ml_phase`      | string       | GPS-smoothed phase (startup/warmup/runup/takeoff/climb/cruise/descent/landing) |
| `ml_score`      | float (4 dp) | Reconstruction MSE — raw anomaly score                                         |
| `ml_anomaly`    | 0 or 1       | 1 if score exceeds per-phase threshold                                         |
| `ml_latency_ms` | integer      | Plugin inference time in milliseconds                                          |

Recording auto-starts when RPM > 500 for 10 consecutive seconds, auto-stops when RPM = 0 for 60 seconds. Files are written to `Documents/FlyTab/flights/` on-device, named `YYYYMMDD_HHMMZ.csv` and renamed to `YYYYMMDD_DEP-DEST.csv` post-flight using NASR nearest-airport lookup against the first and last GPS fix.

The post-flight logbook entry includes:

```json
{
  "samples": 4812,
  "duration_s": 4811,
  "anomaly_count": 23,
  "anomaly_pct": 0,
  "avg_latency_ms": 9,
  "phase_dist": { "cruise": 61, "climb": 14, "descent": 18, "takeoff": 4, "landing": 3 },
  "advisory_count": 2
}
```

---

## 11. Performance and False Positive Observations

**Inference latency:** 8–12 ms average on Snapdragon 870 NPU at 1 Hz. Worst observed: 22 ms on first inference after app resume from background (JIT warm-up). No latency-related missed samples observed.

**Physics layer false positives:** Zero observed in flight testing. The rate-limiting and guards (RPM > 500 for RPM delta, RPM > 2000 for fuel flow collapse, phase-aware CHT limits) have been sufficient to prevent nuisance alerts.

**ML layer false positives:** The most reliable trigger for a spurious ML anomaly is an aggressive lean-out during a LOP lean-forward technique. As fuel flow drops rapidly and EGTs shift across all cylinders simultaneously, the reconstruction error temporarily spikes above the cruise threshold. The effect lasts 15–30 seconds. Because the emergency trigger requires the physics layer to also fire, this does not produce any emergency overlay. The ML advisory that fires ("fuel flow below baseline") is accurate as a description but not useful as an alert — the pilot intentionally reduced fuel flow.

**Mitigation applied:** The 30-second monitor-severity rate limit suppresses advisory repetition during leaning. No threshold adjustment has been needed.

**ML layer sensitivity in non-LOP conditions:** Conservative but not inert. In one instance, the model flagged an EGT #2 deviation approximately 4 minutes before it became visible to the pilot on the EGT gauge. In two instances, it flagged transient fuel flow variations that resolved without intervention. The model has not yet been validated against a known mechanical event.

---

## 12. Some Ideas for Collaboration

The most useful thing Savvy could provide that I cannot generate myself is ground truth. I can observe that my model flagged an anomaly; I cannot independently determine whether the flag corresponded to something real.

**Cross-validation via ml_anomaly column**  
Every CSV I upload to SavvyAnalysis already carries `ml_anomaly` flags and `ml_score`. If GADfly is run post-flight on the same data, the correlation is directly readable: which flights did both systems flag? Which did only one flag? The false-positive and false-negative rates fall out of that comparison without any additional instrumentation. This could be done retroactively on existing uploads if the columns are present.

**Threshold calibration from fleet data**  
My thresholds were derived from 79 flights on one airframe. Savvy has O-360 A1A data across many aircraft. The mean and standard deviation of reconstruction error for cruise-phase windows on normal O-360 engines would tell me whether my cruise threshold (0.0356 MSE) is correctly placed or whether I am sitting 1σ vs. 3σ from the fleet mean. A threshold that is too low relative to fleet variance produces excessive false positives when the engine is operating normally but slightly differently than N194JT's baseline; too high misses real anomalies.

**Training data contribution**  
79 flights is a reasonable dataset for a single-aircraft model but thin for anything more general. If Savvy wanted to explore an edge model distribution — a TFLite model trained on fleet data, pre-calibrated to a specific engine type, downloadable from SavvyAnalysis — these CSVs with phase and anomaly labels already attached are ready to contribute. The training pipeline is already written.

**Sticky valve / cam degradation cross-flight tracking**  
The current implementation logs whether a sticky valve alert fired per-flight. Savvy's historical data for N194JT would allow a retrospective check: do any of my CHT or EGT trends in SavvyAnalysis align with the flights where the startup alert fired? If Savvy's tools already compute CHT spread trend across flights, that's a natural place to surface a "repeated startup misfires" indicator as a cam/lifter wear flag — something neither the on-device alert nor the post-flight SavvyAnalysis trend chart currently does explicitly.
