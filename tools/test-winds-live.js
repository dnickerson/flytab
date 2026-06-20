#!/usr/bin/env node
// Live integration test for the winds-aloft fetch pipeline.
// Reproduces exactly what winds-interpolator.js + WeatherClient do in the browser.
// Run: node tools/test-winds-live.js

'use strict';

// ---------------------------------------------------------------------------
// Inline WeatherClient statics (copied verbatim from weather-client.js)
// ---------------------------------------------------------------------------

const altLevels = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];

function parseWindGroup(group) {
    if (!group || group.length < 4) return null;
    if (isNaN(parseInt(group.substring(0, 4)))) return null;
    if (group.startsWith('9900')) {
        let temp = null;
        if (group.length >= 6) temp = parseInt(group.substring(4));
        return { dir: 0, spd: 0, temp, variable: true };
    }
    const dirCode = parseInt(group.substring(0, 2));
    let spd = parseInt(group.substring(2, 4));
    let dir = dirCode * 10;
    if (dirCode >= 51 && dirCode <= 86) { dir = (dirCode - 50) * 10; spd += 100; }
    let temp = null;
    if (group.length >= 6) temp = parseInt(group.substring(4));
    return { dir, spd, temp, variable: false };
}

function parseAllWindsAloft(text) {
    const allStations = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^(FD|FB|DATA|VALID|FT |0{3}$)/.test(trimmed)) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;
        const stationId = parts[0];
        if (!/^[A-Z]{2,3}$/.test(stationId)) continue;
        const winds = {};
        for (let i = 1; i < parts.length && i <= altLevels.length; i++) {
            const parsed = parseWindGroup(parts[i]);
            if (parsed) winds[altLevels[i - 1]] = parsed;
        }
        if (Object.keys(winds).length > 0) allStations[stationId] = winds;
    }
    return allStations;
}

const FD_STATIONS = {
    ABQ: [35.04, -106.61], ACY: [39.46, -74.58], ALB: [42.75, -73.80],
    AMA: [35.22, -101.71], ATL: [33.64, -84.43], AUS: [30.19, -97.67],
    AVP: [41.34, -75.72], BDL: [41.94, -72.68], BGR: [44.81, -68.83],
    BHM: [33.56, -86.75], BIL: [45.81, -108.54], BIS: [46.77, -100.75],
    BNA: [36.12, -86.68], BOI: [43.56, -116.22], BOS: [42.36, -71.01],
    BRO: [25.91, -97.43], BUF: [42.94, -78.73], CAE: [33.94, -81.12],
    CHS: [32.90, -80.04], CLE: [41.41, -81.85], CLT: [35.21, -80.94],
    CRP: [27.77, -97.50], CVG: [39.05, -84.67], DAL: [32.85, -96.85],
    DAY: [39.90, -84.22], DCA: [38.85, -77.04], DDC: [37.76, -99.97],
    DEN: [39.86, -104.67], DFW: [32.90, -97.04], DSM: [41.53, -93.66],
    DTW: [42.21, -83.35], ELP: [31.81, -106.38], EWR: [40.69, -74.17],
    FAT: [36.78, -119.72], FLL: [26.07, -80.15], GEG: [47.62, -117.53],
    GRB: [44.49, -88.13], GSO: [36.10, -79.94], GYY: [41.62, -87.41],
    HOU: [29.65, -95.28], ICT: [37.65, -97.43], IND: [39.72, -86.29],
    JAX: [30.49, -81.69], JFK: [40.64, -73.78], LAS: [36.08, -115.15],
    LAX: [33.94, -118.41], LBB: [33.66, -101.82], LIT: [34.73, -92.22],
    MCI: [39.30, -94.71], MCO: [28.43, -81.31], MDW: [41.79, -87.75],
    MEM: [35.04, -89.98], MIA: [25.79, -80.29], MKE: [42.95, -87.90],
    MOB: [30.69, -88.24], MSP: [44.88, -93.22], MSY: [29.99, -90.26],
    OKC: [35.39, -97.60], OMA: [41.30, -95.89], ORD: [41.97, -87.91],
    PBI: [26.68, -80.10], PDX: [45.59, -122.59], PHL: [39.87, -75.24],
    PHX: [33.43, -112.01], PIT: [40.49, -80.23], PSP: [33.83, -116.51],
    PVD: [41.72, -71.43], RAP: [44.04, -103.05], RDU: [35.88, -78.79],
    RIC: [37.51, -77.32], RNO: [39.50, -119.77], ROA: [37.32, -79.97],
    SAT: [29.53, -98.47], SAV: [32.13, -81.20], SDF: [38.17, -85.74],
    SEA: [47.45, -122.31], SFO: [37.62, -122.38], SJU: [18.44, -66.00],
    SLC: [40.79, -111.98], STL: [38.75, -90.37], SYR: [43.11, -76.11],
    TLH: [30.40, -84.35], TPA: [27.98, -82.53], TUS: [32.12, -110.94],
    TYS: [35.81, -83.99], ABR: [45.45, -98.42], ABI: [32.41, -99.68],
    BFF: [41.87, -103.60], BIH: [37.37, -118.36], BLH: [33.62, -114.72],
    BAM: [40.57, -116.92], BCE: [38.57, -109.31], ALS: [37.44, -105.87],
};

