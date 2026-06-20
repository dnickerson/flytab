# FlyTab — Convective Detection & Intelligent Hazard Boundary System
**Project:** FlyTab EFB (github.com/dnickerson/flytab)  
**Platform:** Lenovo Yoga Tab Plus (Snapdragon 8 Gen 3 / Hexagon NPU, Android)  
**Stack:** Capacitor / Vanilla JS  
**Author:** Dana Nickerson / Noetic Data LLC  
**Version:** 1.0 — Spec for Claude Code  
**Date:** May 2026  

---

## Problem Statement

Current EFB NEXRAD displays — including FlyTab's existing implementation — present radar returns as hard-edged colored polygons implying a clean boundary between safe and unsafe airspace. This is operationally false and has contributed to fatal accidents where pilots:

1. Penetrated a "small green dot" that was a rapidly developing convective cell
2. Routed around the visible radar return but flew into the invisible hazard boundary
3. Could not distinguish stratiform precipitation from building thunderstorms
4. Were misled by FIS-B data that was 6–10 minutes old at time of display

This spec defines a new FlyTab module — **Convective Intelligence** — that corrects all four failure modes using data already available in the FlyTab stack plus a preflight HRRR data pull.

---

## Existing FlyTab Architecture (Do Not Break)

Claude Code must read and understand existing code before modifying anything.

**Key existing integrations:**
- `ws://192.168.10.1/weather` — Stratux WebSocket, receives `WeatherMessage` JSON objects
  - Fields: `Type`, `Location`, `Time`, `Data`, `LocaltimeReceived`
  - Product types include: `"Regional NEXRAD"`, `"National NEXRAD"`, `"METAR and SPECI"`, `"Winds and Temperatures Aloft"`, `"PIREP"`, `"Convective SIGMET"`, `"AIRMET"`
- `ws://192.168.10.1/situation` — GPS, attitude, traffic
- Dynon D-180 engine data feed (1Hz via Raspberry Pi WiFi)
- FIS-B status page already implemented
- Existing NEXRAD rendering layer (identify before touching)
- flyware.app post-flight integration

**Do not modify existing Stratux WebSocket connection logic.** Build alongside it.

---

## Module Overview: Convective Intelligence

This module has two operating phases that work together:

```
GROUND PHASE (internet required)
  → Pull HRRR instability grid for route
  → Compute preflight convective risk tiles
  → Store locally for in-flight use (no internet needed airborne)

AIRBORNE PHASE (FIS-B only, no internet)
  → NEXRAD frame temporal analysis (growth rate tracking)
  → Hazard boundary expansion and age correction
  → Convective vs. stratiform discrimination
  → Fusion scoring across all available signals
  → Pilot alert and display
```

---

## Part 1: Ground Phase — Preflight HRRR Data Pull

### 1.1 Data Sources

**Primary: NOAA HRRR Model via aviationweather.gov**

```
Base URL: https://aviationweather.gov/api/data/
Endpoint: /griddata
Parameters:
  - bbox: route bounding box + 50nm buffer
  - fields: cape,cin,lcl,lfc,shear03
  - time: current + 6hr forecast
  - format: json
```

**Secondary: ASOS surface observations**
```
URL: https://aviationweather.gov/api/data/metar
Parameters:
  - bbox: same bounding box
  - fields: tmpf,dwpf,sknt,drct,altim
```

### 1.2 Fields to Pull and Why

| Field | Full Name | Why It Matters |
|---|---|---|
| CAPE | Convective Available Potential Energy | Primary instability measure. >1500 J/kg = high convective risk in SE summer |
| CIN | Convective Inhibition | The "cap". <50 J/kg = cap easily broken by surface heating |
| LCL | Lifted Condensation Level | Cloud base height. <4,000 ft AGL = abundant low-level moisture |
| LFC | Level of Free Convection | Once air parcel reaches this, storm is self-sustaining |
| Shear03 | 0-3km wind shear | >20 knots = organized convection, more dangerous |
| Surface dewpoint | From ASOS METARs | >68°F in SE summer = fuel for storms |
| Surface temperature | From ASOS METARs | Drives afternoon heating trigger timing |

### 1.3 Instability Grid Processing

