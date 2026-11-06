# Sticky-valve golden-parity fixtures

Each fixture is a pair: `<name>.csv` (the exact samples the Python reference was
fed: `t,rpm,mp,ff,egt1..egt4,cht1..cht4,carb,gs`, NaN as an empty cell, floats at
full `repr()` precision) and `<name>.json` (`spec_sha256`, `phase_spec_sha256`,
`detector_sha256` -- the sha256 of `~/engine_analysis/sticky_valve.py` -- and the
full Python event list with every key camelCased). The JS test feeds the
CSV to `StickyValveDetector` and demands the same events. The core detector is
frozen (`samples_from_df` -> `sample()` -> `finish()`), not `analyze_flight`,
which adds the offline-only `low_climb_gs` note.

| Fixture | What it is |
|---|---|
| `20261101_KLKR-KLKR` | Real FlyTab flight (`~/engine_analysis/20261101_KLKR-KLKR.csv`), ground-only run |
| `2025-07-02_KLKR-KLKR` | Real legacy merged flight (`Parsed_Engine_Data/2025-07-02_KLKR - KLKR_merged.csv`); next-lowest cold-cylinder margin after 20261101 |
| `cold_flight` | The committed cold-flight fixture `~/engine_analysis/tests/fixtures/sticky_valve_cold_flight.csv`, which has a real takeoff |
| `stuck_cyl3` | `cold_flight` with EGT 3 x 0.4 for rows 0-300 (de-duplicated samples); expects a NO-GO finding on cylinder 3 |
| `cht_lag_cyl4` | `cold_flight` with `CHT4(t) = CHT4(t0) + 0.3 * (CHT4(t) - CHT4(t0))`; expects a `cht_lag` finding on cylinder 4 |
| `inflight_divergence` | `cold_flight` with an airborne MP drop and EGT 1 -250 F / EGT 2 +100 F ramped over 20 s; expects an `inflight` event |
| `nan_dropouts` | `cold_flight` with EGT 2 NaN for one sample in the slow_heatup window, all four CHT NaN for 3 samples in the cht_lag window, MP NaN at the first takeoff-power sample, one RPM NaN row mid-idle, and EGT 1 = 0.0 on one sample (0 is a reading). NaN is an empty CSV cell. Expects `slow_heatup` and `cht_lag` in the first run's `rules_not_run` |
| `holes_and_clock` | `cold_flight` with a 10 s hole (gap_sec < 10 < stop_sec) in idle, a hole of stop_sec + 20 s mid-run (run 1 ends `gap`, run 2 starts) and a 3 s backwards clock step in run 2 (ends it `gap`, run 3 starts). Expects a `run_end` with reason `gap` and >= 2 `run_start` |
| `no_gps` | `cold_flight` with `gs` NaN on every row. Expects a verdict event (trigger by RPM, no GPS) |
| `hot_start` | `cold_flight` with every CHT offset so the settle-time mean CHT is `cold_cht_max_f + 50`. Expects `cold_settle` false and a verdict other than VALVES OK |
| `rough_idle` | `cold_flight` with idle RPM alternating +-(`rpm_std_max` x 1.5) and MP held constant over 75 s of steady idle. Expects a roughness finding (rule 4) |

`inflight_divergence`: `cold_flight` has no natural airborne MP drop of
`divergence.mp_drop_inhg` (3.0 inHg) or more, so the tool injects one of
`mp_drop_inhg + 1` (4.0 inHg) over 5 s starting 120 s after the first
takeoff-power sample (the reduction then stays). The EGT divergence ramps in over
20 s from that same instant.

## Refreeze

```
python3 tools/freeze_sticky_valve_parity_fixture.py
```

Re-run (and re-commit the output) whenever `sticky_valve.py`,
`sticky_valve_spec.json` or `phase_spec.json` changes in `~/engine_analysis`. engine_analysis's
`tests/test_sticky_valve_parity_pin.py` fails until you do: it checks every
fixture's `detector_sha256` and `spec_sha256` against its own files and `cmp`s
`web/sticky_valve_spec.json` with its spec. The
tool asserts the expected content above (and that the three real fixtures have no
NO-GO finding) before writing. If the JS test fails after a refreeze with a
spec-sha message, copy the spec file(s) into `web/` too. A parity mismatch is a
port bug in `web/shared/sticky-valve.js`; never edit a fixture by hand.
