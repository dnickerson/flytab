# FlyTab User Manual

**Version 9.75 · RV-9A N194JT**

---

## What FlyTab Is

FlyTab is an Android cockpit application for experimental aircraft. It combines a moving map with live FIS-B weather, ADS-B traffic, and engine data from the Pi engine monitor — all on one screen in the cockpit.

It works with two hardware pieces: a Stratux ADS-B/FIS-B receiver (GPS, traffic, weather) and a Raspberry Pi running the engine monitor (EGT, CHT, RPM, fuel flow). Either can be absent; FlyTab degrades gracefully.

---

## Hardware Requirements

| Device | Purpose | Connection |
|---|---|---|
| Lenovo Yoga Tab Plus | Runs FlyTab | — |
| Stratux | GPS, ADS-B traffic, FIS-B weather | Wi-Fi (192.168.10.1) |
| Raspberry Pi (engine monitor) | EGT/CHT/RPM/fuel flow | Wi-Fi (192.168.1.x) |
| Home server (preflight) | Sectional/IFR tiles, plates, NASR data | Wi-Fi (192.168.1.x) |

FlyTab connects automatically on app launch. The status bar at the top shows connection state.

---

## Screen Layout

```
┌───────────────────────────────────────────────────────┐
│  GPS  ⚠  FIS-B  OFFL  NASR  ML  REC  12:34  z9   v9  │ ← Status bar
├───────────────────────────────────────────────────────┤
│ ┌──────┐                              │   125 kt      │
│ │ L  R │                              │   GS          │ ← Instrument
│ │▐▌ ▐▌ │        Moving Map           │               │   strip
│ │  ⊷  │                              │  3,500 ft     │   (right edge)
│ │ 3.2G │                  ✈          │   ALT         │
│ │ 2:45 │              own-ship       │               │
│ └──────┘                        ⊙  →  ⋮              │
│  Fuel widget                                          │
│  (top-left)      [FIS-B ⇄] radar badge (bottom-left) │
├───────────────────────────────────────────────────────┤
│ GS —— ALT —— BARO —— CRS —— FUEL —— DEST —— ETE ——    │ ← Instrument strip
├───────────────────────────────────────────────────────┤
│  ≡  │ 🗺MAP │ ✈APT │ ⚙ENG │ ✅CHK │ 📻CLR │ ⊟CMPCT │ ⋯ │ ← Tab bar
└───────────────────────────────────────────────────────┘
       ↑ LAYERS (far left, opens layer panel)        ↑ MORE
```

**Status bar** — always visible at the top. Badges show connection state and alerts from left to right: GPS fix, weather advisory (⚠, when active), FIS-B, internet, NASR age, engine ML, flight recording, UTC clock, map zoom level, app version.

