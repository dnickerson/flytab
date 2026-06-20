/**
 * terminalPlanner.js
 * FlyTab Terminal Area Planner
 *
 * Detects Class B airspace along a proposed route, finds compatible
 * T-routes and avoidance options, and presents the pilot with choices
 * before route assembly.
 *
 * Usage:
 *   import { TerminalPlanner } from './terminalPlanner.js';
 *
 *   const tp = new TerminalPlanner('FlyTabDB');
 *   await tp.init();
 *
 *   const analysis = await tp.analyzeRoute('KLKR', 'KMHT');
 *   // analysis.terminalAreas = [{icao, name, options:[{type,label,...}]}]
 *
 *   // After pilot selects options:
 *   const route = await tp.buildRoute('KLKR', 'KMHT', selections);
 *   // route = { waypoints:[], routeString:'' }
 */

'use strict';

const EARTH_RADIUS_NM = 3440.065;

// ---------------------------------------------------------------------------
// GEOMETRY
// ---------------------------------------------------------------------------

function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }

function haversine(lat1, lon1, lat2, lon2) {
  const a = Math.sin(toRad(lat2-lat1)/2)**2
          + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))
          * Math.sin(toRad(lon2-lon1)/2)**2;
  return EARTH_RADIUS_NM * 2 * Math.asin(Math.sqrt(Math.min(1,a)));
}

function bearing(lat1, lon1, lat2, lon2) {
  const [p1,p2,dl] = [lat1,lat2,lon2-lon1].map(toRad);
  return (toDeg(Math.atan2(
    Math.sin(dl)*Math.cos(p2),
    Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl)
  ))+360)%360;
}

function intermediatePoint(lat1, lon1, lat2, lon2, f) {
  const [p1,l1,p2,l2] = [lat1,lon1,lat2,lon2].map(toRad);
  const d = 2*Math.asin(Math.sqrt(
    Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin((l2-l1)/2)**2));
  if (d < 1e-10) return {lat:lat1,lon:lon1};
  const a=Math.sin((1-f)*d)/Math.sin(d), b=Math.sin(f*d)/Math.sin(d);
  const x=a*Math.cos(p1)*Math.cos(l1)+b*Math.cos(p2)*Math.cos(l2);
  const y=a*Math.cos(p1)*Math.sin(l1)+b*Math.cos(p2)*Math.sin(l2);
  const z=a*Math.sin(p1)+b*Math.sin(p2);
  return {lat:toDeg(Math.atan2(z,Math.sqrt(x*x+y*y))),lon:toDeg(Math.atan2(y,x))};
}

function gcIntersectsCircle(lat1,lon1,lat2,lon2,cLat,cLon,radiusNm) {
  for (let f=0; f<=1; f+=0.04) {
    const p = intermediatePoint(lat1,lon1,lat2,lon2,f);
    if (haversine(p.lat,p.lon,cLat,cLon) < radiusNm) return true;
  }
  return false;
}

function nearestFraction(lat1,lon1,lat2,lon2,fixLat,fixLon) {
  let best=0, bestDist=Infinity;
  for (let f=0; f<=1; f+=0.01) {
    const p = intermediatePoint(lat1,lon1,lat2,lon2,f);
    const d = haversine(p.lat,p.lon,fixLat,fixLon);
    if (d<bestDist) {bestDist=d; best=f;}
  }
  return best;
}

function cardinalDir(brg) {
  return ['N','NE','E','SE','S','SW','W','NW'][Math.round(brg/45)%8];
}

function tRouteCompatible(waypoints, flightBearing) {
  if (!waypoints || waypoints.length < 2) return false;
  const first=waypoints[0], last=waypoints[waypoints.length-1];
  const routeBrg = bearing(first.lat,first.lon,last.lat,last.lon);
  return Math.abs(((flightBearing-routeBrg)+540)%360-180) < 90;
}