function findNearestFdStation(allStations, lat, lon) {
    let best = null, bestDist = Infinity;
    for (const id of Object.keys(allStations)) {
        const coords = FD_STATIONS[id];
        if (!coords) continue;
        const dLat = coords[0] - lat;
        const dLon = (coords[1] - lon) * Math.cos(lat * Math.PI / 180);
        const dist = dLat * dLat + dLon * dLon;
        if (dist < bestDist) { bestDist = dist; best = id; }
    }
    return best;
}

function getWindAtAlt(stationWinds, altFt) {
    const keys = Object.keys(stationWinds).map(Number);
    if (!keys.length) return null;
    let best = keys[0];
    for (const k of keys) {
        if (Math.abs(k - altFt) < Math.abs(best - altFt)) best = k;
    }
    return stationWinds[best] ?? null;
}

function selectFdCycle(utcHour) {
    if (utcHour < 9)  return '06';
    if (utcHour < 21) return '12';
    return '24';
}

// ---------------------------------------------------------------------------
// Test waypoints (KLKR → KBCB route)
// ---------------------------------------------------------------------------
const WAYPOINTS = [
    { id: 'KLKR', name: 'KLKR', lat: 37.01, lon: -81.38 },
    { id: 'KBCB', name: 'KBCB', lat: 36.69, lon: -79.76 },  // Blue Ridge Airport
    { id: 'KRNK', name: 'KRNK', lat: 37.32, lon: -79.97 },  // Roanoke (near ROA FD station)
];

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); process.exitCode = 1; }
function info(msg) { console.log(`        ${msg}`); }

// ---------------------------------------------------------------------------

async function main() {
    const cycle = selectFdCycle(new Date().getUTCHours());
    console.log(`\n=== winds-aloft live integration test (cycle ${cycle}) ===\n`);

    // 1. Fetch via flywhere proxy (same URL as fixed winds-interpolator.js)
    const proxyUrl = `https://www.flywhere.app/api/weather?type=windtemp&region=all&level=low&fcst=${cycle}`;
    console.log(`[1] Fetch flywhere proxy\n    ${proxyUrl}`);
    let text;
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(proxyUrl, { signal: controller.signal });
        if (!resp.ok) { fail(`HTTP ${resp.status}`); return; }
        text = await resp.text();
        pass(`${resp.status} OK — ${text.length} chars`);
    } catch (e) {
        fail(`fetch failed: ${e.message}`);
        return;
    }

    // 2. Verify FD header is present
    console.log('\n[2] Verify FD text format');
    const hasFdHeader = /^(FD|FB)/m.test(text);
    if (hasFdHeader) pass('FD/FB header found');
    else fail('no FD/FB header in response');
    const firstLines = text.split('\n').slice(0, 6).join('\n');
    info(firstLines);

    // 3. Parse
    console.log('\n[3] Parse all stations');
    const allStations = parseAllWindsAloft(text);
    const count = Object.keys(allStations).length;
    if (count > 50) pass(`parsed ${count} stations`);
    else fail(`only ${count} stations — parser may be broken`);

    // 4. Coverage for Virginia/Appalachians
    console.log('\n[4] Nearest-station for test waypoints');
    for (const wp of WAYPOINTS) {
        const nearest = findNearestFdStation(allStations, wp.lat, wp.lon);
        if (!nearest) {
            fail(`${wp.id}: no nearby FD station found`);
            continue;
        }
        const coords = FD_STATIONS[nearest];
        const dLat = (coords[0] - wp.lat);
        const dLon = (coords[1] - wp.lon) * Math.cos(wp.lat * Math.PI / 180);
        const distNm = Math.sqrt(dLat * dLat + dLon * dLon) * 60;
        pass(`${wp.id} → ${nearest} (${distNm.toFixed(0)} nm away)`);

        // 5. Wind at cruise altitudes
        const stationWinds = allStations[nearest];
        for (const altFt of [6000, 9000, 12000]) {
            const w = getWindAtAlt(stationWinds, altFt);
            if (!w) { fail(`  no wind data at ${altFt} ft`); continue; }
            if (w.variable) {
                info(`  ${altFt} ft: light & variable`);
            } else {
                const hwSign = w.spd > 0 ? '' : '';
                info(`  ${altFt} ft: ${w.dir}° @ ${w.spd} kt${w.temp != null ? `, ${w.temp}°C` : ''}`);
                if (w.dir < 0 || w.dir > 360 || w.spd < 0 || w.spd > 200) {
                    fail(`  implausible wind: dir=${w.dir} spd=${w.spd}`);
                }
            }
        }
    }

    // 6. Verify CORS headers (direct AWC should be missing them)
    console.log('\n[5] CORS header comparison');
    const awcUrl = `https://aviationweather.gov/api/data/windtemp?region=all&level=low&fcst=${cycle}`;
    try {
        const r = await fetch(awcUrl);
        const acao = r.headers.get('access-control-allow-origin');
        if (acao) {
            info(`AWC direct: Access-Control-Allow-Origin: ${acao} (would work)`);
        } else {
            pass('AWC direct: NO Access-Control-Allow-Origin header — confirms CORS blocked in browser');
        }
    } catch (e) {
        info(`AWC direct: fetch error: ${e.message}`);
    }
    try {
        const r = await fetch(proxyUrl);
        const acao = r.headers.get('access-control-allow-origin');
        if (acao) pass(`flywhere proxy: Access-Control-Allow-Origin: ${acao}`);
        else fail('flywhere proxy: no CORS header — Capacitor may still be blocked');
    } catch (e) {
        fail(`flywhere proxy CORS check: ${e.message}`);
    }

    console.log('\n=== done ===\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
