/**
 * PR B / B5: NEXRAD frame clusters are computed once per stored frame.
 *
 * ConvectiveIntelligenceEngine re-ran NexradSectorAnalyzer.analyze() on every
 * fisb:nexrad message (each NEXRAD block, often dozens in a burst), and that
 * re-clustered EVERY frame in the history from scratch. Stored frames never
 * change (deep-copied in _takeSnapshot, only pushed/shifted), so their clusters
 * are cached per frame object (WeakMap: dropped with the frame).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

const FisbNexrad = new Function(readFileSync('web/cockpit/fisb-nexrad.js', 'utf8') + '\nreturn FisbNexrad;')();

function nexrad(frames) {
    const n = Object.create(FisbNexrad.prototype);
    n._frameHistory = frames;
    const real = FisbNexrad.prototype._clusterBlocks;
    n._clusterBlocks = vi.fn(function (blocks) { return real.call(this, blocks); });
    return n;
}
const frame = (lat) => ({ time: 0, blocks: new Map([['k', { latN: lat, lonW: -81, width: 0.8, height: 4 / 60, intensity: new Array(128).fill(4) }]]) });

describe('clustersForFrame cache (B5)', () => {
    it('the same frame is clustered once, however often it is asked for', () => {
        const n = nexrad([frame(35), frame(35.1)]);
        const a = n.clustersForFrame(0);
        for (let i = 0; i < 20; i++) n.clustersForFrame(0);
        expect(n._clusterBlocks).toHaveBeenCalledTimes(1);
        expect(n.clustersForFrame(0)).toBe(a);
        expect(a.length).toBeGreaterThan(0);
    });

    it('a new frame is clustered; results match an uncached clustering', () => {
        const frames = [frame(35)];
        const n = nexrad(frames);
        n.clustersForFrame(0);
        frames.push(frame(36));
        const fresh = n.clustersForFrame(1);
        expect(n._clusterBlocks).toHaveBeenCalledTimes(2);
        expect(fresh).toEqual(FisbNexrad.prototype._clusterBlocks.call(n, frames[1].blocks));
    });

    it('when the oldest frame is dropped, indices shift but each frame keeps its own clusters', () => {
        const frames = [frame(35), frame(36)];
        const n = nexrad(frames);
        const second = n.clustersForFrame(1);
        frames.shift();
        expect(n.clustersForFrame(0)).toBe(second);
        expect(n._clusterBlocks).toHaveBeenCalledTimes(1);
    });

    it('out of range: empty, as before', () => {
        expect(nexrad([]).clustersForFrame(0)).toEqual([]);
    });
});
