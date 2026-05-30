# FlyTab Bug List

Running list of bugs found from screenshot/flight review. Newest review at top.
Each item notes the source screenshot, confidence, and a likely root-cause pointer where known.

---

## Today's flight — 2026-05-29 (app v9.26)

Sim/replay flight: KLKR → KGRD planned, then an approach back into KLKR.
Screenshots in `screenshots/Screenshot_20260529-*.png`.

### A. ~~CRITICAL~~ — **FIXED v9.34** — False engine-anomaly emergency alert during the landing flare (14 ft AGL)
- **Source:** `Screenshot_20260529-114025.png`
- Full-screen red **"ENGINE ANOMALY CONFIRMED — No airports within glide range. Declare emergency — squawk 7700."** fired at **14 ft AGL** while landing at the destination (KLKR).
- **Root cause (confirmed):** `_checkEmergencyTrigger` in `web/cockpit/engine-ml.js` had no AGL lower bound. Throttle-to-idle in the landing flare produces the same physics-rule signatures as a total engine failure (MAP drop >5", RPM drop >300 RPM), the ML model flags the transition as anomalous (window built during the approach power setting), and `_hasLaunched` stays `true` because groundspeed is still >30 kts at 14 ft AGL — so the existing ground guard misses the flare.
- **Fix:** Added AGL guard at the top of the joint trigger: compute AGL from `_altHistory`/`_fieldElev`; suppress if AGL < 500 ft. Below 500 ft the pilot is committed regardless; a false 7700 call during the flare is dangerous noise. Genuine failures at pattern altitude (≥500 ft) still trigger. Verified: CDP test confirmed 14 ft suppressed, 1500 ft fires.
- **Commit:** `web/cockpit/engine-ml.js`

### B. ~~HIGH~~ — **FIXED v9.34** (consequence of A) — "0 airports within 0 nm glide range" while landing AT an airport
- **Source:** `Screenshot_20260529-114025.png` (same alert)
- `EmergencyGlide.trigger()` computed glide range as `14 ft × 10 / 6076 = 0.0 nm` → 0 airports found. This was entirely a consequence of Bug A firing at 14 ft AGL. With Bug A suppressed below 500 ft AGL, Bug B never occurs.

### C. MEDIUM (reproducible) — Route table per-phase TIME values don't sum to the leg/total
- **Sources:** `Screenshot_20260529-101410.png` (KLKR→KGRD: CLB 26m + CRZ 12m + DES 10m = 48m, but TOTAL 26m / header 30m); `Screenshot_20260529-111005.png` (CORON→KLKR: CLB 9m + CRZ 5m = 14m, TOTAL 9m).
- The climb/cruise/descent phase sub-rows show times that exceed the leg/total time. A 26-min climb on a 70 nm leg is also implausible. FUEL columns sum correctly; only TIME is wrong.
- **Likely area:** per-phase time computation in `web/cockpit/route-table.js` profile builder (`_buildProfileData`).

### D. MEDIUM — Degenerate approach altitude profile (cruise altitude shown as 50 ft)
- **Sources:** `Screenshot_20260529-111005.png`, `-111306.png`, `-111514.png`
- After loading the CORON→RW06→KLKR approach, the profile shows **CLB 0→50, CRZ 50, DES 50→0** — a 24 nm leg "cruising" at 50 ft, while the aircraft is actually at ~4,500 ft. Origin CORON altitude shows 0.
- The altitude profile for the approach/return leg isn't being computed (defaulting to a 50 ft floor).
- **Likely area:** altitude/profile assignment when an approach is loaded as the active route.

### E. ~~LOW~~ — **FIXED v9.33** — FIS-B towers show "-999 dB" sentinel as a literal signal value
- **Source:** `Screenshot_20260529-110503.png` (FIS-B status page)
- Towers with 0 messages/min displayed **"-999 dB"** in red; additionally they sorted to the top of the list (old sort: `-999 || 0 = 0`).
- **Fix:** `_renderTowers` in `web/cockpit/fisb-status.js` — values ≤ −100 display `—` (no dB suffix), sort to the bottom. Verified via CDP with injected mock tower data.

### F. BUG — Fuel-below-reserve warning fires incorrectly on a short leg
- **Source:** `Screenshot_20260529-101155.png`
- Route planner warns "Fuel below reserve: -2.0 gal at dest, 10 gal reserve required" on a 70 nm / 3.7 gal route starting with ~26.6 gal on board. With 3.7 gal used, ~22.9 gal would remain — far above the 10 gal reserve threshold. The warning should NOT fire.
- **Reclassified** from INVESTIGATE to BUG: the math is clear, the reserve check is wrong (likely using stale, incorrect, or zero starting fuel figure).
- **Likely area:** fuel-reserve calculation in the route planner — check what starting fuel value the reserve check reads.

### Possible / low-confidence (worth a glance, not confirmed)
- Flight phase shows **"STARTUP"** after landing while stopped on the ground (`-114405/-114418/-114613/-114652/-114700`) — phase detector may mislabel a stopped-after-landing state.
- Dense ADS-B traffic labels overlap into an unreadable cluster in a high-traffic area (`-110406.png`).
- Fuel-gauge overlay total (~28 gal) vs TIC entry total (26.6 gal) — minor mismatch (`-101604.png` vs `-101555.png`).

---

## Earlier review — 2026-05-28 (app v9.23)

Screenshot: `screenshots/Screenshot_20260528-143757.png` (route table, KLKR route).
Two other shots that day (`-163252` LAYERS panel, `-163322` MORE drawer) showed no visible bugs.

### 1. HIGH — Route summary header shows the wrong destination (stale)
- Header + destination search box show **KMHT** (729 nm / 5:12 / 40.8 g / DEST:34.0), but the flight strip says **KLKR → KDMW** and the footer shows **DEST 383 nm / ETE 2:44** — which matches a KDMW route at 140 kt cruise.
- Corroborating: header `DEST:34.0` (fuel at destination) is *higher* than the first leg's REM (30.1, declining) — impossible for the final destination.
- **Likely root cause:** `web/cockpit/route-table.js:236-237` builds the header from `plan.flight_plan?.destination` (stale KMHT) and only falls back to `plan.waypoints[last].icao` (current KDMW) when that's null. When the destination changes, the waypoint array is rebuilt but `flight_plan.destination` isn't. Matches the `_lastPlan` / state-lifecycle hazard noted in CLAUDE.md.

### 2. MEDIUM — Climb-leg row: ALT column overlaps HDG/BRG
- On the active CLB leg the climb-altitude range string ("486 → 7,000 ↑1,500") is too wide for the ALT column and collides with the HDG/BRG values. Other rows render cleanly.
- **Note:** likely still present in v9.26 — today's shots show the climb-rate annotation truncated ("↑1,5") in the same column.
