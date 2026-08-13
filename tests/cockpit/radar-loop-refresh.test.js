/**
 * RadarLoop.refresh() rebuilt the frame times but kept the pilot's pre-refresh
 * frameIndex (comment: "clamp ... so a rebuilt array doesn't leave us out of
 * range"). If paused on an older frame, refresh silently re-showed an old
 * frame relative to the new refresh time instead of jumping to "now" — a
 * pilot comparing the loop's time label to the status-bar clock saw it stay
 * wrong even after hitting refresh. setNexrad() already does this correctly
 * (jumps to frames.length - 1); refresh() should match.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

global.CockpitConfig = { get: () => undefined };
global.DiagLog = { log: () => {} };
global.L = { DomEvent: { disableClickPropagation: () => {}, disableScrollPropagation: () => {} } };

const src = readFileSync('web/cockpit/radar-loop.js', 'utf8');
const RadarLoop = new Function(`${src}\nreturn RadarLoop;`)();

function makeSource(frameCount) {
    return {
        sourceType: 'inet',
        frameHistory: Array.from({ length: frameCount }, (_, i) => ({ time: i })),
        hasData: true,
        isActive: true,
        drawFrame: () => {},
        drawLive: () => {},
        enterLoopMode: () => {},
        exitLoopMode: () => {},
        getDataAgeMs: () => null,
        refresh: async () => {},
    };
}

describe('RadarLoop.refresh() frame selection', () => {
    let loop;

    beforeEach(() => {
        loop = new RadarLoop();
        loop.show({ getContainer: () => document.createElement('div') });
        loop.pause();
    });

    it('jumps to the latest frame on refresh, matching setNexrad()', async () => {
        const source = makeSource(12);
        loop.setNexrad(source);
        loop.pause();
        loop._goToFrame(0);   // pilot paused on the oldest frame
        expect(loop._frameIndex).toBe(0);

        await loop.refresh();

        expect(loop._frameIndex).toBe(11);
    });

    it('lands in range (not out of bounds) when a refreshed source returns fewer frames', async () => {
        const source = makeSource(12);
        loop.setNexrad(source);
        loop.pause();
        loop._goToFrame(9);
        source.refresh = async () => { source.frameHistory = source.frameHistory.slice(0, 5); };

        await loop.refresh();

        expect(loop._frameIndex).toBe(4);   // latest of the now-shorter 5-frame array
    });
});