```javascript
// Target output: grid of instability scores at 0.25° resolution
// covering route corridor ± 50nm

function computeInstabilityGrid(hrrData, routeBbox) {
  const grid = [];
  
  for (const cell of hrrData.gridPoints) {
    const score = computeCellInstabilityScore({
      cape: cell.cape,
      cin: cell.cin,
      lcl: cell.lcl,
      lfc: cell.lfc,
      shear03: cell.shear03,
      dewpoint: cell.dwpf,
      timeOfDay: getLocalSolarTime(cell.lat, cell.lon),
      terrainType: lookupTerrainType(cell.lat, cell.lon)  // NLCD lookup
    });
    
    grid.push({
      lat: cell.lat,
      lon: cell.lon,
      instabilityScore: score,       // 0.0 - 1.0
      cape: cell.cape,
      cin: cell.cin,
      validTime: cell.validTime
    });
  }
  
  return grid;
}

function computeCellInstabilityScore({ cape, cin, lcl, shear03, dewpoint, timeOfDay }) {
  // SE summer airmass thunderstorm model
  // Tuned for lat 25-37, May-September, 1200-2000 local
  
  let score = 0;
  
  // CAPE contribution (primary signal)
  if (cape < 200)       score += 0.0;
  else if (cape < 500)  score += 0.1;
  else if (cape < 1000) score += 0.2;
  else if (cape < 1500) score += 0.35;
  else if (cape < 2500) score += 0.5;
  else                  score += 0.65;  // >2500 J/kg = extreme instability
  
  // CIN contribution (cap strength)
  if (cin < 10)        score += 0.20;  // virtually no cap
  else if (cin < 25)   score += 0.15;
  else if (cin < 50)   score += 0.10;
  else if (cin < 100)  score += 0.02;
  else                 score += 0.0;   // strong cap, convection unlikely
  
  // Time of day (peak heating multiplier, SE summer)
  const peakHeatMultiplier = computeSolarHeatingMultiplier(timeOfDay);
  score *= peakHeatMultiplier;  // 0.3 at 0800 local, 1.0 at 1500-1700 local
  
  // Dewpoint (moisture availability)
  if (dewpoint > 70) score += 0.10;
  else if (dewpoint > 65) score += 0.05;
  
  // Low-level shear (organization factor)
  if (shear03 > 30) score += 0.05;  // organized but dangerous
  
  return Math.min(score, 1.0);
}
```

### 1.4 Terrain Type Lookup

Use NLCD (National Land Cover Database) static lookup table — do not fetch at runtime.

Bundle a lightweight lookup table covering the Southeast US (lat 24-37, lon -92 to -74):

```javascript
const TERRAIN_CONVECTIVE_MULTIPLIER = {
  'open_water': 0.3,          // suppresses daytime heating
  'developed_urban': 1.4,     // urban heat island accelerates initiation
  'barren': 1.1,
  'forest': 0.8,              // shading reduces surface heating
  'shrub': 1.0,
  'cultivated_crops': 1.2,    // low albedo, rapid heating
  'pasture': 1.15,
  'wetland': 0.7,
  'default': 1.0
};
```

### 1.5 Local Storage Format

Store preflight grid to IndexedDB for in-flight use:

```javascript
const preflightData = {
  fetchedAt: ISO8601_timestamp,
  validUntil: ISO8601_timestamp,  // fetchedAt + 3 hours
  routeBbox: { minLat, maxLat, minLon, maxLon },
  instabilityGrid: [ ...gridCells ],
  nexradSiteLocations: [ ...nearestSites ]  // for beam height calculation
};
```

**Staleness rule:** If preflight data is >3 hours old, display warning banner. If >6 hours old, disable instability overlay and alert pilot.

---

## Part 2: Airborne Phase — NEXRAD Frame Analysis

### 2.1 Frame Buffer Management

Maintain a rolling buffer of received NEXRAD frames:

