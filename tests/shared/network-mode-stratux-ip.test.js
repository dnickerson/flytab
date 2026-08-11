/**
 * network-mode.js / device-status.js hardcoded 192.168.10.1 for their Stratux
 * getStatus probe, bypassing Settings.stratuxIp — so a pilot who changed the
 * configured IP still got probed against the default. Pins the fix at the
 * source level: the probe URL must be built from Settings.stratuxIp.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

describe('Stratux getStatus probes read Settings.stratuxIp (Finding 7a)', () => {
    it('network-mode.js builds the probe URL from Settings.stratuxIp, with no redundant hardcoded-IP fallback', () => {
        const src = read('web/shared/network-mode.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp\}\/getStatus`/);
        expect(src).not.toMatch(/Settings\.stratuxIp \|\| '192\.168\.10\.1'/);
    });

    it('device-status.js builds the probe URL from Settings.stratuxIp, with no redundant hardcoded-IP fallback', () => {
        const src = read('web/cockpit/device-status.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp\}\/getStatus`/);
        expect(src).not.toMatch(/Settings\.stratuxIp \|\| '192\.168\.10\.1'/);
    });
});
