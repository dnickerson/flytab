/**
 * StickyValve namespace: shared-spec loader/validator (web/shared/sticky-valve.js).
 * Mirrors engine_analysis/sticky_valve_spec.py (validate_sticky_valve_spec, build_config).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const { StickyValve } = new Function(read('web/shared/sticky-valve.js') + '\nreturn { StickyValve };')();

const realSpec = () => JSON.parse(read('web/sticky_valve_spec.json'));
const realPhaseSpec = () => JSON.parse(read('web/phase_spec.json'));
const clone = (o) => JSON.parse(JSON.stringify(o));

beforeEach(() => { delete globalThis.CockpitConfig; });

describe('StickyValve.validateSpec', () => {
    it('accepts the real checked-in spec and returns it', () => {
        const spec = realSpec();
        expect(StickyValve.validateSpec(spec)).toBe(spec);
    });

    it('rejects a spec missing version or sources', () => {
        const a = realSpec(); delete a.version;
        expect(() => StickyValve.validateSpec(a)).toThrow(/version/);
        const b = realSpec(); delete b.sources;
        expect(() => StickyValve.validateSpec(b)).toThrow(/sources/);
    });

    it('rejects a numeric leaf with no source', () => {
        const spec = realSpec();
        delete spec.sources['run.start_rpm'];
        expect(() => StickyValve.validateSpec(spec)).toThrow(/no source.*run\.start_rpm/);
    });

    it('rejects a sources key that is not in the spec', () => {
        const spec = realSpec();
        spec.sources['run.bogus'] = 'placeholder';
        expect(() => StickyValve.validateSpec(spec)).toThrow(/not in spec.*run\.bogus/);
    });

    it('rejects an unknown source value', () => {
        const spec = realSpec();
        spec.sources['run.start_rpm'] = 'vibes';
        expect(() => StickyValve.validateSpec(spec)).toThrow(/unknown source/);
    });

    it('rejects a non-numeric leaf', () => {
        const spec = realSpec();
        spec.run.start_rpm = '500';
        expect(() => StickyValve.validateSpec(spec)).toThrow(/run\.start_rpm must be numeric/);
    });

    it('rejects a boolean leaf (true is not a threshold)', () => {
        const spec = realSpec();
        spec.run.start_rpm = true;
        expect(() => StickyValve.validateSpec(spec)).toThrow(/run\.start_rpm must be numeric/);
    });

    it('rejects NaN / non-finite numeric leaves', () => {
        const spec = realSpec();
        spec.run.start_rpm = NaN;
        expect(() => StickyValve.validateSpec(spec)).toThrow(/must be numeric/);
    });

    it('rejects a section that is not an object', () => {
        const spec = realSpec();
        spec.run = 5;
        expect(() => StickyValve.validateSpec(spec)).toThrow(/section 'run' must be an object/);
        const arr = realSpec();
        arr.run = [1, 2];
        expect(() => StickyValve.validateSpec(arr)).toThrow(/section 'run' must be an object/);
    });

    it('does not treat version or sources as threshold leaves', () => {
        // version is numeric and sources is an object of strings; neither needs a source entry
        const spec = realSpec();
        expect(() => StickyValve.validateSpec(spec)).not.toThrow();
        expect(Object.keys(spec.sources).some(k => k.startsWith('version') || k.startsWith('sources'))).toBe(false);
    });

    it('rejects a null / non-object spec', () => {
        expect(() => StickyValve.validateSpec(null)).toThrow();
        expect(() => StickyValve.validateSpec([])).toThrow();
    });
});

describe('StickyValve.buildConfig', () => {
    it('copies every threshold section and adds the shared phase thresholds', () => {
        const spec = realSpec();
        const cfg = StickyValve.buildConfig(spec, realPhaseSpec());
        expect(cfg.phase).toEqual({ runup_rpm: 1600, takeoff_rpm: 2400, takeoff_mp: 25 });
        expect(cfg.cold_cylinder).toEqual({ egt_ratio: 0.5, min_egt: 200, persist_sec: 30 });
        expect(cfg.run.start_rpm).toBe(500);
        expect(cfg.verdict.fallback_min).toBe(10);
        expect('version' in cfg).toBe(false);
        expect('sources' in cfg).toBe(false);
    });

    it('does not alias the spec sections (mutating cfg leaves the spec alone)', () => {
        const spec = realSpec();
        const cfg = StickyValve.buildConfig(spec, realPhaseSpec());
        cfg.run.start_rpm = 999;
        expect(spec.run.start_rpm).toBe(500);
    });
});

describe('StickyValve.applyCockpitOverrides', () => {
    const baseCfg = () => StickyValve.buildConfig(realSpec(), realPhaseSpec());
    const withEnginePage = (ep) => {
        globalThis.CockpitConfig = { get: (p) => (p === 'enginePage' ? ep : undefined) };
    };

    it('with no CockpitConfig, leaves the spec values', () => {
        const cfg = StickyValve.applyCockpitOverrides(baseCfg());
        expect(cfg.cold_cylinder.egt_ratio).toBe(0.5);
        expect(cfg.verdict.fallback_min).toBe(10);
    });

    it('reads enginePage.stickyValveThresholdPct / stickyValveWindowMinutes', () => {
        withEnginePage({ stickyValveThresholdPct: 40, stickyValveWindowMinutes: 15 });
        const cfg = StickyValve.applyCockpitOverrides(baseCfg());
        expect(cfg.cold_cylinder.egt_ratio).toBe(0.4);
        expect(cfg.verdict.fallback_min).toBe(15);
    });

    it('the shipped cockpit-config.json keeps the spec values', () => {
        withEnginePage(JSON.parse(read('web/cockpit-config.json')).enginePage);
        const cfg = StickyValve.applyCockpitOverrides(baseCfg());
        expect(cfg.cold_cylinder.egt_ratio).toBe(0.5);
        expect(cfg.verdict.fallback_min).toBe(10);
    });

    it('ignores invalid values (pct outside 0-100 exclusive, non-positive or non-numeric minutes)', () => {
        for (const ep of [
            { stickyValveThresholdPct: 0, stickyValveWindowMinutes: 0 },
            { stickyValveThresholdPct: 100, stickyValveWindowMinutes: -5 },
            { stickyValveThresholdPct: 150, stickyValveWindowMinutes: 'abc' },
            { stickyValveThresholdPct: 'x' },
            {},
        ]) {
            withEnginePage(ep);
            const cfg = StickyValve.applyCockpitOverrides(baseCfg());
            expect(cfg.cold_cylinder.egt_ratio).toBe(0.5);
            expect(cfg.verdict.fallback_min).toBe(10);
        }
    });

    it('survives CockpitConfig.get throwing', () => {
        globalThis.CockpitConfig = { get: () => { throw new Error('boom'); } };
        const cfg = StickyValve.applyCockpitOverrides(baseCfg());
        expect(cfg.cold_cylinder.egt_ratio).toBe(0.5);
    });

    it('does not mutate the cfg it is given', () => {
        withEnginePage({ stickyValveThresholdPct: 40, stickyValveWindowMinutes: 15 });
        const base = baseCfg();
        const out = StickyValve.applyCockpitOverrides(base);
        expect(out).not.toBe(base);
        expect(base.cold_cylinder.egt_ratio).toBe(0.5);
        expect(base.verdict.fallback_min).toBe(10);
    });
});

describe('StickyValve.loadSpec', () => {
    const okRes = (body) => ({ ok: true, status: 200, json: async () => clone(body) });
    const stubFetch = (map) => async (url) => {
        if (!(url in map)) throw new Error(`unexpected fetch ${url}`);
        return map[url];
    };

    it('fetches both specs, validates, builds and applies overrides', async () => {
        globalThis.CockpitConfig = { get: (p) => (p === 'enginePage' ? { stickyValveThresholdPct: 40 } : undefined) };
        const cfg = await StickyValve.loadSpec(stubFetch({
            'sticky_valve_spec.json': okRes(realSpec()),
            'phase_spec.json': okRes(realPhaseSpec()),
        }));
        expect(cfg.phase).toEqual({ runup_rpm: 1600, takeoff_rpm: 2400, takeoff_mp: 25 });
        expect(cfg.cold_cylinder.egt_ratio).toBe(0.4);
        expect(cfg.verdict.fallback_min).toBe(10);
    });

    it('rejects with the HTTP status when the sticky valve spec 404s', async () => {
        await expect(StickyValve.loadSpec(stubFetch({
            'sticky_valve_spec.json': { ok: false, status: 404, json: async () => ({}) },
            'phase_spec.json': okRes(realPhaseSpec()),
        }))).rejects.toThrow(/sticky_valve_spec\.json.*HTTP 404/);
    });

    it('rejects with the HTTP status when phase_spec.json 404s', async () => {
        await expect(StickyValve.loadSpec(stubFetch({
            'sticky_valve_spec.json': okRes(realSpec()),
            'phase_spec.json': { ok: false, status: 404, json: async () => ({}) },
        }))).rejects.toThrow(/phase_spec\.json.*HTTP 404/);
    });

    it('rejects an invalid sticky valve spec', async () => {
        const bad = realSpec();
        delete bad.sources['run.start_rpm'];
        await expect(StickyValve.loadSpec(stubFetch({
            'sticky_valve_spec.json': okRes(bad),
            'phase_spec.json': okRes(realPhaseSpec()),
        }))).rejects.toThrow(/no source/);
    });

    it('rejects a phase spec missing the shared thresholds', async () => {
        const ps = realPhaseSpec();
        delete ps.thresholds.rpm_runup_min;
        await expect(StickyValve.loadSpec(stubFetch({
            'sticky_valve_spec.json': okRes(realSpec()),
            'phase_spec.json': okRes(ps),
        }))).rejects.toThrow(/rpm_runup_min/);
    });

    it('requires a fetch implementation when none is injected and no global fetch', async () => {
        const saved = globalThis.fetch;
        delete globalThis.fetch;
        try {
            await expect(StickyValve.loadSpec()).rejects.toThrow(/fetch/);
        } finally {
            if (saved) globalThis.fetch = saved;
        }
    });

    it('DEFAULTS and config() are gone', () => {
        expect(StickyValve.DEFAULTS).toBeUndefined();
        expect(StickyValve.config).toBeUndefined();
    });
});