```javascript
class NexradFrameBuffer {
  constructor() {
    this.frames = [];           // chronological, max 8 frames (~48 min)
    this.maxFrames = 8;
    this.frameIntervalMs = 360000;  // 6 minutes nominal
  }
  
  ingest(weatherMessage) {
    // Only process NEXRAD products
    if (!weatherMessage.Type.includes('NEXRAD')) return;
    
    const frame = {
      receivedAt: new Date(weatherMessage.LocaltimeReceived),
      dataTime: new Date(weatherMessage.Time),
      ageAtReceiptMs: Date.now() - new Date(weatherMessage.Time).getTime(),
      raw: weatherMessage.Data,
      parsed: parseNexradComposite(weatherMessage.Data),
      // parsed contains: grid of {lat, lon, dbz} cells
    };
    
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) {
      this.frames.shift();
    }
  }
  
  getFrameAge(frame) {
    // Age = time since data was VALID, not time since received
    return Date.now() - frame.dataTime.getTime();
  }
  
  getCurrentDisplayAge() {
    if (this.frames.length === 0) return null;
    const latest = this.frames[this.frames.length - 1];
    return this.getFrameAge(latest);
  }
}
```

### 2.2 Convective vs. Stratiform Discrimination

This is the core algorithm. Run every time a new NEXRAD frame arrives.

```javascript
function discriminateConvective(frames, sectorGrid, preflightGrid) {
  const results = {};
  
  for (const sector of sectorGrid) {
    // Need at least 3 frames for reliable trend
    if (frames.length < 3) {
      results[sector.id] = { score: null, confidence: 'insufficient_data' };
      continue;
    }
    
    // --- Signal 1: Area growth rate (strongest discriminator) ---
    const areas = frames.map(f => countPixelsAboveThreshold(f, sector, 15));
    const areaGrowthRate = fitExponentialSlope(areas);
    // Stratiform: <5% per 6min | Convective: >50% per 6min
    
    // --- Signal 2: Peak dBZ growth rate ---
    const peakDbzValues = frames.map(f => getMaxDbz(f, sector));
    const dbzGrowthRate = fitLinearSlope(peakDbzValues);
    // Stratiform: <2 dBZ per 6min | Convective: >8 dBZ per 6min
    
    // --- Signal 3: Shape irregularity (cauliflower vs smooth) ---
    const latestFrame = frames[frames.length - 1];
    const edgeIrregularity = computeEdgeIrregularity(latestFrame, sector);
    // Smooth edge = 0.0, highly irregular = 1.0
    
    // --- Signal 4: Centroid stability ---
    const centroids = frames.map(f => computeCentroid(f, sector));
    const motionVector = fitMotionVector(centroids);
    const areaVsMotionRatio = areaGrowthRate / (motionVector.speed + 0.1);
    // High ratio = growing faster than moving = convective
    
    // --- Signal 5: Environmental context from preflight HRRR ---
    const preflightCell = lookupNearestCell(preflightGrid, sector.centerLat, sector.centerLon);
    const instabilityScore = preflightCell?.instabilityScore ?? 0.5;
    
    // --- Signal 6: Time of day ---
    const timeOfDayFactor = computeSolarHeatingMultiplier(new Date());
    
    // --- Weighted fusion ---
    const rawScore = (
      normalizeAreaGrowth(areaGrowthRate)    * 0.35 +
      normalizeDbzGrowth(dbzGrowthRate)      * 0.25 +
      edgeIrregularity                        * 0.10 +
      normalizeRatio(areaVsMotionRatio)      * 0.10 +
      instabilityScore                        * 0.15 +
      timeOfDayFactor                         * 0.05
    );
    
    results[sector.id] = {
      score: Math.min(rawScore, 1.0),
      confidence: frames.length >= 5 ? 'high' : 'moderate',
      signals: {
        areaGrowthRate,
        dbzGrowthRate,
        edgeIrregularity,
        instabilityScore,
        framesAnalyzed: frames.length
      }
    };
  }
  
  return results;
}
```

### 2.3 Interpretation Thresholds

```javascript
const CONVECTIVE_THRESHOLDS = {
  STRATIFORM:   { min: 0.0, max: 0.30, color: '#4488CC', label: 'Stratiform precipitation' },
  AMBIGUOUS:    { min: 0.30, max: 0.60, color: '#FFAA00', label: 'Possible convective — monitor' },
  LIKELY_CONV:  { min: 0.60, max: 0.80, color: '#FF6600', label: 'Likely convective — deviate' },
  CONFIRMED:    { min: 0.80, max: 1.00, color: '#FF0000', label: 'Convective — immediate deviation' }
};
```