**Map area** — fills most of the screen. Key floating elements:
- **Fuel tanks widget** (top-left) — L/R tank bars, GPH, endurance. Tap **L**/**R** to switch active tank; tap **✎** to edit quantities.
- **Instrument strip** (right edge) — ground speed and altitude at a glance.
- **Radar source badge** (bottom-left, when radar is active) — shows active source (FIS-B or INET) with a `⇄` tap target to switch.
- **Corner buttons** (bottom-right of map): **⊙** auto-pan toggle, **→** direct-to, **⋮** map menu.

**Instrument strip** — always visible below the map. Shows the configured numeric fields (default: ground speed, altitude, nearest altimeter setting, course, fuel, distance to destination, ETE). Tap **FUEL** to open the fuel overlay; tap **DEST** or **ETE** to open the power tradeoff panel. The field list itself is set in `cockpit-config.json`, not from the strip.

**Tab bar** — seven tabs along the bottom. **≡ LAYERS** at the far left opens the layer and weather toggle panel. **⋯ MORE** at the far right opens the secondary-functions drawer.

---

## Status Bar Badges

| Badge | Green | Amber | Red / Absent |
|---|---|---|---|
| **GPS** | 3D fix | 2D fix | No fix |
| **FIS-B** | UAT radio connected and receiving | — | No UAT data |
| **OFFL** | Online | — | Offline (always shows) |
| **NASR** | Database current | ≥7 days old | Very old |
| **ML** | Engine anomaly score normal | Elevated | Anomaly detected |
| **REC** | Flight recording active | — | Not recording |
| **PI vX.X** | Hidden — Pi build matches what this app requires | Shown — connected Pi's software is older than this app needs | — |

The **advisory** badge appears between GPS and FIS-B when a weather advisory is active along the route.

**The PI badge is hidden unless there's a mismatch.** It only appears when the connected Pi's engine monitor software is older than this build of FlyTab expects — a real possibility if the tablet gets updated without also redeploying the Pi (`bash deploy-pi.sh`). Tap it to open the ENG page, which carries the full detail: both version numbers and the exact command to run. Engine data keeps displaying normally either way — a mismatch is a preflight problem to fix on the ground, not a reason to lose the engine page in the air.

---

## Tab Reference

### MAP — Moving Map

The primary cockpit view. Shows position, route, weather, traffic, and airspace overlays.

**Base chart** — Switch between Vector (clean low-clutter), Sectional, IFR Low, and TAC using the **LAYERS tab** (far left of the tab bar).

**Airspace** — Class B (solid blue), C (magenta), D (blue dashed) drawn at correct altitude limits. Tap an airspace boundary for the name and altitudes.

**Own-ship** — Blue chevron showing aircraft position and heading. Appears once GPS locks. The instrument strip on the right shows ground speed and altitude at a glance.

**Traffic** — ADS-B targets shown as arrows with callsign and relative altitude (+/−). Tap a target for full details: callsign, altitude, ground speed, squawk. Traffic disappears automatically if stale.

**Route line** — When a route is loaded, the magenta line connects waypoints. Your current leg is highlighted. The nav strip below shows distance and ETE to the next waypoint and destination.

**Radar loop** — When radar is enabled, a slider appears (bottom of map area) to scrub through up to 55 minutes of NEXRAD history.

**Airport popup** — Tap any airport symbol for runway data, elevation, frequencies, fuel availability, and direct-to shortcut.

---

### APT — Route Airports

Shows all airports on the active route. Tap any entry for the full airport detail view, including runways and approach plates. Use this as your pre-approach briefing page for destination and alternates.

---

### ENG — Engine Monitor

Live engine data from the Pi. Updates approximately every second.

| Gauge | What it shows |
|---|---|
| **RPM** | Engine speed with color-coded bar |
| **% Power** | Calculated power percentage |
| **Fuel** | Total usable fuel remaining (gal) and endurance |
| **GPH** | Fuel flow; shows ROP/LOP indicator for leaning |
| **EGT 1–4** | Exhaust gas temp, all cylinders, bar graph |
| **CHT 1–4** | Cylinder head temp, all cylinders, bar graph |
| **Oil Temp** | Oil temperature |
| **Oil Press** | Oil pressure |

**The FUEL STATUS panel reads the same tracked fuel figure as everything else.** REMAINING, ENDURANCE and RANGE come from your tracked tank state — or from a manual override if you have set one — the same canonical figure behind the fuel tanks widget, the route table's REM column and the DEST badge. They no longer read the EDM's own totalizer, which could disagree with the rest of the fuel displays.

**If no tank quantities have been entered, the whole panel says so.** REMAINING shows `--.-`, ENDURANCE and RANGE show dashes, and the total-fuel bar is empty with the label `--% (--.-/36 gal)` and no colour. That is deliberate: with nothing tracked the page has no live measurement, and showing full tanks there would tell you there is more fuel on board than is actually known. Enter your fuel — the **✎** button on the fuel tanks widget, or the Fuel Entry screen — to get live numbers back.

**Empty tanks look different from untracked tanks.** If you are tracking fuel and the tanks really are down to zero, REMAINING reads `0.0` and the bar is red. A red bar always means low fuel; a blank, colourless bar always means "no fuel data entered." The two never look the same.

**UNCONFIRMED banner.** If more than 45 minutes pass without the tracker integrating a fuel-flow sample (engine data dropped out, or the app was closed), the panel keeps showing the last tracked figure but marks it: REMAINING turns amber and an amber banner reads "UNCONFIRMED — TANK STATE NOT UPDATED IN 45+ MIN. REMAINING MAY READ HIGH; CONFIRM FUEL." The number is kept because it is still your best starting point, but it does not include anything burned during the gap, so it reads high. Confirm or re-enter your fuel to clear it.

**USED (FLIGHT)** shows gallons burned so far this flight, from the Pi's fuel tracker. It previously always read `--.-`.

**LEFT (EDM SENDER) / RIGHT (EDM SENDER)** — the two small tank bars under the gauges are raw EDM float-sender readings, *not* the tracked figure. They are labelled that way because they come from a different and less reliable source and can disagree with REMAINING above. On this airframe the senders are only meaningful below 12 gallons per side; above that they read a flat value, so the bar is drawn empty and the number shows `—` rather than a figure you might mistake for a real level. This matches how the fuel tanks widget already treats its `s:` sender readouts.

The total-fuel bar shows fuel remaining against the aircraft's full capacity from the aircraft page (36 gallons, 2 × 18-gallon tanks). It previously used a hardcoded 34, so percentages now read slightly lower for the same gallons — about 3 points lower at half tanks. The bar turns amber at 8 gallons and red at 4, matching the DEST badge thresholds. Those two figures are configurable (`enginePage.fuelCautionGal` / `fuelWarningGal`); changing them previously had no effect on this bar, and now does.

The **TIC vs EDM** row is unchanged — it still compares your tic-mark measurement against the EDM's own totalizer. Disagreement between those two is exactly what the row exists to show, so it deliberately does not use the tracked figure.

The **engine advisory banner** (below the status bar, on any tab) appears in red if the ML anomaly detector finds an abnormal pattern in the current engine data. Tap it to see which parameters are outside normal for this phase of flight.

**Sticky-valve caution (startup only)** — During engine start, if one cylinder's EGT rise noticeably lags the other three, you may see "Cylinder N EGT rise lagging others during startup (possible sticky valve) — UNVALIDATED CHECK, confirm on ground." This check is new and its sensitivity has not yet been tuned against a confirmed sticky-valve event — treat an alert as a prompt to inspect on the ground, not a confirmed diagnosis.

The **Engine ML** monitor (MORE → Engine ML) shows the real-time anomaly score, per-feature reconstruction errors, and the current flight phase (startup, warmup, taxi_out, runup, takeoff, climb, cruise, descent, approach, landing, taxi_in, or shutdown). The model was trained on N194JT flight data and knows what this engine normally does in each phase.

**FLIGHT DATA** now also shows **EST. TAS** — an estimate from ground speed and density altitude (roughly +2%/1000 ft DA), not a wind-corrected true airspeed. Treat it as approximate.

**CRUISE TARGETS** — recommended fuel flow, power setting, and mixture mode for the current density altitude (below 8,000 ft DA: 65% power LEAN; 8,000–12,000 ft: 60%; above 12,000 ft: 55%), aimed at best-economy LOP operation. A guideline, not a limit — cross-check against your own POH power charts.

**ATIS OVERRIDE** — enter a fresher altimeter setting and/or OAT than the Pi's own calculated values (e.g. right after copying ATIS/AWOS before an approach). SET applies one field at a time; CLEAR reverts that field to the calculated value. An active override is flagged below the inputs ("ATIS OVERRIDE ACTIVE — ...") because it also feeds DENS ALT and EST. TAS above, not just the OAT gauge — those three numbers reflect your entered value, not a live measurement, until cleared.

---

### CHK — Checklists

Three sections: **Normal**, **Abnormal**, and **Emergency**. Each section contains multiple checklist cards. Tap a card to expand it. Tap individual items to check them off. State is not persisted between flights — items reset when you switch sections.

Swipe left/right or tap the section tabs to move between Normal, Abnormal, and Emergency.

---

### CLR — IFR Clearance Copy

Two modes: **DEP** (departure) and **APCH** (approach).

**DEP** — Presents CRAFT-format fields: Clearance limit, Route, Altitude, Frequency, Transponder, void time. Fields are pre-populated from the active flight plan where available. Large touch targets; a custom numpad handles digit entry.

**APCH** — Approach briefing fields: approach type, runway, transition altitude, minimums, frequency, missed approach notes. Fill this in while getting the ATIS and before starting the approach.

---

### CMPCT — Compact Mode

Hides the instrument strip and route table so the map fills the full screen. Useful in landscape orientation or any time you need maximum map visibility. The tab label changes to **MAP** while strips are hidden — tap MAP to restore them. The route table returns to exactly the height it was at before compact was activated.

---

### TMR — Timer

A floating countdown/count-up timer overlay that stays visible over any other tab. Use for holding, approach timing, or any en-route interval. Tap TMR again to dismiss it without losing the timer state.

---

### MORE — Secondary Functions

Opens a right-side drawer with infrequently used actions, organized in three sections.

**In-flight**

| Item | What it does |
|---|---|
| **Timer** | Floating countdown/count-up overlay — stays visible over any tab. Use for holding, approach timing, or any en-route interval. Tap again to dismiss without losing state. |
| **Approach Charts** | Georeferenced approach plates overlaid on the map |
| **Radar (CONUS)** | Full-screen CONUS NEXRAD view centered on ownship. Tap **Recenter on me** to return to ownship position after panning. A badge shows the data source and age (e.g. *FIS-B · CONUS · 4 min*). Use the play/scrub loop at the bottom to animate up to ~55 minutes of history and gauge storm movement. The main map shows the higher-resolution Regional product (with the CONUS mosaic drawn underneath where Regional coverage ends); this page shows the full CONUS mosaic for situational awareness at a wider scale. |
| **Engine ML** | Opens the real-time ML anomaly monitor |
| **Stratux Status** | Opens the Stratux web interface in a browser |

**Pre / Post flight**

| Item | What it does |
|---|---|
| **Fuel Entry** | Manually enter fuel quantity after a fuel stop |
| **Plan on flywhere.app** | Opens the web route planner in a browser for pre-flight planning |
| **Weather Briefing** | Full weather briefing panel (see below) |
| **Weight & Balance** | Enter station weights and fuel; shows total weight, CG, and envelope status with a CG diagram. Fuel pre-fills from tracked tank state — see *Fuel on the Weight & Balance page* |
| **Logbook** | View and edit flight log entries |
| **Flight Upload** | Sync flight logs to the cloud |
| **User Manual** | This document |

**Admin**

| Item | What it does |
|---|---|
| **Data Status** | Shows local database age, tile cache status |
| **Configuration** | Aircraft, engine, and system settings |
| **Reset NASR Data** | Forces a full re-download of the airport/navaid database |

---

## Layer Panel

Tap the **LAYERS tab** (far left of the tab bar) to open the layer panel. Close it by tapping the backdrop or the ✕ button.

The panel has four accordion sections: **Base Chart**, **Map Overlays**, **Traffic**, and **Weather**.

### Base Chart

| Option | Use case |
|---|---|
| **Vector** | Low-clutter view; best for congested airspace and terminal areas |
| **Sectional** | Standard VFR sectional; requires downloaded tiles |
| **IFR Low** | IFR en route low altitude chart |
| **TAC** | Terminal Area Chart for Class B airports |

**Region Download** — Download tile packages for offline use. Eleven CONUS regions plus Alaska. Shows estimated storage size for each region. Tap a region, then **Download**. A progress bar shows tile fetch status. Downloads run in the background.

**Cache Route Area** — When a route is loaded, downloads tiles covering the route corridor ± buffer. More targeted than a full region download.

### Map Overlays

| Toggle | What it shows |
|---|---|
| **Airports** | Airport symbols with type coding (towered/untowered/heliport) |
| **Navaids** | VORs, NDBs, DMEs with identifier labels |
| **Fixes** | Named intersections and reporting points |
| **Airways** | Victor airways and Jet routes with labels |
| **Airspace** | Class B/C/D/E boundaries with altitude labels |
| **Restricted/MOA** | Special use airspace (R/P/W/A/MOA) — amber fill when active |
| **IFR Area Charts** | High-altitude obstacle/terrain charts |
| **Runway Extensions** | Dashed extended centerlines for route airports |
| **TFRs** | Temporary Flight Restrictions — red boundaries with type and altitude |
| **Fuel Gauges** | On-map fuel quantity bars for each tank |
| **Flight Track** | Dashed grey polyline showing the GPS track flown this session. Toggling off hides the track on the map; recording continues in the background and the track reappears when re-enabled. |

**Airport filter** — Below the Airports toggle: minimum runway length (Any / 1500 / 2000 / 3000 / 4000 ft). Changes apply immediately.

### Traffic

| Toggle | What it shows |
|---|---|
| **Traffic Altitude Labels** | Show ±ALT delta on each traffic target |
| **All Altitudes** | Bypass the ±3000 ft altitude filter for traffic display |

### Weather

All weather data comes from FIS-B via Stratux when airborne, or from the internet via the flywhere.app proxy on the ground.

| Toggle | What it shows |
|---|---|
| **NEXRAD / FIS-B** | Radar mosaic with intensity colors (green→yellow→red→purple) |
| **CB Building** | Dashed polygons around growing convective cells (see below) |
| **CB / TCU Reports** | Map markers from METAR CB and TCU sky reports |
| **Flight Category** | Colored dot at each airport: green=VFR, blue=MVFR, red=IFR, purple=LIFR |
| **Category Areas** | Voronoi fill showing IFR/MVFR regions between METAR stations |
| **Ceiling / Sky** | Lowest sky layer at each METAR airport (e.g. BKN030) |
| **Visibility** | Visibility in SM at each METAR airport |
| **Surface Wind** | Wind direction and speed at each METAR airport |
| **Temp / Dew** | Temperature / dewpoint in °F at each airport |
| **Winds Aloft** | Upper-level wind barbs from FIS-B winds aloft product |
| **PIREPs (FIS-B)** | Pilot reports as diamond icons — orange=turbulence, blue=icing |
| **SIGMETs** | Significant weather advisories (purple outlines) |
| **AIRMET Tango** | Turbulence AIRMETs (yellow) — advisories with a base at or above FL200 are not displayed |
| **AIRMET Zulu** | Icing AIRMETs (cyan) |
| **AIRMET Sierra** | IFR/mountain obscuration AIRMETs (grey) |
| **Lightning** | Real-time lightning strike locations |

### Layer Defaults

At the bottom of the layer panel are two buttons:

- **Save as Defaults** — Saves the current state of every toggle, base chart, and airport filter as the startup default. The next time the app opens, all layers will start in exactly this configuration. A brief "Defaults saved" confirmation appears.
- **Reset to Defaults** — Immediately applies your saved default state to the map. All layers, the base chart, and airport filters snap back to the saved configuration. The button is greyed out until you have saved defaults at least once.

Defaults are stored on-device and persist across app restarts. To change the defaults, configure the layers however you want and tap **Save as Defaults** again.

> **Note:** SIGMETs, TFRs, and all AIRMET types (Tango, Zulu, Sierra) always start ON regardless of saved defaults. These overlays are safety-critical and cannot be permanently disabled through the defaults system — if you turn them off, they will be back on at the next app launch or when you tap **Reset to Defaults**.

---

## Weather Features in Detail

### NEXRAD Radar

Intensity levels follow NWS N0Q color coding:

| Color | dBZ | Meaning |
|---|---|---|
| Light green | 20–30 | Light precipitation |
| Dark green | 30–35 | Light-moderate |
| Yellow | 35–40 | Moderate — IFR concern |
| Orange | 40–50 | Heavy — avoid |
| Red | 50–55 | Very heavy — definitely avoid |
| Purple/white | 65+ | Extreme — thunderstorm core |

**Radar loop** — Once radar is enabled, swipe the bottom slider left to step backward through ~55 minutes of history. Watch the progression to see which direction storms are moving.

**Radar source toggle** — The badge in the lower-left corner of the map shows the active radar source and a `⇄` symbol. Tap it to switch your *preferred* source between FIS-B (regional blocks from Stratux) and Internet (IEM tile mosaic). The preference is remembered across sessions.

**Automatic source failover** — FlyTab watches both sources and automatically shows whichever one actually has data. On the ground (no FIS-B towers in range) a FIS-B preference falls back to Internet; in the air (no internet on Stratux WiFi) an Internet preference falls back to FIS-B. When a fallback is active the badge shows the failed source with a ✕, e.g. `Internet ✕ → FIS-B · Regional · 2 min`. When your preferred source becomes available again, FlyTab switches back automatically. You never need to toggle the source manually for a normal ground → air → ground flight.

**CONUS underlay** — The map draws the coarse FIS-B CONUS mosaic underneath the finer Regional blocks, so precipitation beyond Regional coverage (~150 nm from received towers) no longer cuts off at a hard edge. Distant returns look blockier — that is the CONUS product resolution, not a rendering fault.

### CB Building Polygons

Enable **CB Building** in the layer panel. FlyTab analyzes NEXRAD data across time to identify storm cells that are actively growing.

**How it works:** The app compares two radar snapshots separated by 10 minutes (internet mode) or 2.5 minutes (FIS-B mode). Cells that grew ≥25% in area or intensity are flagged as building. The polygon expands outward from the moderate-echo core to include surrounding light-echo areas — the early green dots that grow into storms.

**CB↑ (orange dashed polygon)** — Cell is growing at ≥25% rate. Expect continuing development.

**CB↑↑ (red-orange dashed polygon)** — Rapid growth ≥50%, or new heavy-echo cores appearing. Cell may be approaching thunderstorm intensity.

**Storm motion arrow** — When FIS-B winds aloft data is available, a line projects from the polygon center toward where the cell will be in approximately 15 minutes. This accounts for storm motion at ~75% of FL180 wind speed, which approximates mid-tropospheric steering flow.

Areas *without* a CB polygon are stable or weakening cells — the absence of a polygon is a finding, not a data gap.

The feature works on the ground using internet NEXRAD tiles. It requires the radar overlay to be enabled.

### CB / TCU Reports

Enable **CB / TCU Reports** to see markers where METAR observers have reported cumulonimbus or towering cumulus in the sky groups or remarks.

**How positions are plotted:**
- `CB NE` remark → marker placed 20 nm northeast of the reporting airport
- `TCU DSNT SW` remark → marker placed 50 nm southwest (DSNT = distant)
- `CB ALQDS` remark → marker at the airport (all quadrants)
- `FEW030CB` sky group (no direction) → marker at the airport (overhead)

**CB markers** appear in red-orange. **TCU markers** appear in amber. A dashed storm motion arrow indicates projected movement when winds aloft data is available.

These markers are sourced from FIS-B METARs when airborne. They complement the radar overlay — METAR observers may report CB/TCU in VMC conditions before radar returns are strong enough to trigger CB Building detection.

### Convective Intelligence (Experimental)

**Convective Intelligence** is an experimental decision-support overlay that scores NEXRAD returns for convective potential and displays probabilistic hazard boundaries. Enable it from the Layer Panel.

**EXPERIMENTAL — NOT FOR NAVIGATION.** This tool does not replace ATC advisories, certified weather avoidance equipment, or pilot judgment. Always obtain a standard weather briefing.

#### What it shows

| Badge | Meaning |
|-------|---------|
| (no badge) | Stratiform precipitation — standard radar display |
| `?CONV` | Possible convective — monitor closely |
| `CONV` | Likely convective — deviation recommended |
| `⚠CONV` | Confirmed convective — deviate now |

Convective returns are surrounded by **probabilistic hazard rings** (4 concentric rings, 80%/60%/40%/20% probability contours) instead of hard polygon boundaries. The outermost ring is the recommended avoidance boundary.

#### Data age indicator

The radar loop controls show a color-coded data age badge:
- **Green** — data < 5 minutes old
- **Yellow** — 5–10 minutes (monitor closely)
- **Red** — > 10 minutes (may not reflect current conditions)

#### Beam height warning

When a radar return is far from the nearest NEXRAD site, a ⚡ annotation shows the estimated radar beam height. Hazards may extend well below this altitude.

#### Preflight HRRR data

For best convective scoring, fetch preflight HRRR instability data from the Wx Briefing tab before departure while on WiFi. The data is stored on-device and used during flight with no internet required. Data older than 3 hours shows a staleness warning; data older than 6 hours disables the instability overlay.

#### OAT alerts

When the engine monitor is connected, rapid OAT changes trigger additional alerts:
- **OAT DROP** — rapid cooling indicates storm outflow boundary; evaluate immediately
- **Wind shear signature** — high OAT variance with high preflight instability
- **Approaching heating maximum** — sustained OAT rise in unstable airmass

### Weather Briefing

**MORE → Weather Briefing** opens a full briefing panel that pulls weather along the active route.

The briefing has several sections:

**Summary bar** — Route label and worst flight category badge along the route (color-coded).

**MOS forecast** — Machine-learning model output aviation forecast for each route airport. Shows ceiling, visibility, wind, and category prediction by hour. More granular than TAFs.

**METARs & TAFs** — Current observation and terminal forecast for each route airport. Formatted for quick reading with age indicator.

**G-AIRMETs** — Active G-AIRMET advisories intersecting the route corridor. Organized by type (turbulence, icing, IFR, FZLVL). Note: FZLVL items are freezing level lines, not area advisories.

**Forecast Discussions** — NWS Area Forecast Discussions for regions along the route. Useful for understanding the meteorologist's reasoning behind the forecasts.

**NOTAMs** — Active NOTAMs for route airports and TFRs along the route. Shows type (RWY, APCH, SUA, TFR, etc.) with severity-sorted display. Tap any NOTAM for the full text.

---

## Route Planning

FlyTab uses two planning modes: **building a route on the tablet** and **loading a route planned on flywhere.app**.

### Building a Route on the Tablet

Tap the map at any airport or navaid to open its popup, then tap **Add to Route**. The waypoint appears in the route strip at the bottom. Continue tapping to add waypoints. The route line draws in real time.

The route strip at the bottom is a draggable sheet. Drag the handle upward to expand it; drag down or tap **✕** to close it. The map resizes automatically as you drag so tap targets are never covered.

To edit the route, expand the strip and tap **EDIT**. From there you can:
- Tap any waypoint pill to view details
- Long-press a waypoint pill to delete or move it
- Tap the **+** button to add a waypoint by identifier
- Reorder waypoints by dragging

### Loading a Route from flywhere.app

1. Open **MORE → Plan on flywhere.app** on a device with internet access.
2. Build and save the route in the web planner.
3. Return to FlyTab, open the Route Planner (tap ✎ in the route strip handle), then tap **Plans**.
4. Select the saved plan from the list.

The route imports with all waypoints, planned altitude, and cruise speed. The nav strip activates immediately.

### Direct-To

Tap any airport on the map, then tap the **→** corner button. FlyTab sets a direct course to that airport, overriding the current leg but preserving the rest of the route.

### Route Profile

Expand the route strip and tap the mountain icon (⛰) in the handle to open the profile view — a side-on chart of your route showing terrain, Class B/C/D airspace bands, waypoints, and fuel stops along the distance axis. Tap the panel's chevron to expand or collapse it, or tap **✕** to close. Touch and drag anywhere on the chart to scrub along the route and see airspace detail for that point.

#### Clouds on the profile

When a cloud forecast has been cached, the profile shades cloud along your route at the altitudes it occupies. Shading density follows how much cloud the model expects: faint for scattered, solid for overcast. Anywhere cover reaches broken or worse, a dark outlined box is drawn and labelled **BKN\*** or **OVC\***. A continuous deck is drawn as one box spanning the whole stretch, not as a row of small boxes.

The asterisk is deliberate — the header note reads "\* model-derived". These are model cloud fractions over roughly 3 km grid squares, not an observer's octas, and they are not a METAR.

The bands are deliberately blocky. The forecast samples about every 750 ft low down but only every 3,000–4,000 ft above roughly 6,700 ft, and the boxes show the real span the model resolves rather than a smoothed guess. A layer that sits entirely inside one of those upper gaps will not appear at all.

A solid red line marks the 0°C freezing level, which moves along the route.

**Cloud data is fetched on the ground and does not update in flight.** It refreshes automatically whenever you edit the route while connected at home or on the internet. The WX chip in the profile header shows how old the forecast is — grey when recent, amber past three hours, red past six. Old data is still drawn; the chip tells you how much to trust it. If the chip reads "no data for ETA" — shown in amber — the cached forecast does not reach far enough forward in time to cover your arrival and nothing is drawn.

If the route has no computed timing yet, the chip adds "valid now" and the whole chart is drawn for the current hour rather than for your ETA at each point. It is all or nothing: you never get a chart that mixes the two.

Touch and drag on the chart to scrub, and the detail panel adds a CLOUDS section for that point: coverage %, base–top altitude for the layer nearest your flight altitude, and the freezing level. With several layers stacked, only the one closest to your altitude is shown — the panel has no room to scroll — with a "+N more layers" note for the rest.

---

## Approach Charts

**MORE → Approach Charts** opens the plate viewer. Plates are fetched from the home server (requires home Wi-Fi on first use).

Navigate to an airport using the search field, then select the approach. The plate displays as a PDF. Toggle **Geo Ref** to overlay the plate on the moving map so your own-ship tracks across the plan view.

During the approach, tap **APT** tab instead for quick access to all plates for the route airports.

---

## Fuel Management

**Fuel Entry** (MORE → Fuel Entry) — After refueling, enter the quantity for each tank. FlyTab uses this as the starting fuel for the flight.

**Recording a fuel stop:** Set the tic-mark sliders at the top of the Fuel Entry screen to your dipped/observed reading for each tank, then fill in gallons added, airport, date/time, and price in the FUEL ADDED section before tapping **RECORD FUEL STOP**. Tracked fuel is reset from the tic-mark reading itself, not calculated as "previous fuel + gallons added" — a fuel stop must always be grounded in a fresh physical measurement.

**The tic reading must be one you set on this visit to the screen.** Opening Fuel Entry pre-loads the sliders with your *previous* measurement, which after any preflight measurement is your departure reading — normally more fuel than you have on the ramp. RECORD FUEL STOP is therefore refused unless you have moved a slider, typed in a tic field, or tapped a **+**/**−** button since the screen opened; it shows "Enter this stop's tic-mark reading above" and nothing is recorded. **If you re-dip the tanks and get the same number that is already showing, tap + then − on that tank** — the value ends up unchanged but the reading is now yours, and the entry is accepted. (At a full-tank reading the **+** cannot go any higher, so use **−** then **+** instead; either direction works.) Each recorded stop consumes the reading, so a second RECORD FUEL STOP tap needs its own fresh measurement.

