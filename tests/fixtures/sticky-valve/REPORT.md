# Sticky-valve rule: replay over recorded engine starts

Generated 2026-10-03 by a scratch script (not in repo) from all EDM / engine-monitor recordings found on the development machine. Source data was only read; nothing in it was modified.

## Rule under test

`WARMUP_MIN=10, RATIO=0.50, MIN_EGT=200, PERSIST_SEC=30`. Arm on RPM>500, reset on RPM<300; during the first 10 min, skip samples with avg EGT<200; per cylinder, skip if mean of the other three <200; alert when EGT[i]/others < 0.50 continuously for >=30 s. **Rule B** is identical except that EGT<=0 is "no reading": that cylinder is never a candidate and is excluded from the averages, and samples with <3 valid probes are skipped.

## Summary

- **Captured engine starts: 56** (unique, after cross-file dedup).
- **Rule A alerts: 0. Rule B alerts: 0.**
- **Closest margin:** min ratio **0.787** (cyl 2) in `engine_analysis/Parsed_Engine_Data/2025-07-02_KLKR - KLKR_merged.csv`. That is 0.287 above the 0.50 threshold. Longest continuous run below 0.50 across all captured starts: **0 s**, meaning no cylinder in any captured start ever produced even one evaluated sample below 0.50.
- **Mid-run re-arms after an RPM dropout: 73.** RPM reads 0 for 1–13 s while EGTs stay hot (typically ~1700 RPM; most likely the mag check during run-up, if the EDM tach pickup is on one mag. That cause is inferred, not verified). The rule resets and treats each one as a fresh engine start, restarting the 10-min window and clearing any alert. Alerts in these windows: A=0, B=0; lowest ratio 0.904.
- **Recordings with no start captured: 123** (recording begins at RPM>300 with mean EGT>=400 F; rule still evaluated as it would arm at the first sample). Alerts in these: A=0, B=0; lowest ratio 0.904.
- **Rule A vs B:** identical on every event. No EGT <=0 or >2000 values occurred in any start window. Across all 873,621 loaded 1 Hz samples: EGT1<=0 x17504, EGT2<=0 x11457, EGT3<=0 x11457, EGT4<=0 x11457, every one of them at RPM <= 500 (engine not running), so neither rule ever evaluates them.
- **One file excluded as corrupt:** `Engine_Data_Testing/savvy_2024-07-11_16-39-53.csv`. Its `E1 EGT4` column equals CHT4 of its source stream (`Desktop/desktop_old/stream_0705_1426.csv`) on 2225/2225 rows, so EGT4 reads ~170-360 F. Before exclusion it produced the **only** alerts in the dataset (cyl 4, both rules, at +37 s and +31 s). Those alerts were a conversion bug, not a real valve event. The underlying flight is still counted via the stream file.

## Method notes

- 444 recordings loaded (CSV with RPM + EGT1-4 columns, any of `EGT 1`/`EGT1`/`E1 EGT1`; raw `stream_*` EDM text parsed with `parse_line()` copied verbatim from `engine-monitor/engine_monitor.py`). 659 rule-arm events found across files, deduplicated to 252 by matching the first 120 s of EGT1-4 (±15 s offset, >=80% of rows within 2 F). Many flights exist as route file + segment file + savvy export + copies.
- Time base: each file's own timestamps (EDM time-of-day, `Zulu_Time`, or savvy `Lcl Time`; midnight wrap handled), resampled to one sample per second (first sample in each second). Sub-second raw stream lines therefore collapse to 1 Hz.
- "Captured start" = the rule arms after an RPM<300 sample earlier in the same file. "Re-arm after RPM dropout" = captured, but RPM was <=500 for <15 s with mean EGT >=600 F at re-arm. "No start captured" = the file begins already at RPM>=300 with mean EGT >=400 F. The 400/600 F and 15 s cut-offs were chosen by this analysis, not taken from the spec.
- "min ratio" = lowest EGT[i]/mean(others) among samples the rule actually evaluates (avg EGT>=200 and others>=200) in the 10-min window, using rule A. "longest run" = the longest stretch that cylinder stayed below 0.50 by the rule's own `low_since` accounting.
- Excluded derived/analysis outputs (anomalies, outliers, means, baselines, comparisons) and Android build-asset copies. Spreadsheets (.xlsx/.xlsm/.ods) were not loaded:

  - `engine_analysis/Parsed_Engine_Data/anomalies.csv`: derived/analysis output or build artifact copy
  - `engine_analysis/Parsed_Engine_Data/anomalies_20241211_134732.csv`: derived/analysis output or build artifact copy
  - `engine_analysis/Parsed_Engine_Data/comparison_output.csv`: derived/analysis output or build artifact copy
  - `engine_analysis/Parsed_Engine_Data/mean_temperatures.csv`: derived/analysis output or build artifact copy
  - `engine_analysis/Parsed_Engine_Data/outliers_z_score.csv`: derived/analysis output or build artifact copy
  - `engine_analysis/flight_baseline.csv`: derived/analysis output or build artifact copy
  - `flytab/engine-ml-test/app/src/main/assets/test_flight_anomalies.csv`: derived/analysis output or build artifact copy
  - `flywhere/engine-ml-test/app/build/intermediates/assets/debug/mergeDebugAssets/test_flight.csv`: derived/analysis output or build artifact copy
  - `flywhere/engine-ml-test/app/build/intermediates/assets/debug/mergeDebugAssets/test_flight_anomalies.csv`: derived/analysis output or build artifact copy
  - `Engine_Data_Testing/merged_2024-06-25_16-10-50.ods`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/2024-06-07_KLWA-KFGX.xlsx`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/2024-12-08_BQ1 - KLKR_merged.xlsx`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/20250712_KLKR - KLKR_merged.xlsm`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/cht2_analysis_results.xlsx`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/merged_2024-06-25_16-10-50.ods`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/percent_power_2024-09-19 (1).xlsx`: spreadsheet (xlsx/xlsm/ods) not loaded
  - `engine_analysis/Parsed_Engine_Data/percent_power_2024-09-19.xlsx`: spreadsheet (xlsx/xlsm/ods) not loaded