---

## Part 3: Hazard Boundary Expansion

### 3.1 The Three Corrections

Every NEXRAD return displayed to the pilot must have three corrections applied before display:

**Correction 1: Data Age**
```javascript
function getProjectedReturnBoundary(return_, aircraftPosition) {
  const ageMs = Date.now() - return_.dataTime.getTime();
  const ageMinutes = ageMs / 60000;
  
  // Storm motion estimate: use observed centroid velocity if available,
  // else use winds aloft at 700mb from preflight data
  const motionKnots = return_.observedMotionKnots ?? preflightWindsAt700mb;
  const motionBearing = return_.observedMotionBearing ?? preflightWindBearing700mb;
  
  // Project return position forward by age
  const projectedCenter = projectPosition(
    return_.centroid,
    motionBearing,
    motionKnots * (ageMinutes / 60)
  );
  
  return projectedCenter;
}
```

**Correction 2: Radar Beam Height**
```javascript
function getBeamHeightFt(distanceNm, elevationAngleDeg = 0.5) {
  // Standard atmosphere beam height calculation
  const distanceM = distanceNm * 1852;
  const earthRadiusM = 6371000 * (4/3);  // effective Earth radius, 4/3 model
  const elevationRad = elevationAngleDeg * Math.PI / 180;
  
  const heightM = Math.sqrt(
    distanceM ** 2 + earthRadiusM ** 2 + 
    2 * distanceM * earthRadiusM * Math.sin(elevationRad)
  ) - earthRadiusM;
  
  return heightM * 3.28084;  // convert to feet
}

function getBeamHeightWarning(returnPosition, aircraftPosition, nearestNexradSite) {
  const distanceToSite = getDistanceNm(returnPosition, nearestNexradSite);
  const beamHeightFt = getBeamHeightFt(distanceToSite);
  
  return {
    beamHeightFt,
    warning: beamHeightFt > 5000 
      ? `Radar beam at ${Math.round(beamHeightFt).toLocaleString()} ft — hazard extends below this`
      : null
  };
}
```

**Correction 3: Hazard Boundary Buffer**
```javascript
function computeHazardBoundary(return_, convectiveScore, ageMinutes, preflightInstability) {
  // Base buffer: 20nm minimum for any return
  let bufferNm = 20;
  
  // Scale by convective score
  if (convectiveScore > 0.8) bufferNm = 25;
  else if (convectiveScore > 0.6) bufferNm = 22;
  else if (convectiveScore > 0.3) bufferNm = 18;  // stratiform, smaller buffer
  
  // Scale by data age
  bufferNm += Math.min(ageMinutes * 0.5, 8);  // add up to 8nm for old data
  
  // Scale by instability environment
  const cape = preflightInstability?.cape ?? 1000;
  if (cape > 2500) bufferNm += 5;
  else if (cape > 1500) bufferNm += 3;
  
  // Scale by dBZ growth rate (fast-growing storms expand faster)
  const growthRate = return_.convectiveSignals?.areaGrowthRate ?? 0;
  if (growthRate > 100) bufferNm += 5;  // explosive growth
  
  return {
    bufferNm,
    // Express as concentric probability rings
    rings: [
      { radiusNm: bufferNm * 0.4, probability: 0.80 },
      { radiusNm: bufferNm * 0.7, probability: 0.60 },
      { radiusNm: bufferNm * 1.0, probability: 0.40 },
      { radiusNm: bufferNm * 1.3, probability: 0.20 },
    ]
  };
}
```

---

## Part 4: Display Layer

### 4.1 Display Principles

- **Never show hard-edged radar polygons for convective returns.** Replace with probabilistic gradient rings.
- **Always show data age** prominently — color-coded (green <5min, yellow 5-10min, red >10min).
- **Always show beam height** annotation when >4,000 ft AGL.
- **Stratiform returns** may retain the standard colored polygon display with a blue/gray tint.
- **Convective returns** display as probabilistic hazard zones.

### 4.2 Return Classification Badge

Each radar return on the map shows a small badge:

