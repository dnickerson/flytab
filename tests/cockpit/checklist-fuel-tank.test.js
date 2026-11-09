/**
 * Before Start "FlyTab Tank" item (Dana, 2026-11-09, tablet testing): "My checklist
 * must have a checklist item for setting the correct tank. If I don't do this the
 * tank burn will be off. Add a checklist item with a link to set the tank burn."
 *
 * - web/checklist.json: the item follows "Fuel Selector" in Before Start.
 * - `"link": "fuel-tank"`: the item shows FlyTab's active tank live ("FlyTab: LEFT"),
 *   updated on fueltankstate:changed, and a SET button that goes to the map and
 *   reveals the fuel tanks widget, whose L / R badges set the tank
 *   (FuelTankState.switchTank). SET never checks or unchecks the item.
 * - Checked state is keyed by item index (flypi_checklist_state); the item is
 *   appended at the end of Before Start, so no saved check moves to another item.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const tapUtils = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireIsolatedTap };')();
global.wireIsolatedTap = tapUtils.wireIsolatedTap;
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
const Checklist = new Function(read('web/cockpit/checklist.js') + '\nreturn Checklist;')();

const REAL = JSON.parse(read('web/checklist.json'));
const beforeStart = () => REAL.groups.find(g => g.type === 'normal')
    .sections[0].checklists.find(c => c.name === 'Before Start');

let cl;
async function build(data = REAL) {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) }));
    cl = new Checklist(document.body);
    await vi.waitFor(() => expect(cl._bodyEl.querySelector('.checklist-item')).not.toBeNull());
}
const tankItem = () => {
    const idx = beforeStart().items.findIndex(i => i.link === 'fuel-tank');
    return cl._bodyEl.querySelector(`.checklist-item[data-idx="${idx}"]`);
};
const live = () => tankItem().querySelector('[data-link-status="fuel-tank"]');
const setBtn = () => tankItem().querySelector('.checklist-link-btn[data-link="fuel-tank"]');

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    globalThis.CockpitConfig = { aircraft: (p) => (p === 'performance.fuel_capacity_gal' ? 36 : undefined) };
    window.app = {
        tabBar: { selectTab: vi.fn() },
        fuelTanksDisplay: { revealTankControl: vi.fn() },
    };
});
afterEach(() => { cl?.hide(); delete global.fetch; delete window.app; vi.useRealTimers(); });
// wireIsolatedTap ignores a click within 600 ms of any touch (shared/tap-utils.js);
// move the clock past a touch made by an earlier test.
const pastLastTouch = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 5000); };

describe('checklist.json', () => {
    it('FlyTab Tank follows Fuel Selector in Before Start, with link fuel-tank and a note', () => {
        const items = beforeStart().items;
        const sel = items.findIndex(i => i.title === 'Fuel Selector');
        expect(sel).toBeGreaterThan(-1);
        const item = items[sel + 1];
        expect(item.title).toBe('FlyTab Tank');
        expect(item.response).toBe('MATCHES SELECTOR');
        expect(item.link).toBe('fuel-tank');
        expect(item.note).toMatch(/burn/i);
        // Re-review I1: tapping the badge that already matches confirms; otherwise the other tank.
        expect(item.note).toMatch(/already matches.*tap it to confirm/i);
        expect(item.note).toMatch(/otherwise tap the other tank/i);
    });

    it('is appended last, so saved checks (keyed by index) keep their items', () => {
        const items = beforeStart().items;
        expect(items[items.length - 1].link).toBe('fuel-tank');
        expect(items[items.length - 2].title).toBe('Fuel Selector');
    });
});

describe('FlyTab Tank item', () => {
    it('shows the active tank live', async () => {
        FuelTankState.init(18, 18, 'L');
        await build();
        expect(live().textContent).toBe('FlyTab: LEFT');
        expect(tankItem().querySelector('.checklist-item-response').textContent).toBe('MATCHES SELECTOR');
    });

    it('no tank state yet: FlyTab: NOT SET', async () => {
        await build();
        expect(live().textContent).toBe('FlyTab: NOT SET');
    });

    it('updates on fueltankstate:changed (switchTank fires it)', async () => {
        FuelTankState.init(18, 18, 'L');
        await build();
        FuelTankState.switchTank('R');
        expect(live().textContent).toBe('FlyTab: RIGHT');
    });

    it('SET (tap) goes to the map and reveals the tank control; the item is not checked', async () => {
        FuelTankState.init(18, 18, 'L');
        await build();
        const btn = setBtn();
        expect(btn.textContent).toBe('SET');
        const t = (type) => {
            const e = new Event(type, { bubbles: true, cancelable: true });
            const pt = [{ clientX: 10, clientY: 10 }];
            e.touches = type === 'touchend' ? [] : pt; e.changedTouches = pt;
            return e;
        };
        btn.dispatchEvent(t('touchstart'));
        btn.dispatchEvent(t('touchend'));
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(window.app.tabBar.selectTab).toHaveBeenCalledTimes(1);
        expect(window.app.tabBar.selectTab).toHaveBeenCalledWith('map');
        expect(window.app.fuelTanksDisplay.revealTankControl).toHaveBeenCalledTimes(1);
        expect(tankItem().classList.contains('checked')).toBe(false);
        expect(Object.values(cl._checked).some(Boolean)).toBe(false);
    });

    it('SET (mouse click) also works and does not check the item', async () => {
        await build();
        pastLastTouch();
        setBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(window.app.fuelTanksDisplay.revealTankControl).toHaveBeenCalledTimes(1);
        expect(Object.values(cl._checked).some(Boolean)).toBe(false);
    });

    it('without a tab bar, SET still closes the checklist', async () => {
        delete window.app.tabBar;
        await build();
        pastLastTouch();
        cl.show();
        setBtn().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(cl._visible).toBe(false);
        expect(window.app.fuelTanksDisplay.revealTankControl).toHaveBeenCalledTimes(1);
    });

    it('a tap on the row (not SET) still checks the item', async () => {
        await build();
        tankItem().querySelector('.checklist-item-main')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(tankItem().classList.contains('checked')).toBe(true);
    });

    it('SET button is a 56 px+ touch target from the design tokens', () => {
        const css = read('web/style.css');
        const m = css.match(/\n\.checklist-link-btn\s*\{([^}]*)\}/);
        expect(m).not.toBeNull();
        expect(m[1]).toMatch(/min-height:\s*var\(--touch-min,\s*56px\)/);
        expect(m[1]).not.toMatch(/#[0-9a-f]{3,6}/i);
    });
});
