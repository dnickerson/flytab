const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('/home/dananickerson/fly-pipeline/data/nasr/bundle.json'));

const toRad = d => d * Math.PI / 180;
const hav = (a, b, c, d) => {
    const R = 3440.065;
    const dLat = toRad(c-a), dLon = toRad(d-b);
    const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
};

// Find every "Korry" and its airways
console.log('=== Airways with fix "Korry" ===');
const korryCoords = [];
for (const awy of bundle.airways) {
    for (const w of awy.waypoints || []) {
        if ((w.name || w.id) === 'Korry') {
            console.log(`  ${awy.name} (type=${awy.type}) at (${w.lat?.toFixed(2)}, ${w.lon?.toFixed(2)}) seq=${w.seq}`);
            korryCoords.push({ lat: w.lat, lon: w.lon, awy: awy.name });
        }
    }
}

const KMHT = bundle.airports.find(a => a.icao === 'KMHT');
console.log(`\nKMHT: (${KMHT.lat.toFixed(2)}, ${KMHT.lon.toFixed(2)})`);
for (const k of korryCoords) {
    console.log(`  Korry on ${k.awy}: distance to KMHT = ${hav(k.lat, k.lon, KMHT.lat, KMHT.lon).toFixed(1)}nm`);
}

// What fixes are within 80nm of KMHT (these get DIRECT edges from RouteConstructor)
console.log('\n=== Airway fixes within 80nm of KMHT (DIRECT edge candidates) ===');
const coords = {};
for (const awy of bundle.airways) {
    if (!['V', 'T'].includes(awy.type)) continue;
    for (const w of awy.waypoints || []) {
        const id = w.name || w.id;
        if (id && w.lat != null && !coords[id]) coords[id] = { lat: w.lat, lon: w.lon };
    }
}
const candidates = [];
for (const [id, c] of Object.entries(coords)) {
    const d = hav(KMHT.lat, KMHT.lon, c.lat, c.lon);
    if (d <= 80) candidates.push({ id, distNm: d });
}
candidates.sort((a,b) => a.distNm - b.distNm);
console.log(`Found ${candidates.length} candidates within 80nm:`);
candidates.slice(0, 20).forEach(c => console.log(`  ${c.id.padEnd(20)} ${c.distNm.toFixed(1)}nm`));

// Specifically check: is Korry one of them?
const korryCandidate = candidates.find(c => c.id === 'Korry');
console.log(`\nKorry in DIRECT candidates: ${korryCandidate ? 'YES at ' + korryCandidate.distNm.toFixed(1) + 'nm' : 'NO'}`);
