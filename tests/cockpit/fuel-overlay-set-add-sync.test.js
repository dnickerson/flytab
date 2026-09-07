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
    };
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
});
