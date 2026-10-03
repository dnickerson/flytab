/**
 * FuelOverlay's Pi syncs for a preflight tic measurement (_syncFuelSetToEngine,
 * via _applyMeasurement) and a fuel stop (_syncFuelAddToEngine, via
 * _recordFuelStop) must not swallow a failed sync — same silent-divergence
 * risk the dropped-burn correction's Pi sync was fixed for in PR #143, applied
 * here to the two other Pi-sync call sites the same audit flagged as still
 * fire-and-forget.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

function makeOverlay() {
    const overlay = Object.create(FuelOverlay.prototype);
    overlay._dom = {
        applyStatus: document.createElement('div'),
        addStatus: document.createElement('div'),
        addRecord: document.createElement('button'),
    };
    overlay._recording = false;
    overlay._fuelStopPiSyncFailed = false;
    overlay._lastFuelStopPending = null;
    return overlay;
}

afterEach(() => {
    delete window.engineClient;
    vi.restoreAllMocks();
});

describe('FuelOverlay._syncFuelSetToEngine', () => {
    it('reports ok:true on a successful sync', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        const result = await overlay._syncFuelSetToEngine(24.5, 'Preflight tic mark measurement');

        expect(result.ok).toBe(true);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/set');
        expect(JSON.parse(opts.body)).toEqual({ fuel_remaining: 24.5, reason: 'Preflight tic mark measurement' });
    });

    it('reports ok:false with a message when the Pi is unreachable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();
        const fetchSpy = vi.spyOn(global, 'fetch');

        const result = await overlay._syncFuelSetToEngine(24.5, 'reason');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi unreachable/);
    });

    it('reports ok:false with a message when the fetch rejects', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        const result = await overlay._syncFuelSetToEngine(24.5, 'reason');

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi sync failed/);
    });

    it('reports ok:false when the Pi returns a non-2xx status', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });

        const result = await overlay._syncFuelSetToEngine(24.5, 'reason');

        expect(result.ok).toBe(false);
    });
});

describe('FuelOverlay._syncFuelAddToEngine', () => {
    it('reports ok:true and posts the fuel-stop fields', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        const result = await overlay._syncFuelAddToEngine(10, 'KPAO', 5.99);

        expect(result.ok).toBe(true);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/add');
        expect(JSON.parse(opts.body)).toEqual({ gallons: 10, airport: 'KPAO', price_per_gallon: 5.99 });
    });

    it('reports ok:false with a message when the Pi is unreachable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();

        const result = await overlay._syncFuelAddToEngine(10, 'KPAO', null);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi unreachable/);
    });

    it('reports ok:false with a message when the fetch rejects', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        const result = await overlay._syncFuelAddToEngine(10, 'KPAO', 5.99);

        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Pi sync failed/);
    });

    it('reports ok:false when the Pi returns a non-2xx status', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });

        const result = await overlay._syncFuelAddToEngine(10, 'KPAO', 5.99);

        expect(result.ok).toBe(false);
    });
});

/**
 * _retryFuelStopPiSync() is the safe-retry mechanism for Finding 1 (2026-09
 * whole-branch audit): after _recordFuelStop() has already written the local
 * record (flytab_fuel_stops + FuelTankState) and only the Pi POST failed, this
 * must resend EXACTLY the pending {gallons, airport, price} without touching
 * local state again — a second local write would duplicate the fuel-stop
 * entry, and since the Pi's own fuel total is additive, a genuinely duplicate
 * POST could double-add gallons if the original request actually landed
 * despite a client-side timeout.
 */
describe('FuelOverlay._retryFuelStopPiSync', () => {
    it('does nothing when there is no pending fuel stop to retry', async () => {
        const overlay = makeOverlay();
        const fetchSpy = vi.spyOn(global, 'fetch');

        await overlay._retryFuelStopPiSync();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resends the exact pending gallons/airport/price on retry', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._fuelStopPiSyncFailed = true;
        overlay._lastFuelStopPending = { gallons: 12, airport: 'KMYL', price: 5.5, reason: 'Pi sync failed (network down)' };
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        await overlay._retryFuelStopPiSync();

        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/add');
        expect(JSON.parse(opts.body)).toEqual({ gallons: 12, airport: 'KMYL', price_per_gallon: 5.5 });
    });

    it('a successful retry clears _fuelStopPiSyncFailed and _lastFuelStopPending', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._fuelStopPiSyncFailed = true;
        overlay._lastFuelStopPending = { gallons: 12, airport: 'KMYL', price: null, reason: 'network down' };
        vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });

        await overlay._retryFuelStopPiSync();

        expect(overlay._fuelStopPiSyncFailed).toBe(false);
        expect(overlay._lastFuelStopPending).toBe(null);
        expect(overlay._dom.addStatus.textContent).toMatch(/Pi sync succeeded/i);
        expect(overlay._dom.addStatus.className).toContain('fo-add-status-ok');
        expect(overlay._dom.addRecord.textContent).toBe('RECORD FUEL STOP');
    });

    it('a failed retry keeps the pending stop tracked for another retry, without resurrecting a resolved one', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._fuelStopPiSyncFailed = true;
        overlay._lastFuelStopPending = { gallons: 12, airport: 'KMYL', price: null, reason: 'network down' };
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('still down'));

        await overlay._retryFuelStopPiSync();

        expect(overlay._fuelStopPiSyncFailed).toBe(true);
        expect(overlay._lastFuelStopPending).toMatchObject({ gallons: 12, airport: 'KMYL' });
        expect(overlay._dom.addStatus.textContent).toMatch(/Retry failed/i);
        expect(overlay._dom.addStatus.className).toContain('fo-add-status-error');
        expect(overlay._dom.addRecord.textContent).toBe('RETRY PI SYNC');
    });

    it('refuses a second concurrent retry while one is already in flight', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        overlay._fuelStopPiSyncFailed = true;
        overlay._lastFuelStopPending = { gallons: 12, airport: 'KMYL', price: null, reason: 'network down' };
        let resolveFetch;
        vi.spyOn(global, 'fetch').mockReturnValue(new Promise(r => { resolveFetch = r; }));

        const p1 = overlay._retryFuelStopPiSync();
        const p2 = overlay._retryFuelStopPiSync(); // fired before p1's fetch resolves
        resolveFetch({ ok: true, status: 200 });
        await Promise.all([p1, p2]);

        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});
