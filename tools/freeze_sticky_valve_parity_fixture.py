#!/usr/bin/env python3
"""Freeze the sticky-valve golden-parity fixtures.

Runs the Python reference detector (~/engine_analysis/sticky_valve.py) over six
sample streams and writes, per stream, a normalized samples CSV plus the full
event list as JSON, for tests/sticky-valve-parity/golden-parity.test.js (the
JS port in web/shared/sticky-valve.js must reproduce the events exactly).

Re-run (and re-commit the output) whenever sticky_valve.py, sticky_valve_spec.json
or phase_spec.json changes in ~/engine_analysis:

    python3 tools/freeze_sticky_valve_parity_fixture.py

The CORE detector is run directly (samples_from_df -> StickyValveDetector.sample
-> finish), never analyze_flight(): that adds the offline-only low_climb_gs
context note, which the JS detector deliberately does not produce.
"""
import dataclasses
import hashlib
import json
import math
import re
import sys
from pathlib import Path

ENGINE = Path.home() / 'engine_analysis'
sys.path.insert(0, str(ENGINE))
import pandas as pd
from phase_spec import load_phase_spec
from sticky_valve import Sample, StickyValveDetector, samples_from_df
from sticky_valve_spec import build_config, load_sticky_valve_spec

OUT_DIR = Path(__file__).parent.parent / 'tests/sticky-valve-parity/fixtures'
SPEC_PATH = ENGINE / 'sticky_valve_spec.json'
PHASE_SPEC_PATH = ENGINE / 'phase_spec.json'

REAL = {
    '20261101_KLKR-KLKR': ENGINE / '20261101_KLKR-KLKR.csv',
    '2025-07-02_KLKR-KLKR': ENGINE / 'Parsed_Engine_Data/2025-07-02_KLKR - KLKR_merged.csv',
    'cold_flight': ENGINE / 'tests/fixtures/sticky_valve_cold_flight.csv',
}

COLUMNS = ['t', 'rpm', 'mp', 'ff', 'egt1', 'egt2', 'egt3', 'egt4',
           'cht1', 'cht2', 'cht3', 'cht4', 'carb', 'gs']

SPEC = load_sticky_valve_spec()
PHASE_SPEC = load_phase_spec()
CFG = build_config(SPEC, PHASE_SPEC)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def camel(key):
    return re.sub(r'_([a-z0-9])', lambda m: m.group(1).upper(), key)


