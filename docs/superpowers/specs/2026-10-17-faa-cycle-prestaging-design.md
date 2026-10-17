# Pre-staging the next FAA cycle — design

Date: 2026-10-17. Repos: flytab-pipeline (server), flytab (tablet reminder).
Status: approved in conversation (approach A + C, Parts 1–3, then trimmed per
Dana's "Elon rule": delete what isn't needed); awaiting Dana's review of this spec.

## Goal

On the morning of an FAA cycle change, current data can be synced from 05:01
local (0901Z). Two cases must work:

- **Cycle-day morning flight from home:** sync on home WiFi after the changeover.
- **Away from home:** sync over Tailscale (FlyTab already falls back to it).

Today the server only starts downloading and building at 05:15 on the
effective date, so nothing new can be synced for 1–3 hours (about 8 hours
before the round-2 fixes).

Out of scope (Dana): the tablet carrying two cycles, switching by itself, and
switching in flight. The tablet's 0901Z expiry warnings (v11.57) remain the
safety net if the pilot hasn't synced.

## Facts this rests on

- The FAA posts the next cycle ahead of the effective date. From the logs:
  - the d-TPP for 2611 (10-29) was online on 10-17, 12 days ahead;
  - NASR, CIFP and d-TPP for 2610 downloaded on 09-27, 4 days ahead;
  - all 09-03 sectionals downloaded on 08-30, 4 days ahead (cron.log).

  Not yet checked: how early the A/FD (Chart Supplement) is posted, and
  whether charts appear more than 4 days ahead. Staging works either way,
  with less margin.
- Home server disk: 45 GB free after deleting the terrain zips.
  Staging needs about:
  - 9 GB kept (plates about 6.2 GB, mbtiles 2.3 GB, NASR and CIFP);
  - up to 29 GB of temporary chart files while charts build.
- The tablet is not limited: 162 GB free.

## Design

### 1. Building the next cycle ahead (server)

**Cycle setting.**
- `config.py` takes the cycle from the environment variable
  `FLYTAB_CYCLE_DATE=YYYY-MM-DD` (the 28-day effective date) when set.
  The chart edition comes from `update_cycle.current_chart_cycle_date(that date)`.
- It derives these from that one date:
  - `NASR_CYCLE_DATE`, `NASR_CYCLE_EXPIRATION`;
  - `DTPP_CYCLE_CODE`, `CIFP_CYCLE_CODE`;
  - `CHART_CYCLE_DATE`, `CHART_CYCLE_DATE_ISO`, `CHART_CYCLE_EXPIRATION_ISO`;
  - `DTPP_META_CYCLE`.
- Unset: the values `update_cycle.py` writes, as today.
- `FLYTAB_DATA_DIR` overrides `DATA_DIR` (and with it `MANIFEST_PATH` and
  every output dir derived from it).

**Staging.**
- `stage_next.py` decides whether the next cycle is due:
  - the next 28-day effective date is within **7 days**;
  - or the next chart edition is within 7 days (for charts only).
- It then runs `build_all.py --no-audit` with `FLYTAB_CYCLE_DATE=<next>` and
  `FLYTAB_DATA_DIR=data-next`, for the products not yet staged:
  - NASR, CIFP, plates, A/FD and plate zips, every 28-day cycle;
  - the chart steps and mbtiles, only when the chart edition changes on that
    date.
- Staged charts keep only `data-next/mbtiles/*.mbtiles`. The webp tile folders
  are deleted after packing.
- A download that 404s or fails means "not posted yet / try tomorrow". Nothing
  is retried within the same day. There is no separate availability check.

**Checking the staged data.**
- `audit_currency.py --data-dir data-next --for-date <next effective date>`
  judges it as of the new cycle (`expected(<next>)`).
- The verdict goes into `data-next/manifest.json` (`audit`), the same
  per-product format as today.