**APPLY TIC MEASUREMENT follows the same rule at a fuel stop — but not preflight.** When you reach the Fuel Entry screen through the in-flight Fuel Stop overlay's **Measure & Record Fuel** button, APPLY TIC MEASUREMENT writes tracked fuel exactly as RECORD FUEL STOP does, so it is refused on the same terms: without a slider, tic field or **+**/**−** touch since the screen opened it shows "Enter this stop's tic-mark reading above" under the button and nothing is written. Confirm an unchanged reading the same way, with a **+**/**−** round trip. Reaching Fuel Entry the ordinary way (**MORE → Fuel Entry**, or tapping the FUEL field in the instrument strip) is unchanged: there, APPLY still re-applies the reading the sliders come up showing, which is how you re-confirm a measurement without re-dipping.

If FlyTab detects a gap of more than a few seconds in engine data since the last fuel-flow sample (e.g. a Wi-Fi dropout), a caution line reading "Possible under-tracked burn during a comms gap" appears above the tic total when you open the Fuel Entry screen, showing the estimated gallons that may not have been tracked during the gap. This clears automatically once you record a new tic measurement or fuel stop.

**Choosing a fuel stop when you plan a route:** If a planned route is longer than your leg limit, tapping **Plan Route** in the Route Planner opens a **⛽ Fuel Stop Required** panel for each stop the route needs. The panel names the fix the stop falls near and the flight time to that point, then lists the nearest airports with fuel — identifier, name, distance, and a **Self-serve** tag on fields that have it. Tap one and it is inserted into the route as a fuel stop. Tap **Skip** to plan the route without that stop. The panel is drawn in the same high-contrast light scheme as the rest of FlyTab, so it stays readable in direct sun; it used to be dark, which did not.

