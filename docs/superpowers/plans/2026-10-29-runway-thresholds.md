# Runway Thresholds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every runway end in FlyTab's NASR data carries its real position (physical end and landing threshold), cross-checked against the FAA's CIFP, so approaches put RW## at the threshold and the engine-out glide panel (next plan) has the data it needs.

**Architecture:** The pipeline stops reading runway-end coordinates from the fixed-width `APT.txt` (columns no longer line up in cycle 2611) and reads them from NASR's `APT_RWY_END.csv` (named columns, decimal degrees). The CIFP build additionally extracts its runway records into a server-only `cifp_thresholds.json`; the audit checks the NASR ends against published runway lengths and against CIFP. On the tablet nothing about the import changes (airport records are stored verbatim); `approach-charts.js` reads the new threshold fields.

**Tech Stack:** Python 3.12 (`~/flytab-pipeline`, pytest), vanilla JS (`~/flytab/web`, vitest), IndexedDB (unchanged).

**Spec:** No separate spec. The verified facts are in *Background* below and in memory `reference_runway_end_sources.md` (research of 2026-10-29). The glide panel is NOT in this plan; it gets its own spec once this ships (open question for Dana there: the 200 ft margin).

## Background (verified 2026-10-29, KLKR)

- NASR `CSV_Data/<DD_Mon_YYYY>_CSV.zip` → `APT_RWY_END.csv`: columns `SITE_NO`, `SITE_TYPE_CODE`, `ARPT_ID`, `RWY_ID`, `RWY_END_ID`, `TRUE_ALIGNMENT`, `LAT_DECIMAL`, `LONG_DECIMAL`, `RWY_END_ELEV`, `THR_CROSSING_HGT`, `LAT_DISPLACED_THR_DECIMAL`, `LONG_DISPLACED_THR_DECIMAL`, `DISPLACED_THR_ELEV`, `DISPLACED_THR_LEN`. Empty fields are `""`.
- Join key to `APT.txt` site numbers: APT.txt `"22366.1*A"` = CSV `SITE_NO` `"22366.1"` + `"*"` + `SITE_TYPE_CODE` `"A"`.
- KLKR (April 2026 CSV): RW06 physical end 34.71859708, -80.8631085, displaced 105 ft to 34.71874788, -80.86280972 (elev 459.7), end elev 459.3, TCH 41; RW24 34.72721166, -80.84607163, elev 485.7, TCH 39. Ends 6,004 ft apart at 058.4° true (published 6,004 ft, alignment 059).
- CIFP `FAACIFP18`, runway record lines start `SUSAP <ICAO><rgn>G` (e.g. `SUSAP KLKRK7GRW24`). 0-indexed fields: id `[13:18]`, length ft `[22:27]`, magnetic bearing ×10 `[27:31]`, latitude `[32:41]` (`N34433796` = 34°43'37.96"), longitude `[41:51]`, threshold elevation ft `[66:71]`, displaced threshold ft `[71:75]`, glidepath TCH ft `[75:77]`. The CIFP position is the landing threshold (equals NASR's displaced threshold for RW06 to <1 ft).
- KLKR cycle 2611 CIFP: RW06 34.718747, -80.862811, elev 460, displ 105, TCH 47, brg 066.0; RW24 34.727211, -80.846072, elev 486, displ 0, TCH 43, brg 246.0. Plate RNAV (GPS) RWY 24: WITUR→RW24 = 1.3 + 3.6 NM; computed from CIFP 4.86 NM.
- Today `approach-charts.js:1253` puts RW## at the airport reference point (KLKR RW24 2,999 ft off). `wind-compass.js:576` already uses `base_lat/base_lon/recip_lat/recip_lon` when all four are finite.
- Coverage (April 2026): public-use runway ends with coordinates 12,942 / 14,018 (92%); private 25%; 23,582 / 39,965 overall.

## Global Constraints

- Pipeline branch `feat/runway-thresholds` from `fix/min-doc-single-file` (unmerged EC3TO fix; the server checkout runs it). FlyTab branch `feat/runway-thresholds` from `fix/recorder-logbook-dups` (unmerged v12.26). Both base branches' PRs merge first.
- Bundle runway field names: keep `id, length_ft, width_ft, surface, base_id, base_lat, base_lon, recip_id, recip_lat, recip_lon` (wind-compass reads them); new fields below. A field with no FAA value is **omitted**, never `0` or `null` (0,0 would be a position).
- `BUNDLE_VERSION` 10 → 11 in `build_nasr.py` with a history line; that is what makes the tablet re-import.
- Never burst requests at aeronav.faa.gov; this plan adds no FAA requests (the CIFP and NASR zips are already downloaded by the pipeline).
- Do not rename any `flypi_*` key or the `'flypi'` IndexedDB.
- FlyTab: bump `FLYTAB_VERSION` in `web/app.js` before `bash build.sh`; update `docs/user-manual.md` in the same commit as the user-visible change.
- A check that fails on real FAA data is reported to Dana, never loosened to pass.

