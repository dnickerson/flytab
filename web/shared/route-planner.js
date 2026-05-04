/**
 * routePlanner.js
 * FlyTab Route Planning Module
 *
 * Plain script — loaded via <script src="./shared/route-planner.js">.
 * All classes are global (RoutePlanner, WorkGraph, RouteConstructor, etc.).
 *
 * Queries FlyTab's existing IndexedDB stores:
 *   airports, navaids, airways, sua, fixes, fuel_prices, aircraft_profiles
 *
 * No external dependencies. No network calls (weather excluded).
 * Designed for the Lenovo Yoga Tab Plus — all computation on-device.
 *
 * Usage:
 *   const planner = new RoutePlanner('flypi');
 *   await planner.init();
 *
 *   const plan = await planner.plan({
 *     departure:    'KLKR',
 *     destination:  'KMHT',
 *     aircraftId:   'RV9A',          // key into aircraft_profiles store
 *     preferredLegHrs: 2.0,
 *     reserveGal:   10.0,
 *     selfServeOnly: false,
 *   });
 *
 *   console.log(plan.routeString);   // "KLKR GSO V65 RIC V268 ESN DIRECT SBJ V3 PUT V3 HFD V16 KMHT"
 *   console.log(plan.legs);          // [{from, to, airway, mea, distNm, timeStr, fuelUsed, ...}]
 *   console.log(plan.fuelStops);     // [{icao, name, price, distNm, ...}]
 */

'use strict';

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const EARTH_RADIUS_NM = 3440.065;

// ARTCC latitude bands for this corridor (simplified — full boundary via SUA store)
const ARTCC_BANDS = [
  { id: 'ZJX', name: 'Jacksonville Center', latMin: 30.0, latMax: 36.8 },
  { id: 'ZDC', name: 'Washington Center',   latMin: 36.8, latMax: 39.6 },
  { id: 'ZNY', name: 'New York Center',     latMin: 39.6, latMax: 41.6 },
  { id: 'ZBW', name: 'Boston Center',       latMin: 41.6, latMax: 47.0 },
];

// GPS-direct preferred fix sequence for KLKR→KMHT corridor.
// Routes via ESN (Easton MD) — 39.5 nm P-40/SFRA clearance.
// All real VORs. Latitude increases monotonically — no backtrack.
// Production: extend with preferred routes from PFR store.
const CORRIDOR_PREFERRED_FIXES = [
  'GSO',   // Greensboro VOR  — ZJX anchor
  'RIC',   // Richmond VOR   — ZDC anchor
  'ESN',   // Easton VOR     — P-40 avoidance
  'SBJ',   // Solberg VOR    — ZNY anchor
  'PUT',   // Putnam VOR     — ZNY/ZBW transition
  'HFD',   // Hartford VOR   — ZBW anchor
];

// Washington DC P-40 prohibited area
const DC_P40 = { lat: 38.8951, lon: -77.0364, radiusNm: 15.0 };
const SUA_BUFFER_NM = 5.0;


// ---------------------------------------------------------------------------
// GEOMETRY UTILITIES
// ---------------------------------------------------------------------------

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const [φ1, φ2] = [lat1, lat2].map(toRad);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return EARTH_RADIUS_NM * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const [φ1, φ2, Δλ] = [lat1, lat2, lon2-lon1].map(toRad);
  const x = Math.sin(Δλ) * Math.cos(φ2);
  const y = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(x, y) * 180/Math.PI + 360) % 360;
}

function intermediatePoint(lat1, lon1, lat2, lon2, fraction) {
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const [φ1, λ1, φ2, λ2] = [lat1, lon1, lat2, lon2].map(toRad);
  const d = 2*Math.asin(Math.sqrt(
    Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2
  ));
  if (d < 1e-10) return { lat: lat1, lon: lon1 };
  const a = Math.sin((1-fraction)*d)/Math.sin(d);
  const b = Math.sin(fraction*d)/Math.sin(d);
  const x = a*Math.cos(φ1)*Math.cos(λ1) + b*Math.cos(φ2)*Math.cos(λ2);
  const y = a*Math.cos(φ1)*Math.sin(λ1) + b*Math.cos(φ2)*Math.sin(λ2);
  const z = a*Math.sin(φ1)              + b*Math.sin(φ2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x**2+y**2))), lon: toDeg(Math.atan2(y, x)) };
}

function crossTrackDistanceNm(lat1, lon1, lat2, lon2, latP, lonP) {
  const toRad = d => d * Math.PI / 180;
  const [φ1, λ1, φ2, λ2, φp, λp] = [lat1, lon1, lat2, lon2, latP, lonP].map(toRad);
  const d13 = 2*Math.asin(Math.sqrt(
    Math.sin((φp-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φp)*Math.sin((λp-λ1)/2)**2
  ));
  const θ13 = Math.atan2(
    Math.sin(λp-λ1)*Math.cos(φp),
    Math.cos(φ1)*Math.sin(φp) - Math.sin(φ1)*Math.cos(φp)*Math.cos(λp-λ1)
  );
  const θ12 = Math.atan2(
    Math.sin(λ2-λ1)*Math.cos(φ2),
    Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1)
  );
  return Math.abs(Math.asin(Math.sin(d13)*Math.sin(θ13-θ12))) * 180/Math.PI * 60;
}