function tRouteNearTerminal(waypoints, cLat, cLon, radiusNm) {
  return waypoints?.some(w => haversine(w.lat,w.lon,cLat,cLon) < radiusNm) ?? false;
}


// ---------------------------------------------------------------------------
// INDEXEDDB HELPERS
// ---------------------------------------------------------------------------

function idbGet(db, store, key) {
  return new Promise((res,rej) => {
    const r = db.transaction(store,'readonly').objectStore(store).get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror   = () => rej(r.error);
  });
}

function idbGetAll(db, store) {
  return new Promise((res,rej) => {
    const r = db.transaction(store,'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result ?? []);
    r.onerror   = () => rej(r.error);
  });
}


// ---------------------------------------------------------------------------
// STATIC DATA
// Class B airports along eastern US corridor with outer shelf radii.
// T-route associations — derived from AWY store at runtime but seeded here.
// Avoidance corridors — known safe routing around each Class B.
// ---------------------------------------------------------------------------

const CLASS_B_AIRPORTS = [
  {icao:'KATL', name:'Atlanta',             lat:33.6407,lon:-84.4277, radiusNm:40},
  {icao:'KCLT', name:'Charlotte/Douglas',   lat:35.2140,lon:-80.9431, radiusNm:40},
  {icao:'KRDU', name:'Raleigh-Durham',      lat:35.8777,lon:-78.7875, radiusNm:30},
  {icao:'KDCA', name:'Reagan National',     lat:38.8521,lon:-77.0377, radiusNm:30},
  {icao:'KIAD', name:'Dulles',              lat:38.9445,lon:-77.4558, radiusNm:35},
  {icao:'KBWI', name:'Baltimore/Washington',lat:39.1754,lon:-76.6683, radiusNm:30},
  {icao:'KPHL', name:'Philadelphia',        lat:39.8719,lon:-75.2411, radiusNm:35},
  {icao:'KEWR', name:'Newark',              lat:40.6895,lon:-74.1745, radiusNm:30},
  {icao:'KJFK', name:'JFK',                lat:40.6413,lon:-73.7781, radiusNm:30},
  {icao:'KLGA', name:'LaGuardia',           lat:40.7773,lon:-73.8726, radiusNm:22},
  {icao:'KBOS', name:'Boston',              lat:42.3656,lon:-71.0096, radiusNm:30},
];

// T-routes that serve each Class B terminal area
const CLASS_B_T_ROUTES = {
  KCLT: ['T200','T201','T202','T203'],
  KATL: ['T228','T229'],
  KRDU: ['T289'],
  KJFK: [],  // NYC handled via lateral corridor
  KEWR: [],
  KLGA: [],
  KDCA: [],  // DC SFRA — avoidance is the primary strategy for GA
  KIAD: [],
  KBWI: [],
  KPHL: [],
  KBOS: [],
};

// Named avoidance corridors for Class B areas
const CLASS_B_AVOIDANCE = {
  KCLT: {
    label:       'East of Charlotte — LOCAS direct GSO',
    description: 'RNAV transition via LOCAS, avoids core Class B',
    fixes:       ['LOCAS','GSO'],
  },
  KRDU: {
    label:       'South of Raleigh-Durham — direct RIC',
    description: 'Route south of the Class B via V225 or direct',
    fixes:       ['RIC'],
  },
  KDCA: {
    label:       'East of DC SFRA — via ESN',
    description: 'Easton VOR (ESN), 39nm east of P-40. Standard GA routing.',
    fixes:       ['RIC','ESN'],
  },
  KJFK: {
    label:       'Eastern Shore corridor — ESN to SBJ',
    description: 'Stay east of NYC Class B via Easton → Solberg',
    fixes:       ['ESN','SBJ','PUT'],
  },
  KEWR: {
    label:       'Eastern Shore corridor — ESN to SBJ',
    description: 'Stay east of Newark Class B via Easton → Solberg',
    fixes:       ['ESN','SBJ','PUT'],
  },
  KLGA: {
    label:       'Eastern Shore corridor — ESN to SBJ',
    description: 'Stay east of LaGuardia Class B via Easton → Solberg',
    fixes:       ['ESN','SBJ','PUT'],
  },
  KPHL: {
    label:       'Route via SBJ south of Philadelphia',
    description: 'Solberg VOR keeps you south and east of PHL Class B',
    fixes:       ['SBJ'],
  },
  KBWI: {
    label:       'Route via ESN east of Baltimore',
    description: 'Easton VOR routes you east of BWI Class B',
    fixes:       ['ESN'],
  },
  KBOS: {
    label:       'Route via ORW south of Boston',
    description: 'Norwich VOR routes you south of BOS Class B',
    fixes:       ['ORW','MHT'],
  },
};


// ---------------------------------------------------------------------------
// TERMINAL PLANNER CLASS
// ---------------------------------------------------------------------------

export class TerminalPlanner {
  constructor(dbName = 'FlyTabDB') {
    this.dbName   = dbName;
    this.db       = null;
    this._airways = null;
    this._fixCoords = new Map(); // fix name -> {lat,lon}
  }

  async init() {
    this.db = await new Promise((res,rej) => {
      const r = indexedDB.open(this.dbName);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
    this._airways = await idbGetAll(this.db, 'airways');
    // Build fix coordinate cache from airways waypoints
    for (const awy of this._airways) {
      for (const w of (awy.waypoints ?? [])) {
        const id = w.name || w.id;
        if (id && w.lat != null && !this._fixCoords.has(id)) {
          this._fixCoords.set(id, {lat:w.lat, lon:w.lon});
        }
      }
    }
    return this;
  }

  // -------------------------------------------------------------------------
  // PUBLIC: analyzeRoute
  // -------------------------------------------------------------------------

  async analyzeRoute(depIcao, destIcao) {
    const [dep, dest] = await Promise.all([
      idbGet(this.db,'airports',depIcao),
      idbGet(this.db,'airports',destIcao),
    ]);
    if (!dep)  throw new Error(`Departure ${depIcao} not found`);
    if (!dest) throw new Error(`Destination ${destIcao} not found`);

    const flightBrg  = bearing(dep.lat,dep.lon,dest.lat,dest.lon);
    const totalDist  = haversine(dep.lat,dep.lon,dest.lat,dest.lon);
    const terminalAreas = [];

    for (const cb of CLASS_B_AIRPORTS) {
      if (cb.icao===depIcao || cb.icao===destIcao) continue;

      const frac = nearestFraction(dep.lat,dep.lon,dest.lat,dest.lon,cb.lat,cb.lon);
      if (frac<0.05||frac>0.95) continue;
      if (!gcIntersectsCircle(dep.lat,dep.lon,dest.lat,dest.lon,cb.lat,cb.lon,cb.radiusNm)) continue;

      const gcPt = intermediatePoint(dep.lat,dep.lon,dest.lat,dest.lon,frac);
      const distFromTrack = haversine(gcPt.lat,gcPt.lon,cb.lat,cb.lon);

      const options = await this._buildOptions(
        cb, dep.lat,dep.lon, dest.lat,dest.lon, flightBrg);

      terminalAreas.push({
        icao:           cb.icao,
        name:           cb.name,
        lat:            cb.lat,
        lon:            cb.lon,
        radiusNm:       cb.radiusNm,
        distFromTrack:  Math.round(distFromTrack*10)/10,
        routeFraction:  Math.round(frac*100)/100,
        options,
      });
    }

    terminalAreas.sort((a,b)=>a.routeFraction-b.routeFraction);

    return {
      departure:        depIcao,
      destination:      destIcao,
      totalDistNm:      Math.round(totalDist),
      flightBearing:    Math.round(flightBrg),
      flightDir:        cardinalDir(flightBrg),
      terminalAreas,
      hasTerminalAreas: terminalAreas.length>0,
    };
  }

  // -------------------------------------------------------------------------
  // PRIVATE: build options for one Class B
  // -------------------------------------------------------------------------

  async _buildOptions(cb, depLat,depLon, destLat,destLon, flightBrg) {
    const options = [];
    const directDist = haversine(depLat,depLon,destLat,destLon);

    // --- T-routes ---
    const tRouteNames = CLASS_B_T_ROUTES[cb.icao] ?? [];

    // Also search the airways store dynamically for any T-routes near this Class B
    // that aren't in the static list (future-proofing for new routes)
    const dynamicTRoutes = this._airways
      .filter(a => a.type === 'T' && !tRouteNames.includes(a.name))
      .filter(a => tRouteCompatible(a.waypoints, flightBrg))
      .filter(a => tRouteNearTerminal(a.waypoints, cb.lat, cb.lon, cb.radiusNm))
      .map(a => a.name);

    const allTRoutes = [...new Set([...tRouteNames, ...dynamicTRoutes])];

    for (const routeName of allTRoutes) {
      const record = this._airways.find(a => a.name===routeName);
      if (!record?.waypoints?.length) continue;
      if (!tRouteCompatible(record.waypoints, flightBrg)) continue;
      if (!tRouteNearTerminal(record.waypoints, cb.lat, cb.lon, cb.radiusNm)) continue;

      const wpts     = record.waypoints;
      const entryFix = wpts[0];
      const exitFix  = wpts[wpts.length-1];
      const mea      = record.segments?.[0]?.mea_ft ?? null;

      // Estimate total distance via T-route
      const entryDist = haversine(depLat,depLon,entryFix.lat,entryFix.lon);
      const routeDist = record.segments?.reduce((s,sg)=>s+(sg.dist_nm??0),0) ?? 0;
      const exitDist  = haversine(exitFix.lat,exitFix.lon,destLat,destLon);
      const detourNm  = Math.max(0,Math.round((entryDist+routeDist+exitDist-directDist)*10)/10);

      options.push({
        type:        'T_ROUTE',
        id:          routeName,
        label:       `${routeName} — through ${cb.name} Class B`,
        description: `Enter ${entryFix.name} · exit ${exitFix.name}`
                   + (mea?` · MEA ${mea.toLocaleString()}ft`:'')
                   + (detourNm>0?` · +${detourNm}nm`:' · on track'),
        entryFix:    entryFix.name,
        exitFix:     exitFix.name,
        waypoints:   wpts.map(w=>w.name||w.id),
        meaFt:       mea,
        detourNm,
        recommended: true,
      });
    }

    // Sort T-route options by detour (shortest first)
    options.sort((a,b)=>a.detourNm-b.detourNm);

    // --- Avoidance corridor ---
    const avoid = CLASS_B_AVOIDANCE[cb.icao];
    if (avoid) {
      // Compute detour through avoidance fixes
      let totalDist=0, prevLat=depLat, prevLon=depLon;
      let validFixes = [];
      for (const fixId of avoid.fixes) {
        const c = this._fixCoords.get(fixId);
        if (c) {
          totalDist += haversine(prevLat,prevLon,c.lat,c.lon);
          prevLat=c.lat; prevLon=c.lon;
          validFixes.push(fixId);
        }
      }
      totalDist += haversine(prevLat,prevLon,destLat,destLon);
      const detourNm = Math.max(0,Math.round((totalDist-directDist)*10)/10);

      options.push({
        type:        'AVOIDANCE',
        id:          `AVOID_${cb.icao}`,
        label:       avoid.label,
        description: avoid.description+(detourNm>0?` · +${detourNm}nm`:''),
        fixes:       validFixes.length?validFixes:avoid.fixes,
        detourNm,
        recommended: false,
      });
    }

    // --- ATC direct (let them amend) ---
    options.push({
      type:        'ATC_DIRECT',
      id:          `DIRECT_${cb.icao}`,
      label:       'File direct — let ATC amend',
      description: 'ATC will likely issue a preferred route on the ground. '
                 + 'Re-check fuel and time after amendment.',
      fixes:       [],
      detourNm:    0,
      recommended: false,
    });

    return options;
  }

  // -------------------------------------------------------------------------
  // PUBLIC: buildRoute
  // Assembles the final waypoint list from pilot selections.
  //
  // selections: [{ terminalIcao: 'KCLT', option: { type, waypoints|fixes } }]
  // -------------------------------------------------------------------------

  async buildRoute(depIcao, destIcao, selections=[]) {
    const waypoints = [depIcao];

    for (const sel of selections) {
      const opt = sel.option;
      const toAdd = opt.type==='T_ROUTE' ? (opt.waypoints??[])
                  : opt.type==='AVOIDANCE' ? (opt.fixes??[])
                  : [];  // ATC_DIRECT — nothing to insert
      for (const w of toAdd) {
        if (!waypoints.includes(w)) waypoints.push(w);
      }
    }

    if (waypoints[waypoints.length-1]!==destIcao) waypoints.push(destIcao);

    // Annotate with airways where available
    const parts=[waypoints[0]];
    for (let i=0; i<waypoints.length-1; i++) {
      const awy = this._findAirway(waypoints[i], waypoints[i+1]);
      if (awy) parts.push(awy);
      parts.push(waypoints[i+1]);
    }

    // Dedup consecutive identical tokens
    const deduped=[parts[0]];
    for (let i=1; i<parts.length; i++) {
      if (parts[i]!==deduped[deduped.length-1]) deduped.push(parts[i]);
    }

    return { waypoints, routeString: deduped.join(' ') };
  }

  // -------------------------------------------------------------------------
  // PRIVATE: find best airway for a fix pair
  // -------------------------------------------------------------------------

  _findAirway(fromId, toId) {
    let best=null, bestMea=Infinity;
    for (const awy of this._airways) {
      if (!['V','T'].includes(awy.type)) continue;
      const wpts = awy.waypoints??[];
      for (let i=0; i<wpts.length-1; i++) {
        const a=wpts[i].name||wpts[i].id, b=wpts[i+1].name||wpts[i+1].id;
        if ((a===fromId&&b===toId)||(a===toId&&b===fromId)) {
          const seg=awy.segments?.find(s=>s.from_seq===wpts[i].seq&&s.to_seq===wpts[i+1].seq)??awy.segments?.[i]??{};
          const mea=seg.mea_ft??seg.mea??99999;
          if (mea<bestMea){bestMea=mea; best=awy.name;}
          break;
        }
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // PUBLIC: summarize — human-readable analysis for the planning UI
  // -------------------------------------------------------------------------

  async summarize(depIcao, destIcao) {
    const a = await this.analyzeRoute(depIcao, destIcao);
    const lines=[
      `${a.departure} → ${a.destination}  ${a.totalDistNm}nm  hdg ${a.flightBearing}° ${a.flightDir}`,
      '',
    ];

    if (!a.hasTerminalAreas) {
      lines.push('No Class B airspace along route.');
      return lines.join('\n');
    }

    for (const ta of a.terminalAreas) {
      lines.push(`CLASS B: ${ta.name} (${ta.icao})  ${ta.distFromTrack}nm from track`);
      ta.options.forEach((opt,i)=>{
        const star = opt.recommended?' ★':'';
        lines.push(`  ${i+1}. [${opt.type}]${star} ${opt.label}`);
        lines.push(`     ${opt.description}`);
      });
      lines.push('');
    }
    return lines.join('\n');
  }
}

export async function createTerminalPlanner(dbName='FlyTabDB') {
  return new TerminalPlanner(dbName).init();
}
