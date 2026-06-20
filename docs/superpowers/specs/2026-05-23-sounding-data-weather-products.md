# FlyTab Sounding Data & Derived Weather Products

*Date: 2026-05-23*
*Context: Research session exploring upper-air sounding data as a source for cloud tops, icing layers, turbulence, and atmospheric stability indicators for in-cockpit use.*

---

## What We Investigated

### Cloud Top Data Sources (All Evaluated)

| Source | Verdict |
|--------|---------|
| AWC PIREPs (`/api/data/pirep`) | Viable but sparse — only 8% of PIREPs have non-zero cloud tops. Point data only, not a coverage layer. Already proxied via flywhere. |
| Convective SIGMETs (`/api/data/airsigmet`) | Best ready-made source. Polygon geometry + `altitudeHi1` in feet. Already proxied. Time-bounded via `validTimeFrom`/`validTimeTo`. |
| Windy.com API | Blocked — ECMWF licensing prevents distributing `cloudtop` and `cbase` to third parties. |
| GOES-19 CTH raster | Dead end — no CONUS CTH product on NESDIS CDN. Raw data is on NOAA AWS S3 as NetCDF4, requires server-side pipeline. |
| Radiosonde soundings (IEM RAOB API) | **Best approach for derived cloud layers and full atmospheric analysis.** |

---

## Sounding Data Source

**API**: Iowa State Environmental Mesonet (IEM) RAOB  
**Endpoint**: `https://mesonet.agron.iastate.edu/json/raob.py?station=KILX&ts=2026-05-23T12:00:00Z`  
**Station list (GeoJSON)**: `https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson`  
- 121 online US stations with lat/lon and `sid` field
- `sid` matches what the API uses (e.g., `KILX`, `KDVN`, `KILN`)

**Timing**: Soundings at 00Z and 12Z only — data is 0–12 hours old. Always label with station and time.

**Response fields** per level (211–235 levels per sounding):
```
pres   — pressure in hPa
hght   — height in meters (convert: ft = hght * 3.281)
tmpc   — temperature °C
dwpc   — dewpoint °C
drct   — wind direction (degrees)
sknt   — wind speed (knots)
```

**Nearest station to KLKR**: KILX (Lincoln, IL) at ~143 nm. Workable for pre-flight planning in stable/stratiform weather.

---

## Derived Products

All of the following are computable from the IEM sounding data alone.

### 1. Cloud Layers — Base and Top

**Algorithm**: Find consecutive levels where `tmpc - dwpc ≤ 2.0°C` (saturated air). Record `hght` (converted to feet) at the first and last level of each run.

**Validated against KILX 12Z 2026-05-23**:
| Layer | Base | Top |
|-------|------|-----|
| Low stratus | ~3,700 ft MSL | ~9,000 ft MSL |
| Altostratus | ~17,400 ft MSL | ~19,500 ft MSL |
| Cirrus | ~42,000 ft MSL | ~42,600 ft MSL |

Cross-reference with PIREPs and SIGMET polygon tops.

---

### 2. Freezing Level

**Algorithm**: First level where `tmpc` crosses 0°C (interpolate between levels for precision).

**Pilot value**: Critical for icing risk. Much more precise than G-AIRMET forecast zones.

---

### 3. Icing Layer

**Algorithm**: Intersection of:
- Saturated (T-Td ≤ 2°C), AND
- Temperature between 0°C and −20°C

**Severity**: Worst icing at −10°C to −15°C (supercooled liquid water most concentrated).

**Special case**: Multiple freezing levels (T crosses 0°C, warms, then crosses again) = freezing rain / ice pellet risk below the warm layer.

---

### 4. Atmospheric Stability / Thunderstorm Potential

#### CAPE (Convective Available Potential Energy)
Integrate the area between lifted parcel temperature and environmental temperature from LFC to EL.
- 0–100 J/kg: stable / weak convection
- 100–1,000: moderate
- 1,000–2,500: thunderstorms likely
- > 2,500: severe possible

#### Lifted Index (LI)
Lift a surface parcel to 500 hPa; LI = environmental T − parcel T at 500 hPa.
- LI > 0: stable
- 0 to −2: marginally unstable
- −2 to −6: thunderstorms likely
- < −6: severe storms possible