## Review Focus

1. **Blank coordinate fields** (`LAT_DECIMAL == ""`) → the key is absent, not `0.0`; the tablet must not draw or route to 0,0. *(Task 1 test `test_blank_coordinates_are_omitted`.)*
2. **Runways with one end or odd ids** (helipad `H1`, `N/S`, `18W/36W`) → base only / ends matched by `RWY_END_ID` string, nothing invented. *(Task 1 test `test_helipad_and_letter_ids`.)*
3. **Site types other than airports** (`*H`, `*S`) join on the full key, so a heliport's pad never lands on an airport with the same `SITE_NO`. *(Task 1 test `test_join_key_includes_site_type`.)*
4. **Tablet still on bundle v10, or an airport without thresholds** → approach loads exactly as today (airport point) and says so in the diagnostic log; no exception. *(Task 5 test `falls back to the airport point when there is no threshold`.)*
5. **CIFP and NASR end ids written differently** (`RW06` vs `06`, `RW6`) → normalised before comparing, so the cross-check does not report false disagreements. *(Task 2 test `test_end_id_normalisation`, Task 3 uses `normalise_end_id`.)*

---

### Task 1: Runway ends from APT_RWY_END.csv (pipeline)

**Files:**
- Modify: `~/flytab-pipeline/build_nasr.py` (`parse_airports` RWY branch ~305-345; history comment + `BUNDLE_VERSION` at ~28-80; new helpers next to `_load_awy_csv_segments` ~848)
- Create: `~/flytab-pipeline/tests/fixtures/apt_rwy_end_sample.csv` (real header from the CSV; real KLKR 06 and 24 rows; one helipad `H1` row with a single end; one row with blank `LAT_DECIMAL`; one heliport row whose `SITE_NO` equals an airport's but `SITE_TYPE_CODE` `H`)
- Test: `~/flytab-pipeline/tests/test_runway_ends.py`

**Interfaces:**
- Produces: `read_nasr_csv(name: str) -> list[dict]` (rows of a CSV inside the nested `CSV_Data/*_CSV.zip`; `_load_awy_csv_segments` switches to it); `load_runway_ends(rows: list[dict]) -> dict[str, dict[str, dict[str, dict]]]` keyed `site_key -> RWY_ID -> RWY_END_ID -> end`; `apply_runway_ends(entry: dict, ends: dict[str, dict]) -> dict`.
- Produces (bundle runway entry, per end prefix `base_` / `recip_`): `_id` (str), `_lat`, `_lon` (physical end, float), `_thr_lat`, `_thr_lon` (landing threshold: displaced if `DISPLACED_THR_LEN` > 0 and its coordinates exist, else the physical end), `_true_hdg` (int), `_elev_ft` (threshold elevation: `DISPLACED_THR_ELEV` when displaced, else `RWY_END_ELEV`; float), `_displ_ft` (int, 0 when none), `_tch_ft` (int). Base = first part of `RWY_ID` split on `/`, recip = second.

- [ ] **Step 1: Write the failing tests** in `tests/test_runway_ends.py`:
  - `test_klkr_ends_from_the_faa_csv`: `apply_runway_ends({"id":"06/24",...}, load_runway_ends(rows)["22366.1*A"]["06/24"])` gives `base_id "06"`, `base_lat 34.71859708`, `base_thr_lat 34.71874788`, `base_thr_lon -80.86280972`, `base_elev_ft 459.7`, `base_displ_ft 105`, `base_tch_ft 41`, `base_true_hdg 59`, `recip_id "24"`, `recip_thr_lat == recip_lat == 34.72721166`, `recip_displ_ft 0`; haversine(base_lat/lon, recip_lat/lon) within 30 ft of 6,004.
  - `test_blank_coordinates_are_omitted`: the blank-`LAT_DECIMAL` row yields no `*_lat`, `*_lon`, `*_thr_*` keys for that end.
  - `test_helipad_and_letter_ids`: `"H1"` → `base_id "H1"` only, no `recip_*` keys.
  - `test_join_key_includes_site_type`: the heliport row is under `"<SITE_NO>*H"`, not `"<SITE_NO>*A"`.
  - `test_no_fixed_width_coordinates`: `parse_airports` source contains no `line[88:103]` / `line[310:325]` slices (the broken reads are gone).
- [ ] **Step 2: Run** `python3 -m pytest tests/test_runway_ends.py -q` → FAIL (`load_runway_ends` not defined).
- [ ] **Step 3: Implement** `read_nasr_csv`, `load_runway_ends`, `apply_runway_ends`; in `parse_airports` keep `id/length_ft/width_ft/surface` from `APT.txt`, drop its coordinate reads, and after the loop call `apply_runway_ends` for each runway with `load_runway_ends(read_nasr_csv("APT_RWY_END.csv"))[site_num][rwy_id]` (missing → entry unchanged). Bump `BUNDLE_VERSION = 11` with history `11 — runway ends from APT_RWY_END.csv (APT.txt columns broken in 2611); *_thr_lat/lon, *_true_hdg, *_elev_ft, *_displ_ft, *_tch_ft`.
- [ ] **Step 4: Run** `python3 -m pytest tests -q` → the new tests PASS and the only failures are the 3 that fail on the base branch (cycle-2610 data pinned against 2611 files, measured 2026-10-29: 254 passed, 3 failed): `test_audit_currency.py::test_printed_volume_dates_are_read_from_real_plates`, `test_min_pages.py::test_real_se3to_ktmb_is_page_22`, `test_min_pages.py::test_rasterize_writes_min_pages_with_each_image_hash`.
- [ ] **Step 5: Commit** `feat(nasr): runway ends from APT_RWY_END.csv (APT.txt columns broken in 2611); bundle v11`.

### Task 2: Runway thresholds from CIFP (pipeline, server-only)

**Files:**
- Modify: `~/flytab-pipeline/build_cifp.py` (new parser next to `parse_cifp_records`; `build_cifp_pipeline` writes the file and its hash ~331-358)
- Create: `~/flytab-pipeline/tests/fixtures/cifp_klkr_runways.txt` (the two real 2611 lines `SUSAP KLKRK7GRW06…`, `SUSAP KLKRK7GRW24…`)
- Test: `~/flytab-pipeline/tests/test_cifp_thresholds.py`

**Interfaces:**
- Produces: `normalise_end_id(s: str) -> str` (`"RW06"`, `"06"`, `"RW6"` → `"06"`; `"RW18L"` → `"18L"`; letters-only ids unchanged); `parse_runway_thresholds(lines: Iterable[str]) -> dict[str, dict[str, dict]]` → `{"KLKR": {"24": {"lat", "lon", "elev_ft", "displ_ft", "tch_ft", "mag_brg", "length_ft"}}}`; file `data/cifp/cifp_thresholds.json` (same shape, not shipped to the tablet); `source.json` gains `thresholds_sha256`.

- [ ] **Step 1: Write the failing tests**: `test_klkr_rw24` (lat 34.727211 ±1e-6, lon -80.846072 ±1e-6, elev_ft 486, displ_ft 0, tch_ft 43, mag_brg 246.0, length_ft 6004); `test_klkr_rw06_is_the_displaced_threshold` (lat 34.718747 ±1e-6, displ_ft 105, tch_ft 47); `test_end_id_normalisation` (cases above); `test_non_runway_lines_ignored` (a `SUSAP KLKRK7FR24…` procedure line and a short line give nothing).
- [ ] **Step 2: Run** `python3 -m pytest tests/test_cifp_thresholds.py -q` → FAIL.
- [ ] **Step 3: Implement** using the field slices in *Background*; reuse `parse_arinc_latlon` for the coordinates. In `build_cifp_pipeline`, read `FAACIFP18` from `CIFP_ZIP` a second time (or in the same pass as `parse_cifp_records`), write `cifp_thresholds.json` atomically (`.tmp` + `os.replace`), and pass `thresholds_sha256=source_evidence.sha256(...)` to `source_evidence.write`.
- [ ] **Step 4: Run** the test file → PASS.
- [ ] **Step 5: Commit** `feat(cifp): runway thresholds from CIFP runway records (server-only cross-check)`.

### Task 3: Audit the runway ends (pipeline)

**Files:**
- Modify: `~/flytab-pipeline/audit_currency.py` (`audit_nasr` ~358: new parameter, calls the check; `audit_cifp` ~314: `thresholds_sha256` must match when present)
- Test: `~/flytab-pipeline/tests/test_audit_currency.py`

**Interfaces:**
- Consumes: Task 1 bundle fields; Task 2 `cifp_thresholds.json`, `normalise_end_id`.
- Produces: `runway_end_problems(bundle: dict, cifp_thresholds: dict | None) -> list[str]`; `audit_nasr(exp, nasr_dir, cifp_dir=None)` appends its result to the NASR product's failures.

Rules (one failure line each, with counts and the 5 worst examples `ICAO RWY end: N ft`):
- Ends with coordinates ≥ `RUNWAY_END_MINIMUM = 20000` (April 2026: 23,582).
- Runways with both physical ends: |distance − `length_ft`| ≤ max(30 ft, 1% of length) for ≥ 98%.
- Ends present in both NASR (`*_thr_lat/lon`) and CIFP: within 100 ft for ≥ 98%.
- `cifp_thresholds` missing → the CIFP rule is skipped with no failure (an older CIFP build); the other two still run.

- [ ] **Step 1: Measure first** (no code committed): with the 2611 data built by Task 4's commands on a scratch copy, compute the three numbers and the worst 10 of each. If real data misses a rule, stop and report the numbers to Dana before writing tests.
- [ ] **Step 2: Write the failing tests**: `test_runway_ends_pass_on_good_data` (fixture bundle from Task 1's KLKR entry + Task 2's KLKR thresholds → `[]`); `test_runway_length_mismatch_fails` (move recip 500 ft → one failure naming `KLKR 06/24`); `test_cifp_disagreement_fails` (shift CIFP RW24 0.01° → failure naming `KLKR 24`); `test_too_few_ends_fails`; `test_no_cifp_file_skips_that_rule`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** `python3 -m pytest tests/test_audit_currency.py -q` → new tests PASS (the 3 base-branch failures unchanged, nothing else).
- [ ] **Step 6: Commit** `feat(audit): runway ends -- count, published length, CIFP agreement`.

### Task 4: Rebuild on the server and verify (pipeline)

**Files:** none (operations); results go in the PR description.

- [ ] **Step 1:** `cd ~/flytab-pipeline && git checkout feat/runway-thresholds && python3 build_all.py --only nasr cifp` (it runs the audit at the end).
- [ ] **Step 2: Verify**: audit prints `PASS`; `data/nasr/cycle_info.json` has `bundle_version` 11; KLKR runway in `data/nasr/bundle.json` has `recip_thr_lat` within 1e-5 of 34.727211 (CIFP) and `base_displ_ft` 105; `curl -s localhost:8090/nasr/cycle_info.json` shows `bundle_version: 11`.
- [ ] **Step 3:** Push the branch; PR only on Dana's word (critical review first).

### Task 5: Approaches put RW## at the threshold (FlyTab)

**Files:**
- Modify: `web/cockpit/approach-charts.js` (~1249-1272, `resolveCoords`)
- Modify: `docs/user-manual.md` (approach-loading paragraph), `web/app.js` (`FLYTAB_VERSION`)
- Test: `tests/cockpit/approach-runway-threshold.test.js`; `tests/cockpit/wind-compass.test.js` (one case)

**Interfaces:**
- Consumes: Task 1 bundle fields on `nasrDb.getAirport(icao).runways[]`.
- Produces: `static ApproachCharts.runwayThreshold(airport: object, fixId: string) -> {lat: number, lon: number, elevFt?: number, tchFt?: number} | null` — `fixId` `"RW24"`/`"RW06"`/`"RW18L"`; matches `base_id`/`recip_id` after `normalise` (same rule as Task 2); returns the `*_thr_lat/lon` (else `*_lat/lon`) when both are finite.

- [ ] **Step 1: Write the failing tests** (`approach-runway-threshold.test.js`): KLKR airport object from Task 1's values → `runwayThreshold(apt, "RW24")` = `{lat: 34.72721166, lon: -80.84607163, …}`; `"RW06"` → the displaced threshold 34.71874788; `"RW6"` same as `"RW06"`; airport with v10 runways (no coords) → `null`; airport without runways → `null`. In `wind-compass.test.js`: `parseRunwayEnds([KLKR runway])` → ends `06` hdg 58.4 and `24` hdg 238.4.
- [ ] **Step 2: Run** `npx vitest run tests/cockpit/approach-runway-threshold.test.js tests/cockpit/wind-compass.test.js` → FAIL (`runwayThreshold` not a function).
- [ ] **Step 3: Implement** `runwayThreshold`; in `resolveCoords`, an `RW…` fix uses it and, when it returns `null`, falls back to the airport point as today and logs `DiagLog.log('approach', \`${id}: no threshold in NASR — airport reference point used\`)`.
- [ ] **Step 4: Run** `npx vitest run` → all PASS.
- [ ] **Step 5:** Manual: loading an approach now puts its RW## waypoint at the runway threshold (displaced threshold where there is one); with older data, at the airport. Bump `FLYTAB_VERSION`, `bash build.sh`.
- [ ] **Step 6: Commit** `fix(approach): RW## waypoint at the runway threshold, not the airport point`.
- [ ] **Step 7: On the tablet** (home WiFi, Task 4 done): Data & Maps re-imports NASR (bundle 11); load KLKR RNAV (GPS) RWY 24 → RW24 waypoint at 34.7272, -80.8461 and the WITUR → RW24 leg reads 4.9 NM; tap KLKR → the airport popup still opens (Tap Handler rule); wind compass at KLKR shows 06/24 at 058°/238° true.

---

**Next plan (not here):** engine-out glide panel spec → plan, built on `*_thr_lat/lon`, `*_elev_ft`, `*_true_hdg` from this one; includes the EmergencyGlide wind-factor fix and Dana's margin decision.
