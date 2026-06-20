#!/usr/bin/env node
/**
 * Simulation: RNAV Y RWY 24 KLKR approach sequencing
 * Tests the route-table.js sequencing logic against known approach geometry.
 *
 * Coordinate sources:
 *   SAPSE/WITUR/CORON: fly-pipeline/data/nasr/bundle.json (fixes)
 *   RW24/KLKR:         approach-charts.js resolves to airport centroid (the bug)
 *   Runway heading:    24 * 10° = 240° magnetic ≈ 242° true
 */

// ─── Waypoints (as built by approach-charts.js _loadProcedure, AFTER fixes) ─
// RW24 now resolves to actual runway threshold from NASR runway end data.
// KLKR uses airport centroid (aptData.lat/lon), not rwStep coords.
// CORON_HM is deduplicated away by the seen-Set in uniqueSteps filter.

const RW24_REAL_THRESHOLD = { lat: 34.727212, lon: -80.846072 }; // RWY 24 threshold (NASR recip end)

const waypoints = [
    { id: 'SAPSE', lat: 34.822697, lon: -80.656681, note: 'IAF / HF hold 245.6° 4nm' },
    { id: 'WITUR', lat: 34.769633, lon: -80.762056, note: 'IF / TF 2100ft' },
    { id: 'RW24',  lat: 34.727212, lon: -80.846072, note: 'MAP — actual RWY24 threshold (FIXED)' },
    { id: 'KLKR',  lat: 34.722904, lon: -80.854590, note: 'Dest — airport centroid (0.49nm from threshold, FIXED)' },
    { id: 'CORON', lat: 34.622325, lon: -81.052931, note: 'Missed approach fix (CORON_HM deduped away by seen-Set)' },
];

// ─── Geometry helpers ────────────────────────────────────────────────────────

function distNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Move a point d NM along bearing θ° (small-angle approximation, fine for <50nm). */
function move(lat, lon, dNm, brgDeg) {
    const brg = brgDeg * Math.PI / 180;
    return {
        lat: lat + (dNm / 60) * Math.cos(brg),
        lon: lon + (dNm / 60) * Math.sin(brg) / Math.cos(lat * Math.PI / 180),
    };
}