#### K-Index
Straight arithmetic — no parcel lifting required:
```
K = (T850 − T500) + Td850 − (T700 − Td700)
```
- K > 35: high thunderstorm probability

#### Convective Temperature (tcon)
Surface temperature required to break the cap and trigger free convection. Shown by Windy as "tcon." If current surface temp < tcon, the cap holds.

#### Convective Condensation Level (CCL)
Cloud base altitude if free convection fires (may be much higher than LCL due to a capping inversion).

---

### 5. Turbulence

#### Richardson Number (Ri)
Computed between adjacent level pairs throughout the sounding:
```
Ri = (g/T) × (ΔT/Δz + DALR) / (ΔV/Δz)²
```
- Ri < 0.25: turbulence very likely (Kelvin-Helmholtz instability)
- 0.25–1.0: possible turbulence
- > 1.0: smooth

Produces a turbulence probability profile from surface to FL350.

#### Vector Wind Shear by Layer
Flag layers where vector wind change exceeds 6 kt/1,000 ft — operational CAT threshold.

---

### 6. Tropopause Height
First altitude where lapse rate drops below 2°C/km sustained over 2 km. Relevant for cruise altitude selection and jet-stream turbulence.

---

## Sounding Chart Interpretation (Pilot Mental Model)

### The Two Lines
- **Red (T)**: temperature at each altitude
- **Blue (Td)**: dewpoint at each altitude
- **Gap between them**: T-Td spread. Wide = dry. Converging = moistening. Touching = cloud.

### Key Features to Read

| What you see | What it means |
|---|---|
| Lines touch at low altitude, separate above | Defined cloud layer — base where they touch, top where they separate |
| T line bends RIGHT (warms with altitude) | Inversion — acts as a lid on convection and clouds |
| Lines stay close through a large altitude span | Deep moist layer — convective clouds will be tall if they fire |
| Lines touch, T line steep above | Unstable cumulus with growth potential — check CAPE |
| Lines never touch, wide gap throughout | Dry air, no clouds |

### The Loaded Gun Pattern (From Windy Screenshot, Rock Hill SC, 2026-05-23)
- **LCL: 931 ft** — mechanically lifted air saturates at 931 ft (very moist surface layer)
- **CCL: 5,732 ft** — free convection cloud base (cap suppresses until surface heats)
- **tcon: 84°F** — surface must reach 84°F for cap to break
- **Result**: T-Td lines very close 10,000–25,000 ft = deep moist column waiting. If cap breaks, storms go tall fast.

**Decision framework**: if surface forecast approaches tcon, treat as a convective day regardless of current skies.

---

## Implementation Plan

### Phase 1 — Station + Data Fetch
1. Fetch GeoJSON station list once, cache locally
2. Given pilot's lat/lon, find nearest online RAOB station (haversine)
3. Pick most recent sounding: 00Z if current UTC hour < 12, else 12Z
4. Fetch via IEM RAOB API

### Phase 2 — Derived Products (Simple First)
- Freezing level (ft MSL)
- Cloud layers: base + top of each saturated run
- Icing layer: altitude band where T is 0°C to −20°C and saturated
- K-Index: arithmetic on 850/700/500 hPa levels
- Convective temperature (tcon): find where dry adiabat from surface intersects CCL

### Phase 3 — Stability
- Lifted Index (LI): parcel lifting to 500 hPa
- CAPE: full parcel integration
- Richardson Number: Ri profile by layer

### Phase 4 — UI
- Wx Briefing tab: "Sounding — KILX 12Z" card with:
  - Cloud layers listed (base/top in ft)
  - Freezing level
  - Icing band if present
  - LI / K-Index colored badge (green/yellow/red)
  - tcon vs. current surface temp (METAR) comparison
- All products labeled with station ID and sounding time

### Notes
- Always label data with station + time (e.g., "KILX 12Z — 6h ago")
- Nearest station at 143 nm is workable for pre-flight, not near-real-time
- Sounding-derived layers complement PIREPs and Convective SIGMETs; don't replace them
- Proxy restriction applies only to AWC/app calls; IEM RAOB is a different source with no CORS issue from the flywhere proxy (verify before building)
