/**
 * fuel-overlay.js's _engineBaseUrl() fell back to a hardcoded 192.168.10.1
 * (a Stratux-shaped address, but this URL targets the Pi engine-monitor on
 * port 8080) when window.engineClient.ip was unavailable. engineClient is
 * assigned synchronously at app.js:518, before any panel that calls this can
 * render, so the fallback could only ever paper over a genuine bug — never a
 * real "not ready yet" state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

afterEach(() => { delete window.engineClient; });

describe('FuelOverlay._engineBaseUrl (Finding 7b)', () => {
    it('returns null, not a guessed IP, when engineClient is unavailable', () => {
        delete window.engineClient;
        const overlay = Object.create(FuelOverlay.prototype);
        expect(overlay._engineBaseUrl()).toBeNull();
    });

    it('builds the URL from the real engineClient.ip when available', () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = Object.create(FuelOverlay.prototype);
        expect(overlay._engineBaseUrl()).toBe('http://192.168.1.50:8080');
    });
});
