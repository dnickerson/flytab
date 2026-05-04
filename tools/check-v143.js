// Verify V143 edges are properly in the graph and explore what A* should find
const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('/home/dananickerson/fly-pipeline/data/nasr/bundle.json'));

const toRad = d => d * Math.PI / 180;
const hav = (a, b, c, d) => {
    const R = 3440.065;
    const dLat = toRad(c-a), dLon = toRad(d-b);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
};

// Build graph EXACTLY like AirwayGraph.build does
const graph = {};
const coords = {};
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
        const dist = (seg.dist_nm && seg.dist_nm > 0) ? seg.dist_nm : hav(awy.waypoints[i].lat, awy.waypoints[i].lon, awy.waypoints[i+1].lat, awy.waypoints[i+1].lon);
        const mea = seg.mea_ft ?? 0;
        if (!graph[fromId]) graph[fromId] = [];
        if (!graph[toId]) graph[toId] = [];
        if (!graph[fromId].some(e => e.to === toId && e.airway === awy.name))
            graph[fromId].push({ to: toId, distNm: dist, mea, airway: awy.name });
        if (!graph[toId].some(e => e.to === fromId && e.airway === awy.name))
            graph[toId].push({ to: fromId, distNm: dist, mea, airway: awy.name });
    }
}

// What edges does Greensboro have in graph?
console.log('=== graph[Greensboro] (all edges) ===');
const gso = graph['Greensboro'] || [];
gso.forEach(e => console.log(`  → ${e.to.padEnd(18)} via ${e.airway.padEnd(6)} ${e.distNm.toFixed(1)}nm`));

// What edges does Gizmo have?
console.log('\n=== graph[Gizmo] (all edges) ===');
(graph['Gizmo'] || []).forEach(e => console.log(`  → ${e.to.padEnd(18)} via ${e.airway.padEnd(6)} ${e.distNm.toFixed(1)}nm`));

// What edges does Mayos have?
console.log('\n=== graph[Mayos] (all edges) ===');
(graph['Mayos'] || []).forEach(e => console.log(`  → ${e.to.padEnd(18)} via ${e.airway.padEnd(6)} ${e.distNm.toFixed(1)}nm`));

// Now run A* from KLKR (use addDirectEdge to nearby fixes) to KMHT
const KLKR = bundle.airports.find(a => a.icao === 'KLKR');
const KMHT = bundle.airports.find(a => a.icao === 'KMHT');

// Add temporary direct edges from KLKR/KMHT to nearby fixes (within 80nm)
function addDirectFromAirport(icao, lat, lon, maxNm) {
    coords[icao] = { lat, lon };
    if (!graph[icao]) graph[icao] = [];
    for (const [id, c] of Object.entries(coords)) {
        if (id === icao) continue;
        const d = hav(lat, lon, c.lat, c.lon);
        if (d <= maxNm) {
            graph[icao].push({ to: id, distNm: d, mea: 0, airway: 'DIRECT' });
            graph[id].push({ to: icao, distNm: d, mea: 0, airway: 'DIRECT' });
        }
    }
}
addDirectFromAirport('KLKR', KLKR.lat, KLKR.lon, 80);
addDirectFromAirport('KMHT', KMHT.lat, KMHT.lon, 80);

// A*
function astar(start, goal, goalLat, goalLon) {
    const open = new Map();
    const closed = new Map();
    const h = id => { const c = coords[id]; return c ? hav(c.lat, c.lon, goalLat, goalLon) : 9999; };
    open.set(start, { g: 0, f: h(start), prev: null, prevAirway: null, prevDist: 0 });
    let iters = 0;
    while (open.size > 0 && iters++ < 200000) {
        let curId = null, curNode = null;
        for (const [id, node] of open) {
            if (!curId || node.f < curNode.f) { curId = id; curNode = node; }
        }
        open.delete(curId);
        closed.set(curId, curNode);
        if (curId === goal) {
            const path = [];
            let id = goal;
            while (id !== null) {
                const n = closed.get(id);
                path.unshift({ fix: id, airway: n.prevAirway, segDist: n.prevDist, g: n.g });
                id = n.prev;
            }
            return { path, iters };
        }
        for (const e of (graph[curId] ?? [])) {
            if (closed.has(e.to)) continue;
            const g = curNode.g + e.distNm;
            const f = g + h(e.to);
            const ex = open.get(e.to);
            if (!ex || g < ex.g) {
                open.set(e.to, { g, f, prev: curId, prevAirway: e.airway, prevDist: e.distNm });
            }
        }
    }
    return { path: null, iters };
}

console.log('\n=== Running A* KLKR → KMHT ===');
const result = astar('KLKR', 'KMHT', KMHT.lat, KMHT.lon);
console.log(`iters: ${result.iters}`);
if (result.path) {
    console.log(`Total path: ${result.path[result.path.length - 1].g.toFixed(1)}nm`);
    console.log('Path:');
    result.path.forEach((step, i) => console.log(`  ${i}. ${step.fix.padEnd(15)} via ${(step.airway||'-').padEnd(8)} ${step.segDist.toFixed(1)}nm  cumul=${step.g.toFixed(1)}`));
}

// Compare: what if we force the route through Greensboro?
console.log('\n=== Compare: KLKR → Greensboro ===');
const r1 = astar('KLKR', 'Greensboro', coords.Greensboro.lat, coords.Greensboro.lon);
if (r1.path) console.log(`KLKR → Greensboro: ${r1.path[r1.path.length-1].g.toFixed(1)}nm via ${r1.path.map(s => s.fix).join(' → ')}`);
console.log('=== Greensboro → KMHT ===');
const r2 = astar('Greensboro', 'KMHT', KMHT.lat, KMHT.lon);
if (r2.path) console.log(`Greensboro → KMHT: ${r2.path[r2.path.length-1].g.toFixed(1)}nm`);