**Entering your own fuel stop:** The list only offers the nearest fields with fuel, so it will not always contain the one you want — a better price, a field that is self-serve after hours, or somewhere you simply know. Type the identifier into the **Identifier** box at the bottom of the panel and tap **USE**, or press Enter on the keyboard. FlyTab looks the identifier up in the navigation database and inserts that airport as the fuel stop, exactly as if you had tapped it in the list. If the identifier is not found the panel stays open with a message so you can correct it, and nothing is inserted; if the navigation database is still loading you are told to try again in a moment. An airport is never added as a fuel stop until FlyTab has its position.

**In-flight fuel-stop confirmation:** When you get within 10nm of a fuel-stop airport on an active route, FlyTab opens a full-screen Fuel Stop overlay showing the completed and upcoming flight legs. Tap **Measure & Record Fuel** to open the Fuel Entry screen and set the tic-mark sliders to your dipped/observed reading — the same tic-based reset described above, including the requirement that the reading be one you set on this visit to the screen. The overlay's fuel status line stays red ("Not yet measured") until a tic measurement is recorded; neither a gallons-added number on its own, nor tapping RECORD FUEL STOP **or APPLY TIC MEASUREMENT** over the departure reading the sliders come up showing, is accepted here. Both buttons write the same tracked-fuel figure and both are refused until the reading is yours — previously APPLY was not, and tapping it over an untouched departure reading turned the status line green with your departure gallons over tanks that had since burned down. The **Continue** button remains tappable at all times, but tapping it before a measurement is recorded shows "Measure fuel before continuing" instead of starting the next leg. Once a fresh measurement is applied, the status line turns green ("Measured: X gal") and **Continue** starts the next flight leg. Tap **✕** to dismiss the overlay without starting the next leg — it will reappear if you re-enter the 10nm ring around the same fuel stop.