## Captured engine starts

| file | start idx (1 Hz) | EGT1/2/3/4 at start | min ratio | cyl | longest run <0.50 (s) | rule A alert | rule B alert | EGT <=0 / >2000 (−30 s..+10 min) | notes |
|---|---|---|---|---|---|---|---|---|---|
| `Downloads/stream_0046.txt` | 43 (src row 344) | 114/117/115/133 | 0.922 | 2 | 0 | no | no | none |  |
| `Downloads/stream_2025-11-24_20-07-31.txt` | 15 (src row 122) | 82/84/84/106 | 0.891 | 2 | 0 | no | no | none | recording covers 209s after start |
| `engine_analysis/20260130_KLKR-KUZA_merged.csv` | 1910 (src row 1911) | 245/267/266/259 | 0.920 | 1 | 0 | no | no | none | +2 duplicate file(s) |
| `engine_analysis/20260412_KHXD-KLKR.csv` | 352 (src row 902) | 289/286/301/290 | 0.932 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-0524_KLKR - T73_savvy (1).csv` | 39 (src row 82) | 86/81/75/84 | 0.915 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-06-19_T73 - KLKR_merged.csv` | 40 (src row 41) | 161/165/164/194 | 0.926 | 1 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-06-22_BQ1 - KLKR_merged.csv` | 29 (src row 30) | 168/173/170/190 | 0.907 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-06-24_KLKR - SC76_merged.csv` | 44 (src row 45) | 98/101/91/114 | 0.920 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-06-24_SC76 - KLKR_merged.csv` | 30 (src row 31) | 174/177/179/187 | 0.920 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-06-24_SC76 - SC76_merged.csv` | 108 (src row 109) | 231/255/253/244 | 0.915 | 1 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-06-28_KLKR - KLKR_merged.csv` | 54 (src row 55) | 99/102/99/102 | 0.886 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-0617_KLKR_-_KLKR_savvy (1).csv` | 50 (src row 104) | 126/130/126/147 | 0.897 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-07-02_KLKR - KLKR_merged.csv` | 68 (src row 69) | 136/133/156/149 | n/a (never evaluated: avg or others < 200) | - | - | no | no | none | RPM back <300 after 1s; recording covers 409s after start |
| `engine_analysis/Parsed_Engine_Data/2025-07-02_KLKR - KLKR_merged.csv` | 88 (src row 89) | 171/147/171/167 | 0.787 | 2 | 0 | no | no | none | recording covers 389s after start |
| `engine_analysis/Parsed_Engine_Data/2025-07-04_KLKR - KLKR_merged.csv` | 61 (src row 62) | 89/99/90/92 | 0.927 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-07-25_KLKR-KGEV_merged.csv` | 39 (src row 40) | 90/107/91/103 | 0.936 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-07-27_KGEV-KLKR_merged.csv` | 36 (src row 37) | 123/133/124/126 | 0.964 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/20250709_T73 - KLKR_merged.csv` | 238 (src row 239) | 204/214/228/224 | 0.914 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250712_KLKR - KLKR_merged.csv` | 42 (src row 43) | 86/102/99/114 | 0.935 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250719_KCDN - KLKR_merged.csv` | 35 (src row 36) | 154/154/162/157 | 0.899 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250719_KLKR - KCDN_merged.csv` | 51 (src row 52) | 144/157/147/160 | 0.940 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250724_KLKR - KLKR_merged.csv` | 53 (src row 54) | 100/103/109/106 | 0.916 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250814_KLKR-KLKR_merged.csv` | 53 (src row 54) | 140/145/160/153 | 0.941 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250816_KLKR-T73_merged.csv` | 52 (src row 53) | 91/92/91/97 | 0.925 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250816_T73-KLKR_merged.csv` | 36 (src row 37) | 198/205/208/210 | 0.915 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250817_KLKR-KLKR_merged.csv` | 68 (src row 69) | 122/136/135/144 | 0.931 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250818_KLKR-KLKR_merged.csv` | 58 (src row 59) | 112/106/103/103 | 0.912 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250818_KLKR-KLKR_merged.csv` | 4106 (src row 4107) | 739/732/712/713 | n/a (never evaluated: avg or others < 200) | - | - | no | no | none | RPM back <300 after 1s; recording covers 15s after start |
| `engine_analysis/Parsed_Engine_Data/20250824_KLKR-T73_merged.csv` | 2 (src row 3) | 97/99/98/102 | 0.952 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250824_T73-KLKR_merged.csv` | 46 (src row 47) | 177/185/187/193 | 0.902 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250829_KCQW-KLKR_merged.csv` | 60 (src row 61) | 229/246/243/246 | 0.928 | 1 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250829_KLKR-KCQW_merged.csv` | 59 (src row 60) | 103/105/97/108 | 0.942 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/plot_data.csv` | 23 (src row 24) | 131/127/132/143 | 0.892 | 2 | 0 | no | no | none |  |
| `engine_analysis/stream_0030.txt` | 44 (src row 354) | 69/100/73/79 | 0.933 | 2 | 0 | no | no | none | recording covers 179s after start; +1 duplicate file(s) |
| `engine_analysis/stream_0031.txt` | 52 (src row 412) | 173/181/187/182 | 0.925 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_0032.txt` | 41 (src row 326) | 95/98/101/105 | 0.935 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_0033.txt` | 45 (src row 356) | 72/76/73/82 | 0.926 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_0039.edm` | 57 (src row 452) | 80/83/90/84 | 0.890 | 2 | 0 | no | no | none |  |
| `engine_analysis/stream_2025-09-03_20-24-04.txt` | 46 (src row 370) | 94/102/103/97 | 0.934 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_2025-09-03_21-59-54.txt` | 47 (src row 374) | 148/147/160/158 | 0.874 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_2025-09-10_16-42-16.txt` | 95 (src row 756) | 84/89/83/98 | 0.893 | 2 | 0 | no | no | none |  |
| `engine_analysis/stream_2025-09-12_17-15-59.txt` | 50 (src row 396) | 83/83/82/93 | 0.876 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_2025-09-12_18-13-37.txt` | 56 (src row 442) | 188/181/174/196 | 0.917 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_2025-09-14.txt` | 40 (src row 322) | 159/148/146/156 | 0.910 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/stream_2025-09-24_15-41-30.txt` | 48 (src row 380) | 102/104/104/107 | 0.936 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_2025-10-04_19-30-41.txt` | 34 (src row 274) | 222/211/225/229 | 0.928 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/stream_2025-10-15_16-00-51.txt` | 57 (src row 456) | 84/97/85/93 | 0.921 | 2 | 0 | no | no | none |  |
| `engine_analysis/stream_2025-10-15_17-09-00.txt` | 71 (src row 566) | 219/209/210/222 | 0.922 | 4 | 0 | no | no | none |  |
| `engine_analysis/stream_2025-10-24_20-28-42.txt` | 41 (src row 322) | 182/176/190/198 | 0.886 | 2 | 0 | no | no | none |  |
| `engine_analysis/stream_2325.txt` | 4 (src row 34) | 235/230/243/235 | 0.932 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/stream_2327.txt` | 5 (src row 36) | 265/285/277/278 | 0.928 | 4 | 0 | no | no | none |  |
| `engine_data/flight_active.csv` | 3 (src row 4) | 742/706/759/722 | 0.948 | 4 | 0 | no | no | none | sample interval 20s; recording covers 160s after start |
| `shared/Engine_data/upload_261a85b9/stream_0041.txt` | 38 (src row 300) | 273/293/288/280 | 0.930 | 2 | 0 | no | no | none | +5 duplicate file(s) |
| `stratux/20260112_KLKR-KLKR_merged.csv` | 95 (src row 96) | 87/88/102/104 | 0.896 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `stratux/flight_2026-02-10T20-50-03.csv` | 0 (src row 1) | 103/105/122/105 | 0.914 | 4 | 0 | no | no | none | recording covers 3325s after start |
| `stratux/stream_2026-02-10_21-45-13.txt` | 15 (src row 58) | 97/100/114/99 | 0.893 | 4 | 0 | no | no | none |  |

## Rule re-arms after a mid-run RPM dropout

| file | start idx (1 Hz) | EGT1/2/3/4 at start | min ratio | cyl | longest run <0.50 (s) | rule A alert | rule B alert | EGT <=0 / >2000 (−30 s..+10 min) | notes |
|---|---|---|---|---|---|---|---|---|---|
| `2024-07-28_60J - KLKR_merged.csv` | 165 (src row 166) | 1183/1141/1172/1171 | 0.922 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +1 duplicate file(s) |
| `Desktop/Savvy/Done/stream_1116_1946.edm` | 135 (src row 1080) | 1182/1130/1164/1165 | 0.916 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before |
| `Desktop/Savvy/Done/stream_1116_1946.edm` | 1367 (src row 10936) | 1232/1185/1221/1241 | 0.963 | 2 | 0 | no | no | none | RPM read <=500 for 5s just before; recording covers 101s after start |
| `Desktop/Savvy/stream_1009_2122.edm` | 180 (src row 1438) | 1192/1176/1254/1271 | 0.941 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before; recording covers 8s after start |
| `Desktop/Savvy/stream_1009_2219.edm` | 231 (src row 1844) | 1237/1200/1229/1233 | 0.916 | 2 | 0 | no | no | none | RPM read <=500 for 6s just before |
| `Desktop/desktop_old/2024-08-24_KFGX - KLKR_merged.csv` | 181 (src row 182) | 1213/1224/1257/1279 | 0.940 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +1 duplicate file(s) |
| `Desktop/desktop_old/2025-02-14_KLKR - 35A_merged.csv` | 365 (src row 366) | 1252/1193/1236/1240 | 0.914 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +1 duplicate file(s) |
| `Desktop/desktop_old/edm_data.csv` | 452 (src row 453) | 1127/1117/1158/1157 | 0.938 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +5 duplicate file(s) |
| `Desktop/desktop_old/plot_data.csv` | 37 (src row 38) | 1288/1247/1324/1316 | 0.952 | 2 | 0 | no | no | none | RPM back <300 after 32s; RPM read <=500 for 2s just before; +3 duplicate file(s) |
| `Desktop/desktop_old/plot_data.csv` | 71 (src row 72) | 1297/1277/1349/1342 | 0.913 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +3 duplicate file(s) |
| `Desktop/desktop_old/stream_0711_1458.csv` | 51 (src row 52) | 1199/1151/1162/1160 | 0.932 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +3 duplicate file(s) |
| `Downloads/stream_0607_1547.txt` | 260 (src row 2080) | 1154/1131/1165/1167 | 0.908 | 2 | 0 | no | no | none | RPM read <=500 for 1s just before; +2 duplicate file(s) |
| `Engine_Data_Testing/2024-07-18_KLKR - KLKR_savvy.csv` | 263 (src row 333) | 1200/1159/1188/1198 | 0.927 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 1352s after start |
| `Engine_Data_Testing/2024-07-18_KLKR - KLKR_savvy.csv` | 1408 (src row 1682) | 1237/1191/1202/1214 | 0.978 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 3s after start |
| `Engine_Data_Testing/2024-07-23_KLKR - KLKR_merged.csv` | 180 (src row 181) | 1229/1185/1206/1220 | 0.931 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before; +2 duplicate file(s) |
| `Engine_Data_Testing/2024-07-23_KLKR - KLKR_merged.csv` | 1568 (src row 1569) | 1524/1457/1447/1478 | 0.958 | 2 | 0 | no | no | none | RPM read <=500 for 11s just before; +2 duplicate file(s) |
| `Engine_Data_Testing/2024-07-23_KLKR - KLKR_merged.csv` | 2173 (src row 2174) | 1247/1188/1204/1212 | 0.975 | 2 | 0 | no | no | none | RPM back <300 after 21s; RPM read <=500 for 5s just before; recording covers 122s after start; +2 duplicate file(s) |
| `Engine_Data_Testing/2024-07-23_KLKR - KLKR_merged.csv` | 2199 (src row 2200) | 1267/1218/1225/1230 | 0.970 | 2 | 0 | no | no | none | RPM back <300 after 32s; RPM read <=500 for 5s just before; recording covers 96s after start; +2 duplicate file(s) |
| `Engine_Data_Testing/2024-07-23_KLKR - KLKR_merged.csv` | 2234 (src row 2235) | 1284/1239/1266/1273 | 0.961 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; recording covers 61s after start; +2 duplicate file(s) |
| `Engine_Data_Testing/merged_2024-07-18_KLKR - KLKR_merged.csv` | 1679 (src row 1680) | 1237/1191/1202/1214 | 0.964 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 22s after start |
| `Engine_Data_Testing/savvy_2024-07-10_14-41-22.csv` | 425 (src row 531) | 1206/1171/1175/1187 | 0.938 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 1675s after start; +7 duplicate file(s) |
| `Engine_Data_Testing/savvy_2024-07-12_11-43-09.csv` | 33 (src row 54) | 1199/1151/1162/1160 | 0.932 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 1611s after start |
| `engine_analysis/Parsed_Engine_Data/2024-07-06_10-11-40_merged.csv` | 530 (src row 531) | 1206/1171/1175/1187 | 0.938 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +26 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-15_12-39-19_merged.csv` | 88 (src row 89) | 1225/1178/1198/1209 | 0.933 | 2 | 0 | no | no | none | RPM read <=500 for 1s just before; +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-18_20-09-26_merged.csv` | 330 (src row 331) | 1200/1159/1188/1198 | 0.927 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-18_20-09-26_merged.csv` | 1643 (src row 1644) | 1190/1155/1162/1176 | 0.970 | 2 | 0 | no | no | none | RPM back <300 after 34s; RPM read <=500 for 1s just before; recording covers 58s after start; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-18_20-09-26_merged.csv` | 1679 (src row 1680) | 1237/1191/1202/1214 | 0.964 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 22s after start |
| `engine_analysis/Parsed_Engine_Data/2024-07-18_20-29-17_merged.csv` | 1679 (src row 1680) | 1237/1191/1202/1214 | 0.964 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 22s after start |
| `engine_analysis/Parsed_Engine_Data/2024-07-18_KLKR - KLKR_merged.csv` | 1679 (src row 1680) | 1237/1191/1202/1214 | 0.964 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; recording covers 22s after start |
| `engine_analysis/Parsed_Engine_Data/2024-07-28_KLKR - 60J_merged.csv` | 203 (src row 204) | 1214/1159/1168/1174 | 0.927 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-08-03_KLKR - KLKR_merged.csv` | 432 (src row 433) | 1179/1170/1196/1212 | 0.939 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before |
| `engine_analysis/Parsed_Engine_Data/2024-08-15_KLKR - KLKR_merged.csv` | 182 (src row 183) | 1137/1144/1166/1178 | 0.940 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-09-19_KLKR - KLKR_merged.csv` | 139 (src row 140) | 1288/1240/1266/1282 | 0.926 | 2 | 0 | no | no | none | RPM read <=500 for 11s just before |
| `engine_analysis/Parsed_Engine_Data/2024-09-29_KLKR - KLKR_merged.csv` | 646 (src row 647) | 1194/1135/1167/1160 | 0.922 | 2 | 0 | no | no | none | RPM read <=500 for 1s just before |
| `engine_analysis/Parsed_Engine_Data/2024-10-13_KLKR - KLKR_merged.csv` | 280 (src row 281) | 1215/1177/1217/1221 | 0.966 | 2 | 0 | no | no | none | RPM back <300 after 11s; RPM read <=500 for 2s just before; +2 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-10-18_KAFP - KLKR_merged.csv` | 173 (src row 174) | 1200/1163/1204/1200 | 0.926 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-11-02_KLKR - KLKR_merged.csv` | 158 (src row 159) | 1239/1147/1174/1169 | 0.930 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before; +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-11-12_KLKR - KLKR_merged.csv` | 153 (src row 154) | 1225/1178/1230/1237 | 0.928 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before; +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-11-16_KLKR - KLKR_merged.csv` | 390 (src row 391) | 1215/1168/1212/1223 | 0.931 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before; +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-12-01_BQ1 - KLKR_merged.csv` | 136 (src row 137) | 1196/1148/1205/1197 | 0.916 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-12-08_KLKR - BQ1_merged.csv` | 241 (src row 242) | 1222/1197/1240/1226 | 0.919 | 2 | 0 | no | no | none | RPM read <=500 for 5s just before; +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-12-22_KLKR - KLKR_merged.csv` | 396 (src row 397) | 1288/1251/1307/1307 | 0.921 | 4 | 0 | no | no | none | RPM read <=500 for 2s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024_05-11_1504_edm.csv` | 176 (src row 177) | 1173/1115/1146/1153 | 0.917 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before |
| `engine_analysis/Parsed_Engine_Data/2024_05-24_1839_edm.csv` | 128 (src row 129) | 1244/1197/1210/1226 | 0.917 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before |
| `engine_analysis/Parsed_Engine_Data/2024_05-31_1315_edm.csv` | 264 (src row 265) | 1209/1153/1173/1175 | 0.904 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before |
| `engine_analysis/Parsed_Engine_Data/2025-01-02_KLKR - KLKR_merged.csv` | 683 (src row 684) | 1250/1208/1263/1250 | 0.918 | 2 | 0 | no | no | none | RPM read <=500 for 5s just before |
| `engine_analysis/Parsed_Engine_Data/2025-01-03_KLKR - KLKR_merged.csv` | 799 (src row 800) | 1230/1198/1258/1240 | 0.928 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before |
| `engine_analysis/Parsed_Engine_Data/2025-02-02_KLKR - KLKR_merged.csv` | 231 (src row 232) | 1223/1183/1208/1197 | 0.919 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before |
| `engine_analysis/Parsed_Engine_Data/2025-02-18_KEQY - KLKR_merged.csv` | 335 (src row 336) | 1218/1185/1231/1235 | 0.913 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before |
| `engine_analysis/Parsed_Engine_Data/2025-03-03_KLKR - KLKR_merged.csv` | 654 (src row 655) | 1211/1162/1199/1192 | 0.913 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before |
| `engine_analysis/Parsed_Engine_Data/2025-03-09_KLKR - KLKR_merged.csv` | 156 (src row 157) | 1214/1177/1202/1191 | 0.923 | 2 | 0 | no | no | none | RPM read <=500 for 6s just before |
| `engine_analysis/Parsed_Engine_Data/2025-03-11_KGMU - KUZA_merged.csv` | 1863 (src row 1864) | 1233/1205/1239/1213 | 0.972 | 4 | 0 | no | no | none | RPM back <300 after 19s; RPM read <=500 for 9s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-11_KGMU - KUZA_merged.csv` | 1891 (src row 1892) | 1280/1237/1243/1234 | 0.943 | 4 | 0 | no | no | none | RPM read <=500 for 9s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-11_KLKR - KUZA_merged.csv` | 122 (src row 123) | 1205/1172/1223/1214 | 0.916 | 2 | 0 | no | no | none | RPM read <=500 for 5s just before; +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-14_KUZA - KLKR_merged.csv` | 347 (src row 348) | 1188/1137/1151/1148 | 0.978 | 2 | 0 | no | no | none | RPM back <300 after 29s; RPM read <=500 for 4s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-14_KUZA - KLKR_merged.csv` | 380 (src row 381) | 1208/1173/1197/1191 | 0.925 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before; +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-27_KLKR - KUZA_merged.csv` | 217 (src row 218) | 1274/1245/1307/1318 | 0.918 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before |
| `engine_analysis/Parsed_Engine_Data/2025-03-27_KUZA - KLKR_merged.csv` | 526 (src row 527) | 1304/1256/1323/1322 | 0.922 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before |
| `engine_analysis/Parsed_Engine_Data/2025-04-10_KLKR - KLKR_merged.csv` | 672 (src row 673) | 1282/1250/1302/1295 | 0.917 | 2 | 0 | no | no | none | RPM read <=500 for 4s just before |
| `engine_analysis/Parsed_Engine_Data/2025-04-14_KLKR - KLKR_merged.csv` | 335 (src row 336) | 1240/1206/1262/1270 | 0.922 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +2 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-04-17_KEQY - KLKR_merged.csv` | 354 (src row 355) | 1302/1301/1336/1339 | 0.923 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before |
| `engine_analysis/Parsed_Engine_Data/2025-05-06_KFDW - KLKR_merged.csv` | 92 (src row 93) | 1236/1193/1267/1272 | 0.925 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before |
| `engine_analysis/Parsed_Engine_Data/20250619_KSUT - KLKR_merged.csv` | 108 (src row 109) | 1265/1238/1289/1280 | 0.923 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/EDM_20250312.csv` | 47 (src row 48) | 1204/1228/1201/1217 | 0.961 | 1 | 0 | no | no | none | RPM read <=500 for 13s just before; recording covers 233s after start |
| `engine_analysis/Parsed_Engine_Data/EDM_20250312.csv` | 126 (src row 127) | 1358/1387/1409/1427 | 0.965 | 1 | 0 | no | no | none | RPM read <=500 for 7s just before; recording covers 154s after start |
| `engine_analysis/Parsed_Engine_Data/EDM_20250312.csv` | 236 (src row 237) | 1343/1372/1376/1397 | 0.960 | 1 | 0 | no | no | none | RPM back <300 after 14s; RPM read <=500 for 3s just before; recording covers 44s after start |
| `engine_analysis/Parsed_Engine_Data/EDM_20250312.csv` | 254 (src row 255) | 1351/1385/1398/1423 | 0.963 | 1 | 0 | no | no | none | RPM read <=500 for 4s just before; recording covers 26s after start |
| `engine_analysis/Parsed_Engine_Data/anomaly_test_merged.csv` | 223 (src row 224) | 1212/1177/1234/1232 | 0.929 | 2 | 0 | no | no | none | RPM read <=500 for 3s just before; +6 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/merged_data.csv` | 246 (src row 247) | 1205/1160/1206/1218 | 0.916 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +11 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/percent_power_2024-09-10.csv` | 425 (src row 426) | 1138/1134/1182/1188 | 0.935 | 2 | 0 | no | no | none | RPM read <=500 for 2s just before; +2 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/percent_power_2025-03-02.csv` | 317 (src row 318) | 1231/1169/1213/1216 | 0.913 | 4 | 0 | no | no | none | RPM read <=500 for 4s just before; +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/plot_data-cyberpower.csv` | 152 (src row 153) | 1221/1182/1212/1228 | 0.918 | 2 | 0 | no | no | none | RPM read <=500 for 7s just before; +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/savvy_data_2024-11-30.csv` | 476 (src row 956) | 1225/1183/1245/1246 | 0.940 | 4 | 0 | no | no | none | RPM read <=500 for 4s just before; +1 duplicate file(s) |

## Recordings with no start captured (rule armed on first sample)

| file | start idx (1 Hz) | EGT1/2/3/4 at start | min ratio | cyl | longest run <0.50 (s) | rule A alert | rule B alert | EGT <=0 / >2000 (−30 s..+10 min) | notes |
|---|---|---|---|---|---|---|---|---|---|
| `2024-07-28_60J - KLKR_merged.csv` | 0 (src row 1) | 1069/1007/1010/1017 | 0.968 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `Desktop/Savvy/Done/stream_1116_1946.edm` | 0 (src row 2) | 1005/911/929/915 | 0.951 | 2 | 0 | no | no | none |  |
| `Desktop/Savvy/stream_1004_1828.edm` | 0 (src row 2) | 1029/955/967/978 | 0.948 | 2 | 0 | no | no | none |  |
| `Desktop/Savvy/stream_1009_2122.edm` | 0 (src row 2) | 999/963/978/986 | 0.935 | 2 | 0 | no | no | none | recording covers 188s after start |
| `Desktop/Savvy/stream_1009_2219.edm` | 0 (src row 2) | 963/883/874/897 | 0.940 | 3 | 0 | no | no | none |  |
| `Desktop/desktop_old/2024-08-24_KFGX - KLKR_merged.csv` | 0 (src row 1) | 970/982/979/970 | 0.969 | 1 | 0 | no | no | none | +1 duplicate file(s) |
| `Desktop/desktop_old/2025-02-14_35A - KLKR_merged.csv` | 0 (src row 1) | 1453/1371/1372/1310 | 0.935 | 4 | 0 | no | no | none | +1 duplicate file(s) |
| `Desktop/desktop_old/2025-02-14_KLKR - 35A_merged.csv` | 0 (src row 1) | 994/919/930/925 | 0.950 | 4 | 0 | no | no | none | +1 duplicate file(s) |
| `Desktop/desktop_old/KLKR - 60J_2024-07-28_merged.csv` | 0 (src row 1) | 1069/1007/1010/1017 | n/a (never evaluated: avg or others < 200) | - | - | no | no | none | recording covers 0s after start |
| `Desktop/desktop_old/edm_data.csv` | 0 (src row 1) | 932/906/923/886 | 0.958 | 3 | 0 | no | no | none | +5 duplicate file(s) |
| `Desktop/desktop_old/plot_data.csv` | 0 (src row 1) | 967/902/918/896 | 0.949 | 2 | 0 | no | no | none | RPM back <300 after 35s; +3 duplicate file(s) |
| `Desktop/desktop_old/stream_0311_1615.edm` | 0 (src row 2) | 1010/989/994/956 | 0.924 | 2 | 0 | no | no | none | +2 duplicate file(s) |
| `Desktop/desktop_old/stream_0711_1458.csv` | 0 (src row 1) | 1106/1056/1030/1046 | 0.962 | 3 | 0 | no | no | none | RPM back <300 after 49s; +3 duplicate file(s) |
| `Downloads/KLWA-KFGX.csv` | 0 (src row 1) | 1004/957/969/971 | 0.909 | 2 | 0 | no | no | none | +5 duplicate file(s) |
| `Downloads/stream_0044.txt` | 0 (src row 2) | 1417/1388/1426/1397 | 0.919 | 4 | 0 | no | no | none |  |
| `Downloads/stream_0607_1547.txt` | 0 (src row 2) | 1150/1099/1121/1136 | 0.965 | 2 | 0 | no | no | none | +2 duplicate file(s) |
| `Downloads/stream_0620_0032.csv` | 0 (src row 1) | 997/942/949/965 | 0.956 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `Engine_Data_Testing/2024-07-15_11-52-17_savvy.csv` | 0 (src row 3) | 1050/993/997/981 | 0.941 | 2 | 0 | no | no | none | recording covers 1827s after start; +1 duplicate file(s) |
| `Engine_Data_Testing/2024-07-15_12-39-19_savvy.csv` | 0 (src row 3) | 1076/1021/1034/1037 | 0.933 | 2 | 0 | no | no | none | recording covers 1807s after start; +4 duplicate file(s) |
| `Engine_Data_Testing/2024-07-18_KLKR - KLKR_savvy.csv` | 0 (src row 3) | 1090/1034/1044/1046 | 0.952 | 3 | 0 | no | no | none | recording covers 1669s after start |
| `Engine_Data_Testing/2024-07-23_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1036/990/998/995 | 0.966 | 3 | 0 | no | no | none | +2 duplicate file(s) |
| `Engine_Data_Testing/savvy_2024-07-10_14-41-22.csv` | 0 (src row 1) | 1071/1003/978/985 | 0.940 | 3 | 0 | no | no | none | recording covers 2198s after start; +7 duplicate file(s) |
| `Engine_Data_Testing/savvy_2024-07-12_11-43-09.csv` | 0 (src row 3) | 1106/1056/1030/1046 | 0.962 | 3 | 0 | no | no | none | RPM back <300 after 38s; recording covers 1651s after start |
| `engine_analysis/20260319_1429Z.csv` | 0 (src row 1) | 609/570/610/582 | 0.944 | 4 | 0 | no | no | none | sample interval 2s; +4 duplicate file(s) |
| `engine_analysis/20260319_1458Z.csv` | 0 (src row 1) | 1401/1383/1441/1408 | 0.939 | 4 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260321_1627Z.csv` | 0 (src row 1) | 1055/1038/1041/1031 | 0.931 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260321_1804Z.csv` | 0 (src row 1) | 1461/1399/1425/1387 | 0.957 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260322_1537Z.csv` | 0 (src row 1) | 591/531/588/544 | n/a (never evaluated: avg or others < 200) | - | - | no | no | none | recording covers 0s after start |
| `engine_analysis/20260322_KCQW-KLKR.csv` | 0 (src row 1) | 585/537/581/552 | 0.909 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260403_2058Z.csv` | 0 (src row 1) | 1056/1033/1042/1022 | 0.942 | 4 | 0 | no | no | none | sample interval 2s; +3 duplicate file(s) |
| `engine_analysis/20260410_1347Z.csv` | 0 (src row 1) | 512/480/514/489 | 0.930 | 4 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260410_1553Z.csv` | 0 (src row 1) | 521/487/531/508 | 0.937 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260412_KHXD-KLKR.csv` | 0 (src row 1) | 691/688/682/654 | 0.942 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260412_KLKR-KHXD.csv` | 0 (src row 1) | 497/456/489/476 | 0.923 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260417_KLKR-KLKR.csv` | 0 (src row 1) | 1052/1043/1028/1021 | 0.930 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260424_KLKR-KT73.csv` | 0 (src row 1) | 553/501/531/490 | 0.938 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260424_KT73-KLKR.csv` | 0 (src row 1) | 601/566/601/576 | 0.918 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260427_2116Z.csv` | 0 (src row 1) | 582/529/575/551 | 0.940 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260501_KLKR-KLKR.csv` | 0 (src row 1) | 648/589/647/622 | 0.929 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260503_KLKR-SC58.csv` | 0 (src row 1) | 535/528/568/521 | 0.933 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260503_KRCZ-KLKR.csv` | 0 (src row 1) | 906/874/888/870 | 0.923 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260508_2118Z.csv` | 0 (src row 1) | 546/497/542/518 | 0.934 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260516_1320Z.csv` | 0 (src row 1) | 534/489/544/510 | 0.926 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260516_KCDN-KLKR.csv` | 0 (src row 1) | 1432/1379/1414/1408 | 0.958 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260517_KAFP-KLKR.csv` | 0 (src row 1) | 627/630/665/650 | 0.940 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260517_KLKR-KAFP.csv` | 0 (src row 1) | 565/530/593/543 | 0.928 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260521_1313Z.csv` | 0 (src row 1) | 673/620/677/634 | 0.943 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260529_1444Z.csv` | 0 (src row 1) | 524/484/542/496 | 0.933 | 2 | 0 | no | no | none | sample interval 2s; +3 duplicate file(s) |
| `engine_analysis/20260604_1340Z.csv` | 0 (src row 1) | 604/543/593/578 | 0.927 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260606_1428Z.csv` | 0 (src row 1) | 1040/1035/1025/1005 | 0.932 | 2 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260607_1452Z.csv` | 0 (src row 1) | 552/530/569/534 | 0.940 | 2 | 0 | no | no | none | sample interval 2s; recording covers 2552s after start; +4 duplicate file(s) |
| `engine_analysis/20260607_1536Z.csv` | 0 (src row 1) | 552/555/568/533 | 0.938 | 4 | 0 | no | no | none | sample interval 2s; +4 duplicate file(s) |
| `engine_analysis/20260619_2119Z.csv` | 0 (src row 1) | 582/542/573/559 | 0.946 | 4 | 0 | no | no | none | sample interval 2s; +2 duplicate file(s) |
| `engine_analysis/20260621_1407Z.csv` | 0 (src row 1) | 666/600/646/616 | 0.927 | 4 | 0 | no | no | none | sample interval 2s; +3 duplicate file(s) |
| `engine_analysis/20260708_1434Z.csv` | 0 (src row 1) | 440/402/429/383 | 0.904 | 4 | 0 | no | no | none | sample interval 2s; recording covers 432s after start; +1 duplicate file(s) |
| `engine_analysis/20260710_1310Z.csv` | 0 (src row 1) | 606/548/590/564 | 0.938 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260717_1323Z.csv` | 0 (src row 1) | 506/468/514/474 | 0.951 | 4 | 0 | no | no | none | sample interval 2s; recording covers 2768s after start; +2 duplicate file(s) |
| `engine_analysis/20260729_1406Z.csv` | 0 (src row 1) | 566/519/575/504 | 0.910 | 4 | 0 | no | no | none | sample interval 2s; +3 duplicate file(s) |
| `engine_analysis/20260814_1605Z.csv` | 0 (src row 1) | 659/599/662/612 | 0.932 | 2 | 0 | no | no | none | sample interval 2s; recording covers 261s after start |
| `engine_analysis/20260814_1625Z.csv` | 0 (src row 1) | 728/701/726/683 | 0.944 | 4 | 0 | no | no | none | sample interval 2s; recording covers 250s after start; +1 duplicate file(s) |
| `engine_analysis/20260815_1341Z.csv` | 0 (src row 1) | 619/563/622/586 | 0.927 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260904_1547Z.csv` | 0 (src row 1) | 1429/1386/1416/1417 | 0.970 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260905_1545Z.csv` | 0 (src row 1) | 620/577/624/589 | 0.947 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260906_1458Z.csv` | 0 (src row 1) | 567/531/539/513 | 0.940 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260911_1446Z.csv` | 0 (src row 1) | 495/463/486/457 | 0.927 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260911_1613Z.csv` | 0 (src row 1) | 595/573/622/585 | 0.951 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260921_1348Z.csv` | 0 (src row 1) | 1096/1042/1040/1036 | 0.960 | 4 | 0 | no | no | none | sample interval 2s; recording covers 104s after start |
| `engine_analysis/20260921_1404Z.csv` | 0 (src row 1) | 595/577/611/587 | 0.942 | 4 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/20260921_1727Z.csv` | 0 (src row 1) | 590/544/611/594 | 0.918 | 2 | 0 | no | no | none | sample interval 2s; +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-06_10-11-40_merged.csv` | 0 (src row 1) | 1071/1003/978/985 | 0.940 | 3 | 0 | no | no | none | +26 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-15_11-52-17_merged.csv` | 0 (src row 1) | 1050/993/997/981 | 0.941 | 2 | 0 | no | no | none | +8 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-15_12-39-19_merged.csv` | 0 (src row 1) | 1076/1021/1034/1037 | 0.956 | 2 | 0 | no | no | none | +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-18_20-09-26_merged.csv` | 0 (src row 1) | 1090/1034/1044/1046 | 0.952 | 3 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-07-28_KLKR - 60J_merged.csv` | 0 (src row 1) | 1016/959/980/957 | 0.958 | 3 | 0 | no | no | none | +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-08-03_KLKR - KLKR_merged.csv` | 0 (src row 1) | 996/953/967/981 | 0.965 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024-08-15_KLKR - KLKR_merged.csv` | 0 (src row 1) | 998/979/983/990 | 0.974 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-09-19_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1001/902/903/918 | 0.945 | 3 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024-09-29_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1008/931/966/927 | 0.943 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024-10-13_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1043/992/997/1002 | 0.951 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024-10-18_KAFP - KLKR_merged.csv` | 0 (src row 1) | 996/955/952/941 | 0.952 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-11-02_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1012/916/913/913 | 0.947 | 3 | 0 | no | no | none | +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-11-12_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1021/947/952/955 | 0.958 | 2 | 0 | no | no | none | +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-11-16_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1026/951/938/956 | 0.952 | 3 | 0 | no | no | none | +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-12-01_BQ1 - KLKR_merged.csv` | 0 (src row 1) | 1021/943/951/954 | 0.952 | 2 | 0 | no | no | none | +4 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-12-08_KLKR - BQ1_merged.csv` | 0 (src row 1) | 1001/941/943/943 | 0.947 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024-12-22_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1043/992/980/995 | 0.948 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024_05-11_1504_edm.csv` | 0 (src row 1) | 1025/971/965/966 | 0.951 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024_05-11_1601_edm.csv` | 0 (src row 1) | 1017/943/968/968 | 0.909 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024_05-12_1957_edm.csv` | 0 (src row 1) | 1054/996/1012/1005 | 0.916 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024_05-12_2051_edm.csv` | 0 (src row 1) | 1064/1014/1017/1006 | 0.906 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2024_05-24_1839_edm.csv` | 0 (src row 1) | 1010/980/974/964 | 0.962 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024_05-31_1315_edm.csv` | 0 (src row 1) | 981/930/911/913 | 0.945 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2024_05-31_1551_edm.csv` | 0 (src row 1) | 1040/981/997/1000 | 0.907 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-01-02_KLKR - KLKR_merged.csv` | 0 (src row 1) | 920/859/896/876 | 0.957 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-01-03_KLKR - KLKR_merged.csv` | 0 (src row 1) | 999/921/925/925 | 0.958 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-02-02_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1020/965/960/941 | 0.945 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-02-18_KEQY - KLKR_merged.csv` | 0 (src row 1) | 985/909/921/938 | 0.958 | 3 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-03-03_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1016/955/968/964 | 0.937 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-03-09_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1003/997/998/976 | 0.962 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-03-11_KGMU - KUZA_merged.csv` | 0 (src row 1) | 1364/1289/1301/1244 | 0.917 | 4 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-11_KLKR - KUZA_merged.csv` | 0 (src row 1) | 982/962/970/946 | 0.961 | 2 | 0 | no | no | none | +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-14_KUZA - KLKR_merged.csv` | 0 (src row 1) | 964/920/918/923 | 0.965 | 2 | 0 | no | no | none | +3 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-03-27_KLKR - KUZA_merged.csv` | 0 (src row 1) | 990/959/966/955 | 0.955 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-03-27_KUZA - KLKR_merged.csv` | 0 (src row 1) | 964/914/949/935 | 0.952 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-04-10_KLKR - KLKR_merged.csv` | 0 (src row 1) | 996/923/945/949 | 0.957 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-04-14_KLKR - KLKR_merged.csv` | 0 (src row 1) | 1080/1028/1027/1026 | 0.948 | 3 | 0 | no | no | none | +2 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/2025-04-17_KEQY - KLKR_merged.csv` | 0 (src row 1) | 1048/1038/1055/1040 | 0.970 | 4 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-04-17_KLKR - KEQY_merged.csv` | 0 (src row 1) | 1051/1003/1012/1022 | 0.916 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-04-30_KSUT - KLKR_merged.csv` | 0 (src row 1) | 1398/1366/1401/1399 | 0.969 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/2025-05-06_KFDW - KLKR_merged.csv` | 0 (src row 1) | 1046/989/1046/1010 | 0.949 | 2 | 0 | no | no | none |  |
| `engine_analysis/Parsed_Engine_Data/20250619_KSUT - KLKR_merged.csv` | 0 (src row 1) | 1052/1012/1023/1013 | 0.960 | 4 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/20260322_1537Z_savvy.csv` | 0 (src row 6) | 591/531/588/544 | n/a (never evaluated: avg or others < 200) | - | - | no | no | none | recording covers 0s after start |
| `engine_analysis/Parsed_Engine_Data/EDM_20250312.csv` | 0 (src row 1) | 964/994/959/986 | 0.974 | 3 | 0 | no | no | none | RPM back <300 after 34s; recording covers 280s after start |
| `engine_analysis/Parsed_Engine_Data/anomaly_test_merged.csv` | 0 (src row 1) | 959/886/897/891 | 0.955 | 2 | 0 | no | no | none | +6 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/merged_data.csv` | 0 (src row 1) | 1074/1005/1018/1031 | 0.961 | 2 | 0 | no | no | none | recording covers 86399s after start; +7 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/percent_power_2024-09-10.csv` | 0 (src row 1) | 987/962/950/967 | 0.967 | 2 | 0 | no | no | none | +2 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/percent_power_2024-11-24.csv` | 0 (src row 1) | 1043/997/997/983 | 0.930 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/percent_power_2025-03-02.csv` | 0 (src row 1) | 1058/1004/993/987 | 0.957 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/plot_data-cyberpower.csv` | 0 (src row 1) | 1047/981/981/967 | 0.960 | 2 | 0 | no | no | none | +5 duplicate file(s) |
| `engine_analysis/Parsed_Engine_Data/savvy_data_2024-11-30.csv` | 0 (src row 4) | 1029/994/987/996 | 0.952 | 2 | 0 | no | no | none | +1 duplicate file(s) |
| `engine_analysis/feb-2026/20260225_XXXX-YYYY_merged.csv` | 0 (src row 1) | 1051/1018/1015/986 | 0.920 | 2 | 0 | no | no | none | +4 duplicate file(s) |
| `flytab-debrief/tests/fixtures/sample.csv` | 0 (src row 1) | 1380/1370/1390/1360 | 0.986 | 4 | 0 | no | no | none | recording covers 9s after start |
| `flywhere/data/flights/20260322_1537Z.csv` | 0 (src row 1) | 591/531/588/544 | n/a (never evaluated: avg or others < 200) | - | - | no | no | none | recording covers 0s after start |
