// Reference model for the engine-out glide panel (the constants below are the agreed
// RV-9A DEFAULTS of the settings listed in the design document, not values to hardcode): the plan() / initialTurn() /
// triangle() functions of the simulator agreed with the pilot on 2026-10-28
// (https://claude.ai/artifact/G632nTeyWPH8uW2G2PiisX), copied verbatim except that
// the airport (ELEV, RWY_LEN, RWY_TRUE, VAR_W) is a parameter instead of KLKR
// constants. Local plane in nm, x east, y north, airport reference at 0,0.
// The production module must reproduce plan() for the golden cases in the design
// document (docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md).
'use strict';
const VBG = 65, SINK = 700;
const MARGIN = 200, TURN_FT_PER_DEG = 1.5, NOWIND_HEAD = 10;
const BANK = 30, TURN_SINK_FACTOR = 1.24;
const FT_PER_NM = 6076.12, KT_TO_FPM = 101.269;
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const norm = (d) => ((d % 360) + 360) % 360;
const signedDiff = (to, from) => ((to - from + 540) % 360) - 180;
const fromPolar = (brgTrue, nm) => ({ x: nm * Math.sin(rad(brgTrue)), y: nm * Math.cos(rad(brgTrue)) });
const toPolar = (dx, dy) => ({ brg: norm(deg(Math.atan2(dx, dy))), nm: Math.hypot(dx, dy) });
const tas = (altFt) => VBG * (1 + 0.02 * altFt / 1000);
const sinkAt = (altFt) => SINK * tas(altFt) / VBG;
function triangle(courseT, tasKt, wind) {
  if (!wind) return { hdg: courseT, gs: Math.max(tasKt - NOWIND_HEAD, 1), wca: 0 };
  const rel = rad(wind.from - courseT);
  const cross = wind.kt * Math.sin(rel), head = wind.kt * Math.cos(rel);
  const s = Math.max(-1, Math.min(1, cross / tasKt));
  const wca = deg(Math.asin(s));
  return { hdg: norm(courseT + wca), gs: Math.max(tasKt * Math.cos(rad(wca)) - head, 1), wca };
}
function initialTurn(pos, trk, target, altFt, wind) {
  const tasK = tas(altFt), sinkT = sinkAt(altFt) * TURN_SINK_FACTOR;
  const rate = 1091 * Math.tan(rad(BANK)) / tasK;
  let p = { ...pos }, t = trk, lost = 0, dg = 0;
  for (let i = 0; i < 200; i++) {
    const d = signedDiff(toPolar(target.x - p.x, target.y - p.y).brg, t);
    if (Math.abs(d) <= 2) break;
    const stepDeg = Math.sign(d) * Math.min(Math.abs(d), 2), dt = Math.abs(stepDeg) / rate;
    const mv = triangle(t, tasK, wind).gs * dt / 3600;
    p = { x: p.x + Math.sin(rad(t)) * mv, y: p.y + Math.cos(rad(t)) * mv };
    t = norm(t + stepDeg); lost += sinkT * dt / 60; dg += Math.abs(stepDeg);
  }
  return { pos: p, trk: t, lost, deg: dg };
}
// apt: { elev, rwyLen, rwyTrue } (rwyTrue = true landing heading of one end); s: { pos, alt, gs, trk, vs, wd, ws, noWind, preferDirect }
function plan(apt, s) {
  const ELEV = apt.elev, RWY_LEN = apt.rwyLen, RWY_TRUE = apt.rwyTrue;
  const ENDS = [{ id: 'A', hdg: RWY_TRUE }, { id: 'B', hdg: norm(RWY_TRUE + 180) }];
  const wind = s.noWind ? null : { from: s.wd, kt: s.ws };
  const offsetFt = Math.min(1000, Math.max(500, 0.25 * RWY_LEN));
  const tasNow = tas(s.alt), sinkNow = sinkAt(s.alt);
  const evalEnd = (e) => {
    const back = norm(e.hdg + 180);
    const thr = fromPolar(back, (RWY_LEN / 2) / FT_PER_NM);
    const pt = fromPolar(back, (RWY_LEN / 2 + offsetFt) / FT_PER_NM);
    const it = initialTurn(s.pos, s.trk, pt, s.alt, wind);
    const leg = toPolar(pt.x - it.pos.x, pt.y - it.pos.y);
    const headRwy = wind ? wind.kt * Math.cos(rad(wind.from - e.hdg)) : NOWIND_HEAD;
    const turn = Math.abs(signedDiff(e.hdg, leg.brg));
    const finalGs = Math.max(tasNow - headRwy, 20);
    const ftPerFtFinal = finalGs * KT_TO_FPM / sinkNow;
    const hStraight = (offsetFt + RWY_LEN / 2) / ftPerFtFinal;
    const hTurn = TURN_FT_PER_DEG * turn;
    const needMsl = ELEV + hStraight + hTurn + MARGIN;
    const tri = triangle(leg.brg, tasNow, wind);
    const tMin = leg.nm * 60 / tri.gs;
    const toLose = s.alt - needMsl - it.lost;
    return { kind: 'final', e, thr, pt, leg, headRwy, turn, needMsl, hInit: it.lost, initTurn: it.deg, tri, tMin, toLose,
             target: tMin > 0 ? toLose / tMin : Infinity, spare: toLose - sinkNow * tMin };
  };
  const ends = ENDS.map(evalEnd);
  const half = (RWY_LEN / 2) / FT_PER_NM;
  const ra = fromPolar(RWY_TRUE, half), rb = fromPolar(RWY_TRUE + 180, half);
  const ux = rb.x - ra.x, uy = rb.y - ra.y, len2 = ux * ux + uy * uy;
  const k = Math.max(0, Math.min(1, ((s.pos.x - ra.x) * ux + (s.pos.y - ra.y) * uy) / len2));
  const near = { x: ra.x + k * ux, y: ra.y + k * uy };
  const itD = initialTurn(s.pos, s.trk, near, s.alt, wind);
  const legD = toPolar(near.x - itD.pos.x, near.y - itD.pos.y);
  const triD = triangle(legD.brg, tasNow, wind);
  const tMinD = legD.nm * 60 / triD.gs, needD = ELEV + MARGIN, toLoseD = s.alt - needD - itD.lost;
  const direct = { kind: 'direct', e: { id: 'both', hdg: null }, pt: near, leg: legD, needMsl: needD, hInit: itD.lost,
                   initTurn: itD.deg, tri: triD, tMin: tMinD, toLose: toLoseD,
                   target: tMinD > 0 ? toLoseD / tMinD : Infinity, spare: toLoseD - sinkNow * tMinD };
  const need = s.preferDirect ? 100 : 0;
  const reach = ends.filter((c) => c.spare >= need);
  const pick = reach.length
    ? reach.reduce((a, b) => (wind ? (b.headRwy > a.headRwy ? b : a) : (b.turn < a.turn ? b : a)))
    : direct;
  return { kind: pick.kind, best: pick, spare: pick.spare, needMsl: pick.needMsl, sinkNow, tri: pick.tri, target: pick.target,
           turnNow: signedDiff(toPolar(pick.pt.x - s.pos.x, pick.pt.y - s.pos.y).brg, s.trk), wind };
}
module.exports = { plan, triangle, initialTurn, tas, sinkAt, fromPolar, toPolar, norm, signedDiff };