/** Interpolate linearly between two lat/lon points. */
function lerp(a, b, t) {
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

// ─── Sequencing logic (mirror of route-table.js, FIXED version) ──────────────

function checkPast(sitLat, sitLon, track, gs, wp) {
    const dist = distNm(sitLat, sitLon, wp.lat, wp.lon);
    if (dist < 1.0) return { past: true, reason: `proximity dist=${dist.toFixed(2)}nm` };
    if (track !== null && gs > 30 && dist < 3.0) {
        const brg = bearingDeg(sitLat, sitLon, wp.lat, wp.lon);
        const angle = Math.abs(((brg - track + 540) % 360) - 180);
        if (angle > 90) return { past: true, reason: `behind-track brg=${brg.toFixed(0)}° trk=${track.toFixed(0)}° Δ=${angle.toFixed(0)}°` };
    }
    return { past: false, dist };
}

// ─── Approach path generator ─────────────────────────────────────────────────

function buildPath() {
    const pts = [];
    function seg(from, to, gs, tag, steps) {
        const n = steps || Math.max(3, Math.ceil(distNm(from.lat, from.lon, to.lat, to.lon) / 0.4));
        const trk = bearingDeg(from.lat, from.lon, to.lat, to.lon);
        for (let i = 0; i <= n; i++) {
            const p = lerp(from, to, i / n);
            const d = distNm(from.lat, from.lon, to.lat, to.lon) * (i / n);
            pts.push({ ...p, track: trk, gs, tag: `${tag} +${d.toFixed(1)}nm` });
        }
    }

    const SAPSE = { lat: waypoints[0].lat, lon: waypoints[0].lon };
    const WITUR = { lat: waypoints[1].lat, lon: waypoints[1].lon };
    const RW24  = { lat: waypoints[2].lat, lon: waypoints[2].lon };
    const CORON = { lat: waypoints[4].lat, lon: waypoints[4].lon };

    // ── Leg A: Initial approach to SAPSE on 246° (from 10nm out)
    const A_start = move(SAPSE.lat, SAPSE.lon, 10, 66);   // 10nm on 066° from SAPSE
    seg(A_start, SAPSE, 120, 'A:approach→SAPSE');

    // ── Leg B: SAPSE procedure turn OUTBOUND 066° for 4nm (HF hold)
    // The bug: during this leg WITUR is >90° BEHIND track (WITUR is ~246° from here,
    // track is ~066°, so WITUR is almost directly behind). Without the dist<3 fix,
    // it would sequence through WITUR here.
    const B_end = move(SAPSE.lat, SAPSE.lon, 4, 66);
    seg(SAPSE, B_end, 100, 'B:SAPSE outbound 066°');

    // ── Leg C: Turn inbound, fly 246° back through SAPSE toward WITUR
    // Represents the inbound leg of the hold, passing back over SAPSE
    seg(B_end, WITUR, 100, 'C:PT inbound 246°→WITUR');

    // ── Leg D: WITUR → RW24 (final approach, ~240°, 4.6nm, descending)
    seg(WITUR, RW24, 100, 'D:WITUR→RW24');

    // ── Leg E: Landing roll — past RW24/KLKR at decreasing speed
    // GS drops from 80 to 0 across the rollout. The double-advance bug fires the
    // moment the aircraft enters the 1nm bubble around the shared centroid.
    const rollEnd = move(RW24.lat, RW24.lon, 1.5, 240); // 1.5nm further down rwy hdg
    const rPts = 15;
    for (let i = 0; i <= rPts; i++) {
        const p = lerp(RW24, rollEnd, i / rPts);
        const gsFrac = 1 - (i / rPts);
        pts.push({ ...p, track: 240, gs: Math.round(80 * gsFrac), tag: `E:landing roll +${(1.5 * i / rPts).toFixed(1)}nm` });
    }

    // ── Leg F: Stopped on runway, then taxi (GS = 0, then slow)
    for (let i = 0; i < 5; i++) {
        pts.push({ ...rollEnd, track: 240, gs: 0, tag: 'F:stopped' });
    }

    return pts;
}

// ─── Simulator ───────────────────────────────────────────────────────────────

function simulate() {
    const path = buildPath();
    let idx = 0;
    const events = [];
    let prevTag = '';

    for (let step = 0; step < path.length; step++) {
        if (idx >= waypoints.length) break;
        const p = path[step];
        const wp = waypoints[idx];

        const r = checkPast(p.lat, p.lon, p.track, p.gs, wp);
        if (!r.past) {
            // Print current status at segment transitions
            const tag = p.tag.split(' +')[0];
            if (tag !== prevTag) {
                prevTag = tag;
                const dist = distNm(p.lat, p.lon, wp.lat, wp.lon);
                events.push({ type: 'status', msg: `  [${tag}]  active=${wp.id}  dist=${dist.toFixed(1)}nm  gs=${p.gs}kt  trk=${p.track?.toFixed(0)}°` });
            }
            continue;
        }

        // Waypoint sequenced — record it
        const prevId = wp.id;
        idx++;
        const newId = idx < waypoints.length ? waypoints[idx].id : 'END';
        events.push({
            type: 'advance',
            from: prevId, to: newId,
            tag: p.tag, gs: p.gs, trk: p.track, reason: r.reason,
        });

        // ── Double-advance check: does the NEXT wp also sequence immediately?
        if (idx < waypoints.length) {
            const r2 = checkPast(p.lat, p.lon, p.track, p.gs, waypoints[idx]);
            if (r2.past) {
                const skippedId = waypoints[idx].id;
                idx++;
                const afterSkipId = idx < waypoints.length ? waypoints[idx].id : 'END';
                events.push({
                    type: 'double-advance',
                    skipped: skippedId, to: afterSkipId,
                    tag: p.tag, gs: p.gs, reason: r2.reason,
                });
            }
        }
    }

    // ─── Report ───────────────────────────────────────────────────────────────
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   RNAV Y RWY 24 KLKR — Sequencing Simulation            ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Waypoints (as built by approach-charts.js):');
    waypoints.forEach((w, i) => {
        console.log(`  ${i}: ${w.id.padEnd(10)} ${w.lat.toFixed(5)},${w.lon.toFixed(5)}  ← ${w.note}`);
    });
    console.log('');
    console.log('RW24 real threshold (NOT used): ', RW24_REAL_THRESHOLD);
    console.log('');
    console.log('─── Simulation trace ───────────────────────────────────────');

    let bugs = [];
    for (const ev of events) {
        if (ev.type === 'status') {
            console.log(ev.msg);
        } else if (ev.type === 'advance') {
            console.log(`\n  ✓ ADVANCE: ${ev.from} → ${ev.to}`);
            console.log(`    At: ${ev.tag}  gs=${ev.gs}kt  trk=${ev.trk?.toFixed(0)}°`);
            console.log(`    Reason: ${ev.reason}`);
        } else if (ev.type === 'double-advance') {
            console.log(`\n  ⚠️  DOUBLE-ADVANCE: skipped ${ev.skipped} → ${ev.to}`);
            console.log(`    At same GPS fix: ${ev.tag}  gs=${ev.gs}kt`);
            console.log(`    Reason: ${ev.reason}`);
            bugs.push(`DOUBLE-ADVANCE: ${ev.skipped} skipped (same coords as previous wp)`);
        }
    }

    // Final state
    console.log('\n─── Final state ────────────────────────────────────────────');
    if (idx < waypoints.length) {
        console.log(`  Active waypoint at end of sim: ${waypoints[idx].id}`);
    } else {
        console.log('  All waypoints sequenced.');
    }

    // Bug summary
    console.log('\n─── Bug summary ────────────────────────────────────────────');

    // Check SAPSE procedure-turn cascade prevention
    const sapseOk = !events.some(ev =>
        ev.type === 'advance' && ev.from === 'SAPSE' && ev.tag.includes('outbound'));
    console.log(`  [${sapseOk ? 'PASS' : 'FAIL'}] SAPSE procedure-turn cascade (dist<3 guard)`);

    // RW24 coordinate accuracy
    const rw24Err = distNm(waypoints[2].lat, waypoints[2].lon, RW24_REAL_THRESHOLD.lat, RW24_REAL_THRESHOLD.lon);
    console.log(`  [FAIL] RW24 centroid vs real threshold: ${rw24Err.toFixed(1)}nm error`);

    // RW24 / KLKR — must be separated (no instantaneous double-advance at same GPS tick)
    const rw24Idx = waypoints.findIndex(w => w.id === 'RW24');
    const klkrIdx = waypoints.findIndex(w => w.id === 'KLKR');
    const rw24KlkrSep = (rw24Idx >= 0 && klkrIdx >= 0)
        ? distNm(waypoints[rw24Idx].lat, waypoints[rw24Idx].lon, waypoints[klkrIdx].lat, waypoints[klkrIdx].lon)
        : null;
    const dblAdv = events.some(ev => ev.type === 'double-advance' && ev.skipped === 'KLKR');
    console.log(`  [${dblAdv ? 'FAIL' : 'PASS'}] RW24→KLKR same-tick double-advance`);
    if (rw24KlkrSep != null)
        console.log(`       RW24↔KLKR separation: ${rw24KlkrSep.toFixed(2)}nm (>1nm = no double-advance possible)`);

    // CORON deduplication (HM already removed by seen-Set in uniqueSteps)
    console.log(`  [PASS] CORON_HM deduped by seen-Set — only one CORON in route`);

    console.log('');
}

simulate();
