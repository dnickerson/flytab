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
│  NEXT  ——   DEST  ——   GS  ——kt  ALT  ——  FUEL  ——    │ ← Nav strip
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

**Nav strip** — always visible below the map. Shows six configurable fields (default: next waypoint, destination, ground speed, altitude, range, fuel). Tap any field to change it.

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

The **advisory** badge appears between GPS and FIS-B when a weather advisory is active along the route.

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

The **engine advisory banner** (below the status bar, on any tab) appears in red if the ML anomaly detector finds an abnormal pattern in the current engine data. Tap it to see which parameters are outside normal for this phase of flight.

**Sticky-valve caution (startup only)** — During engine start, if one cylinder's EGT rise noticeably lags the other three, you may see "Cylinder N EGT rise lagging others during startup (possible sticky valve) — UNVALIDATED CHECK, confirm on ground." This check is new and its sensitivity has not yet been tuned against a confirmed sticky-valve event — treat an alert as a prompt to inspect on the ground, not a confirmed diagnosis.

The **Engine ML** monitor (MORE → Engine ML) shows the real-time anomaly score, per-feature reconstruction errors, and the current flight phase (startup, warmup, taxi_out, runup, takeoff, climb, cruise, descent, approach, landing, taxi_in, or shutdown). The model was trained on N194JT flight data and knows what this engine normally does in each phase.

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
| **Weight & Balance** | Enter station weights and fuel; shows total weight, CG, and envelope status with a CG diagram |
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

---

## Approach Charts

**MORE → Approach Charts** opens the plate viewer. Plates are fetched from the home server (requires home Wi-Fi on first use).

Navigate to an airport using the search field, then select the approach. The plate displays as a PDF. Toggle **Geo Ref** to overlay the plate on the moving map so your own-ship tracks across the plan view.

During the approach, tap **APT** tab instead for quick access to all plates for the route airports.

---

## Fuel Management

**Fuel Entry** (MORE → Fuel Entry) — After refueling, enter the quantity for each tank. FlyTab uses this as the starting fuel for the flight.

**Recording a fuel stop:** Set the tic-mark sliders at the top of the Fuel Entry screen to your dipped/observed reading for each tank, then fill in gallons added, airport, date/time, and price in the FUEL ADDED section before tapping **RECORD FUEL STOP**. Tracked fuel is reset from the tic-mark reading itself, not calculated as "previous fuel + gallons added" — a fuel stop must always be grounded in a fresh physical measurement. If you tap RECORD FUEL STOP without entering a tic reading, the entry is rejected.

If FlyTab detects a gap of more than a few seconds in engine data since the last fuel-flow sample (e.g. a Wi-Fi dropout), a caution line reading "Possible under-tracked burn during a comms gap" appears above the tic total when you open the Fuel Entry screen, showing the estimated gallons that may not have been tracked during the gap. This clears automatically once you record a new tic measurement or fuel stop.

**In-flight fuel-stop confirmation:** When you get within 10nm of a fuel-stop airport on an active route, FlyTab opens a full-screen Fuel Stop overlay showing the completed and upcoming flight legs. Tap **Measure & Record Fuel** to open the Fuel Entry screen and set the tic-mark sliders to your dipped/observed reading — the same tic-based reset described above. The overlay's fuel status line stays red ("Not yet measured") until a tic measurement is recorded; simply entering a gallons-added number is no longer accepted here. The **Continue** button remains tappable at all times, but tapping it before a measurement is recorded shows "Measure fuel before continuing" instead of starting the next leg. Once a fresh measurement is applied, the status line turns green ("Measured: X gal") and **Continue** starts the next flight leg. Tap **✕** to dismiss the overlay without starting the next leg — it will reappear if you re-enter the 10nm ring around the same fuel stop.

The **fuel tanks widget** (floating, top-left corner of the map) shows left/right tank quantities in gallons, live fuel flow (GPH), and combined endurance. The center column displays a total-fuel bar gauge, current GPH, and hours:minutes remaining. Tap the **L** or **R** badge to switch the active tank. Tap the **✎** button in the center column to edit fuel quantities at any time — the dialog pre-fills with your most recent tic measurement if one exists. All values update in real time from the engine monitor.

The **FUEL** field in the nav strip shows total fuel remaining and projected endurance at current burn rate. This is the authoritative fuel-state display.

### Route table FUEL and REM columns

The route table's **FUEL** column shows the fuel burned on each leg; **REM** shows the fuel expected to remain on arrival at that waypoint.

**On the flight you are actually flying, REM is derived from live tracked fuel** — the same figure the fuel tanks widget and nav strip show, which traces back to your most recent tic measurement plus integrated burn. This is true on every leg of a multi-leg trip, not just the first. After a fuel stop where you added a partial fill, the next flight's REM reflects what you actually put in; it does not assume full tanks.

**Approaching a fuel stop, REM decreases all the way into the stop.** The REM shown at a fuel-stop waypoint is your fuel on *arrival* — before refueling. The added fuel appears on the legs after the stop. If you have seen REM jump upward on the leg before a fuel stop, that was a display error and is fixed.

For fuel stops further ahead on the route that you have not yet reached, REM is a **planning projection**, not a measurement. It assumes you fill to full unless you have entered an explicit gallons-added figure for that stop. Treat those downstream numbers as estimates for planning, and the current flight's REM as the figure to fly by.

### The DEST figure in the route strip handle

The collapsed route strip handle shows departure → destination, distance and time to run, planned burn, and a **DEST:X.X** badge — gallons expected to remain on arrival. The badge turns amber at 8 gallons and red at 4.

**The badge is computed from your tracked fuel** — the same canonical figure the fuel tanks widget and the route table's REM column use — projected forward at your live fuel flow, or at planned cruise GPH if the engine monitor is not reporting flow. It no longer reads a separate engine-panel field that could disagree with the rest of the fuel displays.

**On a trip with a fuel stop, the badge is fuel remaining at the end of the flight you are currently on — normally the fuel stop, not the trip's final airport.** Once you are established on a leg after the stop it re-scopes to the final airport. The airport named in the handle label is always the trip's *final* destination, so on a fuel-stop trip the label and the DEST figure can refer to different airports.

One limitation to know: while you are flying the last leg directly into a fuel stop, the badge still projects across the whole remaining trip and therefore reads **lower** than the fuel you will actually land with. Use the route table's REM column at the fuel-stop waypoint for the arrival figure on that leg.

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