The **fuel tanks widget** (floating, top-left corner of the map) shows left/right tank quantities in gallons, live fuel flow (GPH), and combined endurance. The center column displays a total-fuel bar gauge, current GPH, and hours:minutes remaining. Tap the **L** or **R** badge to switch the active tank. Tap the **✎** button in the center column to edit fuel quantities at any time — the dialog pre-fills with your most recent tic measurement if one exists. All values update in real time from the engine monitor.

**A stale tracked figure stays on the widget, marked — it no longer blanks.** If the tank state goes 45 minutes or more without an integrated fuel-flow sample (engine data dropped out, or the app was closed), the widget used to drop both tanks, the total, the GPH and the endurance to `--` while every other fuel display in FlyTab kept showing the figure. It now behaves the same as the rest: both tank quantities, the total and the endurance keep their numbers, each gains a trailing **?** (`15.0?`, `29.0g?`, `3:38?`) and turns amber, and the tank bars drop out of the plain in-limits colour even when the quantity looks comfortable. The number is your last known-good quantity, which is why it is kept, but it reads HIGH — nothing burned during the gap was subtracted. Live GPH is not marked; it comes from the engine, not from tank tracking. A tank already in the red low-fuel band stays red. Confirm or re-enter your fuel to clear the marking.

**If no tank quantities have ever been entered, the widget still shows `--`.** That case is unchanged, and is different from a stale figure: with nothing tracked there is no last known-good quantity to preserve.

The **FUEL** field in the instrument strip along the bottom of the map is the in-flight fuel figure. It shows total fuel remaining in gallons and reads the same tracked figure as everything else — a manual override if you have set one, otherwise your tracked tank state (most recent tic measurement plus integrated burn). It no longer shows the EDM's own totalizer: that field could disagree with tracked fuel by 20 gallons in the optimistic direction. Tap the field to open the fuel overlay.

**If no tank quantities have been entered, FUEL shows a dash (—), not a number.** As on the engine page, this is deliberate: with nothing tracked there is no measurement to show, and displaying full tanks would tell you there is more fuel aboard than is known to exist. Enter your fuel — the **✎** button on the fuel tanks widget, or the Fuel Entry screen — and the field starts reading. A tracked **0.0** is a real reading (tanks dry) and is deliberately different from the dash.

**A stale tracked figure is flagged, not hidden.** If the tank state has gone 45 minutes or more without an integrated fuel-flow sample — the same condition that raises the UNCONFIRMED banner on the engine page — the FUEL value turns amber and a **?** is appended, e.g. `18.0?`. The number is still your last known-good quantity, which is why it is kept, but it reads HIGH: the fuel burned during the gap was never subtracted. Confirm your fuel before flying by it.

> **Correction to earlier notes in this manual.** Earlier versions said the nav strip's RANGE and FUEL fields "now work", that RANGE, FUEL and endurance "all come alive" once fuel is entered, and that the nav strip FUEL field was "the authoritative fuel-state display". All of that was wrong. The nav strip was never mounted in the app, so none of those fields ever rendered — there was no display to come alive and none of it was ever authoritative. The nav strip and its range calculator have been removed. The figure to fly by is the instrument strip **FUEL** field described above, cross-checked against the engine page's FUEL STATUS section.
>
> There is no range display and no map range ring. The **RNG** map button described in earlier notes was never wired up, and both went away with the nav strip. Use the engine page's FUEL STATUS **RANGE** and **ENDURANCE** gauges, which are live and read from the same tracked fuel figure.

### Route table FUEL and REM columns

The route table's **FUEL** column shows the fuel burned on each leg; **REM** shows the fuel expected to remain on arrival at that waypoint.

**On the flight you are actually flying, REM is derived from live tracked fuel** — the same figure the fuel tanks widget and the instrument strip FUEL field show, which traces back to your most recent tic measurement plus integrated burn. This is true on every leg of a multi-leg trip, not just the first. After a fuel stop where you added a partial fill, the next flight's REM reflects what you actually put in; it does not assume full tanks.

**Approaching a fuel stop, REM decreases all the way into the stop.** The REM shown at a fuel-stop waypoint is your fuel on *arrival* — before refueling. The added fuel appears on the legs after the stop. If you have seen REM jump upward on the leg before a fuel stop, that was a display error and is fixed.

For fuel stops further ahead on the route that you have not yet reached, REM is a **planning projection**, not a measurement. It assumes you fill to full unless you have entered an explicit gallons-added figure for that stop. Treat those downstream numbers as estimates for planning, and the current flight's REM as the figure to fly by.

