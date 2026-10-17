# FAA currency, round 2 (2026-10-17)

Four read-only reviewers covered:
- the review fixes (pipeline b07f89f, ff14fbb; flytab 89204f4);
- a trace of the 10-29 cycle change;
- tablet offline currency;
- the NASR/CIFP/chart builders.

Dana's requirement: the tablet always has the most current FAA data.

Dana's decisions (2026-10-17):
- **Disk:** investigate first, and Dana chooses what to delete. The pipeline also removes last cycle's temp files after a successful build.
- **A/FD fails but plates pass:** sync the plates and warn on A/FD (A/FD tab says its page is not current).
- **Cycle-day gap:** quick fix before 10-29, then a separate pre-staging design for Dana's approval.
- **Tablet expiry UI:** the full set.

## 1. Disk (report → Dana decides)
- [x] du of pipeline data and tmp, what each is for, what is safe to delete.
- [x] Remove last cycle's FAA sources/temp after a successful build (d-TPP volumes, chart temp).

## 2. Bugs in my recent code
- [x] Gate per product:
  - plates are gated on plates only (A/FD is a warning);
  - charts gated per layer;
  - NASR and CIFP gated separately;
  - expiry gated per product;
  - the "building" mark applies only to the products being built.
- [x] A/FD records:
  - keep still-valid records from earlier runs;
  - retry transient errors;
  - stop on repeated non-403 errors as well;
  - a 403 on a single page should not stop the run if it means "missing".
- [x] `min_page_problems` continuation rule: another airport's "(ID) (CON'T)" or a two-column city line must not count.
- [x] A leftover state zip of an unconfigured state must not crash the audit.
- [x] Audit takes the build lock.
- [x] build_all atexit captures the lock path, and tests patch `_acquire_lock` (tests deleted the live lock).
- [x] Per-layer DOWNLOAD/RE-DOWNLOAD goes through the audit gate. `_tileUpdateAvail` also considers `packed_at`.
- [x] Smaller fixes:
  - NASR badge shows -0 ("0d") on expiry day;
  - cycle_info fetches should be no-store;
  - `_probeServerManifest` JSON rejection leaves Sync stuck;
  - `test_failed_tiles_build_exits_1` passes for the wrong reason;
  - a verdict without `valid_until` never expires.

## 3. Pipeline hardening before 10-29
- [x] `download_file`:
  - `.part` + rename;
  - test zips;
  - non-zip 200 fails;
  - never reuse a partial file.
- [x] Charts:
  - fail the layer if any expected chart is missing/failed or any WebP conversion fails;
  - source cache keyed by edition;
  - no reuse of intermediates across editions.
- [x] NASR:
  - fail when class airspace or SUA is empty (pyshp missing, shapefile error);
  - `audit_nasr` checks counts.
- [x] Failures only the audit catches are retried (`.last_cycle` only when the cycle's products passed).

## 4. Cycle-day quick fix
- [x] Cron right after 0901Z (05:15 local).
- [x] NASR/CIFP/plates audited and syncable before the charts build.
- [x] The verdict's `valid_until` is the 0901Z effective time, and the tablet refuses only from then.

## 5. Tablet expiry UI (user-visible, manual update)
- [x] Device manifest stores `expiration_date` per product at sync. Data Status uses it offline.
- [x] Plate viewer and procedure picker show the cycle, red when expired.
- [x] Status-bar badge covers plates/CIFP.
- [x] Partly-synced state marked.

## 6. Pre-staging the next cycle (design, Dana approves)
- [ ] Brainstorm/spec: build and audit the next cycle days ahead; tablet downloads it ahead and switches at 0901Z.

## Status (2026-10-17)
1-5 done:
- pipeline 191cec1, 960f69e;
- flytab v11.57 (this commit);
- cron at 05:15;
- 33 GB of unused terrain zips deleted (Dana).

Not done or deferred:
- 6 (design);
- route-planner procedure sheet has no currency line;
- FETCH_LOCK queueing after a JS timeout (M5);
- CIFP IndexedDB bundle/cycle in two records;
- case-insensitive plate prune;
- removing a state leaves its index entries (audit fails loudly).