```
[STRAT]  → Stratiform (blue-gray, standard polygon)
[?CONV]  → Ambiguous (yellow, expanded buffer)
[CONV]   → Convective (orange, gradient rings, deviation recommended)
[⚠CONV] → Confirmed convective (red, gradient rings, alert)
```

### 4.3 Age Display

```javascript
function renderDataAgeIndicator(frameBuffer) {
  const ageMs = frameBuffer.getCurrentDisplayAge();
  if (ageMs === null) return renderNoDataWarning();
  
  const ageMinutes = ageMs / 60000;
  
  return {
    text: `NEXRAD ${Math.round(ageMinutes)}min old`,
    color: ageMinutes < 5 ? '#00CC44' :   // green
           ageMinutes < 10 ? '#FFAA00' :  // yellow
           '#FF3300',                      // red
    warning: ageMinutes > 10 
      ? 'DATA MAY NOT REFLECT CURRENT CONDITIONS' 
      : null
  };
}
```

### 4.4 Pilot Alert System

```javascript
const ALERT_LEVELS = {
  // Level 0: No alert, pilot situational awareness only
  // Level 1: Route intersects ambiguous return (score 0.3-0.6)
  // Level 2: Route intersects likely convective return (0.6-0.8)  
  // Level 3: Route intersects confirmed convective or hazard boundary (>0.8)
  // Level 4: Aircraft is inside projected hazard boundary NOW
};

function evaluateRouteAlerts(route, returns, aircraftPosition) {
  const alerts = [];
  
  for (const ret of returns) {
    const hazardBoundary = computeHazardBoundary(ret, ret.convectiveScore, ...);
    const distanceToReturn = getDistanceNm(aircraftPosition, ret.projectedCenter);
    const distanceToHazardBoundary = distanceToReturn - hazardBoundary.bufferNm;
    const minutesToBoundary = distanceToHazardBoundary / aircraftGroundspeedKnots * 60;
    
    if (minutesToBoundary < 0) {
      // Inside hazard boundary
      alerts.push({
        level: 4,
        message: `INSIDE CONVECTIVE HAZARD ZONE — DEVIATE IMMEDIATELY`,
        bearing: getBearingTo(aircraftPosition, ret.projectedCenter),
        voice: true
      });
    } else if (minutesToBoundary < 5) {
      alerts.push({
        level: 3,
        message: `CONVECTIVE HAZARD BOUNDARY ${Math.round(distanceToHazardBoundary)}NM — DEVIATE NOW`,
        minutesToBoundary: Math.round(minutesToBoundary),
        voice: true
      });
    } else if (minutesToBoundary < 15 && ret.convectiveScore > 0.6) {
      alerts.push({
        level: 2,
        message: `Convective return ${Math.round(distanceToReturn)}NM — deviation recommended`,
        minutesToBoundary: Math.round(minutesToBoundary),
        voice: false
      });
    }
  }
  
  return alerts.sort((a, b) => b.level - a.level);
}
```

---

## Part 5: OAT Trend Analysis

Integrates with existing Dynon D-180 1Hz data feed.

```javascript
class OATTrendMonitor {
  constructor() {
    this.buffer = [];        // 5-minute rolling window of OAT readings
    this.maxBufferMs = 300000;
  }
  
  ingest(oatC, timestamp) {
    this.buffer.push({ oatC, timestamp });
    // Prune old readings
    const cutoff = Date.now() - this.maxBufferMs;
    this.buffer = this.buffer.filter(r => r.timestamp > cutoff);
  }
  
  analyze() {
    if (this.buffer.length < 30) return null;  // need 30 seconds minimum
    
    // Rapid warming trend: surface heating maximum ahead
    const trend = fitLinearSlope(this.buffer.map(r => r.oatC));
    
    // High frequency oscillation: convergence boundary
    const variance = computeVariance(
      this.buffer.slice(-60).map(r => r.oatC)  // last 60 seconds
    );
    
    return {
      trendCPerMin: trend * 60,
      varianceC: variance,
      signals: {
        rapidWarming: trend > 0.3,     // >0.3°C/min = approaching heating max
        convergenceBoundary: variance > 1.5,  // high variance = boundary
        outflowBoundary: trend < -0.5  // rapid cooling = outflow, turn now
      }
    };
  }
}
```