**A stale tracked figure marks the whole REM column.** Every REM cell is your tracked fuel less the planned burn to that waypoint, so if the tank state has gone 45 minutes or more without an integrated fuel-flow sample, every cell in the column reads high by whatever was burned during the gap — including the rows after a fuel stop, which are built on the same figure. When that happens each REM cell turns amber and gains a trailing **?** (`25.0?`), the same signal used on the instrument strip's FUEL field and the DEST badge. Cells already in the red band stay red. Confirm or re-enter your fuel to clear it.

**Legs already behind you show `—` in FUEL and REM, not numbers.** A dash there is correct, not a fault: FlyTab only projects fuel forward from your live tracked figure, so a leg it can no longer recompute is blanked rather than left showing what it last predicted. Legs split into separate climb/cruise/descent rows used to keep those old numbers, and after a heavier-than-planned burn they read *higher* than the fuel actually on board — sitting directly above live rows showing much less. Their TAS and PWR cells now blank for the same reason. The TOTAL and per-flight footer figures count only legs still to fly, so they match the rows still showing numbers.

**The leg you are actually flying now burns at your measured fuel flow, not the planned or %PWR-selected figure.** Once you are airborne on a leg, FUEL for that row comes straight from the engine monitor's live fuel flow — the same figure used elsewhere in the app — not from the plan or from whatever %PWR selection is in effect. That figure is shown in **bold blue** to mark it as measured. The %PWR column header now reads "Applies to legs ahead" on tap-and-hold: the selection was always meant as a planning question ("if I fly at 65%, where do I need to stop for fuel?"), and now it only drives legs you have not reached yet — it no longer has any effect on the leg you are on. The **%PWR figure shown on the active leg is also live** — what the engine is actually making, not a plan.

**If the engine monitor is not reporting fuel flow, the active leg falls back to the planned figure and marks it.** That row's FUEL turns amber with a trailing **?** — the same two-signal convention used everywhere else in the app for a figure that is a fallback, not a fact — rather than silently looking like a genuine live measurement. This can happen before you have gotten far enough along the route for GPS to consider you en route to the next waypoint, or if the Pi connection drops.

### Where the planned burn numbers come from

Planned fuel figures — the route table's FUEL and REM columns, the TOTAL footer, and the DEST badge — are built from three burn rates: **climb 15.0 gph, cruise 8.4 gph at the aircraft's normal 65% power, descent 6.9 gph.** Climb and descent are those figures in every case. **Cruise is not** — depending on how the rows were produced and whether you have set a cruise-power override, the number behind the cruise rows can be 8.4, 9.0, or a measured figure for the power you selected. Which one applies is spelled out under *Which cruise number is actually in use* below. All three now come from recorded flight data rather than from a formula.

These are **measured, not book numbers.** All three are the **85th-percentile** fuel flow recorded by the engine monitor for that phase, across 53 logged flights in N194JT — deliberately the high side of normal rather than the average, because an under-estimate quietly over-states the fuel you will have left, and that is the error that runs tanks dry. Climb p85 is 15.1 gph, carried as 15.0; descent p85 is 6.9. Cruise comes from the same logs, narrowed first to the power setting you actually fly: of the cruise-phase samples recorded at 65–69% power — 7,879 of them — the 85th percentile is **8.4 gph.** The *median* of that same set is 8.10, and 8.10 is what the aircraft configuration's measured power table carries for the 61–65% band, because that table is built from medians. The planning figure is deliberately not the median: a median plans for the average day.

**Descent now plans at 6.9 gph instead of the old 4.0.** The 4.0 figure was an estimate and it was wrong in the unsafe direction — real descents in this airplane burn nearly 3 gph more than that. Expect route FUEL and REM figures, and the DEST badge, to read **slightly more fuel burned and slightly less remaining than they used to**, on any leg that ends at an airport. On a 150 nm leg the whole-leg planned burn rises by about 0.3 gal from 4,500 ft, 0.45 gal from 6,500 ft, and 0.75 gal from 10,500 ft. Over a three-leg day that is roughly 2 gallons. Nothing is broken — the old numbers were optimistic and the new ones are not.

**Changing these numbers.** All six fuel figures are editable on the aircraft page (MORE → Configuration): Fuel Capacity, Cruise Fuel Burn, Climb Fuel Burn, Descent Fuel Burn, Reserve Fuel, and the Fuel Sender Accuracy Threshold. Climb and descent burn were previously absent from that page even though both drive every planned figure above — so if you had ever tapped SAVE CONFIGURATION, a stale descent figure could sit in your saved settings shadowing the shipped one, with no way to see or correct it. Both fields are now shown.

**Saving now stores only the fields you actually changed (fixed 2 Aug 2026).** SAVE CONFIGURATION used to write your entire performance block, so any field merely displayed at the time — not just the one you edited — froze at whatever value it had and silently kept overriding every later update to that figure, indefinitely. A field you have genuinely edited still overrides future updates until you change it back, same as before; a field you have never touched now tracks whatever value ships in a later update, automatically. If planned burn still looks wrong after an update on a tablet that was already carrying a saved override from before this fix, clearing and re-saving the affected field on this page — or reinstalling — clears the old shadow.

**Which cruise number is actually in use — there are three.** Cruise burn is not a single fixed figure, and which one sits behind the cruise rows depends on how those rows were produced:

