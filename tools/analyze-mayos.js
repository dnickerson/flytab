const fs = require('fs');
const bundle = JSON.parse(fs.readFileSync('/home/dananickerson/fly-pipeline/data/nasr/bundle.json'));

console.log('=== V103 full waypoint list ===');
const v103 = bundle.airways.find(a => a.name === 'V103');
v103.waypoints.forEach((w, i) =>
    console.log(`  ${i}. ${(w.name||w.id).padEnd(15)} (${w.lat?.toFixed(2)}, ${w.lon?.toFixed(2)})`));

console.log('\n=== V143 full waypoint list ===');
const v143 = bundle.airways.find(a => a.name === 'V143');
v143.waypoints.forEach((w, i) =>
    console.log(`  ${i}. ${(w.name||w.id).padEnd(15)} (${w.lat?.toFixed(2)}, ${w.lon?.toFixed(2)})`));

console.log('\n=== Airways containing fix "Mayos" ===');
for (const awy of bundle.airways) {
    if (awy.waypoints?.some(w => (w.name||w.id) === 'Mayos')) {
        const idx = awy.waypoints.findIndex(w => (w.name||w.id) === 'Mayos');
        console.log(`  ${awy.name} (idx ${idx}/${awy.waypoints.length}, type=${awy.type})`);
    }
}

console.log('\n=== Airways containing fix "Greensboro" (major NC node) ===');
for (const awy of bundle.airways) {
    if (awy.waypoints?.some(w => (w.name||w.id) === 'Greensboro')) {
        console.log(`  ${awy.name} (type=${awy.type})`);
    }
}

console.log('\n=== Airways containing fix "Hustn" (used by route, near KLKR) ===');
for (const awy of bundle.airways) {
    if (awy.waypoints?.some(w => (w.name||w.id) === 'Hustn')) {
        console.log(`  ${awy.name} (type=${awy.type})`);
    }
}

console.log('\n=== Where does V143 start vs KLKR? ===');
const klkr = bundle.airports.find(a => a.icao === 'KLKR');
const gizmo = v143.waypoints[0];
const haversine = (a,b,c,d) => { const R=3440.065,toRad=x=>x*Math.PI/180,dLat=toRad(c-a),dLon=toRad(d-b),x=Math.sin(dLat/2)**2+Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2; return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); };
console.log(`KLKR (${klkr.lat.toFixed(2)}, ${klkr.lon.toFixed(2)}) → Gizmo (V143 start) (${gizmo.lat.toFixed(2)}, ${gizmo.lon.toFixed(2)}): ${haversine(klkr.lat, klkr.lon, gizmo.lat, gizmo.lon).toFixed(1)}nm`);
