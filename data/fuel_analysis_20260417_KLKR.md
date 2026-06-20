# Fuel Tank Level Analysis — 20260417 KLKR–KLKR

**Aircraft:** RV-9A N194JT, Lycoming O-360 A1A  
**Flight:** 5:42–6:31 PM EDT (48 min), local pattern work  
**Issue reported:** Fuel tank gauge fluctuations observed in cockpit

---

## Bottom Line

The tank level fluctuations are **attitude-induced sensor artifacts, not actual fuel movement or a gauging fault.**

When the aircraft is in a banked, nose-down turn, L2 drops sharply while L1 rises by an almost identical amount — and the fuel totalizer (Gallons Remaining) does not move. Fuel is sloshing within each tank away from the sensor element. The sensors are reading the position of the fuel surface relative to the probe, not the actual quantity in the tank.

**The fuel totalizer is accurate and should be the primary fuel reference in flight.**

---

## Key Evidence

### The Smoking Gun: Sensors Move in Opposite Directions

At 6:24:45–6:25:05 PM the aircraft made a sustained pattern turn (right bank ~30°, nose-down ~18–20°):

| Time | L1 | L2 | L1+L2 | Totalizer | Bank | Pitch | G |
|------|----|----|-------|-----------|------|-------|---|
| 6:24:45 | 7.1 | 6.4 | 13.5 | 17.4 | 27° | −30° | 0.78 |
| 6:24:48 | 8.2 | 5.7 | 13.9 | 17.3 | 35° | −21° | 0.77 |
| 6:24:51 | 9.3 | 5.1 | 14.4 | 17.3 | 34° | −16° | 0.75 |
| 6:24:53 | 10.0 | 4.6 | 14.6 | 17.3 | 29° | −18° | 0.81 |
| 6:24:57 | 10.7 | 3.8 | 14.5 | 17.3 | 20° | −18° | 0.74 |
| 6:25:03 | 11.4 | 2.9 | 14.3 | 17.3 | 31° | −17° | 0.77 |
| **6:25:05** | **11.5** | **2.8** | **14.3** | **17.3** | **30°** | **−20°** | **0.77** |

**Over 20 seconds:**
- L2 dropped 3.6 gal (from 6.4 → 2.8)
- L1 rose 4.4 gal (from 7.1 → 11.5)
- Totalizer: unchanged at 17.3 gal

Two tanks cannot simultaneously gain and lose 4 gallons. This is pure probe-attitude error.

---

## Was It Turbulence?

No. The vertical G data rules out turbulence as a cause:

| Metric | Value |
|--------|-------|
| Max G recorded | 1.05g |
| Min G recorded | 0.59g |
| Average G (whole flight) | 0.77g |
| Rows exceeding ±0.5g from 1.0g | **0** |
| Rows exceeding ±0.3g from 1.0g | 166 (5.6%) |

The flight average of 0.77g reflects sustained nose-low, banked pattern work — not turbulence. No turbulence event exceeded 0.5g deviation from normal. All large fuel fluctuations occurred at bank angles above 20° with nose-down pitch, not during G-loading events.

---

## What Triggers the Fluctuations

Every large tank sensor drop correlated with the same attitude signature:

- **Bank > 20°** (all large drops occurred above this threshold)
- **Pitch nose-down > −15°**
- **G-load ~0.76–0.78g** (unloaded turn)

| Event | L2 drop | Bank | Pitch | G |
|-------|---------|------|-------|---|
| Row 176 | 10.2→9.8 | 30° | −26° | 0.76 |
| Row 412 | 10.8→10.4 | 28° | −26° | 0.77 |
| Row 2516 | 6.4→5.7 | 35° | −21° | 0.77 |
| Row 2528 | 3.8→3.4 | 30° | −19° | 0.78 |
| Row 2692 | 5.4→5.0 | 34° | −26° | 0.77 |

**Pattern:** Every event is a coordinated banked descending turn — consistent with downwind-to-base and base-to-final turns in the pattern.

---

## Overall Fuel Accuracy

| Source | Start | End | Burned |
|--------|-------|-----|--------|
| Totalizer (Gallons Remaining) | 22.3 gal | 17.1 gal | **5.2 gal** |
| Calculated from avg fuel flow (6.33 GPH × 0.807 hr) | — | — | **5.1 gal** |
| L1 sensor | 10.0 | 9.0 | 1.0 gal |
| L2 sensor | 10.1 | 6.4 | 3.7 gal |
| L1+L2 sensor combined | 20.1 | 15.4 | **4.7 gal** |

The totalizer and flow-computed burn agree within 2%. The individual tank sensors under-report total burn by ~0.5 gal (10%) due to attitude errors accumulated over the flight.

**The totalizer is the only reliable fuel quantity reference in maneuvering flight.**

---

## Sensor Behavior: Root Cause

The RV-9A uses capacitance or float probes positioned at a fixed location in each tank. In straight-and-level flight, the fuel surface covers the probe uniformly. In a banked nose-down turn:

- The low-wing tank fuel migrates outboard and aft, away from the inboard probe → **reads falsely low**
- The high-wing tank fuel migrates inboard toward its probe → **reads falsely high**

This is a known characteristic of fixed-point fuel sensors in aerobatic/utility-category aircraft. It is not a FlyTab logging error or an EDM fault.

---

## Recommendations

1. **Pilot:** Use Gallons Remaining (totalizer) as the primary fuel reference. Ignore individual tank level gauges during maneuvering, turns, and approach.

2. **FlyTab display:** Consider adding a cockpit warning when L1 and L2 sum diverges from Gallons Remaining by more than 2 gal — this would flag sensor drift without alarming on normal attitude-induced swings.

3. **EDM calibration:** The post-shutdown fuel flow reading of 0.9 GPH (with RPM=0) should be investigated. If the flow transducer has a non-zero floor, the totalizer will over-count burn during shutdown and taxi-in.

---

*Analysis based on 2,965 data points from 20260417_KLKR-KLKR.csv*
