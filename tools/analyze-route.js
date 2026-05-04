// Analyze the KLKR→KMHT route by recreating the planner offline
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('/home/dananickerson/fly-pipeline/data/nasr/bundle.json'));

const KLKR = bundle.airports.find(a => a.icao === 'KLKR');
const KMHT = bundle.airports.find(a => a.icao === 'KMHT');

const toRad = d => d * Math.PI / 180;
const hav = (a, b, c, d) => {
    const R = 3440.065;
    const dLat = toRad(c - a), dLon = toRad(d - b);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
};

const gc = hav(KLKR.lat, KLKR.lon, KMHT.lat, KMHT.lon);
console.log(`KLKR (${KLKR.lat.toFixed(2)}, ${KLKR.lon.toFixed(2)}) → KMHT (${KMHT.lat.toFixed(2)}, ${KMHT.lon.toFixed(2)})`);
console.log(`Great-circle direct: ${gc.toFixed(1)} nm`);
console.log();

// Build the airway graph the same way RoutePlanner does (V/T only)
const graph = {};   // fixId -> [{to, distNm, mea, airway}]
const coords = {};  // fixId -> {lat, lon}
let edgeCount = 0;
for (const awy of bundle.airways) {
    if (!['V', 'T'].includes(awy.type)) continue;
    if (!awy.waypoints?.length) continue;
    for (const w of awy.waypoints) {
        const id = w.name || w.id;
        if (id && w.lat != null && !coords[id]) coords[id] = { lat: w.lat, lon: w.lon };
    }
    for (let i = 0; i < awy.waypoints.length - 1; i++) {
        const fromId = awy.waypoints[i].name || awy.waypoints[i].id;
        const toId   = awy.waypoints[i+1].name || awy.waypoints[i+1].id;
        if (!fromId || !toId) continue;
        const seg = awy.segments?.find(s => s.from_seq === awy.waypoints[i].seq && s.to_seq === awy.waypoints[i+1].seq) ?? awy.segments?.[i] ?? {};
        const dist = seg.dist_nm ?? hav(awy.waypoints[i].lat, awy.waypoints[i].lon, awy.waypoints[i+1].lat, awy.waypoints[i+1].lon);
        const mea = seg.mea_ft ?? 0;
        if (!graph[fromId]) graph[fromId] = [];
        if (!graph[toId]) graph[toId] = [];
        if (!graph[fromId].some(e => e.to === toId && e.airway === awy.name)) {
            graph[fromId].push({ to: toId, distNm: dist, mea, airway: awy.name });
            edgeCount++;
        }
        if (!graph[toId].some(e => e.to === fromId && e.airway === awy.name)) {
            graph[toId].push({ to: fromId, distNm: dist, mea, airway: awy.name });
            edgeCount++;
        }
    }
}
console.log(`Graph: ${Object.keys(graph).length} fixes, ${edgeCount} edges`);
console.log();

// Find airway fixes near KLKR and KMHT
function nearestFixes(lat, lon, maxNm, limit = 10) {
    const cands = [];
    for (const [id, c] of Object.entries(coords)) {
        const d = hav(lat, lon, c.lat, c.lon);
        if (d <= maxNm) cands.push({ id, distNm: d, lat: c.lat, lon: c.lon });
    }
    return cands.sort((a, b) => a.distNm - b.distNm).slice(0, limit);
}

console.log('Nearest airway fixes to KLKR (top 10 within 80nm):');
for (const f of nearestFixes(KLKR.lat, KLKR.lon, 80)) {
    const airwaysFromHere = (graph[f.id] || []).map(e => e.airway);
    const uniq = [...new Set(airwaysFromHere)];
    console.log(`  ${f.id.padEnd(15)} ${f.distNm.toFixed(1).padStart(5)}nm  airways: ${uniq.join(', ')}`);
}
console.log();
console.log('Nearest airway fixes to KMHT (top 10 within 80nm):');
for (const f of nearestFixes(KMHT.lat, KMHT.lon, 80)) {
    const airwaysFromHere = (graph[f.id] || []).map(e => e.airway);
    const uniq = [...new Set(airwaysFromHere)];
    console.log(`  ${f.id.padEnd(15)} ${f.distNm.toFixed(1).padStart(5)}nm  airways: ${uniq.join(', ')}`);
}

// Identify what's at the user's current routed waypoints
console.log('\nThe planned route fixes (with their lat/lon):');
const planned = ['Hustn', 'Moped', 'Owalt', 'Jotta', 'Ingon', 'Prove', 'Mayos', 'Elkins', 'Tygar', 'Morgantown', 'Philipsburg', 'Swiss', 'Zagti', 'Williamsport', 'Ordmo', 'Elexy', 'Lopez', 'Lecor', 'Laayk', 'Helon', 'Specl', 'Kingston', 'Pawling', 'Stuby', 'Sasha', 'Molds', 'Chester', 'Whate', 'Waric', 'Keynn'];
for (const id of planned) {
    const c = coords[id];
    if (c) {
        const distFromGcLine = Math.abs(c.lon - (KLKR.lon + (KMHT.lon - KLKR.lon) * (c.lat - KLKR.lat) / (KMHT.lat - KLKR.lat)));
        console.log(`  ${id.padEnd(15)} ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}   (${distFromGcLine.toFixed(1)}° west/east of GC line)`);
    } else {
        console.log(`  ${id.padEnd(15)} NOT FOUND`);
    }
}