- A product counts as staged when its entry there has `ok: true`.
- `data-next/` is never served: `start-home-server.sh` serves `data/` only.
  This is checked in a test.

**Daily retry.** A product not staged (build or audit failed) is tried again
on the next daily run, until the effective date.

### 2. The swap at 0901Z (server)

**Schedule:** a systemd user timer replaces the cron entry, because the home
server is sometimes switched off at night (Dana, 2026-10-17).

- `~/.config/systemd/user/flytab-pipeline.timer`: `OnCalendar=*-*-* 05:05`,
  `Persistent=true`. A run missed while the PC was off happens at the next
  boot. Linger is on for the user (checked: `Linger=yes`), so it runs before
  login.
- `flytab-pipeline.service`: `ExecStart=run_pipeline.sh`, logging to
  `logs/cron.log` as now. It first waits up to 2 minutes for the network
  (`ExecStartPre` polls DNS for aeronav.faa.gov), because a run at boot can
  start before WiFi is up.
- The cron line is removed once the timer is installed. Only one scheduler
  ever runs the pipeline; `run_pipeline.sh`'s lock covers an overlap anyway.
- 05:05 local is 0901Z + 4 min under EDT, and + 64 min under EST (from
  11-01).

**First step of `run_pipeline.sh`:** when today's 28-day effective date
equals `data-next`'s cycle, `stage_next.py --promote` runs:
- for each product whose staged audit entry has `ok: true`, it renames the
  product's paths from `data-next/` into `data/`;
- the old `data/` paths are deleted first (`os.replace` into place; the
  previous cycle is not kept);
- it copies that product's manifest section into `data/manifest.json`;
- products not staged stay as they are.

Product → paths:

| Product | Paths |
|---|---|
| nasr | `nasr/` |
| cifp | `cifp/` |
| plates (+ afd) | `plates/` |
| charts:\<layer\> | `mbtiles/<layer>.mbtiles` and its `tiles` manifest entry |

**Then the run continues as today:**
- products already current are skipped (`update_cycle` and `.last_cycle`
  updated for a promoted 28-day cycle);
- products not promoted are built on the day (the existing path, which is the
  fallback);
- the full audit gives the live verdict;
- NASR and CIFP are published.

The tablet needs no "building" mark during the swap. From 0901Z the previous
verdict has passed its `valid_until`, so the tablet refuses until the new
audit is written, a few minutes later.

### 3. Temporary FAA files (server)

**Evidence at download.** When a source passes `download_file`'s check, the
product's builder writes a server-only `source.json` in the product folder.
It moves with the product at the swap and is never shipped:

- `cifp.zip` contains only the bundle and the cycle info;
- `nasr.zip` contains named files;
- `checksums.json` lists named files.

Contents:
- `cifp/source.json`: `{header_cycle, source_sha256, bundle_sha256}`;
- `nasr/source.json`: `{edition, source_sha256, bundle_sha256}` (edition e.g. `01_Oct_2026`).

`audit_cifp` and `audit_nasr` check these instead of opening `tmp/`. The
bundle hash ties the served bundle to the checked source.

*(Changed while planning: the conversation said "the existing cycle_info
files", but `cycle_info.json` ships to the tablet inside `nasr.zip`. Changing
it would make every tablet's verify step report the current NASR as
different.)*

