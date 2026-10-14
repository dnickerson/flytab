/**
 * Layer panel "Conv Intel" toggle must actually switch the Convective
 * Intelligence engine.
 *
 * Since b1c6634 (May 2026) the change handler called CockpitConfig.set(), which
 * doesn't exist -- CockpitConfig.patch() is the persisting setter. It threw
 * before convectiveEngine.setActive(on), so the toggle never did anything. The
 * panel replays saved layer defaults as 'change' events at startup, so it also
 * threw "Uncaught TypeError: CockpitConfig.set is not a function" on every
 * launch (seen in the tablet's DiagLog 2026-10-13).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');

global.DiagLog = { log: vi.fn() };
global.wireTap = (el, fn) => el.addEventListener('click', fn);
global.Settings = new Proxy({}, { get: () => undefined });
const CockpitConfig = new Function(read('web/shared/cockpit-config.js') + '\nreturn CockpitConfig;')();
global.CockpitConfig = CockpitConfig;
const LayerPanel = new Function(read('web/cockpit/layer-panel.js') + '\nreturn LayerPanel;')();

function build() {
    const setActive = vi.fn();
    window.app = { convectiveEngine: { setActive }, cockpitMap: {} };
    // Stand-ins: any method the panel calls during init is a no-op; any flag reads false.
    const stub = (base = {}) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /Visible$|^_/.test(k) ? false : () => {})) });
    const map = stub({ getZoom: () => 8, hasLayer: () => false });
    const panel = new LayerPanel(map, stub(), stub({ map }), null);
    panel.init();
    const input = document.querySelector('.lp-toggle input[data-action="conv-intel"]');
    return { panel, input, setActive };
}

describe('Layer panel Conv Intel toggle', () => {
    beforeEach(() => { document.body.innerHTML = ''; localStorage.clear(); CockpitConfig._config = {}; });
    afterEach(() => { delete window.app; });

    it('turning it on activates the engine and persists convective.enabled', () => {
        const { input, setActive } = build();
        expect(input).not.toBeNull();
        input.checked = true;
        expect(() => input.dispatchEvent(new Event('change'))).not.toThrow();
        expect(setActive).toHaveBeenCalledWith(true);
        expect(CockpitConfig.get('convective.enabled')).toBe(true);
        const stored = JSON.parse(localStorage.getItem('flypi_user_cockpit') || '{}');
        expect(stored?.convective?.enabled).toBe(true);
    });

    it('turning it off deactivates the engine', () => {
        const { input, setActive } = build();
        input.checked = false;
        input.dispatchEvent(new Event('change'));
        expect(setActive).toHaveBeenCalledWith(false);
        expect(CockpitConfig.get('convective.enabled')).toBe(false);
    });

    it('no code calls the nonexistent CockpitConfig.set', () => {
        expect(typeof CockpitConfig.set).toBe('undefined');
        expect(read('web/cockpit/layer-panel.js')).not.toMatch(/CockpitConfig\.set\(/);
    });
});
