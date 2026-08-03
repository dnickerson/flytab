/**
 * Engine Page — Pi contract mismatch banner (#113)
 *
 * FlyTab and the Pi engine monitor share a data contract with no version
 * check; a mismatch used to be silent — the app runs, shows numbers, and the
 * numbers can be wrong. This covers the ENG-page half of the fix: a banner
 * naming both versions when the connected Pi reports a contract older than
 * this build requires, gated on a LIVE connection (not a stale cached
 * reading) so it agrees with the status-bar badge (app.js) at all times.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME, ENGINE_FRAME_NO_CONTRACT, ENGINE_FRAME_OLD_CONTRACT } = require('../fixtures/engine-messages.js');

// EnginePage.update() expects the already-flattened shape EnginePanel produces
// (raw.data promoted to top level) — it does not flatten itself. Match the
// real call path rather than passing the raw nested fixtures directly.
const flatten = (frame) => (frame.data ? { ...frame, ...frame.data } : frame);
const FRAME = flatten(ENGINE_FRAME);
const FRAME_NO_CONTRACT = flatten(ENGINE_FRAME_NO_CONTRACT);
const FRAME_OLD_CONTRACT = flatten(ENGINE_FRAME_OLD_CONTRACT);

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

// engine-page.js references the bare identifier EngineClient.MIN_PI_CONTRACT —
// only the static constant is needed here, not the full WebSocket client.
globalThis.EngineClient = { MIN_PI_CONTRACT: 2 };

let page = null;

function setup({ enginePanelConnected = true } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = true; // nothing tracked — irrelevant to these tests

    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null };
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? 36 : undefined),
    };
    window.enginePanel = { connected: enginePanelConnected };

    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();
    return page;
}

function banner() {
    const el = page._dom.contractBanner;
    return {
        shown: el.style.display !== 'none',
        text: page._dom.contractBanner.textContent.replace(/\s+/g, ' ').trim(),
        required: page._dom.contractRequired.textContent,
        piVersion: page._dom.contractPiVersion.textContent,
        piContract: page._dom.contractPiContract.textContent,
    };
}

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
    page = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete window.enginePanel;
});

describe('EnginePage — Pi contract banner', () => {
    it('stays hidden when the connected Pi reports the current contract', () => {
        setup();
        page.update(ENGINE_FRAME);
        expect(banner().shown).toBe(false);
    });

    it('shows, naming both versions, when the Pi reports an old contract number', () => {
        setup();
        page.update(FRAME_OLD_CONTRACT);
        const b = banner();
        expect(b.shown).toBe(true);
        expect(b.required).toBe('2');
        expect(b.piContract).toBe('1');
        expect(b.piVersion).toBe('3.4.0');
        expect(b.text).toContain('deploy-pi.sh');
    });

    it('treats a completely missing api_contract field as contract 0 — warned, not silently accepted', () => {
        setup();
        page.update(FRAME_NO_CONTRACT);
        const b = banner();
        expect(b.shown).toBe(true);
        expect(b.piContract).toBe('0');
    });

    it('does not warn when the Pi reports a contract NEWER than required — it may legitimately be ahead', () => {
        setup();
        page.update({ ...ENGINE_FRAME, api_contract: 99 });
        expect(banner().shown).toBe(false);
    });

    it('never shows while genuinely disconnected, even with a stale old-contract reading cached', () => {
        // EnginePanel-style behavior: lastData is never nulled on disconnect. The
        // banner must not piggyback on stale data while offline — that's the
        // separate "ENGINE MON. OFFLINE" indicator's job, not this banner's.
        setup({ enginePanelConnected: false });
        page.update(FRAME_NO_CONTRACT);
        expect(banner().shown).toBe(false);
    });

    it('engine data keeps rendering normally alongside the banner — a mismatch never blocks the page', () => {
        setup();
        page.update(FRAME_OLD_CONTRACT);
        expect(banner().shown).toBe(true);
        // 2200 is ENGINE_FRAME's fixture RPM (tests/fixtures/engine-messages.js) —
        // proves the rest of the page keeps rendering real data, not blanking or
        // blocking, alongside the contract-mismatch banner.
        expect(page._el.querySelector('#ep-rpm').textContent).toBe('2200');
    });

    it('clears the banner on the next update once the contract is current again', () => {
        setup();
        page.update(FRAME_OLD_CONTRACT);
        expect(banner().shown).toBe(true);
        page.update(ENGINE_FRAME);
        expect(banner().shown).toBe(false);
    });
});