function alongTrackFraction(lat1, lon1, lat2, lon2, latP, lonP) {
  const totalDist = haversine(lat1, lon1, lat2, lon2);
  if (totalDist < 0.1) return 0;
  const distFromStart = haversine(lat1, lon1, latP, lonP);
  const xtdRad = crossTrackDistanceNm(lat1, lon1, lat2, lon2, latP, lonP) / 60 * Math.PI/180;
  const dRad   = distFromStart / EARTH_RADIUS_NM;
  const atdNm  = Math.acos(Math.max(-1, Math.min(1, Math.cos(dRad)/Math.cos(xtdRad))))
                 * EARTH_RADIUS_NM;
  return Math.max(0, Math.min(1, atdNm / totalDist));
}

function formatTime(hrs) {
  const h = Math.floor(hrs);
  const m = Math.round((hrs - h) * 60);
  return `${h}h ${String(m).padStart(2,'0')}m`;
}

function artccForLat(lat) {
  return (ARTCC_BANDS.find(b => lat >= b.latMin && lat < b.latMax) || {}).id || 'UNKN';
}


// ---------------------------------------------------------------------------
// INDEXEDDB HELPERS
// ---------------------------------------------------------------------------

function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(req.error);
  });
}

function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

function idbGetAllKeys(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

function idbPut(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function openDB(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}


// ---------------------------------------------------------------------------
// SUA CONFLICT CHECK
// ---------------------------------------------------------------------------

function segmentConflictsSua(lat1, lon1, lat2, lon2, suas) {
  for (const sua of suas) {
    if (!['RESTRICTED', 'PROHIBITED'].includes(sua.type?.toUpperCase?.())) continue;
    for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const mid = intermediatePoint(lat1, lon1, lat2, lon2, f);
      if (haversine(mid.lat, mid.lon, sua.lat, sua.lon) < (sua.radiusNm + SUA_BUFFER_NM)) {
        return sua;
      }
    }
    // Also check the P-40 explicitly since it's always relevant
    for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const mid = intermediatePoint(lat1, lon1, lat2, lon2, f);
      if (haversine(mid.lat, mid.lon, DC_P40.lat, DC_P40.lon) < (DC_P40.radiusNm + SUA_BUFFER_NM)) {
        return { id: 'P-40', name: 'Washington DC P-40', type: 'PROHIBITED', ...DC_P40 };
      }
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// AIRWAY LOOKUP
// ---------------------------------------------------------------------------

/**
 * Given two adjacent fix IDs and the airways store records (array),
 * find all airways that have a direct segment connecting them.
 * Returns array of { airwayName, mea, distNm } sorted by MEA ascending.
 */
function airwaysBetweenFixes(fromId, toId, airwayRecords) {
  const results = [];
  for (const awy of airwayRecords) {
    if (!awy.waypoints || !awy.segments) continue;
    // Only low-altitude airways for the RV-9A
    if (!['V', 'T'].includes(awy.type)) continue;

    const wpts = awy.waypoints;
    for (let i = 0; i < wpts.length - 1; i++) {
      const a = wpts[i].name   || wpts[i].id;
      const b = wpts[i+1].name || wpts[i+1].id;
      if ((a === fromId && b === toId) || (a === toId && b === fromId)) {
        // Find the matching segment record
        const seg = awy.segments.find(
          s => s.from_seq === wpts[i].seq && s.to_seq === wpts[i+1].seq
        ) || awy.segments[i] || {};
        results.push({
          airwayName: awy.name,
          mea:        seg.mea_ft  ?? seg.mea ?? null,
          meaGnss:    seg.mea_gnss_ft ?? seg.mea_gnss ?? null,
          distNm:     seg.dist_nm ?? haversine(
            wpts[i].lat, wpts[i].lon, wpts[i+1].lat, wpts[i+1].lon),
        });
        break;
      }
    }
  }
  // Sort by MEA ascending — prefer lowest altitude constraint
  results.sort((a, b) => (a.mea ?? 99999) - (b.mea ?? 99999));
  return results;
}


// ---------------------------------------------------------------------------
// AIRWAY GRAPH — built once from IndexedDB airways store
// ---------------------------------------------------------------------------

class AirwayGraph {
  /**
   * Builds a bidirectional weighted graph from the IndexedDB airways store.
   *
   * graph[fixId] = [{to, distNm, mea, airway}]
   * coords[fixId] = {lat, lon}
   *
   * Includes both published airway edges AND GPS-direct edges for
   * departure/destination airports that are off-airway.
   */
  constructor() {
    this.graph  = {};   // fixId -> [{to, distNm, mea, airway}]
    this.coords = {};   // fixId -> {lat, lon}
  }

  /**
   * Populate the graph from an array of airway records.
   * Call once after loading airways from IndexedDB.
   */
  build(airways) {
    this.graph  = {};
    this.coords = {};

    for (const awy of airways) {
      // Only low-altitude airways for the RV-9A
      if (!['V', 'T'].includes(awy.type)) continue;
      if (!awy.waypoints?.length) continue;

      const wpts = awy.waypoints;

      // Register all fix coordinates
      for (const w of wpts) {
        const id = w.name || w.id;
        if (id && w.lat != null && w.lon != null && !this.coords[id]) {
          this.coords[id] = { lat: w.lat, lon: w.lon };
        }
      }

      // Add edges for each segment, bidirectional
      for (let i = 0; i < wpts.length - 1; i++) {
        const fromId = wpts[i].name   || wpts[i].id;
        const toId   = wpts[i+1].name || wpts[i+1].id;
        if (!fromId || !toId) continue;

        const seg = awy.segments?.find(
          s => s.from_seq === wpts[i].seq && s.to_seq === wpts[i+1].seq
        ) ?? awy.segments?.[i] ?? {};

        // FAA AWY_SEG_ALT.csv has gaps where dist_nm is 0. A* treats 0 as a
        // free edge and produces nonsense routes (e.g. via WV when V143 is
        // available). Fall back to haversine when dist is missing OR zero.
        const dist = (seg.dist_nm && seg.dist_nm > 0)
            ? seg.dist_nm
            : haversine(wpts[i].lat, wpts[i].lon, wpts[i+1].lat, wpts[i+1].lon);
        const mea = seg.mea_ft ?? seg.mea ?? 0;

        this._addEdge(fromId, toId, dist, mea, awy.name);
        this._addEdge(toId, fromId, dist, mea, awy.name);
      }
    }

    return this;
  }

  _addEdge(from, to, distNm, mea, airway) {
    if (!this.graph[from]) this.graph[from] = [];
    // Avoid duplicate edges on the same airway segment
    const existing = this.graph[from].find(e => e.to === to && e.airway === airway);
    if (!existing) {
      this.graph[from].push({ to, distNm, mea, airway });
    }
  }

  /**
   * Add a GPS-direct edge between two points (off-airway departure/destination,
   * or any gap where no airway connects adjacent fixes).
   */
  addDirectEdge(fromId, fromLat, fromLon, toId, toLat, toLon) {
    if (!this.coords[fromId]) this.coords[fromId] = { lat: fromLat, lon: fromLon };
    if (!this.coords[toId])   this.coords[toId]   = { lat: toLat,   lon: toLon   };
    const dist = haversine(fromLat, fromLon, toLat, toLon);
    this._addEdge(fromId, toId, dist, 0, 'DIRECT');
    this._addEdge(toId, fromId, dist, 0, 'DIRECT');
  }

  /**
   * Find the nearest on-airway fix(es) to a given lat/lon within maxNm.
   * Used to connect off-airway airports to the graph.
   * Returns array of {fixId, distNm} sorted by distance.
   */
  nearestFixes(lat, lon, maxNm = 60, limit = 5) {
    const candidates = [];
    for (const [id, c] of Object.entries(this.coords)) {
      const d = haversine(lat, lon, c.lat, c.lon);
      if (d <= maxNm) candidates.push({ fixId: id, distNm: d });
    }
    candidates.sort((a, b) => a.distNm - b.distNm);
    return candidates.slice(0, limit);
  }
}


// ---------------------------------------------------------------------------
// WORK GRAPH — lightweight proxy over the shared AirwayGraph for one plan()
// call. Reads through to the shared immutable graph for all existing edges;
// only the small set of temporary DEP/DEST edges are stored separately.
// Eliminates the JSON.parse(JSON.stringify(...)) deep-copy in build().
// ---------------------------------------------------------------------------

class WorkGraph {
    constructor(base) {
        this._extra = {};
        // Shallow-copy coords so DEP/DEST entries don't mutate the shared graph
        this.coords = { ...base.coords };
        // Proxy the adjacency list: merge base + extra on each fixId lookup
        const self = this;
        this.graph = new Proxy(base.graph, {
            get(target, fixId) {
                if (typeof fixId !== 'string') return target[fixId];
                const baseEdges = target[fixId]      || [];
                const extra     = self._extra[fixId] || [];
                return extra.length ? [...baseEdges, ...extra] : baseEdges;
            },
        });
    }

    _addEdge(from, to, distNm, mea, airway) {
        if (!this._extra[from]) this._extra[from] = [];
        if (!this._extra[from].find(e => e.to === to && e.airway === airway))
            this._extra[from].push({ to, distNm, mea, airway });
    }

    addDirectEdge(fromId, fromLat, fromLon, toId, toLat, toLon) {
        if (!this.coords[fromId]) this.coords[fromId] = { lat: fromLat, lon: fromLon };
        if (!this.coords[toId])   this.coords[toId]   = { lat: toLat,   lon: toLon   };
        const dist = haversine(fromLat, fromLon, toLat, toLon);
        this._addEdge(fromId, toId, dist, 0, 'DIRECT');
        this._addEdge(toId, fromId, dist, 0, 'DIRECT');
    }

    nearestFixes(lat, lon, maxNm = 60, limit = 5) {
        const candidates = [];
        for (const [id, c] of Object.entries(this.coords)) {
            const d = haversine(lat, lon, c.lat, c.lon);
            if (d <= maxNm) candidates.push({ fixId: id, distNm: d });
        }
        candidates.sort((a, b) => a.distNm - b.distNm);
        return candidates.slice(0, limit);
    }
}


// ---------------------------------------------------------------------------
// ROUTE CONSTRUCTOR  — A* search on the airway graph
// ---------------------------------------------------------------------------

class RouteConstructor {
  /**
   * @param {IDBDatabase} db
   * @param {AirwayGraph}  airwayGraph   pre-built graph
   * @param {object[]}     suas          SUA records
   */
  constructor(db, airwayGraph, suas) {
    this.db    = db;
    this.graph = airwayGraph;
    this.suas  = suas;
  }

  /**
   * A* shortest-path search through the airway graph.
   *
   * Heuristic: straight-line distance to destination (admissible — never
   * overestimates since airways are always >= direct distance).
   *
   * Cost function: segment distance. MEA is tracked but not used as
   * a cost driver — it's reported on each leg for the pilot's reference.
   *
   * @param {string} startId   departure fix ID (or airport ICAO)
   * @param {string} goalId    destination fix ID (or airport ICAO)
   * @param {number} destLat
   * @param {number} destLon
   * @returns {Array|null}  ordered array of {fix, airway, g} or null if no path
   */
  _astar(startId, goalId, destLat, destLon) {
    const open   = new Map();   // fixId -> {g, f, prev, prevAirway, prevDist}
    const closed = new Map();

    const h = id => {
      const c = this.graph.coords[id];
      return c ? haversine(c.lat, c.lon, destLat, destLon) : 9999;
    };

    open.set(startId, { g: 0, f: h(startId), prev: null, prevAirway: null, prevDist: 0 });

    let iters = 0;
    while (open.size > 0 && iters++ < 20000) {
      // Pop lowest-f node
      let curId = null, curNode = null;
      for (const [id, node] of open) {
        if (!curId || node.f < curNode.f) { curId = id; curNode = node; }
      }
      open.delete(curId);
      closed.set(curId, curNode);

      if (curId === goalId) {
        // Reconstruct path
        const path = [];
        let id = goalId;
        while (id !== null) {
          const node = closed.get(id);
          path.unshift({ fix: id, airway: node.prevAirway, g: node.g, segDist: node.prevDist });
          id = node.prev;
        }
        return path;
      }

      for (const edge of (this.graph.graph[curId] ?? [])) {
        if (closed.has(edge.to)) continue;
        const g = curNode.g + edge.distNm;
        const f = g + h(edge.to);
        const ex = open.get(edge.to);
        if (!ex || g < ex.g) {
          open.set(edge.to, {
            g, f,
            prev: curId,
            prevAirway: edge.airway,
            prevDist:   edge.distNm,
          });
        }
      }
    }
    return null;   // no path found
  }

  /**
   * Build route from departure to destination.
   *
   * 1. Connect departure airport to nearest on-airway fixes (GPS direct)
   * 2. Connect destination airport to nearest on-airway fixes (GPS direct)
   * 3. Run A* to find shortest airway path
   * 4. SUA conflict check on each segment — insert avoidance waypoints if needed
   * 5. Return {waypoints, legs, routeString}
   */
  async build(depIcao, destIcao) {
    const depApt  = await idbGet(this.db, 'airports', depIcao);
    const destApt = await idbGet(this.db, 'airports', destIcao);
    if (!depApt)  throw new Error(`Departure ${depIcao} not found`);
    if (!destApt) throw new Error(`Destination ${destIcao} not found`);

    // Clone graph so we can add temporary departure/destination edges
    // without mutating the shared graph
    const workGraph = new WorkGraph(this.graph);

    // Connect departure airport to nearby on-airway fixes
    const nearDep = workGraph.nearestFixes(depApt.lat, depApt.lon, 80);
    for (const nf of nearDep) {
      workGraph.addDirectEdge(depIcao, depApt.lat, depApt.lon,
                              nf.fixId,
                              workGraph.coords[nf.fixId].lat,
                              workGraph.coords[nf.fixId].lon);
    }

    // Connect destination airport to nearby on-airway fixes
    const nearDest = workGraph.nearestFixes(destApt.lat, destApt.lon, 80);
    for (const nf of nearDest) {
      workGraph.addDirectEdge(destIcao, destApt.lat, destApt.lon,
                              nf.fixId,
                              workGraph.coords[nf.fixId].lat,
                              workGraph.coords[nf.fixId].lon);
    }
    // Run A*
    const rawPath = new RouteConstructor(this.db, workGraph, this.suas)
      ._astar(depIcao, destIcao, destApt.lat, destApt.lon);

    if (!rawPath) throw new Error(`No route found from ${depIcao} to ${destIcao}`);

    // Build waypoint list with coords
    const waypoints = rawPath.map(step => {
      const c = workGraph.coords[step.fix] ?? { lat: 0, lon: 0 };
      return {
        fix:     step.fix,
        lat:     c.lat,
        lon:     c.lon,
        airway:  step.airway,   // airway used to ARRIVE at this fix
        segDist: step.segDist,
      };
    });

    // SUA conflict check — insert avoidance fixes where needed
    const safeWaypoints = this._applySuaAvoidance(waypoints, workGraph);

    // Build legs with airway annotation
    const legs = [];
    const routeParts = [safeWaypoints[0].fix];

    for (let i = 0; i < safeWaypoints.length - 1; i++) {
      const from = safeWaypoints[i];
      const to   = safeWaypoints[i + 1];
      const distNm = haversine(from.lat, from.lon, to.lat, to.lon);
      const hdg    = bearing(from.lat, from.lon, to.lat, to.lon);
      const awy    = to.airway || 'DIRECT';

      legs.push({
        from:      from.fix,
        to:        to.fix,
        distNm:    Math.round(distNm * 10) / 10,
        hdgTrue:   Math.round(hdg),
        airway:    awy,
        mea:       to.mea ?? null,
        artcc:     artccForLat((from.lat + to.lat) / 2),
      });

      if (awy !== 'DIRECT') routeParts.push(awy);
      routeParts.push(to.fix);
    }

    // Clean up consecutive duplicate airway labels
    const routeString = this._buildRouteString(routeParts);

    return { waypoints: safeWaypoints, legs, routeString };
  }

  _buildRouteString(parts) {
    const out = [parts[0]];
    for (let i = 1; i < parts.length; i++) {
      // Skip duplicate consecutive airway labels
      if (parts[i] === out[out.length - 1]) continue;
      out.push(parts[i]);
    }
    return out.join(' ');
  }

  _applySuaAvoidance(waypoints, workGraph) {
    const result = [waypoints[0]];
    let i = 0, splices = 0;
    const wpts = [...waypoints];

    // The safety counter only guards against runaway splice insertions.
    // Counting every iteration (the previous bug) truncated routes longer
    // than 30 waypoints — A*'s final waypoint (the destination airport)
    // would be dropped, leaving legs that end at the previous fix.
    while (i < wpts.length - 1) {
      const from = wpts[i];
      const to   = wpts[i + 1];
      const conflict = segmentConflictsSua(from.lat, from.lon, to.lat, to.lon, this.suas);

      if (conflict) {
        // Find a nearby on-airway fix that routes around the conflict
        const avoidFix = this._findAvoidanceFix(from, to, conflict, workGraph);
        if (avoidFix && !result.find(w => w.fix === avoidFix.fix) && splices++ < 10) {
          result.push(avoidFix);
          wpts.splice(i + 1, 0, avoidFix);
        } else {
          result.push(to);
          i++;
        }
      } else {
        result.push(to);
        i++;
      }
    }
    return result;
  }

  _findAvoidanceFix(from, to, sua, workGraph) {
    // Find nearest on-airway fix that clears the SUA and is between from and to
    let best = null, bestScore = Infinity;
    for (const [id, c] of Object.entries(workGraph.coords)) {
      const frac = alongTrackFraction(from.lat, from.lon, to.lat, to.lon, c.lat, c.lon);
      if (frac <= 0.05 || frac >= 0.95) continue;
      const distToSua = haversine(c.lat, c.lon, sua.lat, sua.lon);
      if (distToSua < (sua.radiusNm + SUA_BUFFER_NM)) continue;
      // Prefer fixes east of the SUA (avoids DC SFRA)
      const eastBonus = Math.max(0, c.lon - sua.lon) * 8;
      const xtd = crossTrackDistanceNm(from.lat, from.lon, to.lat, to.lon, c.lat, c.lon);
      const score = xtd - eastBonus;
      if (score < bestScore) { bestScore = score; best = { fix: id, lat: c.lat, lon: c.lon, airway: 'DIRECT', segDist: 0 }; }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// FUEL STOP OPTIMIZER
// ---------------------------------------------------------------------------

class FuelStopOptimizer {
  /**
   * @param {IDBDatabase} db
   * @param {object}      aircraft  - aircraft profile record
   * @param {object}      opts
   * @param {number}      opts.preferredLegHrs  default 2.0
   * @param {number}      opts.reserveGal       default 10.0
   * @param {boolean}     opts.selfServeOnly    default false
   * @param {number}      opts.corridorWidthNm  default 25
   * @param {number}      opts.maxDetourNm      default 20
   * @param {number}      opts.minLegNm         default 80
   */
  constructor(db, aircraft, opts = {}) {
    this.db        = db;
    this.ac        = aircraft;
    this.ktas      = aircraft.ktas      || aircraft.cruise_ktas || 155;
    this.gph       = aircraft.gph       || aircraft.fuel_burn_gph || 8.0;
    this.usableGal = aircraft.usableGal || aircraft.fuel_capacity_gal || 36.0;

    this.preferredLegNm  = this.ktas * (opts.preferredLegHrs ?? 2.0);
    this.reserveGal      = opts.reserveGal ?? 10.0;
    this.safeRangeNm     = (this.usableGal - this.reserveGal) * this.ktas / this.gph;
    this.selfServeOnly   = opts.selfServeOnly ?? false;
    this.corridorWidthNm = opts.corridorWidthNm ?? 25;
    this.maxDetourNm     = opts.maxDetourNm ?? 20;
    this.minLegNm        = opts.minLegNm ?? 80;

    this._DETOUR_PENALTY = 0.12;  // $/nm
  }

  fuelForLeg(distNm)   { return (distNm / this.ktas) * this.gph; }
  timeForLeg(distNm)   { return distNm / this.ktas; }

  async _candidateStops(fromLat, fromLon, toLat, toLon) {
    // Load all airports with fuel prices from IndexedDB
    // We do a full scan here; in production add a geo-index for performance
    const [airports, fuelPrices] = await Promise.all([
      idbGetAll(this.db, 'airports'),
      idbGetAll(this.db, 'fuel_prices'),
    ]);

    const priceMap = new Map(fuelPrices.map(fp => [fp.icao, fp]));
    const directDist = haversine(fromLat, fromLon, toLat, toLon);
    const candidates = [];

    for (const apt of airports) {
      if (!apt.lat || !apt.lon) continue;

      // Must have 100LL
      const fp = priceMap.get(apt.icao);
      const price100ll = fp?.price_100ll ?? fp?.avgas ?? null;
      if (!price100ll) continue;
      if (this.selfServeOnly && !fp?.self_serve) continue;

      const frac = alongTrackFraction(fromLat, fromLon, toLat, toLon, apt.lat, apt.lon);
      if (frac <= 0.05 || frac >= 0.95) continue;

      const xtd = Math.abs(crossTrackDistanceNm(fromLat, fromLon, toLat, toLon, apt.lat, apt.lon));
      if (xtd > this.corridorWidthNm) continue;

      const distToStop  = haversine(fromLat, fromLon, apt.lat, apt.lon);
      if (distToStop < this.minLegNm) continue;
      if (distToStop > this.safeRangeNm) continue;

      const distStopToDest = haversine(apt.lat, apt.lon, toLat, toLon);
      const detour = Math.max(0, (distToStop + distStopToDest) - directDist);
      if (detour > this.maxDetourNm) continue;

      const galsNeeded = this.fuelForLeg(distToStop);
      const fuelCost   = price100ll * galsNeeded;
      const costScore  = fuelCost + detour * this._DETOUR_PENALTY;

      candidates.push({
        icao:       apt.icao,
        name:       apt.name || apt.icao,
        state:      apt.state || '',
        lat:        apt.lat,
        lon:        apt.lon,
        price100ll,
        selfServe:  fp?.self_serve ?? false,
        distNm:     Math.round(distToStop * 10) / 10,
        detourNm:   Math.round(detour * 10) / 10,
        galsNeeded: Math.round(galsNeeded * 10) / 10,
        fuelCost:   Math.round(fuelCost * 100) / 100,
        costScore:  Math.round(costScore * 100) / 100,
        frac,
      });
    }

    candidates.sort((a, b) => a.costScore - b.costScore);
    return candidates;
  }

  async optimize(depIcao, destIcao) {
    const [depApt, destApt] = await Promise.all([
      idbGet(this.db, 'airports', depIcao),
      idbGet(this.db, 'airports', destIcao),
    ]);

    const stops    = [];
    let curLat     = depApt.lat;
    let curLon     = depApt.lon;
    let remaining  = haversine(curLat, curLon, destApt.lat, destApt.lon);
    let iteration  = 0;

    while (remaining > this.safeRangeNm && iteration++ < 10) {
      const candidates = await this._candidateStops(
        curLat, curLon, destApt.lat, destApt.lon);

      if (!candidates.length) {
        console.warn('[RoutePlanner] No fuel stop candidates found in corridor');
        break;
      }

      // Pick best candidate weighted by cost + proximity to preferred leg length
      let best = null, bestTotal = Infinity;
      for (const c of candidates.slice(0, 8)) {
        const distPenalty = Math.abs(c.distNm - this.preferredLegNm) * 0.05;
        const total = c.costScore + distPenalty;
        if (total < bestTotal) { bestTotal = total; best = c; }
      }

      // Attach alternatives for display
      best.alternatives = candidates.slice(1, 4).map(a => ({
        icao: a.icao, name: a.name, price: a.price100ll, distNm: a.distNm,
      }));

      stops.push(best);
      curLat    = best.lat;
      curLon    = best.lon;
      remaining = haversine(curLat, curLon, destApt.lat, destApt.lon);
    }

    return stops;
  }
}


// ---------------------------------------------------------------------------
// LEG BUILDER
// ---------------------------------------------------------------------------

function buildLegs(depIcao, destIcao, fuelStops, routeLegs, aircraft, reserveGal) {
  const ktas      = aircraft.ktas      || 155;
  const gph       = aircraft.gph       || 8.0;
  const usableGal = aircraft.usableGal || 36.0;

  // Sequence: dep → stop1 → stop2 → ... → dest
  const stopIcaos = fuelStops.map(s => s.icao);
  const sequence  = [depIcao, ...stopIcaos, destIcao];

  let fuelOnboard = usableGal;
  const legs = [];

  for (let i = 0; i < sequence.length - 1; i++) {
    const fromId = sequence[i];
    const toId   = sequence[i + 1];

    // Find total distance for this segment (may span multiple route legs)
    let distNm = 0;
    let airway = 'DIRECT';
    for (const leg of routeLegs) {
      if (leg.from === fromId || leg.to === toId) {
        distNm += leg.distNm;
        if (leg.airway !== 'DIRECT') airway = leg.airway;
      }
    }
    // Fallback: use fuel stop dist_nm directly
    if (distNm === 0 && i < fuelStops.length) {
      distNm = fuelStops[i].distNm;
    }
    if (distNm === 0) distNm = 1; // guard

    const timeHrs       = distNm / ktas;
    const galsUsed      = timeHrs * gph;
    const fuelAtArrival = fuelOnboard - galsUsed;
    const marginGal     = fuelAtArrival - reserveGal;
    const reserveOk     = fuelAtArrival >= reserveGal;

    legs.push({
      from:           fromId,
      to:             toId,
      distNm:         Math.round(distNm * 10) / 10,
      timeHrs:        Math.round(timeHrs * 100) / 100,
      timeStr:        formatTime(timeHrs),
      fuelStartGal:   Math.round(fuelOnboard * 10) / 10,
      galsUsed:       Math.round(galsUsed * 10) / 10,
      fuelArrivalGal: Math.round(fuelAtArrival * 10) / 10,
      reserveGal,
      marginGal:      Math.round(marginGal * 10) / 10,
      reserveOk,
    });

    // Top off at fuel stops, not at destination
    if (i < sequence.length - 2) fuelOnboard = usableGal;
  }

  return legs;
}


// ---------------------------------------------------------------------------
// MAIN PLANNER CLASS
// ---------------------------------------------------------------------------

class RoutePlanner {
  /**
   * @param {string} dbName  IndexedDB database name (default 'flypi' — same as NasrDB)
   */
  constructor(dbName = 'flypi') {
    this.dbName = dbName;
    this.db     = null;
    this._suas    = null;
    this._airways = null;
    this._fixMap  = null;
  }

  /**
   * Open DB and warm up caches. Call once after construction.
   */
  async init() {
    this.db = await openDB(this.dbName);
    await this._warmCache();
    return this;
  }

  async _warmCache() {
    // Load SUAs and airways once — stable within a NASR cycle
    const [suas, airways] = await Promise.all([
      idbGetAll(this.db, 'sua'),
      idbGetAll(this.db, 'airways'),
    ]);

    this._suas = suas;

    // Build the airway graph — A* searches this directly
    this._airwayGraph = new AirwayGraph().build(airways);
  }

  /**
   * Refresh caches — call after a NASR cycle update.
   */
  async refresh() {
    this._suas = this._airwayGraph = null;
    await this._warmCache();
  }

  /**
   * Build a complete route plan.
   *
   * @param {object} opts
   * @param {string}  opts.departure         ICAO departure
   * @param {string}  opts.destination       ICAO destination
   * @param {string}  [opts.aircraftId]      key in aircraft_profiles store
   * @param {object}  [opts.aircraft]        inline aircraft profile (overrides aircraftId)
   * @param {number}  [opts.preferredLegHrs] default 2.0
   * @param {number}  [opts.reserveGal]      default 10.0
   * @param {boolean} [opts.selfServeOnly]   default false
   *
   * @returns {Promise<RoutePlan>}
   */
  async plan(opts) {
    const {
      departure,
      destination,
      aircraftId,
      preferredLegHrs = 2.0,
      reserveGal      = 10.0,
      selfServeOnly   = false,
    } = opts;

    // Load aircraft profile
    let aircraft = opts.aircraft ?? null;
    if (!aircraft && aircraftId) {
      aircraft = await idbGet(this.db, 'aircraft_profiles', aircraftId);
    }
    if (!aircraft) {
        // Fall back to RV-9A defaults when aircraft_profiles IDB store is empty
        aircraft = { ktas: 155, gph: 8.0, usableGal: 36.0,
                     cruise_ktas: 155, fuel_burn_gph: 8.0, fuel_capacity_gal: 36.0 };
    }

    // Ensure caches are ready
    if (!this._suas) await this._warmCache();

    // Stage 1: Route construction via A* on the airway graph
    const constructor = new RouteConstructor(
      this.db, this._airwayGraph, this._suas);
    const { waypoints, legs: routeLegs, routeString } =
      await constructor.build(departure, destination);

    // Stage 2: Fuel stop optimization
    const optimizer = new FuelStopOptimizer(this.db, aircraft, {
      preferredLegHrs,
      reserveGal,
      selfServeOnly,
      corridorWidthNm: 25,
      maxDetourNm:     20,
      minLegNm:        80,
    });
    const fuelStops = await optimizer.optimize(departure, destination);

    // Build legs with fuel tracking
    const legs = buildLegs(
      departure, destination, fuelStops, routeLegs, aircraft, reserveGal);

    // Totals
    const totalDistNm   = routeLegs.reduce((s, l) => s + l.distNm, 0);
    const totalTimeHrs  = legs.reduce((s, l) => s + l.timeHrs, 0);
    const totalGals     = legs.reduce((s, l) => s + l.galsUsed, 0);
    const totalFuelCost = fuelStops.reduce((s, st) =>
      s + (st.price100ll ?? 0) * (st.galsNeeded ?? 0), 0);

    return {
      // Inputs
      departure,
      destination,
      aircraft,
      reserveGal,

      // Core outputs
      routeString,
      waypoints,
      routeLegs,
      fuelStops,
      legs,

      // Summary
      summary: {
        totalDistNm:   Math.round(totalDistNm * 10) / 10,
        initialHdg:    routeLegs[0]?.hdgTrue ?? 0,
        totalTimeHrs:  Math.round(totalTimeHrs * 100) / 100,
        totalTimeStr:  formatTime(totalTimeHrs),
        fuelStopCount: fuelStops.length,
        totalGals:     Math.round(totalGals * 10) / 10,
        totalFuelCost: Math.round(totalFuelCost * 100) / 100,
        avgFuelPrice:  totalGals > 0
          ? Math.round(totalFuelCost / totalGals * 100) / 100
          : null,
        reserveOk:     legs.every(l => l.reserveOk),
      },

      // Metadata
      planTime: new Date().toISOString(),
    };
  }

  /**
   * Save a completed plan to the flight_plans store.
   * @param {RoutePlan} plan
   * @param {string}    [id]  optional key; generated if omitted
   */
  async savePlan(plan, id) {
    const record = {
      id:          id ?? `FP-${Date.now()}`,
      created:     plan.planTime,
      departure:   plan.departure,
      destination: plan.destination,
      routeString: plan.routeString,
      plan,
    };
    await idbPut(this.db, 'flight_plans', record);
    return record.id;
  }

  /**
   * Load a saved plan by ID.
   * @param {string} id
   */
  async loadPlan(id) {
    const record = await idbGet(this.db, 'flight_plans', id);
    return record?.plan ?? null;
  }
}


// ---------------------------------------------------------------------------
// CONVENIENCE FACTORY
// ---------------------------------------------------------------------------

/**
 * Create and initialise a RoutePlanner in one call.
 * @param {string} dbName
 */
async function createRoutePlanner(dbName = 'flypi') {
  return new RoutePlanner(dbName).init();
}


// ---------------------------------------------------------------------------
// PIPELINE NOTE — AWY.csv
// ---------------------------------------------------------------------------
/**
 * The airways store must be populated from NASR AWY_BASE.csv + AWY_SEG.csv
 * at build time via the fly-pipeline.  The expected record shape per airway is:
 *
 *   {
 *     name: "V65",
 *     type: "V",
 *     waypoints: [
 *       { seq: 10, name: "GSO", lat: 36.0978, lon: -79.9373, id: "GSO", type: "VORTAC" },
 *       { seq: 20, name: "RIC", lat: 37.5052, lon: -77.3197, id: "RIC", type: "VORTAC" },
 *     ],
 *     segments: [
 *       { from_seq: 10, to_seq: 20, dist_nm: 152.0, mea_ft: 3000, mea_gnss_ft: null }
 *     ]
 *   }
 *
 * The nasr_awy_parser.py script in fly-pipeline produces this shape from
 * AWY_BASE.csv + AWY_SEG.csv + NAV_BASE.csv.  Add AWY_BASE.csv and AWY_SEG.csv
 * to the pipeline download list alongside the existing NASR files.
 *
 * Minimum pipeline additions:
 *   - Download: AWY_BASE.csv, AWY_SEG.csv (from NASR_Subscription_<cycle>.zip)
 *   - Parse:    nasr_awy_parser.py (already written)
 *   - Store:    write to IndexedDB 'airways' store, keyed by name
 */