- **A route FlyTab planned for you — 8.4 gph at 65%.** This is the normal case, and it is the planning figure above. The route table looks up the measured power table in the aircraft configuration and uses the recorded band closest to the power percentage in effect; 65% is the default. **At 65% — the aircraft's configured cruise power — the planner uses the 8.4 p85 rather than that band's 8.1,** because the band table is built from medians and a median plans for the average day. Everything else in the row still comes from the measured band: RPM 2390, 22.1" MP, 153 KTAS. At any *other* power setting the band's own figure is used as-is, since 8.4 is a 65% number and nothing else has been re-derived — measured burn at the other recorded settings ranges from 5.0 gph at 42% power up to 8.9 gph at 75%. **This is why the route table's 65% cruise burn reads 0.3 gph higher than the 61–65 band in the power table** — the two are the same flight data read at different percentiles, and that is deliberate.
- **Rows FlyTab had to build itself — 9.0 gph.** When a leg arrives with no climb/cruise/descent breakdown — a waypoint you added by hand, or a plan imported without segment detail — the route table generates its own segments using the `cruise_gph` figure from the aircraft configuration, which is 9.0. That is deliberately higher than 8.4: it over-plans the burn, which is the safe side. (A plan imported *with* segment detail keeps whatever burn rates that plan was built with — those are not FlyTab's numbers and FlyTab does not second-guess them.)
- **A cruise-power override you have set — the measured figure for that power.** Tapping the route table's **%PWR** column header cycles an override through 55%, 65%, 75%, then off again. While one is active, FUEL, REM, TOTAL and DEST recompute the cruise rows using the **measured power table** — the nearest recorded band to the power you picked: **6.5 gph at 55%** and **8.9 gph at 75%.** Selecting **65%** — the aircraft's configured cruise power — changes nothing at all: it plans at the same 8.4 gph, and shows exactly the same FUEL, REM, TOTAL and DEST figures, as leaving the override off.

**Selecting a power no longer makes the fuel look better (fixed 1 Aug 2026).** The override used to compute cruise burn from a formula — % power × 180 hp × 0.067 — instead of from the recorded data. In the 60–70% range that formula sat *below* what the engine actually burns: it produced 7.8 gph at 65% against a measured 8.1 and a planned 8.4, so an override left sitting on 65% showed **more** fuel remaining than doing nothing, about 1.7 gal over a three-hour cruise. The formula is gone; every override figure is now measured. If you had learned to distrust the %PWR override, that reason no longer applies.

Two things to know when you use it. **Selecting a lower power really does show more fuel remaining** — 55% burns 6.5 gph against 8.4, and that is a genuine saving, not the old error. It also costs speed, so the leg takes longer; the REM figure accounts for both. And **the override's cruise figures are the band medians, not the 85th percentile** the default 65% planning number uses — so at any setting other than 65% you are looking at an average-day burn rather than the deliberately conservative one.

**The TAS the override shows is still estimated, not measured.** Burn now comes from the recorded band, but the KTAS in an overridden cruise row is still scaled from the cruise TAS by the square root of the power ratio — at 75% it reads about 164 kt where the recorded band for that power is 161, and at 55% about 141 against a recorded 128. Because that estimate is optimistic, a 70% or 75% override can still show marginally *more* fuel remaining than the default view (about 0.1 gal over a three-hour cruise at 75%) even though its burn rate is correctly higher. Treat overridden TAS and ETE as approximate. Use the override to compare settings, then clear it (keep tapping past 75%) before you fly the numbers.

One caveat when comparing to the engine page: the **% power label** on those bands is calculated from RPM and manifold pressure, the way the Lycoming charts do it, while the engine monitor computes power from fuel flow when you are running lean of peak. The **gallons-per-hour figure is the measured ground truth** in both places; the percentage beside it is a label for the band, not a number to compare across the two screens.

### The DEST figure in the route strip handle

The collapsed route strip handle shows departure → destination, distance and time to run, planned burn, and a **DEST:X.X** badge — gallons expected to remain on arrival. The badge turns amber at 8 gallons and red at 4.

**The badge is computed from your tracked fuel** — the same canonical figure the fuel tanks widget and the route table's REM column use — projected forward at your live fuel flow, or at planned cruise GPH if the engine monitor is not reporting flow. It no longer reads a separate engine-panel field that could disagree with the rest of the fuel displays.

**On a trip with a fuel stop, the badge is fuel remaining at the end of the flight you are currently on — normally the fuel stop, not the trip's final airport.** Once you are established on a leg after the stop it re-scopes to the final airport. The airport named in the handle label is always the trip's *final* destination, so on a fuel-stop trip the label and the DEST figure can refer to different airports. To make that unambiguous, **when the badge refers to an airport other than the one in the handle label it is named** — you will see `KFGX:15.0` rather than `DEST:15.0`. A plain `DEST:` badge always means the airport shown in the handle label.

**The badge assumes you actually make the planned fuel stop.** It is fuel on arrival at the named airport only — it does not include the leg beyond it. If you overfly a planned fuel stop, for weather, a closed FBO, or a decision to press on, the route does not change and the badge keeps showing fuel at the stop. You will arrive at the final airport with substantially less than the badge shows — the whole downstream leg's burn less. Re-plan the route, or work the arrival figure from the route table, before pressing past a planned stop.

**The badge no longer disagrees with itself on the last leg into a fuel stop.** Previously, once the fuel stop itself became your active waypoint, the badge jumped to projecting across the whole remaining trip and read 15.0 where you were really going to land with 25.0 — while the instrument strip, reading the same route, showed about 25.0 at the same moment. Both now scope to the flight you are actually on, so the two agree.

**If you have no fuel tracked, there is no badge.** With nothing entered in the fuel tanks widget and no manual override, FlyTab has no measurement to project from. It used to fall back to full tanks and show a comfortable green figure on a route it knew nothing about. The badge is now simply absent until you enter your fuel — the rest of the handle (route, distance, time, planned burn) is unaffected.

**A stale tracked figure is marked here too.** If the tank state has gone 45 minutes or more without an integrated fuel-flow sample, the badge turns amber and gains a trailing **?** — `DEST:25.4?` — even when the reserve is comfortable. It is the same signal the instrument strip's FUEL field and the engine page's UNCONFIRMED banner use, and it means the same thing: the number does not include anything burned during the gap, so it reads high. A marked figure never shows green, whatever the arithmetic says.

### The power tradeoff panel

Tapping **DEST** or **ETE** on the instrument strip opens the power tradeoff panel: one row per power setting, showing the ground speed, fuel flow, ETE and **FUEL@DEST** you would see at that power.

**FUEL@DEST is your tracked fuel less the projected burn.** It reads from the same canonical figure as everything else — your tank state, or a manual override if you have set one. It previously read the EDM's own totalizer instead, which on a typical flight sat about 20 gallons above the tracked figure: the panel showed 25.5 gal remaining at destination, uncoloured, where the truth was 5.5.

**Two rows in this table are estimates, and are now labelled as such.** The 40-45% and 46-50% power bands have no logged flight data behind them — their true airspeed and fuel flow were interpolated from the bands above, not measured in your aeroplane. They now show as **~42% EST** and **~48% EST**: a tilde before the percentage and an amber EST tag. Every figure on those rows — ground speed, GPH, ETE, FUEL@DEST and △TIME — follows from the estimated numbers and should be treated as a rough guide, not a measurement. This matters most at the bottom of the table: 42% is the lowest power setting shown, so it carries the longest endurance and the best FUEL@DEST on screen, and it is the row you are most likely to be reading when you are trying to stretch fuel.

The panel footer says which rows the data claim covers: "Measured rows: 47+ actual flight data points · ~ rows are ESTIMATES — no flight data, TAS and GPH interpolated". It previously read "Based on 47+ actual flight data points" with no qualification, which claimed measured data for the whole table including the two rows that had none. The estimated rows are kept rather than removed — they are real power settings you can fly, and having a rough number is better than having none, as long as you know which it is.

With nothing tracked, FUEL@DEST shows **—** rather than a projection from full tanks. A stale tank state is shown but marked with a trailing **?** and never left uncoloured. The colour bands are amber at 12 gallons, deeper amber at 8, and red at 4 — the 8 and 4 figures are the same thresholds every other fuel display uses, set in `cockpit-config.json`. Those colours previously did not render at all, so a 2-gallon arrival looked exactly like a 25-gallon one.

### Fuel on the Weight & Balance page

The **Fuel** station on the W&B page (MORE → Weight & Balance) pre-fills from the same tracked figure as everything else — your tank state, or a manual override if you have set one. It previously read the pre-flight planning chain, which never consulted tank state at all: with 18 gallons tracked it pre-filled **36**, and with the tanks tracked dry it still pre-filled **36**. At 6 lb per gallon that is up to 216 lb of fuel that may not be in the aeroplane, and on this airframe the fuel arm sits ahead of the forward CG limit, so a fuel figure that is too high also drags the plotted CG forward of where it really is.

**With nothing tracked, the Fuel field is left blank rather than filled with full tanks.** The page then refuses to give you an envelope verdict: the badge reads **NO VERDICT — ENTER FUEL QUANTITY** in amber, an amber line above it reads "FUEL NOT ENTERED — this weight excludes fuel. Enter gallons aboard.", and Total Weight and CG are shown in amber with a trailing **?**. This matters more here than anywhere else in the app: a missing fuel figure makes the aeroplane look *lighter* than it is, which is the one direction a weight and balance answer must never err in. Type the gallons aboard and the page computes normally.

**A stale tracked figure is flagged, not hidden.** If the tank state has gone 45 minutes or more without an integrated fuel-flow sample — the same condition behind the engine page's UNCONFIRMED banner and the instrument strip's `18.0?` — the figure is still pre-filled, but an amber line reads "FUEL QUANTITY UNCONFIRMED — tank tracking is over 45 min stale and reads high. Verify before using this weight.", Total Weight and CG carry the same amber **?**, and the envelope badge reads **IN ENVELOPE — UNCONFIRMED FUEL** in amber instead of green. The CG dot on the diagram turns amber for the same reason. An **OUT OF ENVELOPE** result stays red whatever the fuel confidence — a limit exceedance is never softened.

**Your own entry always wins.** As soon as you type in the Fuel field, the number is yours: the amber marking clears and the page will not overwrite it when you re-open W&B. Until you do type in it, an untouched pre-fill is re-read from the tracker each time the page opens, so it follows the burn instead of freezing at the ramp figure. A tracked **0.0** is a real reading and computes normally — dry tanks and untracked tanks never look the same.

**Typing in the field is one-way for the rest of the session.** Once you type a fuel figure, W&B stops re-reading the tracker for the remainder of this app session — there is currently no in-app button to go back to tracked fuel. If you want the page to resume following your tracked tank state, restart FlyTab.

**The station breakdown table below the summary carries the same marking.** If fuel has not been entered, the Fuel row reads **(not entered)** instead of a gallon figure, and both that row and the TOTAL row are shown in amber with a trailing **?** — the same convention as the summary above, so the two cannot disagree about whether the total is confirmed.

---

## Logbook

**MORE → Logbook** opens the flight log. Each entry records:
- Date, departure/destination airports
- Hobbs time, flight time
- Conditions (VFR/IFR)
- Pilot notes

Entries are created automatically at the end of each flight when recording is active. The **REC** badge in the status bar shows recording state. You can edit any entry after the fact.

Recording stops automatically 60 seconds after engine shutdown (RPM ≤ 100). If the tablet screen turns off or the app is backgrounded while the engine is already off, the recording finalizes immediately so no data is lost.

**Multi-leg flights with a fuel stop:** If you power off the Stratux between legs, FlyTab will automatically stop the current recording after 2 minutes with no GPS or engine data. Each flight leg produces its own CSV file. The second leg's recording starts automatically on the next engine start after Stratux is powered back up.

### Weather Recording

When a flight is recorded, FlyTab simultaneously logs all FIS-B weather events to a companion file named `YYYYMMDD_HHMMZ_weather.ndjson` (e.g. `20260607_1430Z_weather.ndjson`). The file captures NEXRAD blocks, METARs, PIREPs, SIGMETs, AIRMETs, winds aloft, and NOTAMs received during the flight. At engine-off, the file is renamed to match the engine CSV (e.g. `20260607_KLKR-KFDK_weather.ndjson`).

This file is available for post-flight review in fly-debrief as a weather replay layer — scrub through the flight to see what weather looked like at each point in time.

**CWA polygons** — Center Weather Advisories issued during the flight appear as orange polygons on the map when the SIGMETs/AIRMETs overlay is enabled.

**MORE → Flight Upload** syncs entries to the cloud.

---

## GPS and Connectivity

FlyTab receives GPS from Stratux, not from the tablet's internal GPS. The Stratux provides WAAS-quality position (3D DGPS) when the antenna is properly sited.

**GPS badge states:**
- **GPS** (green) — 3D fix from Stratux
- **GPS** (amber) — 2D fix only; altitude unreliable
- **SIM** — Using simulated GPS (developer mode)
- **GPS** (red/absent) — No fix; Stratux may not be connected

If Stratux is not found within about 30 seconds of launch, a banner appears: "SIM MODE — not connected to Stratux." The map will not track position in this state. Verify the tablet is on the Stratux Wi-Fi network (192.168.10.1).

**OFFL badge** shows internet connectivity. Many features work offline (charts, NASR data, saved plans). Weather briefing and internet NEXRAD require internet.

---

## Pre-Flight Workflow

**At home (day before or morning of flight):**

1. Connect to home Wi-Fi with home server running.
2. Launch FlyTab — it will auto-download any updated NASR data.
3. **MORE → Plan on flywhere.app** — build the route.
4. **MORE → Load Plan** — import the route.
5. **LAYERS → Cache Route Area** — download tiles for the route corridor.
6. **MORE → Weather Briefing** — review METARs, TAFs, G-AIRMETs, NOTAMs.
7. **MORE → Fuel Entry** — set fuel quantities if you know them.

**At the airport:**

1. Power on Stratux, wait for GPS lock (status bar GPS turns green).
2. Pi engine monitor powers on with the avionics. The ENG tab shows data once running.
3. Verify FIS-B is receiving: FIS-B badge turns green once you're in range of a ground station. This typically happens on the ground at most airports.
4. **CHK** tab → Normal → Preflight.
5. Confirm route is loaded and DEST shows the destination.

---

## In-Flight Workflow

**Departure:**
- Switch to auto-pan (⊙ button) if not already active.
- **LAYERS → Weather → NEXRAD** on if convective weather is a concern.
- Nav strip shows GS, ALT, and ETE to first waypoint automatically.

**En route:**
- For convective weather: enable **CB Building** when radar is active. Polygons appear within seconds on internet tiles; within 2.5 minutes on FIS-B.
- Enable **PIREPs** for FIS-B pilot reports above/below your altitude.
- Tap the radar slider to check storm motion history.
- Tap any traffic target for full detail; close the popup with the CLOSE button.

**Approach:**
- **CLR tab → APCH** — fill in approach briefing fields from ATIS.
- **APT tab** — tap destination airport for approach plate.
- **MORE → Approach Charts** for full georeferenced plate overlay.
- The nav strip NEXT field updates automatically to each fix as you cross it.

**Post-flight:**
- Flight recording stops automatically when engine data ceases.
- **MORE → Logbook** — review and edit the auto-generated entry.
- **MORE → Flight Upload** to sync.
- **MORE → Flight Upload** to sync the track to the cloud.

---

## Troubleshooting

**Map shows no position:**
Stratux is not connected. Check that the tablet Wi-Fi is on the Stratux network (not home Wi-Fi). The SIM banner will be visible.

**No NEXRAD data (FIS-B):**
You need to be within range of a UAT ground station. Tap the FIS-B badge in the status bar for last-received ages. FIS-B status badge green = connected. Internet NEXRAD is the fallback when FIS-B is not available.

**CB Building shows no polygons:**
The feature requires the NEXRAD / FIS-B radar overlay to be enabled first. The internet mode also requires internet connectivity. If there are no growing cells in the viewport, no polygons appear — that is correct behavior, not a failure.

**Engine data not showing:**
Check that the Pi is powered and the tablet is on the same network segment. Pi usually assigned to 192.168.1.x. More → Data Status shows the last-connected time for the engine monitor.

**Tiles are missing / grey squares:**
Charts for this area are not downloaded. Either download the region (LAYERS → Base Chart → Region Download) or use the Vector base layer, which requires no tile data.

**NASR badge is red:**
Airport/navaid database is stale. Connect to home Wi-Fi with home server running and restart FlyTab — it auto-downloads fresh NASR data on startup.

**App is very slow after a long route import:**
The NASR import writes ~100,000 records to IndexedDB. If this happens during startup, wait for the progress bar to complete. Force-stopping during import can leave the database in a locked state; force-stop and relaunch to recover.

---

## Quick Reference — Common Tasks

| Task | How |
|---|---|
| Switch base chart | LAYERS → Base Chart section |
| Enable weather radar | LAYERS → Weather → NEXRAD / FIS-B |
| See CB building polygons | LAYERS → Weather → CB Building (radar must be on) |
| See METAR dots | LAYERS → Weather → Flight Category |
| Download tiles offline | LAYERS → Region Download |
| Add airport to route | Tap airport on map → Add to Route |
| Direct-to an airport | Tap airport on map → → (corner button) |
| Start approach briefing | CLR tab → APCH |
| Open approach plate | APT tab → tap airport → Approaches |
| Check engine trends | ENG tab |
| Log fuel stop | MORE → Fuel Entry |
| Export / sync GPS track | MORE → Flight Upload |
| Check NOTAM for airport | MORE → Weather Briefing → NOTAMs |
| Reload airport database | MORE → Reset NASR Data |

---

*FlyTab is built for N194JT. Some performance values, power settings, and engine thresholds in the Engine ML model are specific to the Lycoming O-360-A1A on this airframe.*
