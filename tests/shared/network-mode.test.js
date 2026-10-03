// tests/shared/network-mode.test.js
//
// Behavioral tests for NetworkMode._probe()/detect().
//
// Field bug (2026-10-02, v10.74): on Stratux WiFi (no internet) the Android
// WebView reports navigator.onLine === false. _probe() checked onLine FIRST and
// returned 'offline' without ever probing Stratux, so after the first probe
// (taken while onLine was still true) the mode flipped flight → offline, and
// app.js tore down every Stratux socket. Every later probe short-circuited the
// same way, so the mode never returned to 'flight' and nothing reconnected.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

global.Settings      = { stratuxIp: '192.168.10.1' };
global.CockpitConfig = { homeBases: ['http://home:8090'] };

const src = readFileSync('web/shared/network-mode.js', 'utf8');
const NetworkMode = new Function(`${src}\nreturn NetworkMode;`)();

let stratuxUp, homeUp, onLine;

function installFetch() {
    global.fetch = vi.fn(async (url) => {
        if (url.startsWith('http://192.168.10.1/')) {
            if (stratuxUp) return { ok: true };
            throw new TypeError('Failed to fetch');
        }
        if (url.startsWith('http://home:8090/')) {
            if (homeUp) return { ok: true };
            throw new TypeError('Failed to fetch');
        }
        throw new TypeError('Failed to fetch');
    });
}

describe('NetworkMode — Stratux reachability wins over navigator.onLine', () => {
    let onLineSpy;

    beforeEach(() => {
        stratuxUp = false; homeUp = false; onLine = true;
        installFetch();
        onLineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => onLine);
    });

    afterEach(() => {
        onLineSpy.mockRestore();
        delete global.fetch;
    });

    it("reports 'flight' when Stratux answers even though navigator.onLine is false (no-internet WiFi)", async () => {
        stratuxUp = true; onLine = false;
        const nm = new NetworkMode();
        expect(await nm.detect()).toBe('flight');
        expect(nm.mode).toBe('flight');
    });

    it('stays in flight when navigator.onLine flips to false while Stratux is still reachable (the field sequence)', async () => {
        const nm = new NetworkMode();
        const changes = [];
        nm.addEventListener('mode:changed', e => changes.push(e.detail));

        stratuxUp = true; onLine = true;
        await nm.detect();                     // first probe right after joining WiFi
        onLine = false;                        // Android decides the WiFi has no internet
        await nm.detect();
        await nm.detect();
        await nm.detect();

        expect(nm.mode).toBe('flight');
        expect(changes).toEqual([{ mode: 'flight', previous: 'offline' }]);
    });

    it("reports 'offline' when Stratux is unreachable and navigator.onLine is false", async () => {
        const nm = new NetworkMode();
        onLine = false;
        expect(await nm.detect()).toBe('offline');
    });

    it("reports 'home' / 'internet' when online and Stratux is unreachable", async () => {
        const nm = new NetworkMode();
        homeUp = true;
        expect(await nm.detect()).toBe('home');
        homeUp = false;
        expect(await nm.detect()).toBe('internet');
    });
});

describe('NetworkMode — leaving flight requires consecutive failed Stratux probes', () => {
    let onLineSpy;

    beforeEach(() => {
        stratuxUp = true; homeUp = false; onLine = false;
        installFetch();
        onLineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => onLine);
    });

    afterEach(() => {
        onLineSpy.mockRestore();
        delete global.fetch;
    });

    it('a single slow/failed Stratux probe does not drop out of flight mode', async () => {
        const nm = new NetworkMode();
        await nm.detect();
        expect(nm.mode).toBe('flight');

        stratuxUp = false;
        await nm.detect();
        expect(nm.mode).toBe('flight');
    });

    it(`leaves flight only after ${3} consecutive failed probes`, async () => {
        const nm = new NetworkMode();
        const changes = [];
        nm.addEventListener('mode:changed', e => changes.push(e.detail));
        await nm.detect();

        stratuxUp = false;
        await nm.detect();
        await nm.detect();
        expect(nm.mode).toBe('flight');
        await nm.detect();
        expect(nm.mode).toBe('offline');
        expect(changes.at(-1)).toEqual({ mode: 'offline', previous: 'flight' });
    });

    it('a successful probe resets the miss counter', async () => {
        const nm = new NetworkMode();
        await nm.detect();

        stratuxUp = false;
        await nm.detect();
        await nm.detect();
        stratuxUp = true;
        await nm.detect();
        stratuxUp = false;
        await nm.detect();
        await nm.detect();
        expect(nm.mode).toBe('flight');
    });

    it('detect() returns the effective mode, not the raw probe result, while holding flight', async () => {
        const nm = new NetworkMode();
        await nm.detect();
        stratuxUp = false;
        expect(await nm.detect()).toBe('flight');
    });
});