**Kept in `tmp/`:**
- the d-TPP metafile (a few MB, used to rebuild the plate index and by the
  audit's list of current charts);
- the A/FD index XML.

**Deleted** when that cycle's products pass their audit (staged or live):
- d-TPP volumes;
- NASR zip and `nasr_extracted/`;
- CIFP zip;
- chart zips, GeoTIFFs, intermediates and mosaic tiles.

Rule: `tmp/` holds only sources of cycles still being built. A failed build
keeps its sources, so the retry needs no new download from aeronav.

### 4. Reminder the day before (tablet)

At startup, `_checkDataReadiness` checks every FAA product (FaaCurrency) whose
expiry is less than 24 h away and adds one warning:

> **New FAA cycle at 05:01 tomorrow (0901Z) — sync on home WiFi before flying**

- The local time is computed from 0901Z on the device, so it is correct in
  EDT and EST.
- It replaces that product's "expires in 0d" warning.

No other tablet change. The status-bar badge already shows amber
(`PLATES 0d`) in the last days.

## Failures

| What fails | What happens |
|---|---|
| Staging (download or build) | Retried daily until the effective date. Desktop notice "Staging 2611 failed: plates — retried tomorrow; built on the day if still failing" |
| Not staged by the effective date | Built on the day at 05:05, as today. The tablet keeps expired-red data until synced |
| A staged product fails its audit | Not promoted, built on the day |
| Swap fails partway | Products are independent. One not swapped is built on the day; one swapped and broken fails the live audit, and the tablet refuses it |
| Server PC off at 05:05 on cycle day | The timer's `Persistent=true` runs the missed job at the next boot (before login, linger on). The swap happens then, and you sync after it |

## Testing (no FAA requests in tests)

- **config:** `FLYTAB_CYCLE_DATE` and `FLYTAB_DATA_DIR` drive every derived
  constant. Checked for 10-29 (2611; chart edition 10-29), 11-26 (2612) and
  12-24 (2613; chart edition 12-24).
- **`stage_next`:**
  - due and not-due decisions;
  - only unstaged products are rebuilt;
  - charts only on chart dates;
  - the staged webp tiles are removed.
- **Audit `--for-date`** on a staged tree.
- **Promote:**
  - only `ok` products move, with the right paths and manifest sections;
  - the previous data is deleted;
  - a failed product stays and is built on the day.
- **`run_pipeline.sh` with stub steps:** the promote step runs first on the
  effective date; the day-of build only covers what wasn't promoted.
- **Audit from cycle info:** a CIFP or NASR edition mismatch is caught without
  `tmp/` zips.
- **Temporary-file cleanup:** deleted on pass, kept on failure; the metafile
  and A/FD XML are kept.
- **Tablet:** the banner appears less than 24 h before expiry, with local
  05:01 (EDT) or 04:01 (EST).
- **Timer:**
  - `systemd-analyze calendar` and `systemctl --user list-timers` show the
    next run;
  - a test start (`systemctl --user start flytab-pipeline.service`) runs one
    real pipeline pass;
  - a missed run is simulated by stopping the timer past 05:05 and starting
    it again, after which it fires.
- **Rehearsal on the real server before 10-29:**
  1. stage 2611 for real (from 10-22);
  2. run the audit on `data-next`;
  3. `stage_next.py --promote --dry-run` lists what it would rename.

## Interfaces

- `FLYTAB_CYCLE_DATE` (`YYYY-MM-DD`, the 28-day effective date) and
  `FLYTAB_DATA_DIR` (path), read by `config.py`.
- `stage_next.py [--promote] [--dry-run]`: exit 0 when nothing is due or all
  due products are staged or promoted; exit 1 when a due product failed.
- `audit_currency.py --data-dir <dir> --for-date <YYYY-MM-DD>`.
- `data-next/manifest.json`: same sections as `data/manifest.json`, with
  `audit.products.<product>.ok` deciding promotion.
- `nasr/source.json`: `{edition, source_sha256, bundle_sha256}`.
- `cifp/source.json`: `{header_cycle, source_sha256, bundle_sha256}`.

## Not included (deleted from the earlier draft)

- `data-prev/` rollback: the previous cycle is expired after 0901Z.
- A separate "is it posted yet?" check: the download itself answers it.
- One shared `sources.json`: each product folder carries its own `source.json`.
- A separate cleanup of older cycles: covered by the one tmp rule.
- A "building" mark during the swap.
- A `next` manifest entry and a Data Status "Next:" line.
- Banner repeats.
- A login catch-up check: the timer's `Persistent=true` does this.
