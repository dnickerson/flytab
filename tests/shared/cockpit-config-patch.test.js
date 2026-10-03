/**
 * CockpitConfig.patch() and override merging.
 *
 * patch() (layer-panel toggles, the Map Engine Box picker) used to write the WHOLE
 * live config to flypi_user_cockpit, freezing every other key at today's value so a
 * later bundle correction to any of them never reached that tablet (#112 fixed the
 * same thing for the config editor). It now stores only the difference from the
 * bundle. Overrides are diffs, so merging them back must be recursive.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const load = () => new Function(readFileSync('web/shared/cockpit-config.js', 'utf8') + '\nreturn CockpitConfig;')();

function serveBundle(cockpit) {
    globalThis.fetch = vi.fn((url) => Promise.resolve({
        ok: true,
        json: async () => JSON.parse(JSON.stringify(url.includes('cockpit') ? cockpit : {})),
    }));
}
async function boot(bundle) {
    serveBundle(bundle);
    const CC = load();
    await CC.load();
    return CC;
}
const stored = () => JSON.parse(localStorage.getItem('flypi_user_cockpit') || '{}');

const BUNDLE_A = {
    engineOverlay: { enabled: true, position: 'top-right', fields: [{ key: 'carb_temp', label: 'CARB TEMP', unit: '°F' }] },
    enginePage: { fuelCautionGal: 8 },
    airspace_alerts: { enabled: false, types: { class_b: false, class_c: true, class_d: true } },
};

beforeEach(() => localStorage.clear());

describe('CockpitConfig.patch stores only what differs from the bundle', () => {
    it('stores just the patched value, not the whole config', async () => {
        const CC = await boot(BUNDLE_A);
        CC.patch('engineOverlay.fields', [{ key: 'rpm', label: 'RPM', unit: '' }]);
        expect(stored()).toEqual({ engineOverlay: { fields: [{ key: 'rpm', label: 'RPM', unit: '' }] } });
    });

    it('a later bundle change to any OTHER key still takes effect after a patch', async () => {
        let CC = await boot(BUNDLE_A);
        CC.patch('engineOverlay.fields', [{ key: 'rpm', label: 'RPM', unit: '' }]);
        const BUNDLE_B = JSON.parse(JSON.stringify(BUNDLE_A));
        BUNDLE_B.engineOverlay.position = 'top-left';
        BUNDLE_B.enginePage.fuelCautionGal = 10;
        CC = await boot(BUNDLE_B);
        expect(CC.get('engineOverlay.position')).toBe('top-left');
        expect(CC.get('enginePage.fuelCautionGal')).toBe(10);
        expect(CC.get('engineOverlay.fields').map(f => f.key)).toEqual(['rpm']);   // the pilot's choice survives
    });

    it('patching back to the bundle value stores nothing for it', async () => {
        const CC = await boot(BUNDLE_A);
        CC.patch('airspace_alerts.enabled', true);
        CC.patch('airspace_alerts.enabled', false);
        expect(stored()).toEqual({});
    });

    it('keeps an earlier config-editor override when patching something else', async () => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({ enginePage: { fuelCautionGal: 6 } }));
        const CC = await boot(BUNDLE_A);
        CC.patch('airspace_alerts.types.class_b', true);
        expect(stored()).toEqual({ enginePage: { fuelCautionGal: 6 }, airspace_alerts: { types: { class_b: true } } });
    });
});

describe('override merge is recursive', () => {
    it('a nested override does not wipe its siblings (class_b on keeps class_c/class_d)', async () => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({ airspace_alerts: { types: { class_b: true } } }));
        const CC = await boot(BUNDLE_A);
        expect(CC.get('airspace_alerts.types')).toEqual({ class_b: true, class_c: true, class_d: true });
        expect(CC.get('airspace_alerts.enabled')).toBe(false);
    });

    it('arrays replace rather than merge', async () => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({ engineOverlay: { fields: [] } }));
        const CC = await boot(BUNDLE_A);
        expect(CC.get('engineOverlay.fields')).toEqual([]);
        expect(CC.get('engineOverlay.enabled')).toBe(true);
    });
});
