/**
 * The Pi already computes and exposes its own K-factor calibration status
 * (GET /api/fuel/calibration) and an endpoint to record an applied value
 * (POST /api/fuel/calibration/applied) — engine_monitor.py's KFactorCalibration
 * class. Nothing in web/ read either before this task; FlyTab's own K-FACTOR
 * CALCULATOR panel is a separate, locally-computed ratio and stays unchanged.
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
        kfPiSection: document.createElement('div'),
        kfPiCurrent: document.createElement('div'),
        kfPiSuggested: document.createElement('div'),
        kfPiRecommendation: document.createElement('div'),
        kfPiApply: document.createElement('button'),
        kfPiStatus: document.createElement('div'),
    };
    return overlay;
}

afterEach(() => {
    delete window.engineClient;
    vi.restoreAllMocks();
});

describe('FuelOverlay._fetchPiCalibration / _renderPiKFactor', () => {
    it('hides the PI K-FACTOR section when the Pi is unreachable', async () => {
        delete window.engineClient;
        const overlay = makeOverlay();
        await overlay._fetchPiCalibration();
        expect(overlay._dom.kfPiSection.style.display).toBe('none');
    });

    it('shows current-only, no APPLY button, when the Pi does not have enough data yet', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                ready: false, message: 'Need more data: 4.0 gal added, recommend 30+ gal',
                current_k_factor: 68000, period_start: '2026-09-01T00:00:00', fuel_added: 4.0, computed_used: 3.9,
            }),
        });

        await overlay._fetchPiCalibration();

        expect(overlay._dom.kfPiSection.style.display).toBe('');
        expect(overlay._dom.kfPiCurrent.textContent).toBe('68000');
        expect(overlay._dom.kfPiSuggested.textContent).toBe('--');
        expect(overlay._dom.kfPiRecommendation.textContent).toMatch(/Need more data/);
        expect(overlay._dom.kfPiApply.style.display).toBe('none');
    });

    it('shows the suggested value and APPLY button when the Pi has enough calibration data', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = makeOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({
                ready: true, current_k_factor: 68000, suggested_k_factor: 68680,
                k_factor_ratio: 1.01, variance_percent: 1.0,
                recommendation: 'Sensor reads 1.0% HIGH. Increase K-factor.',
            }),
        });

        await overlay._fetchPiCalibration();

        expect(overlay._dom.kfPiCurrent.textContent).toBe('68000');
        expect(overlay._dom.kfPiSuggested.textContent).toBe('68680');
        expect(overlay._dom.kfPiRecommendation.textContent).toMatch(/1.0% HIGH/);
        expect(overlay._dom.kfPiApply.style.display).toBe('');
    });
});

describe('FuelOverlay._applyPiKFactor', () => {
    function readyOverlay() {
        const overlay = makeOverlay();
        overlay._piCalibration = { ready: true, current_k_factor: 68000, suggested_k_factor: 68680 };
        return overlay;
    }

    it('does nothing if the Pi calibration is not ready', async () => {
        const overlay = makeOverlay();
        overlay._piCalibration = { ready: false };
        const fetchSpy = vi.spyOn(global, 'fetch');
        await overlay._applyPiKFactor();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('POSTs the suggested K-factor and reports success', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = readyOverlay();
        vi.spyOn(global, 'fetch').mockImplementation((url) => {
            if (String(url).includes('/calibration/applied')) {
                return Promise.resolve({ ok: true, json: async () => ({ success: true, message: 'K-factor 68680 recorded as applied' }) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ ready: false, current_k_factor: 68680, message: 'reset' }) });
        });

        await overlay._applyPiKFactor();

        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://192.168.1.50:8080/api/fuel/calibration/applied');
        expect(JSON.parse(opts.body)).toEqual({ new_k_factor: 68680 });
        expect(overlay._dom.kfPiStatus.textContent).toMatch(/recorded as applied/);
        expect(overlay._dom.kfPiStatus.className).toContain('fo-add-status-ok');
    });

    it('reports a Pi-side rejection', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = readyOverlay();
        vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: false, status: 400, json: async () => ({ error: 'Invalid K-factor' }),
        });

        await overlay._applyPiKFactor();

        expect(overlay._dom.kfPiStatus.textContent).toBe('Invalid K-factor');
        expect(overlay._dom.kfPiStatus.className).toContain('fo-add-status-error');
    });

    it('reports a network failure', async () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = readyOverlay();
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

        await overlay._applyPiKFactor();

        expect(overlay._dom.kfPiStatus.textContent).toMatch(/Pi sync failed/);
        expect(overlay._dom.kfPiStatus.className).toContain('fo-add-status-error');
    });
});