def camelize(x):
    """R-10: convert every dict KEY at any depth to camelCase; values unchanged."""
    if isinstance(x, dict):
        return {camel(k): camelize(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [camelize(v) for v in x]
    return x


def run_detector(samples):
    det = StickyValveDetector(CFG, days_since_flight=None)
    events = []
    for s in samples:
        events.extend(det.sample(s))
    events.extend(det.finish(samples[-1].t))
    return events


def fmt(v):
    return '' if math.isnan(v) else repr(float(v))


def samples_csv(samples):
    lines = [','.join(COLUMNS)]
    for s in samples:
        row = [s.t, s.rpm, s.mp, s.ff, *s.egt, *s.cht, s.carb, s.gs]
        lines.append(','.join(fmt(v) for v in row))
    return '\n'.join(lines) + '\n'


def is_takeoff(s):
    return s.rpm >= CFG['phase']['takeoff_rpm'] and s.mp >= CFG['phase']['takeoff_mp']


# ---- synthetic derivations (all from the committed cold-flight fixture) -------

def make_stuck_cyl3(base):
    """EGT 3 x 0.4 for rows 0..300 of the de-duplicated samples."""
    out = []
    for i, s in enumerate(base):
        if i <= 300:
            e = list(s.egt)
            e[2] = e[2] * 0.4
            s = dataclasses.replace(s, egt=tuple(e))
        out.append(s)
    return out


def make_cht_lag_cyl4(base):
    """CHT4(t) = CHT4(t0) + 0.3 * (CHT4(t) - CHT4(t0)); t0 = first sample."""
    c0 = base[0].cht[3]
    out = []
    for s in base:
        c = list(s.cht)
        c[3] = c0 + 0.3 * (c[3] - c0)
        out.append(dataclasses.replace(s, cht=tuple(c)))
    return out


def first_airborne_mp_drop(base):
    """Index of the first sample, after the first takeoff-power sample, whose MP
    is <= max(MP of earlier samples within divergence.mp_drop_window_sec) -
    divergence.mp_drop_inhg, or None."""
    drop = CFG['divergence']['mp_drop_inhg']
    win = CFG['divergence']['mp_drop_window_sec']
    takeoff = next((i for i, s in enumerate(base) if is_takeoff(s)), None)
    if takeoff is None:
        return None, None
    for i in range(takeoff + 1, len(base)):
        s = base[i]
        if math.isnan(s.mp):
            continue
        prev = [p.mp for p in base[:i]
                if s.t - win <= p.t < s.t and not math.isnan(p.mp)]
        if prev and s.mp <= max(prev) - drop:
            return takeoff, i
    return takeoff, None


def make_inflight_divergence(base):
    """After the first airborne MP drop >= divergence.mp_drop_inhg: EGT 1 -250 F
    and EGT 2 +100 F, ramped in over 20 s. If the base flight has no natural
    drop, inject an MP drop of mp_drop_inhg + 1 over 5 s starting 120 s after
    the first takeoff-power sample (the reduction then stays). Returns
    (samples, note)."""
    drop = CFG['divergence']['mp_drop_inhg']
    takeoff, idx = first_airborne_mp_drop(base)
    if takeoff is None:
        raise SystemExit('cold_flight has no takeoff-power sample; cannot build inflight_divergence')
    samples = list(base)
    if idx is not None:
        t_drop = base[idx].t
        note = f'natural airborne MP drop at t={t_drop} (sample {idx})'
    else:
        t_drop = base[takeoff].t + 120.0
        amount = drop + 1.0
        samples = []
        for s in base:
            if s.t >= t_drop and not math.isnan(s.mp):
                s = dataclasses.replace(s, mp=s.mp - amount * min(1.0, (s.t - t_drop) / 5.0))
            samples.append(s)
        note = (f'no natural airborne MP drop; injected {amount} inHg over 5 s '
                f'starting at t={t_drop} (120 s after first takeoff power)')
    out = []
    for s in samples:
        if s.t >= t_drop:
            f = min(1.0, (s.t - t_drop) / 20.0)
            e = list(s.egt)
            e[0] = e[0] - 250.0 * f
            e[1] = e[1] + 100.0 * f
            s = dataclasses.replace(s, egt=tuple(e))
        out.append(s)
    return out, note


# ---- synthetic derivations that exercise the hand-ported edge branches ---------
# (missing values, data holes, backwards clock, no GPS, hot start, rule 4)

NAN = float('nan')


def _set(samples, idx, **kw):
    out = list(samples)
    out[idx] = dataclasses.replace(out[idx], **kw)
    return out


def make_nan_dropouts(base):
    """Dropouts in every field the detector gates on isfinite:
    EGT2 NaN for one sample inside the R2 (slow_heatup) window; all four CHT NaN
    for 3 samples inside the R3 (cht_lag) window; MP NaN at the first
    takeoff-power sample (NaN MP is never takeoff power); one RPM NaN row
    mid-idle; EGT1 = 0.0 on one sample (0 is a reading, not missing)."""
    out = list(base)
    r2_w = CFG['slow_heatup']['window_sec']
    r3_w = CFG['cht_lag']['window_sec']
    t0 = base[0].t
    i_egt = next(i for i, s in enumerate(base) if s.t >= t0 + r2_w / 4)
    assert base[i_egt].t < t0 + r2_w
    i_cht = next(i for i, s in enumerate(base) if s.t >= t0 + r2_w + 10)   # past R2's window, inside R3's
    assert base[i_cht + 2].t < t0 + r3_w
    i_rpm = next(i for i, s in enumerate(base) if s.t >= t0 + r3_w + 10)
    assert base[i_rpm].rpm < CFG['phase']['runup_rpm'] and not is_takeoff(base[i_rpm])
    i_zero = next(i for i, s in enumerate(base) if s.t >= t0 + 20)
    i_takeoff = next(i for i, s in enumerate(base) if is_takeoff(s))
    e = list(out[i_egt].egt)
    e[1] = NAN
    out = _set(out, i_egt, egt=tuple(e))
    for k in range(i_cht, i_cht + 3):
        out = _set(out, k, cht=(NAN, NAN, NAN, NAN))
    out = _set(out, i_rpm, rpm=NAN)
    z = list(out[i_zero].egt)
    z[0] = 0.0
    out = _set(out, i_zero, egt=tuple(z))
    out = _set(out, i_takeoff, mp=NAN)
    return out


def _shift_from(samples, idx, delta):
    return [dataclasses.replace(s, t=s.t + delta) if i >= idx else s for i, s in enumerate(samples)]


def make_holes_and_clock(base):
    """A hole of 10 s (gap_sec < 10 < stop_sec) inside the idle period; later a
    hole of stop_sec + 20 s mid-run (run 1 ends with reason 'gap', run 2 starts);
    then one backwards clock step of 3 s in run 2 (ends it with reason 'gap',
    run 3 starts)."""
    gap, stop = CFG['run']['gap_sec'], CFG['run']['stop_sec']
    assert gap < 10 < stop
    i1 = next(i for i, s in enumerate(base) if s.t >= base[0].t + 80)
    i2 = next(i for i, s in enumerate(base) if is_takeoff(s)) - 30
    i3 = next(i for i, s in enumerate(base) if is_takeoff(s)) + 40
    dt = lambda i: base[i].t - base[i - 1].t
    out = _shift_from(base, i1, 10.0 - dt(i1))                         # dt becomes 10 s
    out = _shift_from(out, i2, (stop + 20.0) - (out[i2].t - out[i2 - 1].t))   # dt becomes stop+20
    out = _shift_from(out, i3, -3.0 - (out[i3].t - out[i3 - 1].t))     # dt becomes -3
    return out


def make_no_gps(base):
    """Every ground speed NaN: the verdict trigger must come from RPM / fallback."""
    return [dataclasses.replace(s, gs=NAN) for s in base]


def make_hot_start(base):
    """Every CHT offset so the settle-time mean CHT is cold_cht_max_f + 50."""
    cs = [v for v in base[0].cht if not math.isnan(v)]
    off = CFG['verdict']['cold_cht_max_f'] + 50.0 - sum(cs) / len(cs)
    return [dataclasses.replace(s, cht=tuple(c + off for c in s.cht)) for s in base]


def make_rough_idle(base):
    """Idle RPM jitter of +-(roughness.rpm_std_max * 1.5), alternating, with MP
    held constant, over a steady-idle stretch longer than a roughness window."""
    r = CFG['roughness']
    amp = r['rpm_std_max'] * 1.5
    t0 = base[0].t
    lo = next(i for i, s in enumerate(base) if s.t >= t0 + 180)
    hi = next(i for i, s in enumerate(base) if s.t >= base[lo].t + r['window_sec'] * 2.5)
    runup = CFG['phase']['runup_rpm']
    assert all(CFG['run']['stop_rpm'] <= s.rpm and s.rpm + amp < runup for s in base[lo:hi]), \
        'rough_idle: stretch is not steady idle'
    mp = base[lo].mp
    out = list(base)
    for k in range(lo, hi):
        out[k] = dataclasses.replace(out[k], mp=mp, rpm=base[k].rpm + (amp if (k - lo) % 2 == 0 else -amp))
    return out


# ---- expected-content assertions -----------------------------------------------

def findings(events):
    return [e for e in events if e['type'] == 'finding']


def no_go(events):
    return [f for f in findings(events) if f['level'] == 'NO-GO']


def first_run_end(events):
    return next(e for e in events if e['type'] == 'run_end')


def check(name, events):
    if name == 'stuck_cyl3':
        assert any(f['cyl'] == 3 for f in no_go(events)), 'stuck_cyl3: no NO-GO finding on cyl 3'
    elif name == 'cht_lag_cyl4':
        assert any(f['rule'] == 'cht_lag' and f['cyl'] == 4 for f in findings(events)), \
            'cht_lag_cyl4: no cht_lag finding on cyl 4'
    elif name == 'inflight_divergence':
        assert any(e['type'] == 'inflight' for e in events), 'inflight_divergence: no inflight event'
    elif name == 'nan_dropouts':
        res = first_run_end(events)['result']
        assert 'slow_heatup' in res['rules_not_run'] and 'cht_lag' in res['rules_not_run'], \
            f"nan_dropouts: rules_not_run = {res['rules_not_run']}"
    elif name == 'holes_and_clock':
        assert any(e['type'] == 'run_end' and e['reason'] == 'gap' for e in events), \
            'holes_and_clock: no run_end with reason gap'
        assert sum(e['type'] == 'run_start' for e in events) >= 2, 'holes_and_clock: < 2 run_start'
    elif name == 'no_gps':
        assert any(e['type'] == 'verdict' for e in events), 'no_gps: no verdict event'
    elif name == 'hot_start':
        res = first_run_end(events)['result']
        assert res['cold_settle'] is False, f"hot_start: cold_settle = {res['cold_settle']}"
        assert res['verdict'] != 'VALVES OK', 'hot_start: verdict is VALVES OK'
    elif name == 'rough_idle':
        assert any(f['rule'] == 'roughness' for f in findings(events)), 'rough_idle: no roughness finding'
    else:
        assert not no_go(events), f'{name}: unexpected NO-GO finding {no_go(events)}'


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    streams = {}
    for name, path in REAL.items():
        streams[name] = samples_from_df(pd.read_csv(path, low_memory=False))
    base = streams['cold_flight']
    streams['stuck_cyl3'] = make_stuck_cyl3(base)
    streams['cht_lag_cyl4'] = make_cht_lag_cyl4(base)
    streams['inflight_divergence'], inflight_note = make_inflight_divergence(base)
    streams['nan_dropouts'] = make_nan_dropouts(base)
    streams['holes_and_clock'] = make_holes_and_clock(base)
    streams['no_gps'] = make_no_gps(base)
    streams['hot_start'] = make_hot_start(base)
    streams['rough_idle'] = make_rough_idle(base)

    spec_sha, phase_sha = sha256(SPEC_PATH), sha256(PHASE_SPEC_PATH)
    for name, samples in streams.items():
        assert samples, f'{name}: no samples'
        events = run_detector(samples)
        check(name, events)
        payload = {'spec_sha256': spec_sha, 'phase_spec_sha256': phase_sha,
                   'events': camelize(events)}
        (OUT_DIR / f'{name}.csv').write_text(samples_csv(samples))
        # allow_nan=False: a NaN/inf anywhere in an event must fail loudly
        (OUT_DIR / f'{name}.json').write_text(json.dumps(payload, indent=1, allow_nan=False) + '\n')
        kinds = {}
        for e in events:
            kinds[e['type']] = kinds.get(e['type'], 0) + 1
        print(f'{name}: {len(samples)} samples, {len(events)} events {kinds}')
    print(f'inflight_divergence: {inflight_note}')
    print(f'Wrote {len(streams)} CSV + {len(streams)} JSON to {OUT_DIR}')


if __name__ == '__main__':
    main()