**OAT Alert Rules:**
- `outflowBoundary = true` → Level 3 alert: "OAT DROP — POSSIBLE STORM OUTFLOW — EVALUATE IMMEDIATELY"
- `convergenceBoundary = true` + preflight instability > 0.6 → Level 2 alert: "Wind shear signature — convective trigger zone"
- `rapidWarming = true` + preflight instability > 0.7 → Level 1 advisory: "Approaching heating maximum — monitor for convective development"

---

## Part 6: Wind Convergence Detection

```javascript
function detectWindConvergence(aircraftGroundtrack, preflightWindsAloft, nearbyMetars) {
  // Compare GPS-derived winds to forecast winds
  const gpsWinds = deriveWindsFromGPSGroundtrack(aircraftGroundtrack);
  const forecastWinds = interpolateWindsAloft(preflightWindsAloft, aircraftPosition, aircraftAltitude);
  
  const windDeviation = computeWindDeviation(gpsWinds, forecastWinds);
  // windDeviation: { speedDeltaKts, directionDeltaDeg }
  
  // ASOS network convergence check
  const asosDivergence = computeASOSDivergence(nearbyMetars);
  // Look for stations with opposing wind directions within 50nm
  
  return {
    gpsWindDeviation: windDeviation,
    convergenceScore: computeConvergenceScore(windDeviation, asosDivergence),
    // convergenceScore 0-1: 1.0 = definite convergence boundary nearby
  };
}
```

---

## Part 7: NPU Fusion Model (Phase 2 — After Rule-Based System Validated)

**Phase 1:** Deploy rule-based scoring as defined above. Log all inputs and outputs to flyware.app.

**Phase 2:** After accumulating 6+ months of labeled data (flights where storms did/did not form as predicted), train a TFLite temporal attention model:

```
Architecture: Temporal attention network
Input: [8 sectors × 16 features × 6 time steps]
Output: [8 sectors × risk_score_0_to_1]
Model size target: <50MB INT8 quantized
Runtime: TFLite + NnApiDelegate (Hexagon NPU)
Inference cadence: Every 30 seconds
Power budget: <200mW NPU
```

Training data pipeline:
- NOAA Big Data Program: `s3://noaa-nexrad-level2/` + `s3://noaa-hrrr-bdp-pds/`
- Geographic filter: SE US (lat 25-37, lon -90 to -75)
- Temporal filter: May-September, 1200-2200 local
- Positive labels: NEXRAD cells where new >35dBZ echo appeared within 60 minutes with no prior echo
- Negative labels: Same thermodynamic conditions where no echo formed

---

## Part 8: NEXRAD Site Database

Bundle a static database of NEXRAD site locations for beam height correction:

```javascript
// Relevant to SE US routes
const NEXRAD_SITES = [
  { id: 'KGSP', lat: 34.8833, lon: -82.2203, elevFt: 940 },  // Greenville-Spartanburg
  { id: 'KCAE', lat: 33.9488, lon: -81.1184, elevFt: 231 },  // Columbia SC
  { id: 'KCLX', lat: 32.6558, lon: -81.0422, elevFt: 97 },   // Charleston SC
  { id: 'KJGX', lat: 32.6750, lon: -83.3511, elevFt: 521 },  // Robins AFB GA
  { id: 'KFFC', lat: 33.3636, lon: -84.5658, elevFt: 858 },  // Atlanta area
  { id: 'KLTX', lat: 33.9891, lon: -78.4291, elevFt: 61 },   // Wilmington NC
  { id: 'KRAX', lat: 35.6654, lon: -78.4897, elevFt: 348 },  // Raleigh NC
  { id: 'KMHX', lat: 34.7759, lon: -76.8762, elevFt: 31 },   // Morehead City NC
  // Add additional sites for full SE coverage
];

function findNearestNexradSite(position) {
  return NEXRAD_SITES.reduce((nearest, site) => {
    const dist = getDistanceNm(position, site);
    return dist < getDistanceNm(position, nearest) ? site : nearest;
  });
}
```

---

## Build Sequence for Claude Code

Implement in this exact order. Do not skip ahead.

