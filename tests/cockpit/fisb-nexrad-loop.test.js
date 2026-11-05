/**
 * FIS-B NEXRAD flashing (10/27 KORL-KTBR flight, replayed from the weather log and
 * compared against IEM radar):
 *  - CONUS level 1 ("< 20 dBZ", in practice no echo) painted green slabs over clear air
 *  - CONUS was hidden over the whole bounding box of recent Regional blocks, so it
 *    turned on and off as the box moved and real echo inside the box was hidden
 *  - CONUS is re-sent every ~14 min but was held 15: a partial burst left holes
 *  - the first loop frame was taken at the first message (1 block); snapshots were
 *    taken at a burst's first message; a purge-time snapshot repeated stale data
 *  - a resize or map move in loop mode left the canvas blank until the next frame
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const FisbNexrad = new Function(readFileSync('web/cockpit/fisb-nexrad.js', 'utf8') + '\nreturn FisbNexrad;')();

const T0 = Date.UTC(2026, 9, 27, 13, 0, 0);
const MIN = 60000;
const REG_H = 4 / 60, REG_W = 0.8, CON_H = 20 / 60, CON_W = 4;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    globalThis.CockpitConfig = { get: (k) => ({ 'radar.frameIntervalMinutes': 10, 'radar.loopDurationHours': 2 })[k] };
    globalThis.DiagLog = { log() {} };
    globalThis.indexedDB = { open: () => ({}) };        // never opens: no hydrate/persist
    globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
    globalThis.window.app = { cockpitMap: { onFisbNexradLoopReady: vi.fn() } };
});
afterEach(() => { vi.useRealTimers(); });

function makeNexrad() {
    return new FisbNexrad({ addEventListener() {}, removeEventListener() {} });
}

// Wire-format blocks (what Stratux sends)
const regional = (lat, lon, fill = 0, set = {}) => {
    const I = new Array(128).fill(fill);
    for (const [i, v] of Object.entries(set)) I[i] = v;
    return { LatNorth: lat, LonWest: lon, Height: REG_H, Width: REG_W, Intensity: I, Radar_Type: 63, Scale: 0 };
};
const conus = (lat, lon, fill = 1, set = {}) => {
    const I = new Array(128).fill(fill);
    for (const [i, v] of Object.entries(set)) I[i] = v;
    return { LatNorth: lat, LonWest: lon, Height: CON_H, Width: CON_W, Intensity: I, Radar_Type: 64, Scale: 1 };
};
const send = (nx, blocks) => nx._handleNexrad({ NEXRAD: blocks });

// ---- drawing: fake map (linear projection, 100 px / degree) + recording canvas ----
const VIEW = { n: 32, s: 26, w: -86, e: -76 };
function fakeMap() {
    return {
        latLngToContainerPoint: ([lat, lon]) => ({ x: (lon - VIEW.w) * 100, y: (VIEW.n - lat) * 100 }),
        containerPointToLayerPoint: () => ({ x: 0, y: 0 }),
        getBounds: () => ({ getSouth: () => VIEW.s, getNorth: () => VIEW.n, getWest: () => VIEW.w, getEast: () => VIEW.e }),
        getZoom: () => 8,
        getSize: () => ({ x: 1000, y: 600 }),
    };
}
function recCtx() {
    const ops = [];
    return {
        ops, globalAlpha: 1, fillStyle: null,
        clearRect(x, y, w, h) { ops.push({ op: 'clear', x, y, w, h }); },
        fillRect(x, y, w, h) { ops.push({ op: 'fill', x, y, w, h, style: this.fillStyle }); },
    };
}
function target() {
    const ctx = recCtx();
    return { map: fakeMap(), canvas: { width: 2000, height: 1200, style: {} }, ctx };
}
// Colour visible at a lat/lon after the recorded ops (last op covering the pixel wins).
function colourAt(t, lat, lon) {
    const { x, y } = t.map.latLngToContainerPoint([lat, lon]);
    let c = null;
    for (const o of t.ctx.ops) {
        if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) c = o.op === 'fill' ? o.style : null;
    }
    return c;
}
// Centre of bin (row r, col c) of a block
const binCentre = (latN, lonW, h, w, r, c) => [latN - (r + 0.5) * h / 4, lonW + (c + 0.5) * w / 32];

describe('drawing', () => {
    it('CONUS level 1 is not drawn; CONUS level 2+ and Regional level 1 are', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 1, { 1: 2 }), regional(28, -80, 0, { 0: 1 })]);
        const t = target();
        nx._drawToTarget(t, ['conus', 'regional'], nx._blocks);
        expect(colourAt(t, ...binCentre(30, -84, CON_H, CON_W, 0, 0))).toBeNull();
        expect(colourAt(t, ...binCentre(30, -84, CON_H, CON_W, 0, 1))).toBe(FisbNexrad.COLORS[2]);
        expect(colourAt(t, ...binCentre(28, -80, REG_H, REG_W, 0, 0))).toBe(FisbNexrad.COLORS[1]);
    });

    it('the CONUS-only page also skips CONUS level 1', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 1)]);
        const t = target();
        nx.draw(t, 'conus');
        expect(t.ctx.ops.filter(o => o.op === 'fill')).toHaveLength(0);
    });

    it('CONUS is hidden exactly under a Regional block, shown next to it', () => {
        const nx = makeNexrad();
        // CONUS block 30N..29.667N, 84W..80W, all level 3
        // Regional blocks at its west and east ends only (no echo) — the old rule's
        // bounding box spanned the whole CONUS block and hid all of it.
        send(nx, [conus(30, -84, 3), regional(30, -84, 0), regional(30, -80.8, 0)]);
        const t = target();
        nx._drawToTarget(t, ['conus', 'regional'], nx._blocks);
        expect(colourAt(t, 29.97, -83.6)).toBeNull();                 // under west Regional block
        expect(colourAt(t, 29.97, -80.4)).toBeNull();                 // under east Regional block
        expect(colourAt(t, 29.97, -82.0)).toBe(FisbNexrad.COLORS[3]); // between them: CONUS
        expect(colourAt(t, 29.80, -83.6)).toBe(FisbNexrad.COLORS[3]); // south of the Regional row
    });

    it('Regional echo is drawn over the cleared CONUS footprint', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 3), regional(30, -84, 0, { 5: 5 })]);
        const t = target();
        nx._drawToTarget(t, ['conus', 'regional'], nx._blocks);
        expect(colourAt(t, ...binCentre(30, -84, REG_H, REG_W, 0, 5))).toBe(FisbNexrad.COLORS[5]);
        expect(colourAt(t, ...binCentre(30, -84, REG_H, REG_W, 0, 6))).toBeNull();
    });

    it('a Regional block too small to draw does not blank the CONUS under it', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 3), regional(30, -84, 0)]);
        const t = target();
        const m = t.map;
        // 5 px per degree: a Regional column is 0.125 px (< 0.3, not drawn)
        m.latLngToContainerPoint = ([lat, lon]) => ({ x: (lon - VIEW.w) * 5, y: (VIEW.n - lat) * 5 });
        nx._drawToTarget(t, ['conus', 'regional'], nx._blocks);
        expect(colourAt(t, 29.97, -83.6)).toBe(FisbNexrad.COLORS[3]);
    });

    it('Regional drawn alone or first never clears anything', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 3), regional(30, -84, 0)]);
        const t = target();
        nx._drawToTarget(t, ['regional', 'conus'], nx._blocks);
        expect(t.ctx.ops.filter(o => o.op === 'clear')).toHaveLength(1);   // only the full-canvas clear
    });
});

describe('holding blocks', () => {
    it('CONUS is held 30 minutes, Regional 15', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 3), regional(28, -80, 2)]);
        vi.setSystemTime(T0 + 15 * MIN + 1000); nx._purgeOld();
        expect([...nx._blocks.keys()].some(k => k.startsWith('regional'))).toBe(false);
        expect([...nx._blocks.keys()].some(k => k.startsWith('conus'))).toBe(true);
        vi.setSystemTime(T0 + 29 * MIN); nx._purgeOld();
        expect(nx._blocks.size).toBe(1);
        vi.setSystemTime(T0 + 30 * MIN + 1000); nx._purgeOld();
        expect(nx._blocks.size).toBe(0);
    });

    it('a partial CONUS burst no longer leaves the blocks it missed to vanish', () => {
        const nx = makeNexrad();
        const full = [];
        for (let i = 0; i < 20; i++) full.push(conus(40 - i / 3, -100, 3));
        send(nx, full);                                   // full burst at T0
        vi.setSystemTime(T0 + 14 * MIN);
        send(nx, full.slice(0, 5));                       // partial burst 14 min later
        vi.setSystemTime(T0 + 16 * MIN); nx._purgeOld();
        expect([...nx._blocks.values()].filter(b => b.radarType === 64)).toHaveLength(20);
    });
});

describe('loop snapshots', () => {
    it('the first message alone makes no frame; the first frame waits for CONUS and the end of the burst', () => {
        const nx = makeNexrad();
        send(nx, [regional(30, -84, 2)]);
        vi.advanceTimersByTime(31000);
        expect(nx._frameHistory).toHaveLength(0);         // no CONUS yet
        send(nx, [conus(30, -84, 3)]);                    // burst starts
        vi.advanceTimersByTime(10000);
        send(nx, [regional(28, -80, 2)]);                 // later in the burst
        expect(nx._frameHistory).toHaveLength(0);         // not at the first message
        vi.advanceTimersByTime(20000);
        expect(nx._frameHistory).toHaveLength(1);
        const keys = [...nx._frameHistory[0].blocks.keys()];
        expect(keys).toHaveLength(3);                     // whole burst, both products
    });

    it('without CONUS, the first frame comes after 15 minutes of reception', () => {
        const nx = makeNexrad();
        for (let m = 0; m <= 16; m += 2) {
            vi.setSystemTime(T0 + m * MIN);
            send(nx, [regional(30, -84, 2)]);
            vi.advanceTimersByTime(30000);
            if (m < 14) expect(nx._frameHistory).toHaveLength(0);
        }
        expect(nx._frameHistory).toHaveLength(1);
    });

    it('frames are frameIntervalMinutes apart and the loop-ready switch fires at two frames', () => {
        const nx = makeNexrad();
        nx._map = {};                                     // attached
        for (let m = 0; m <= 22; m += 2) {
            vi.setSystemTime(T0 + m * MIN);
            send(nx, [conus(30, -84, 3), regional(30, -84, 2)]);
            vi.advanceTimersByTime(30000);
        }
        const times = nx._frameHistory.map(f => (f.time - T0) / MIN);
        expect(times).toEqual([0.5, 10.5, 20.5]);
        expect(window.app.cockpitMap.onFisbNexradLoopReady).toHaveBeenCalledTimes(1);
    });

    it('a snapshot leaves out blocks that have expired but not yet been purged', () => {
        const nx = makeNexrad();
        send(nx, [conus(30, -84, 3), regional(28, -80, 2)]);
        nx._takeSnapshot(T0 + 16 * MIN, T0 + 16 * MIN);
        expect([...nx._frameHistory[0].blocks.keys()]).toEqual(['conus,30,-84']);
    });

    it('the purge no longer takes a snapshot when everything expires', () => {
        const nx = makeNexrad();
        send(nx, [regional(28, -80, 2)]);
        vi.setSystemTime(T0 + 16 * MIN);
        nx._purgeOld();
        expect(nx._frameHistory).toHaveLength(0);
        expect(nx._storeSince).toBe(0);
    });

    it('after the store empties, warm-up starts again from the next block', () => {
        const nx = makeNexrad();
        send(nx, [regional(28, -80, 2)]);
        vi.setSystemTime(T0 + 20 * MIN); nx._purgeOld();
        send(nx, [regional(28, -80, 2)]);
        expect(nx._storeSince).toBe(T0 + 20 * MIN);
    });

    it('remove() cancels a pending snapshot', () => {
        const nx = makeNexrad();
        nx._active = true;
        send(nx, [conus(30, -84, 3)]);
        nx.remove();
        vi.advanceTimersByTime(31000);
        expect(nx._frameHistory).toHaveLength(0);
    });
});

describe('loop mode redraws', () => {
    function attached() {
        const nx = makeNexrad();
        const t = target();
        nx._active = true;
        nx._map = t.map; nx._canvas = t.canvas; nx._ctx = t.ctx; nx._mainTarget = t;
        send(nx, [conus(30, -84, 3)]);
        vi.advanceTimersByTime(31000);                    // one frame
        return { nx, t };
    }
    const fills = (t) => t.ctx.ops.filter(o => o.op === 'fill').length;

    it('a resize during playback redraws the frame on screen', () => {
        const { nx, t } = attached();
        nx.enterLoopMode();
        nx.drawFrame(t, ['conus', 'regional'], 0);
        t.ctx.ops.length = 0;
        nx._resizeCanvas();
        expect(fills(t)).toBeGreaterThan(0);
    });

    it('a map move during playback redraws the frame on screen', () => {
        const { nx, t } = attached();
        nx.enterLoopMode();
        nx.drawFrame(t, ['conus', 'regional'], 0);
        t.ctx.ops.length = 0;
        nx._scheduleMoveDraw();
        expect(fills(t)).toBeGreaterThan(0);
    });

    it('in loop mode with no FIS-B frame drawn (internet loop), a resize draws nothing', () => {
        const { nx, t } = attached();
        nx.drawLive();
        nx.enterLoopMode();
        t.ctx.ops.length = 0;
        nx._resizeCanvas();
        nx._scheduleMoveDraw();
        expect(fills(t)).toBe(0);
    });
});