### Step 1 — NEXRAD Frame Buffer
- Implement `NexradFrameBuffer` class
- Tap into existing Stratux WebSocket without modifying it
- Verify frame ingestion with console logging
- Test: confirm frames accumulate correctly over 30-minute session

### Step 2 — Frame Age Display
- Add data age indicator to existing NEXRAD display
- Color code per spec (green/yellow/red)
- This is standalone value, no other dependencies
- Test: age display updates correctly as frames arrive

### Step 3 — NEXRAD Site Database + Beam Height
- Bundle NEXRAD site database
- Implement beam height calculation
- Add beam height annotation to display when >4,000 ft
- Test: verify beam heights match published values for known site/distance pairs

### Step 4 — Preflight HRRR Pull (Ground Phase)
- Implement `fetchHRRRInstabilityGrid()` 
- Store to IndexedDB
- Add staleness check and warning banner
- Test: verify data fetch, storage, and retrieval on app restart

### Step 5 — Convective vs. Stratiform Discrimination
- Implement `discriminateConvective()` using frame buffer
- Requires Step 1 (frame buffer) and Step 4 (preflight grid)
- Add classification badge to each radar return
- Test: run against recorded FIS-B sessions to validate scoring

### Step 6 — Hazard Boundary Expansion
- Implement `computeHazardBoundary()`
- Replace hard polygon display with gradient rings for convective returns
- Test: visual inspection against known convective events

### Step 7 — Route Alert System
- Implement `evaluateRouteAlerts()`
- Wire to existing route display
- Add voice alert integration
- Test: simulate route through convective sector, verify alert timing

### Step 8 — OAT Trend Monitor
- Implement `OATTrendMonitor`
- Wire to existing Dynon data feed
- Test: verify trend detection using recorded Dynon sessions

### Step 9 — Wind Convergence Detection
- Implement `detectWindConvergence()`
- Wire to GPS groundtrack and preflight winds aloft
- Test: verify deviation detection against known wind data

### Step 10 — Integration + Logging to flyware.app
- Wire all signals into unified `ConvectiveIntelligenceEngine`
- Log all predictions to flyware.app with flight ID
- This enables Phase 2 ML training dataset accumulation

---

## Open Questions for Dana to Answer Before Starting

1. Where in the FlyTab codebase does current NEXRAD rendering live? (file name)
2. Is there an existing sector grid definition, or does Claude Code need to create one?
3. What voice alert library is currently in use (if any)?
4. Is the Dynon OAT feed already accessible as a named event/channel in the app?
5. What is the current flyware.app logging endpoint format? (to ensure Step 10 compatibility)

---

## Acceptance Criteria

- [ ] NEXRAD data age displays correctly and updates in real time
- [ ] Beam height annotation appears when radar return is >80nm from nearest NEXRAD site
- [ ] Convective score correctly classifies: stratiform rain = low score, building CB = high score (validate against known events)
- [ ] Hazard boundary rings display around convective returns, not hard polygons
- [ ] Preflight HRRR data pull completes in <30 seconds on WiFi
- [ ] Preflight data persists across app restart (IndexedDB)
- [ ] Staleness warning displays when data >3 hours old
- [ ] OAT outflow boundary alert fires on rapid temperature drop
- [ ] Route alert fires when projected track enters hazard boundary with >5 minutes to boundary
- [ ] All predictions logged to flyware.app with timestamp and flight ID
- [ ] No regression in existing FlyTab functionality (FIS-B status page, engine data display, etc.)

---

## Explicitly Out of Scope (This Version)

- IR camera (FLIR Lepton) integration — future hardware phase
- NPU TFLite fusion model — Phase 2 after rule-based system validated
- NOAA Big Data training pipeline — Phase 2
- External antenna modifications to aircraft
- Any FAA certification — experimental aircraft / experimental tool, clearly labeled

---

## Safety Disclaimer Language (Required in UI)

The following must appear in the module header and in any alert:

> **EXPERIMENTAL — NOT FOR NAVIGATION**  
> Convective Intelligence is an experimental decision-support tool for situational awareness only. It does not replace ATC advisories, certified weather avoidance equipment, or pilot judgment. Always obtain a standard weather briefing. Always defer to ATC convective advisories. This tool may display incorrect, delayed, or missing information.
