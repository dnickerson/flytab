# Pre-staging the next FAA cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the home server builds and audits the next FAA cycle up to 7 days ahead in `data-next/`, swaps it into `data/` at the 0901Z changeover, and deletes FAA source files once a cycle passes. The tablet reminds the pilot the day before.

**Architecture:** the existing builders run unchanged, pointed at another cycle and output folder by two environment variables read in `config.py`.
- `stage_next.py` decides what is due, seeds and builds `data-next/`, audits it as of its effective date, and promotes the audited products by folder rename.
- `tmp_cleanup.py` removes sources of cycles that passed.
- `run_pipeline.sh` calls them, from a persistent systemd user timer that replaces cron.
- The tablet gets one startup warning.

**Tech stack:** Python 3.12 (pipeline, pytest), bash, systemd user units, vanilla JS (FlyTab, vitest).

**Spec:** `docs/superpowers/specs/2026-10-17-faa-cycle-prestaging-design.md` (flytab repo).

## Global Constraints

- Never burst requests at aeronav.faa.gov: one request per source file, sequential, and no same-day retry of a failed download. Tests make no FAA request.
- Pipeline work is on branch `fix/plate-charts` in `~/flytab-pipeline`.
- `config.py` holds uncommitted cycle values written by cron (`NASR_CYCLE_DATE`, `NASR_CYCLE_EXPIRATION`, `DTPP_CYCLE_CODE`, `CIFP_CYCLE_CODE`). Commit only your own hunks: build the blob from the working file with those four lines restored to HEAD's values, then `git hash-object -w` + `git update-index --cacheinfo 100644,<sha>,config.py`.
- `data-next/` is never served: `start-home-server.sh` serves `$PIPELINE_DIR/data` only.
- Changeover: 0901Z on the effective date. Promotion must not happen before it, even when the timer catches up a missed run at boot.
- FlyTab changes:
  - bump `FLYTAB_VERSION` in `web/app.js`, then `bash build.sh`;
  - update `docs/user-manual.md` for user-visible changes;
  - design tokens only; light theme.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Deadline: staging window for 2611 opens 2026-10-22; rehearsal (Task 9) before 2026-10-29.

## Review Focus

1. **A timer catch-up at boot before 0901Z on the effective date** (PC switched on at 04:00 EDT): nothing is promoted. Covered by the Task 5 test `test_promote_refuses_before_0901z`.
2. **Staged plates must carry the A/FD pages.** The whole `plates/` folder is swapped, so the staged folder must hold every A/FD page and its records, or the tablet loses A/FD after the swap. Covered by Task 4 `test_seed_copies_afd_pages_records_and_geo_context` and Task 5 `test_promote_requires_afd_ok_for_plates`.
3. **A cycle with no new chart edition** (11-26) stages no charts and promotes none; the live charts stay. Covered by Task 4 `test_due_products_charts_only_on_chart_dates`.
4. **The daily audit still passes after `tmp/` is cleaned** (it reads `source.json`, not zips). Covered by Task 3 `test_audit_cifp_nasr_from_source_json_without_tmp` and Task 6 `test_cleanup_keeps_what_the_audit_needs`.
5. **A leftover `data-next/` from a cycle that was never promoted** (e.g. staged 10-29, now 11-26) is never promoted onto the wrong date, and is wiped before staging the next one. A server switched off all of the effective date still promotes when it next runs. Covered by Task 5 `test_promote_ignores_another_cycles_staging`, `test_promote_catches_up_after_a_day_switched_off` and Task 4 `test_stale_staging_is_wiped`.

---

### Task 1: cycle and data-dir overrides in config.py

**Files:**
- Modify: `~/flytab-pipeline/config.py` (cycle block, lines ~33–42; `DATA_DIR` ~47)
- Test: `~/flytab-pipeline/tests/test_config_overrides.py`

**Interfaces:**
- Produces: environment `FLYTAB_CYCLE_DATE=YYYY-MM-DD` (28-day effective date) and `FLYTAB_DATA_DIR=<path>`. When set, `config.NASR_CYCLE_DATE`, `NASR_CYCLE_EXPIRATION`, `DTPP_CYCLE_CODE`, `CIFP_CYCLE_CODE`, `CHART_CYCLE_DATE` (MM-DD-YYYY), `CHART_CYCLE_DATE_ISO`, `CHART_CYCLE_EXPIRATION_ISO`, `DTPP_META_CYCLE`, `DATA_DIR`, `MANIFEST_PATH` and all `*_OUTPUT_DIR` follow them. `PLATE_STATES` always comes from `PIPELINE_DIR/data/plate_states_config.json`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config_overrides.py
"""config.py follows FLYTAB_CYCLE_DATE / FLYTAB_DATA_DIR (pre-staging, 2026-10-17)."""
import json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).parent.parent

def _cfg(env):
    code = ("import config, json; print(json.dumps({k: str(getattr(config, k)) for k in "
            "['NASR_CYCLE_DATE','NASR_CYCLE_EXPIRATION','DTPP_CYCLE_CODE','CIFP_CYCLE_CODE','CHART_CYCLE_DATE',"
            "'CHART_CYCLE_DATE_ISO','CHART_CYCLE_EXPIRATION_ISO','DTPP_META_CYCLE','DATA_DIR','MANIFEST_PATH',"
            "'PLATES_OUTPUT_DIR','MBTILES_OUTPUT_DIR','NASR_URL','DTPP_META_URL','SECTIONAL_URL_TEMPLATE']}))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env={**os.environ, **env},
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def test_cycle_2611_with_new_chart_edition():
    c = _cfg({"FLYTAB_CYCLE_DATE": "2026-10-29", "FLYTAB_DATA_DIR": "/tmp/dn"})
    assert (c["NASR_CYCLE_DATE"], c["NASR_CYCLE_EXPIRATION"]) == ("2026-10-29", "2026-11-26")
    assert (c["DTPP_CYCLE_CODE"], c["CIFP_CYCLE_CODE"], c["DTPP_META_CYCLE"]) == ("261029", "261029", "2611")
    assert (c["CHART_CYCLE_DATE"], c["CHART_CYCLE_DATE_ISO"], c["CHART_CYCLE_EXPIRATION_ISO"]) == ("10-29-2026", "2026-10-29", "2026-12-24")
    assert c["DATA_DIR"] == "/tmp/dn" and c["MANIFEST_PATH"] == "/tmp/dn/manifest.json"
    assert c["PLATES_OUTPUT_DIR"] == "/tmp/dn/plates" and c["MBTILES_OUTPUT_DIR"] == "/tmp/dn/mbtiles"
    assert "Effective_2026-10-29" in c["NASR_URL"] and "/d-tpp/2611/" in c["DTPP_META_URL"]
    assert "/visual/10-29-2026/" in c["SECTIONAL_URL_TEMPLATE"]

def test_cycle_2612_keeps_the_chart_edition():
    c = _cfg({"FLYTAB_CYCLE_DATE": "2026-11-26"})
    assert (c["DTPP_META_CYCLE"], c["CHART_CYCLE_DATE_ISO"]) == ("2612", "2026-10-29")

def test_unset_uses_the_written_values():
    c = _cfg({})
    import config
    assert c["NASR_CYCLE_DATE"] == config.NASR_CYCLE_DATE and c["DATA_DIR"].endswith("/data")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/flytab-pipeline && python3 -m pytest tests/test_config_overrides.py -q`
Expected: FAIL (`NASR_CYCLE_DATE` stays the written value).

- [ ] **Step 3: Implement.** In `config.py`, directly after the line `CIFP_CYCLE_CODE = "...."` (the cron-written block stays untouched above it):

```python
# Pre-staging (2026-10-17): build another cycle into another folder. One
# date decides every cycle value; unset: the values update_cycle.py writes.
_OVERRIDE_CYCLE = os.environ.get("FLYTAB_CYCLE_DATE")
if _OVERRIDE_CYCLE:
    _eff = date.fromisoformat(_OVERRIDE_CYCLE)
    from update_cycle import current_chart_cycle_date as _chart_of
    _chart = _chart_of(_eff)
    NASR_CYCLE_DATE = _eff.isoformat()
    NASR_CYCLE_EXPIRATION = (_eff + timedelta(days=28)).isoformat()
    DTPP_CYCLE_CODE = CIFP_CYCLE_CODE = _eff.strftime("%y%m%d")
    CHART_CYCLE_DATE = _chart.strftime("%m-%d-%Y")
    CHART_CYCLE_DATE_ISO = _chart.isoformat()
    CHART_CYCLE_EXPIRATION_ISO = (_chart + timedelta(days=56)).isoformat()
```

Change `DATA_DIR = PIPELINE_DIR / "data"` to:

```python
DATA_DIR = Path(os.environ["FLYTAB_DATA_DIR"]) if os.environ.get("FLYTAB_DATA_DIR") else PIPELINE_DIR / "data"
```

Check that `update_cycle.py` does not import `config` at module level; if it does, move the import of `current_chart_cycle_date` inside the `if` block (as written) to avoid a cycle. `DTPP_META_CYCLE` and the URLs further down already derive from these names.

- [ ] **Step 4: Run tests.** `python3 -m pytest tests/ -q`: all pass.

- [ ] **Step 5: Commit only your hunks** (see Global Constraints):

```bash
python3 - <<'EOF'
import subprocess
s = open('config.py').read()
head = subprocess.run(['git','show','HEAD:config.py'], capture_output=True, text=True).stdout
for name in ('NASR_CYCLE_DATE = ', 'NASR_CYCLE_EXPIRATION = ', 'DTPP_CYCLE_CODE = ', 'CIFP_CYCLE_CODE = '):
    cur = next(l for l in s.splitlines() if l.startswith(name))
    old = next(l for l in head.splitlines() if l.startswith(name))
    s = s.replace(cur, old, 1)
open('/tmp/config_commit.py','w').write(s)
EOF
git update-index --cacheinfo 100644,$(git hash-object -w /tmp/config_commit.py),config.py
git add tests/test_config_overrides.py
git commit -m "feat(config): FLYTAB_CYCLE_DATE / FLYTAB_DATA_DIR build another cycle into another folder"
git diff --cached --stat; git status --short   # config.py still shows the cron values unstaged
```

---

### Task 2: per-cycle temporary names (metafile, NASR extract)

**Files:**
- Modify: `build_plates_for_states.py:45` (`META_FILE`)
- Modify: `build_nasr.py:26` (`EXTRACT_DIR`)
- Modify: `audit_currency.py` `run_audit` (metafile path)
- Test: `tests/test_tmp_names.py`

**Interfaces:**
- Produces: `META_FILE = PLATES_TMP / f"d-TPP_Metafile_{DTPP_META_CYCLE}.xml"`; `EXTRACT_DIR = TMP_DIR / f"nasr_extracted_{NASR_CYCLE_DATE}"`. `audit_currency.metafile_path(tmp_dir, cycle) -> Path` returns `tmp_dir / "plates" / f"d-TPP_Metafile_{cycle}.xml"`.

- [ ] **Step 1: Failing test**

```python
# tests/test_tmp_names.py
"""Two cycles' temporary files side by side (pre-staging): the shared names
d-TPP_Metafile.xml and nasr_extracted/ would be overwritten by the next cycle."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import audit_currency as au, build_nasr as bn, build_plates_for_states as bp, config

def test_names_carry_the_cycle():
    assert bp.META_FILE.name == f"d-TPP_Metafile_{config.DTPP_META_CYCLE}.xml"
    assert bn.EXTRACT_DIR.name == f"nasr_extracted_{config.NASR_CYCLE_DATE}"
    assert au.metafile_path(Path("/t"), "2611") == Path("/t/plates/d-TPP_Metafile_2611.xml")
```

- [ ] **Step 2:** `python3 -m pytest tests/test_tmp_names.py -q`: FAIL.
- [ ] **Step 3: Implement.**
  - In `build_plates_for_states.py`, `META_FILE = PLATES_TMP / f"d-TPP_Metafile_{DTPP_META_CYCLE}.xml"`; import `DTPP_META_CYCLE` from config if it isn't already.
  - In `build_nasr.py`, `EXTRACT_DIR = TMP_DIR / f"nasr_extracted_{NASR_CYCLE_DATE}"`.
  - In `audit_currency.py`:

```python
def metafile_path(tmp_dir: Path, cycle: str) -> Path:
    """This cycle's d-TPP metafile (kept per cycle: two cycles are built side by side)."""
    return tmp_dir / "plates" / f"d-TPP_Metafile_{cycle}.xml"
```

  and in `run_audit` replace `tmp_dir / "plates" / "d-TPP_Metafile.xml"` with `metafile_path(tmp_dir, exp["cycle"])`.

  Update `tests/test_audit_currency.py` and any test that builds `d-TPP_Metafile.xml` in a tmp tree to use the new name (grep `d-TPP_Metafile.xml` in `tests/`).
- [ ] **Step 4: Migrate the live tmp once** (data step, not code):
  - `mv tmp/plates/d-TPP_Metafile.xml tmp/plates/d-TPP_Metafile_2610.xml`
  - `mv tmp/nasr_extracted tmp/nasr_extracted_2026-10-01`
  - Then `python3 audit_currency.py`: PASS.
- [ ] **Step 5:** run all tests; commit `build_plates_for_states.py build_nasr.py audit_currency.py tests/`.

---

### Task 3: server-only `source.json` evidence; audit reads it

**Files:**
- Create: `source_evidence.py` (small shared helpers)
- Modify: `build_cifp.py` (`build_cifp_pipeline`, cycle-info write order)
- Modify: `build_nasr.py` (after `require_complete`, before `nasr.zip`)
- Modify: `audit_currency.py` (`audit_cifp`, `audit_nasr`)
- Test: `tests/test_source_evidence.py`

**Interfaces:**
- Produces:
  - `source_evidence.sha256(path) -> str`;
  - `source_evidence.cifp_header_cycle(zip_path) -> str` (last 4 chars of token 2 of the `FAACIFP18` first line, `""` if not a CIFP header);
  - `source_evidence.nasr_edition(zip_path) -> str` (e.g. `"01_Oct_2026"`, from `CSV_Data/<edition>_CSV.zip`, `""` if none);
  - `source_evidence.write(product_dir, **fields)` writes `product_dir/source.json` atomically.
- Files:
  - `cifp/source.json`: `{"header_cycle", "source_sha256", "bundle_sha256"}`;
  - `nasr/source.json`: `{"edition", "source_sha256", "bundle_sha256"}`.
- `audit_cifp(exp, cifp_dir)` and `audit_nasr(exp, nasr_dir)` no longer take `tmp_dir`.

- [ ] **Step 1: Failing tests**

```python
# tests/test_source_evidence.py
"""Audit evidence kept with the product (source.json), so FAA source zips can
be deleted from tmp/ (pre-staging). Never shipped: cifp.zip and nasr.zip name
their members, checksums.json names its files."""
import hashlib, json, sys, zipfile
from datetime import date
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).parent.parent))
import audit_currency as au, source_evidence as se

EXP = au.expected(date(2026, 10, 16))

def test_helpers(tmp_path):
    c = tmp_path / "cifp.zip"
    with zipfile.ZipFile(c, "w") as z:
        z.writestr("FAACIFP18", "HDR01FAACIFP18      001P013203969192610  09-SEP-2026\n")
    n = tmp_path / "nasr.zip"
    with zipfile.ZipFile(n, "w") as z:
        z.writestr("CSV_Data/01_Oct_2026_CSV.zip", b"x")
    assert se.cifp_header_cycle(c) == "2610"
    assert se.nasr_edition(n) == "01_Oct_2026"
    assert se.sha256(c) == hashlib.sha256(c.read_bytes()).hexdigest()
    se.write(tmp_path, a=1)
    assert json.loads((tmp_path / "source.json").read_text()) == {"a": 1}

def _cifp_dir(tmp_path, header="2610", bundle=b"{}", recorded=None):
    d = tmp_path / "cifp"; d.mkdir(parents=True)
    (d / "cifp_cycle_info.json").write_text(json.dumps({"cycle_code": "261001"}))
    (d / "cifp_bundle.json").write_bytes(bundle)
    se.write(d, header_cycle=header, source_sha256="s", bundle_sha256=recorded or hashlib.sha256(bundle).hexdigest())
    return d

def test_audit_cifp_nasr_from_source_json_without_tmp(tmp_path):
    assert au.audit_cifp(EXP, _cifp_dir(tmp_path / "a")) == []
    assert any("header" in x for x in au.audit_cifp(EXP, _cifp_dir(tmp_path / "b", header="2609")))
    assert any("not the bundle built" in x for x in au.audit_cifp(EXP, _cifp_dir(tmp_path / "c", recorded="0" * 64)))
    d = tmp_path / "nasr"; d.mkdir()
    (d / "cycle_info.json").write_text(json.dumps({"effective_date": "2026-10-01"}))
    bundle = json.dumps({"airports": [{}] * 19135, "navaids": [{}] * 1440, "airways": [{}] * 1230,
        "fixes": [{}] * 70129, "sua": [{}] * 1236,
        "airspace": [{"class": c} for c, k in (("B", 369), ("C", 340), ("D", 578), ("E", 4325)) for _ in range(k)]}).encode()
    (d / "bundle.json").write_bytes(bundle)
    se.write(d, edition="01_Oct_2026", source_sha256="s", bundle_sha256=hashlib.sha256(bundle).hexdigest())
    assert au.audit_nasr(EXP, d) == []
    se.write(d, edition="03_Sep_2026", source_sha256="s", bundle_sha256=hashlib.sha256(bundle).hexdigest())
    assert any("01_Oct_2026" in x for x in au.audit_nasr(EXP, d))
    (d / "source.json").unlink()
    assert any("source.json" in x for x in au.audit_nasr(EXP, d))
```

- [ ] **Step 2:** `python3 -m pytest tests/test_source_evidence.py -q`: FAIL (no module `source_evidence`).
- [ ] **Step 3: Implement `source_evidence.py`**

```python
"""Evidence that a product was built from the right FAA source, kept in the
product folder (source.json) so the source zips can leave tmp/ (pre-staging,
2026-10-17). Server-only: never inside cifp.zip, nasr.zip or checksums.json."""
import hashlib, json, os, zipfile
from pathlib import Path

def sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def cifp_header_cycle(zip_path) -> str:
    with zipfile.ZipFile(zip_path) as z:
        header = z.open("FAACIFP18").readline().decode("ascii", "replace")
    tokens = header.split()
    return tokens[1][-4:] if header.startswith("HDR01FAACIFP18") and len(tokens) > 1 else ""

def nasr_edition(zip_path) -> str:
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            if n.startswith("CSV_Data/") and n.endswith("_CSV.zip"):
                return n[len("CSV_Data/"):-len("_CSV.zip")]
    return ""

def write(product_dir, **fields):
    p = Path(product_dir) / "source.json"
    tmp = p.with_name("source.json.tmp")
    tmp.write_text(json.dumps(fields, indent=1, sort_keys=True))
    os.replace(tmp, p)
```

- [ ] **Step 4: Builders.**
  - In `build_cifp.py` `build_cifp_pipeline`:
    - move the `cifp_cycle_info.json` write and `update_manifest('cifp', ...)` to **after** `export_cifp_bundle()` (the label follows the bundle);
    - then call `source_evidence.write(CIFP_OUTPUT_DIR, header_cycle=source_evidence.cifp_header_cycle(CIFP_ZIP), source_sha256=source_evidence.sha256(CIFP_ZIP), bundle_sha256=source_evidence.sha256(CIFP_OUTPUT_DIR / "cifp_bundle.json"))`.
  - In `build_nasr.py`, after the `nasr.zip` swap and before `update_manifest('nasr', ...)`: `source_evidence.write(NASR_OUTPUT_DIR, edition=source_evidence.nasr_edition(NASR_ZIP), source_sha256=source_evidence.sha256(NASR_ZIP), bundle_sha256=source_evidence.sha256(bundle_path))`.
- [ ] **Step 5: Audit.** Replace the bodies of `audit_cifp` and `audit_nasr` (drop the `tmp_dir` parameter and update the two calls in `run_audit`):

```python
def audit_cifp(exp: dict, cifp_dir: Path) -> list:
    f = []
    info_file = cifp_dir / "cifp_cycle_info.json"
    info = json.loads(info_file.read_text()) if info_file.exists() else {}
    if info.get("cycle_code") != exp["code"]:
        _fail(f, f"cifp_cycle_info.json says {info.get('cycle_code')}; current is {exp['code']}")
    src = cifp_dir / "source.json"
    if not src.exists():
        return f + ["cifp/source.json missing -- the bundle's FAA source is unknown"]
    rec = json.loads(src.read_text())
    if rec.get("header_cycle") != exp["cycle"]:
        _fail(f, f"FAA CIFP header said cycle {rec.get('header_cycle')!r}; current is {exp['cycle']}")
    bundle = cifp_dir / "cifp_bundle.json"
    if not bundle.exists():
        _fail(f, "cifp_bundle.json missing")
    elif sha256_file(bundle) != rec.get("bundle_sha256"):
        _fail(f, "cifp_bundle.json is not the bundle built from the checked FAA source")
    return f


def audit_nasr(exp: dict, nasr_dir: Path) -> list:
    f = []
    info_file = nasr_dir / "cycle_info.json"
    info = json.loads(info_file.read_text()) if info_file.exists() else {}
    if info.get("effective_date") != exp["effective"].isoformat():
        _fail(f, f"NASR cycle_info.json effective {info.get('effective_date')}; current is {exp['effective']}")
    src = nasr_dir / "source.json"
    if not src.exists():
        return f + ["nasr/source.json missing -- the bundle's FAA source is unknown"]
    rec = json.loads(src.read_text())
    want = exp["effective"].strftime("%d_%b_%Y")
    if rec.get("edition") != want:
        _fail(f, f"FAA NASR source was the {rec.get('edition')} edition; current is {want}")
    bundle = nasr_dir / "bundle.json"
    if not bundle.exists():
        _fail(f, "NASR bundle.json missing")
    else:
        if sha256_file(bundle) != rec.get("bundle_sha256"):
            _fail(f, "NASR bundle.json is not the bundle built from the checked FAA source")
        try:
            f += nasr_completeness(json.loads(bundle.read_text()))
        except ValueError as e:
            _fail(f, f"NASR bundle.json unreadable: {e}")
    return f
```

  Add `from source_evidence import sha256 as sha256_file` at the top of `audit_currency.py`. Update the existing tests that call `audit_cifp(..., tmp)` / `audit_nasr(..., tmp)` (`tests/test_audit_currency.py`, `tests/test_audit_review.py`) to write `source.json` instead of tmp zips.

- [ ] **Step 6: Backfill the live cycle once** (data step; the 2610 sources are still in `tmp/`):

```bash
cd ~/flytab-pipeline && python3 - <<'EOF'
import source_evidence as se
from pathlib import Path
d = Path('data')
se.write(d/'cifp', header_cycle=se.cifp_header_cycle('tmp/cifp_261001.zip'),
         source_sha256=se.sha256('tmp/cifp_261001.zip'), bundle_sha256=se.sha256(d/'cifp/cifp_bundle.json'))
se.write(d/'nasr', edition=se.nasr_edition('tmp/nasr_2026-10-01.zip'),
         source_sha256=se.sha256('tmp/nasr_2026-10-01.zip'), bundle_sha256=se.sha256(d/'nasr/bundle.json'))
EOF
python3 audit_currency.py   # PASS; checksums.json count unchanged (17,404): source.json is not listed
```

- [ ] **Step 7:** run all tests; commit `source_evidence.py build_cifp.py build_nasr.py audit_currency.py tests/`.

---

### Task 4: `stage_next.py` — decide, seed, build, audit

**Files:**
- Create: `~/flytab-pipeline/stage_next.py`
- Modify: `audit_currency.py` (`--for-date`)
- Test: `tests/test_stage_next.py`

**Interfaces:**
- Consumes: Task 1 env vars; `build_all.py --no-audit --only <steps>`; `audit_currency.py --data-dir D --for-date YYYY-MM-DD --require P...`.
- Produces:
  - `stage_next.NEXT_DIR = PIPELINE_DIR / "data-next"`;
  - `next_cycle(today) -> date | None`: the next 28-day effective date within 7 days, else `None`;
  - `due_products(eff: date) -> list[str]` from `nasr cifp plates afd` and `charts:<layer>`, the latter when `current_chart_cycle_date(eff) == eff`;
  - `staged_ok(next_dir) -> set[str]` from `next_dir/manifest.json` `audit.products.<p>.ok is True`;
  - `seed(next_dir, live_dir)`;
  - `stage(today) -> int` (exit code);
  - CLI `python3 stage_next.py`.
- `STEPS_FOR = {"nasr": ["nasr"], "cifp": ["cifp"], "plates": ["plates", "plate-zips"], "afd": ["afd-pages", "plate-zips"], "charts:sectional": ["charts"], "charts:tac": ["charts-tac"], "charts:ifr-low": ["ifr-enroute-tiles"], "charts:ifr-area": ["ifr-area-tiles"]}`, plus `mbtiles` whenever any chart is staged.

- [ ] **Step 1: Failing tests**

```python
# tests/test_stage_next.py
"""Pre-staging the next FAA cycle into data-next/ (spec 2026-10-17)."""
import json, sys
from datetime import date
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).parent.parent))
import stage_next as sn

def test_next_cycle_window():
    assert sn.next_cycle(date(2026, 10, 21)) is None            # 8 days ahead
    assert sn.next_cycle(date(2026, 10, 22)) == date(2026, 10, 29)
    assert sn.next_cycle(date(2026, 10, 28)) == date(2026, 10, 29)
    assert sn.next_cycle(date(2026, 10, 29)) is None            # effective today: promote, not stage

def test_due_products_charts_only_on_chart_dates():
    base = ["afd", "cifp", "nasr", "plates"]
    assert sn.due_products(date(2026, 11, 26)) == base
    assert sn.due_products(date(2026, 10, 29)) == base + ["charts:ifr-area", "charts:ifr-low", "charts:sectional", "charts:tac"]

def test_steps_for_products():
    assert sn.steps_for(["nasr", "plates"]) == ["nasr", "plates", "plate-zips"]
    assert sn.steps_for(["charts:tac"]) == ["charts-tac", "mbtiles"]

def test_seed_copies_afd_pages_records_and_geo_context(tmp_path):
    live, nxt = tmp_path / "data", tmp_path / "data-next"
    (live / "plates" / "KTMB").mkdir(parents=True)
    (live / "plates" / "KTMB" / "AFD_PAGE.webp").write_bytes(b"page")
    (live / "plates" / "KTMB" / "05349AD.PDF").write_bytes(b"old cycle plate")
    for n in ("afd_pages.json", "afd_index.json"):
        (live / "plates" / n).write_text("{}")
    (live / "nasr").mkdir()
    (live / "nasr" / "geo_context.json").write_text("{}")
    sn.seed(nxt, live)
    assert (nxt / "plates" / "KTMB" / "AFD_PAGE.webp").read_bytes() == b"page"
    assert (nxt / "plates" / "afd_pages.json").exists() and (nxt / "plates" / "afd_index.json").exists()
    assert (nxt / "nasr" / "geo_context.json").exists()
    assert not (nxt / "plates" / "KTMB" / "05349AD.PDF").exists()      # plates come from the new cycle only

def test_stale_staging_is_wiped(tmp_path):
    nxt = tmp_path / "data-next"
    nxt.mkdir()
    (nxt / "manifest.json").write_text(json.dumps({"staging_for": "2026-10-29"}))
    (nxt / "leftover").write_text("x")
    sn.prepare(nxt, date(2026, 11, 26))
    assert not (nxt / "leftover").exists()
    assert json.loads((nxt / "manifest.json").read_text())["staging_for"] == "2026-11-26"
    (nxt / "kept").write_text("y")
    sn.prepare(nxt, date(2026, 11, 26))                       # same cycle: kept
    assert (nxt / "kept").exists()

def test_stage_builds_only_unstaged_products_and_audits_for_the_effective_date(tmp_path, monkeypatch):
    calls = []
    nxt = tmp_path / "data-next"
    monkeypatch.setattr(sn, "NEXT_DIR", nxt)
    monkeypatch.setattr(sn, "LIVE_DIR", tmp_path / "data")
    (tmp_path / "data").mkdir()
    monkeypatch.setattr(sn, "_run", lambda argv, env: calls.append((argv, env.get("FLYTAB_CYCLE_DATE"), env.get("FLYTAB_DATA_DIR"))) or 0)
    sn.prepare(nxt, date(2026, 11, 26))
    m = json.loads((nxt / "manifest.json").read_text())
    m["audit"] = {"products": {"nasr": {"ok": True}, "cifp": {"ok": True}}}
    (nxt / "manifest.json").write_text(json.dumps(m))
    assert sn.stage(date(2026, 11, 20)) == 0
    build, audit = calls
    assert build[0][-4:] == ["--only", "plates", "afd-pages", "plate-zips"] and build[1:] == ("2026-11-26", str(nxt))
    assert audit[0][1:] == ["audit_currency.py", "--data-dir", str(nxt), "--for-date", "2026-11-26",
                            "--require", "afd", "cifp", "nasr", "plates"]

def test_staging_is_never_served():
    sh = (Path(__file__).parent.parent / "start-home-server.sh").read_text()
    assert 'DATA_DIR="$PIPELINE_DIR/data"' in sh and "data-next" not in sh

def test_staged_chart_tiles_are_removed_after_packing(tmp_path):
    nxt = tmp_path / "data-next"
    (nxt / "tiles" / "sectional" / "8").mkdir(parents=True)
    (nxt / "mbtiles").mkdir()
    (nxt / "mbtiles" / "sectional.mbtiles").write_bytes(b"x")
    sn.drop_loose_tiles(nxt)
    assert not (nxt / "tiles").exists() and (nxt / "mbtiles" / "sectional.mbtiles").exists()
```

- [ ] **Step 2:** `python3 -m pytest tests/test_stage_next.py -q`: FAIL.
- [ ] **Step 3: `audit_currency.py --for-date`.** In `main` add `ap.add_argument("--for-date", type=date.fromisoformat, default=None)` and pass `today=args.for_date` to `run_audit`. Test: in `tests/test_audit_review.py` add

```python
def test_for_date_judges_as_of_that_date(tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(au, "run_audit", lambda **k: seen.update(k) or au.verdict({"nasr": []}, k["today"], au.expected(k["today"])))
    monkeypatch.setattr(au, "write_checksums", lambda *a: {"count": 0})
    with pytest.raises(SystemExit):
        au.main(["--data-dir", str(tmp_path), "--for-date", "2026-10-29"])
    assert seen["today"] == date(2026, 10, 29)
    assert json.loads((tmp_path / "manifest.json").read_text())["audit"]["cycle"] == "2611"
```

- [ ] **Step 4: Implement `stage_next.py`**

```python
#!/usr/bin/env python3
"""Pre-stage the next FAA cycle (spec 2026-10-17): from 7 days before its
effective date, build it into data-next/ with the normal builders and audit
it as of that date. data-next/ is never served; --promote (Task 5) swaps the
audited products in at 0901Z. A product that fails is retried on the next
daily run -- never the same day (aeronav refuses bursts)."""
import json, os, shutil, subprocess, sys
from datetime import date, timedelta
from pathlib import Path

import update_cycle

PIPELINE_DIR = Path(__file__).parent
LIVE_DIR = PIPELINE_DIR / "data"
NEXT_DIR = PIPELINE_DIR / "data-next"
WINDOW_DAYS = 7
BASE = ["afd", "cifp", "nasr", "plates"]
CHARTS = ["charts:ifr-area", "charts:ifr-low", "charts:sectional", "charts:tac"]
STEPS_FOR = {"nasr": ["nasr"], "cifp": ["cifp"], "plates": ["plates", "plate-zips"],
             "afd": ["afd-pages", "plate-zips"], "charts:sectional": ["charts"],
             "charts:tac": ["charts-tac"], "charts:ifr-low": ["ifr-enroute-tiles"],
             "charts:ifr-area": ["ifr-area-tiles"]}
ORDER = ["nasr", "cifp", "plates", "afd-pages", "plate-zips", "charts", "charts-tac",
         "ifr-enroute-tiles", "ifr-area-tiles", "mbtiles"]


def next_cycle(today: date):
    cur = update_cycle.current_cycle_date(today)
    nxt = cur + timedelta(days=28)
    return nxt if 0 < (nxt - today).days <= WINDOW_DAYS else None


def due_products(eff: date) -> list:
    charts = CHARTS if update_cycle.current_chart_cycle_date(eff) == eff else []
    return BASE + charts


def steps_for(products) -> list:
    want = {s for p in products for s in STEPS_FOR[p]}
    if any(p.startswith("charts:") for p in products):
        want.add("mbtiles")
    return [s for s in ORDER if s in want]


def staged_ok(next_dir: Path) -> set:
    try:
        products = json.loads((next_dir / "manifest.json").read_text())["audit"]["products"]
    except Exception:
        return set()
    return {k for k, v in products.items() if v.get("ok") is True}


def prepare(next_dir: Path, eff: date):
    """data-next/ for this effective date: another date's staging is wiped."""
    mf = next_dir / "manifest.json"
    try:
        for_ = json.loads(mf.read_text()).get("staging_for")
    except Exception:
        for_ = None
    if for_ != eff.isoformat():
        if next_dir.exists():
            shutil.rmtree(next_dir)
        next_dir.mkdir(parents=True)
        mf.write_text(json.dumps({"staging_for": eff.isoformat()}, indent=2))


def seed(next_dir: Path, live_dir: Path):
    """What the builders don't fetch per cycle: A/FD pages (+ records, index) --
    the plates folder is swapped whole -- and the static geo_context.json."""
    for f in (live_dir / "plates").glob("*/AFD_PAGE.webp"):
        dst = next_dir / "plates" / f.parent.name / f.name
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dst)
    for n in ("afd_pages.json", "afd_index.json"):
        if (live_dir / "plates" / n).exists() and not (next_dir / "plates" / n).exists():
            (next_dir / "plates").mkdir(parents=True, exist_ok=True)
            shutil.copy2(live_dir / "plates" / n, next_dir / "plates" / n)
    geo = live_dir / "nasr" / "geo_context.json"
    if geo.exists():
        (next_dir / "nasr").mkdir(parents=True, exist_ok=True)
        shutil.copy2(geo, next_dir / "nasr" / "geo_context.json")


def drop_loose_tiles(next_dir: Path):
    """Staged charts keep only the .mbtiles the tablet downloads (saves ~8 GB)."""
    if (next_dir / "tiles").exists():
        shutil.rmtree(next_dir / "tiles")


def _run(argv, env) -> int:
    return subprocess.run(argv, cwd=PIPELINE_DIR, env=env).returncode


def stage(today: date) -> int:
    eff = next_cycle(today)
    if eff is None:
        print("Pre-staging: nothing due")
        return 0
    prepare(NEXT_DIR, eff)
    seed(NEXT_DIR, LIVE_DIR)
    due = due_products(eff)
    todo = [p for p in due if p not in staged_ok(NEXT_DIR)]
    print(f"Pre-staging cycle {eff}: due {' '.join(due)}; to build: {' '.join(todo) or 'none'}")
    env = {**os.environ, "FLYTAB_CYCLE_DATE": eff.isoformat(), "FLYTAB_DATA_DIR": str(NEXT_DIR)}
    if todo:
        _run([sys.executable, "build_all.py", "--no-audit", "--only", *steps_for(todo)], env)
        drop_loose_tiles(NEXT_DIR)
    return _run([sys.executable, "audit_currency.py", "--data-dir", str(NEXT_DIR),
                 "--for-date", eff.isoformat(), "--require", *due], dict(os.environ))


if __name__ == "__main__":
    if "--promote" in sys.argv:
        from promote import main as promote_main   # Task 5
        sys.exit(promote_main(sys.argv[1:]))
    sys.exit(stage(date.today()))
```

Note on the test `test_stage_builds_only_unstaged...`: the build argv's last four items are `["--only", "plates", "afd-pages", "plate-zips"]`, from `steps_for(["afd", "plates"])` (nasr and cifp already ok).

- [ ] **Step 5:** `python3 -m pytest tests/ -q`: all pass.
- [ ] **Step 6:** commit `stage_next.py audit_currency.py tests/`.

---

### Task 5: promote at 0901Z (`promote.py`)

**Files:**
- Create: `~/flytab-pipeline/promote.py`
- Test: `tests/test_promote.py`

**Interfaces:**
- Consumes: `stage_next.NEXT_DIR`, `LIVE_DIR`, `staged_ok`, `due_products`; `next_dir/manifest.json` `staging_for`.
- Produces:
  - `promote(now_utc: datetime, next_dir, live_dir, dry_run=False) -> list[str]` (products promoted);
  - `PATHS = {"nasr": ["nasr"], "cifp": ["cifp"], "plates": ["plates"], "charts:<layer>": ["mbtiles/<layer>.mbtiles"]}`;
  - `afd` moves with `plates` and is required with it;
  - `main(argv) -> int`;
  - writes `PIPELINE_DIR/.last_cycle` with the effective date when nasr, cifp, plates and afd were all promoted.

- [ ] **Step 1: Failing tests**

```python
# tests/test_promote.py
"""The swap at the 0901Z changeover (spec 2026-10-17)."""
import json, sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import promote as pr

def _trees(tmp_path, ok=("nasr", "cifp", "plates", "afd"), staging_for="2026-10-29", charts=False):
    live, nxt = tmp_path / "data", tmp_path / "data-next"
    for d, tag in ((live, "old"), (nxt, "new")):
        for p in ("nasr", "cifp", "plates"):
            (d / p).mkdir(parents=True)
            (d / p / "f").write_text(tag)
        (d / "mbtiles").mkdir()
        (d / "mbtiles" / "sectional.mbtiles").write_text(tag)
    (live / "manifest.json").write_text(json.dumps({"nasr": {"v": "old"}, "tiles": {"sectional": {"v": "old"}}, "audit": {}}))
    products = {p: {"ok": p in ok} for p in ("nasr", "cifp", "plates", "afd", "charts:sectional")}
    if charts:
        products["charts:sectional"]["ok"] = True
    (nxt / "manifest.json").write_text(json.dumps({"staging_for": staging_for, "nasr": {"v": "new"}, "cifp": {"v": "new"},
        "plates": {"v": "new"}, "tiles": {"sectional": {"v": "new"}}, "audit": {"products": products}}))
    return live, nxt

AT = lambda iso: datetime.fromisoformat(iso).replace(tzinfo=timezone.utc)

import pytest

@pytest.fixture(autouse=True)
def _own_pipeline_dir(tmp_path, monkeypatch):
    # promote writes .last_cycle into PIPELINE_DIR: never the real one from a test
    monkeypatch.setattr(pr.sn, "PIPELINE_DIR", tmp_path)

def test_promote_refuses_before_0901z(tmp_path):
    live, nxt = _trees(tmp_path)
    assert pr.promote(AT("2026-10-29T09:00:00"), nxt, live) == []
    assert (live / "nasr" / "f").read_text() == "old"

def test_promote_moves_audited_products_and_their_manifest_sections(tmp_path):
    live, nxt = _trees(tmp_path)
    assert pr.promote(AT("2026-10-29T09:05:00"), nxt, live) == ["afd", "cifp", "nasr", "plates"]
    assert all((live / p / "f").read_text() == "new" for p in ("nasr", "cifp", "plates"))
    m = json.loads((live / "manifest.json").read_text())
    assert m["nasr"] == {"v": "new"} and m["tiles"]["sectional"] == {"v": "old"}     # charts not staged: untouched
    assert (live / "mbtiles" / "sectional.mbtiles").read_text() == "old"

def test_promote_requires_afd_ok_for_plates(tmp_path):
    live, nxt = _trees(tmp_path, ok=("nasr", "cifp", "plates"))
    assert pr.promote(AT("2026-10-29T09:05:00"), nxt, live) == ["cifp", "nasr"]
    assert (live / "plates" / "f").read_text() == "old"

def test_promote_charts_layer(tmp_path):
    live, nxt = _trees(tmp_path, charts=True)
    assert "charts:sectional" in pr.promote(AT("2026-10-29T09:05:00"), nxt, live)
    assert (live / "mbtiles" / "sectional.mbtiles").read_text() == "new"
    assert json.loads((live / "manifest.json").read_text())["tiles"]["sectional"] == {"v": "new"}

def test_promote_ignores_another_cycles_staging(tmp_path):
    live, nxt = _trees(tmp_path, staging_for="2026-10-29")
    assert pr.promote(AT("2026-11-26T09:05:00"), nxt, live) == []          # its cycle is over: never promoted

def test_promote_catches_up_after_a_day_switched_off(tmp_path):
    live, nxt = _trees(tmp_path)
    assert pr.promote(AT("2026-10-30T12:00:00"), nxt, live) == ["afd", "cifp", "nasr", "plates"]

def test_dry_run_changes_nothing(tmp_path):
    live, nxt = _trees(tmp_path)
    assert pr.promote(AT("2026-10-29T09:05:00"), nxt, live, dry_run=True) == ["afd", "cifp", "nasr", "plates"]
    assert (live / "nasr" / "f").read_text() == "old" and (nxt / "nasr" / "f").read_text() == "new"
```

- [ ] **Step 2:** `python3 -m pytest tests/test_promote.py -q`: FAIL.
- [ ] **Step 3: Implement `promote.py`**

```python
"""Swap the audited staged cycle into data/ at the 0901Z changeover (spec
2026-10-17). Only products whose staged audit passed, only on their effective
date, never before 0901Z (the timer may catch up a missed run at boot). The
previous cycle is deleted: after 0901Z it has expired."""
import json, os, shutil, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import stage_next as sn

CHANGEOVER_UTC = (9, 1)
PATHS = {"nasr": ["nasr"], "cifp": ["cifp"], "plates": ["plates"],
         **{f"charts:{l}": [f"mbtiles/{l}.mbtiles"] for l in ("sectional", "tac", "ifr-low", "ifr-area")}}


def _eff_reached(staging_for: str, now_utc: datetime) -> bool:
    """From its 0901Z changeover until the next cycle's: a server switched off
    on the effective date still promotes when it next runs."""
    d = datetime.fromisoformat(staging_for).replace(hour=CHANGEOVER_UTC[0], minute=CHANGEOVER_UTC[1], tzinfo=timezone.utc)
    return d <= now_utc < d + timedelta(days=28)


def promote(now_utc: datetime, next_dir: Path, live_dir: Path, dry_run: bool = False) -> list:
    try:
        nm = json.loads((next_dir / "manifest.json").read_text())
    except Exception:
        return []
    if not nm.get("staging_for") or not _eff_reached(nm["staging_for"], now_utc):
        return []
    ok = sn.staged_ok(next_dir)
    want = [p for p in PATHS if p in ok and (p != "plates" or "afd" in ok)]
    if not want:
        return []
    promoted = sorted(want + (["afd"] if "plates" in want else []))
    if dry_run:
        for p in want:
            print(f"  would move {', '.join(PATHS[p])}")
        return promoted
    lm_path = live_dir / "manifest.json"
    lm = json.loads(lm_path.read_text()) if lm_path.exists() else {}
    for p in want:
        for rel in PATHS[p]:
            src, dst = next_dir / rel, live_dir / rel
            if dst.is_dir():
                shutil.rmtree(dst)
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dst)
        if p.startswith("charts:"):
            layer = p.split(":", 1)[1]
            lm.setdefault("tiles", {})[layer] = nm.get("tiles", {}).get(layer)
        elif p in nm:
            lm[p] = nm[p]
    tmp = lm_path.with_name("manifest.json.tmp")
    tmp.write_text(json.dumps(lm, indent=2))
    os.replace(tmp, lm_path)
    if {"nasr", "cifp", "plates", "afd"} <= set(promoted):
        (sn.PIPELINE_DIR / ".last_cycle").write_text(nm["staging_for"] + "\n")
    leftover = [rel for p in PATHS if p not in want for rel in PATHS[p] if (next_dir / rel).exists()]
    if not leftover:                       # everything staged went live: data-next/ is done
        shutil.rmtree(next_dir, ignore_errors=True)
    return promoted


def main(argv) -> int:
    dry = "--dry-run" in argv
    done = promote(datetime.now(timezone.utc), sn.NEXT_DIR, sn.LIVE_DIR, dry_run=dry)
    print(f"Promote{' (dry run)' if dry else ''}: {' '.join(done) or 'nothing'}")
    return 0
```

Note: the autouse fixture `_own_pipeline_dir` points `sn.PIPELINE_DIR` at `tmp_path` in every promote test — a promote test must never write the real `.last_cycle`. In `test_promote_moves_audited_products_and_their_manifest_sections` also assert `(tmp_path / ".last_cycle").read_text().strip() == "2026-10-29"`.

- [ ] **Step 4:** `python3 -m pytest tests/ -q`: all pass.
- [ ] **Step 5:** commit `promote.py tests/test_promote.py`.

---

### Task 6: temporary-file cleanup (`tmp_cleanup.py`)

**Files:**
- Create: `~/flytab-pipeline/tmp_cleanup.py`
- Test: `tests/test_tmp_cleanup.py`

**Interfaces:**
- Produces: `cleanup(tmp_dir: Path, passed: dict) -> list[str]` (removed names), where `passed = {"YYMMDD": {"nasr","cifp","plates"}, "charts": bool}`; CLI `python3 tmp_cleanup.py` reads `data/audit.json` (live) and `data-next/manifest.json` (staged).
- Rule:
  - remove a cycle's sources once its products passed: `nasr_<date>.zip` + `nasr_extracted_<date>/` (nasr), `cifp_<code>.zip` (cifp), `plates/DDTPP*_<code>.zip` (plates);
  - remove `charts/` contents when all chart layers of the live audit passed;
  - always keep `plates/d-TPP_Metafile_*.xml` of the live and staged cycles, and `afd/*.xml`;
  - remove metafiles of other cycles.

- [ ] **Step 1: Failing tests**

```python
# tests/test_tmp_cleanup.py
"""tmp/ holds only sources of cycles still being built (spec 2026-10-17)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import tmp_cleanup as tc

def _tmp(t):
    for rel in ("nasr_2026-10-01.zip", "cifp_261001.zip", "plates/DDTPPA_261001.zip", "plates/d-TPP_Metafile_2610.xml",
                "plates/d-TPP_Metafile_2609.xml", "nasr_2026-10-29.zip", "cifp_261029.zip", "plates/DDTPPA_261029.zip",
                "plates/d-TPP_Metafile_2611.xml", "afd/afd_03SEP2026.xml", "charts/sectional_Atlanta.zip"):
        (t / rel).parent.mkdir(parents=True, exist_ok=True)
        (t / rel).write_bytes(b"x")
    (t / "nasr_extracted_2026-10-01").mkdir()
    return t

def test_cleanup_keeps_what_the_audit_needs(tmp_path):
    t = _tmp(tmp_path)
    removed = tc.cleanup(t, {"261001": {"nasr", "cifp", "plates"}, "261029": {"nasr"}, "charts": False},
                         keep_metafiles={"2610", "2611"})
    left = sorted(str(p.relative_to(t)) for p in t.rglob("*") if p.is_file())
    assert "nasr_2026-10-01.zip" in removed and "cifp_261001.zip" in removed and "plates/DDTPPA_261001.zip" in removed
    assert "plates/d-TPP_Metafile_2609.xml" in removed
    assert left == ["afd/afd_03SEP2026.xml", "charts/sectional_Atlanta.zip", "cifp_261029.zip",
                    "plates/DDTPPA_261029.zip", "plates/d-TPP_Metafile_2610.xml", "plates/d-TPP_Metafile_2611.xml"]
    assert not (t / "nasr_extracted_2026-10-01").exists()

def test_failed_cycle_keeps_its_sources(tmp_path):
    t = _tmp(tmp_path)
    tc.cleanup(t, {"261001": set(), "charts": False}, keep_metafiles={"2610"})
    assert (t / "plates" / "DDTPPA_261001.zip").exists() and (t / "nasr_2026-10-01.zip").exists()

def test_charts_cleared_when_all_layers_passed(tmp_path):
    t = _tmp(tmp_path)
    tc.cleanup(t, {"charts": True}, keep_metafiles=set())
    assert not list((t / "charts").iterdir())
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement**

```python
"""tmp/ holds only FAA sources of cycles still being built (spec 2026-10-17):
a cycle's source zips go once its products passed their audit (the audit
reads source.json, not the zips); a failed build keeps them, so a retry
downloads nothing again from aeronav."""
import json, shutil, sys
from datetime import datetime
from pathlib import Path

import config


def _date_of(code: str) -> str:            # "261029" -> "2026-10-29"
    return datetime.strptime(code, "%y%m%d").date().isoformat()


def cleanup(tmp_dir: Path, passed: dict, keep_metafiles: set) -> list:
    removed = []
    def rm(p: Path):
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()
        else:
            return
        removed.append(str(p.relative_to(tmp_dir)))
    for code, prods in passed.items():
        if code == "charts":
            continue
        if "nasr" in prods:
            rm(tmp_dir / f"nasr_{_date_of(code)}.zip")
            rm(tmp_dir / f"nasr_extracted_{_date_of(code)}")
        if "cifp" in prods:
            rm(tmp_dir / f"cifp_{code}.zip")
        if "plates" in prods:
            for z in sorted((tmp_dir / "plates").glob(f"DDTPP*_{code}.zip")):
                rm(z)
    if passed.get("charts") and (tmp_dir / "charts").exists():
        for p in sorted((tmp_dir / "charts").iterdir()):
            rm(p)
    for m in sorted((tmp_dir / "plates").glob("d-TPP_Metafile_*.xml")):
        if m.stem.rsplit("_", 1)[1] not in keep_metafiles:
            rm(m)
    return removed


def _passed(audit_products: dict) -> set:
    return {p for p in ("nasr", "cifp", "plates") if audit_products.get(p, {}).get("ok") is True}


def main() -> int:
    passed, keep = {}, set()
    live = json.loads((config.DATA_DIR / "audit.json").read_text())
    passed[config.DTPP_CYCLE_CODE] = _passed(live["products"])
    passed["charts"] = all(v.get("ok") for k, v in live["products"].items() if k.startswith("charts:"))
    keep.add(live["cycle"])
    nm_path = config.PIPELINE_DIR / "data-next" / "manifest.json"
    if nm_path.exists():
        nm = json.loads(nm_path.read_text())
        if nm.get("audit"):
            code = datetime.fromisoformat(nm["staging_for"]).strftime("%y%m%d")
            passed[code] = _passed(nm["audit"]["products"])
            keep.add(nm["audit"]["cycle"])
            passed["charts"] = passed["charts"] and all(
                v.get("ok") for k, v in nm["audit"]["products"].items() if k.startswith("charts:"))
    for r in cleanup(config.TMP_DIR, passed, keep):
        print(f"  removed tmp/{r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4:** all tests pass; commit.

---

### Task 7: `run_pipeline.sh` — promote first, stage after, clean last

**Files:**
- Modify: `~/flytab-pipeline/run_pipeline.sh`
- Modify: `tests/test_run_pipeline.py` (stubs for `stage_next.py`, `tmp_cleanup.py`)

**Interfaces:**
- Consumes: `python3 stage_next.py --promote`, `python3 stage_next.py`, `python3 tmp_cleanup.py`.
- Order in a run:
  1. update_cycle and stale check (unchanged);
  2. **promote**;
  3. recompute `BUILT_CYCLE` (`.last_cycle` may be written by promote) and `NEED_NASR`;
  4. retry-steps, builds and audits as today;
  5. **stage**;
  6. **cleanup**;
  7. publish and notify (as today).
- A failed stage is reported (desktop notice) but doesn't make the run fail. A promote error is reported and the run continues with day-of builds.

- [ ] **Step 1: Failing tests** (add to `tests/test_run_pipeline.py`; extend `STUBS`):

```python
STUBS["stage_next.py"] = (
    "import os, sys\n"
    "open(os.environ['CALLS'], 'a').write('stage ' + ' '.join(sys.argv[1:]) + '\\n')\n"
    "if '--promote' in sys.argv and os.environ.get('STUB_PROMOTE_ALL'):\n"
    "    open('.last_cycle', 'w').write(os.environ['CYCLE'] + '\\n')\n"
    "sys.exit(int(os.environ.get('STUB_STAGE_EXIT', '0')) if '--promote' not in sys.argv else 0)\n")
STUBS["tmp_cleanup.py"] = "import os\nopen(os.environ['CALLS'], 'a').write('cleanup\\n')\n"

def test_promote_runs_first_and_a_full_promotion_skips_the_day_of_build(tmp_path):
    r, calls, m = run(tmp_path, UPDATE_EXIT=0, STUB_PROMOTE_ALL=1)
    assert r.returncode == 0, r.stdout + r.stderr
    assert calls[0] == "stage --promote"
    assert not any(c.startswith("build --no-audit --only nasr") for c in calls)
    last_audit = max(i for i, c in enumerate(calls) if c == "audit")
    assert calls.index("stage ") > last_audit                 # staging after the final audit
    assert calls.index("cleanup") > calls.index("stage ")     # cleanup last

def test_nothing_promoted_builds_on_the_day(tmp_path):
    r, calls, m = run(tmp_path, UPDATE_EXIT=0)
    assert calls[0] == "stage --promote"
    assert any(c.startswith("build --no-audit --only nasr cifp plates afd-pages plate-zips") for c in calls)

def test_a_failed_stage_is_reported_but_the_run_passes(tmp_path):
    (tmp_path / "pipeline").mkdir()
    (tmp_path / "pipeline" / ".last_cycle").write_text("2026-10-29\n")
    (tmp_path / "pipeline" / ".last_published").write_text("2026-10-29\n")
    r, calls, m = run(tmp_path, STUB_STAGE_EXIT=1)
    assert r.returncode == 0
    assert any("staging" in c.lower() and "failed" in c.lower() for c in calls if c.startswith("notify"))
```

Update the existing order assertions in `test_cycle_day_nasr_plates_audited_and_published_before_the_charts_build` and `test_nothing_to_do_audits_only` to expect `"stage --promote"` first, and `"stage "` and `"cleanup"` after the final audit (the stub writes `stage ` for the plain run).

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.** In `run_pipeline.sh`, right after the tile stale check (`TILES_CHECK_OUTPUT` block) and **before** the `RETRY_STEPS=` line:

```bash
# ── Pre-staged cycle: swap in what passed its audit, at the 0901Z changeover ─
# (stage_next.py / promote.py, spec 2026-10-17). Whatever isn't promoted is
# built below on the day, as before.
python3 stage_next.py --promote || echo "⚠ promote step failed — building on the day"
if [ -f "$LAST_RUN_FILE" ] && grep -q "$CURRENT_CYCLE" "$LAST_RUN_FILE"; then
    NEED_NASR=false
fi
TILES_EXIT=0
TILES_CHECK_OUTPUT=$(python3 check_tiles_stale.py) || TILES_EXIT=$?
NEED_TILES=false; STALE_STEPS=""
if [ $TILES_EXIT -eq 0 ]; then
    NEED_TILES=true
    STALE_STEPS=$(echo "$TILES_CHECK_OUTPUT" | sed -n 's/^Rebuild needed: //p')
fi
```

After the final `run_audit || AUDIT_EXIT=$?` and the publish-if-due block, add:

```bash
# ── Pre-stage the next cycle (from 7 days ahead) and clean tmp/ ──────────────
STAGE_EXIT=0
python3 stage_next.py || STAGE_EXIT=$?
if [ $STAGE_EXIT -ne 0 ]; then
    notify "⚠ FlyTab next-cycle staging failed" "Retried tomorrow; built on the effective date if still failing. See $LOG_FILE"
fi
python3 tmp_cleanup.py || true
```

`STAGE_EXIT` does not feed `FAILED`. The stub `check_tiles_stale.py` already exists; it is now called twice (harmless).

- [ ] **Step 4:** `bash -n run_pipeline.sh` and `python3 -m pytest tests/ -q`: all pass.
- [ ] **Step 5:** commit `run_pipeline.sh tests/test_run_pipeline.py`.

---

### Task 8: persistent systemd timer replaces cron

**Files:**
- Create: `~/flytab-pipeline/systemd/flytab-pipeline.service`
- Create: `~/flytab-pipeline/systemd/flytab-pipeline.timer`
- Modify: `~/flytab-pipeline/CLAUDE.md` (the `run_pipeline.sh` line: scheduler)
- Modify: `run_pipeline.sh` header comment (install)

- [ ] **Step 1: Unit files**

`systemd/flytab-pipeline.service`:
```ini
[Unit]
Description=FlyTab FAA data pipeline (build, audit, pre-stage, swap at 0901Z)

[Service]
Type=oneshot
# A run at boot can start before WiFi: wait up to 2 min for DNS.
ExecStartPre=/bin/sh -c 'for i in $(seq 1 24); do getent hosts aeronav.faa.gov >/dev/null && exit 0; sleep 5; done; exit 0'
ExecStart=/bin/sh -c '%h/flytab-pipeline/run_pipeline.sh >> %h/flytab-pipeline/logs/cron.log 2>&1'
```

`systemd/flytab-pipeline.timer`:
```ini
[Unit]
Description=FlyTab pipeline daily 05:05 (0901Z + 4 min EDT); a run missed while off happens at boot

[Timer]
OnCalendar=*-*-* 05:05
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 2: Install, then verify before removing cron**

```bash
mkdir -p ~/.config/systemd/user
cp ~/flytab-pipeline/systemd/flytab-pipeline.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemd-analyze calendar '*-*-* 05:05'          # shows the next elapse in local time
systemctl --user enable --now flytab-pipeline.timer
systemctl --user list-timers flytab-pipeline.timer   # NEXT = tomorrow 05:05
loginctl show-user "$USER" -p Linger              # Linger=yes (runs without login)
```

- [ ] **Step 3: One real pass through the service** (runs the pipeline now: today that means an audit plus staging if due; no burst):

```bash
systemctl --user start flytab-pipeline.service; systemctl --user status flytab-pipeline.service --no-pager | head -5
tail -20 ~/flytab-pipeline/logs/cron.log
```

Expected: exit 0 and "FAA currency audit: PASS".

- [ ] **Step 4: Remove the cron line** (show before and after):

```bash
crontab -l > /tmp/crontab.before
grep -v 'flytab-pipeline/run_pipeline.sh' /tmp/crontab.before > /tmp/crontab.after
diff /tmp/crontab.before /tmp/crontab.after; crontab /tmp/crontab.after; crontab -l
```

- [ ] **Step 5: Docs and commit.**
  - In `run_pipeline.sh`'s header, replace the crontab install lines with `systemd/flytab-pipeline.timer (05:05, Persistent=true) — see systemd/`.
  - In `CLAUDE.md`, the `run_pipeline.sh` line: "Run by the systemd user timer `flytab-pipeline.timer` (05:05 daily, catches up at boot)".
  - Commit `systemd/ run_pipeline.sh CLAUDE.md`.

---

### Task 9: the tablet's day-before reminder (flytab)

**Files:**
- Modify: `~/flytab/web/app.js` (`_checkDataReadiness`, the FaaCurrency loop)
- Modify: `~/flytab/web/shared/faa-currency.js` (`changeoverLocal(expiration) -> string`)
- Modify: `~/flytab/docs/user-manual.md` (FAA data badge paragraph)
- Test: `~/flytab/tests/cockpit/faa-currency-ui.test.js`

**Interfaces:**
- Produces: `FaaCurrency.changeoverLocal("2026-10-29")` returns the local `HH:MM` of `2026-10-29T09:01:00Z` (EDT → `"05:01"`, EST → `"04:01"`).

- [ ] **Step 1: Failing tests** (append to `tests/cockpit/faa-currency-ui.test.js`):

```js
describe('the day before a new cycle', () => {
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); delete globalThis.fetch; document.body.innerHTML = ''; });
    it('one reminder with the local changeover time, instead of "expires in 0d"', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-28T20:00:00Z') });          // 16:00 EDT, 13 h before
        localStorage.setItem('flytab_device_manifest', JSON.stringify({
            cifp: { expiration_date: '2026-10-29' }, plates: { expiration_date: '2026-10-29' }, afd: { expiration_date: '2026-12-24' } }));
        globalThis.fetch = vi.fn(async (u) => ({ ok: true, json: async () => (String(u).includes('cifp') ? { cycle_code: '261001' }
            : { effective_date: '2026-10-01', expiration_date: '2026-10-29' }) }));
        await FlyTabApp.prototype._checkDataReadiness.call({ dataStatus: null });
        const t = document.getElementById('dataReadinessBanner').textContent;
        expect(t.match(/New FAA cycle at/g)).toHaveLength(1);
        expect(t).toMatch(new RegExp(`New FAA cycle at ${FaaCurrency.changeoverLocal('2026-10-29')} tomorrow \\(0901Z\\) — sync on home WiFi before flying`));
        expect(t).not.toMatch(/expires in 0d/);
    });
    it('changeoverLocal is the device\'s local time of 0901Z', () => {
        const d = new Date('2026-10-29T09:01:00Z');
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        expect(FaaCurrency.changeoverLocal('2026-10-29')).toBe(hhmm);
    });
});
```

- [ ] **Step 2:** `cd ~/flytab && npx vitest run tests/cockpit/faa-currency-ui.test.js`: FAIL.
- [ ] **Step 3: Implement.** In `faa-currency.js`, add to the object:

```js
    /** Local HH:MM of the 0901Z changeover on this expiration date (05:01 EDT, 04:01 EST). */
    changeoverLocal(expiration) {
        const d = new Date(this.expiresAt(expiration));
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    },
```

In `app.js` `_checkDataReadiness`, replace the `else if (p.state === 'expiring')` branch with:

```js
            } else if (p.state === 'expiring' && p.expiresAt - Date.now() < 24 * 3600 * 1000) {
                if (!issues.some((i) => i.newCycle)) {
                    issues.push({ severity: 'warn', newCycle: true,
                        text: `New FAA cycle at ${FaaCurrency.changeoverLocal(p.expiration)} tomorrow (0901Z) — sync on home WiFi before flying` });
                }
            } else if (p.state === 'expiring') {
                issues.push({ severity: 'warn', text: `${p.label} expires in ${p.daysLeft}d` });
```

- [ ] **Step 4:** `npx vitest run`: all pass.
- [ ] **Step 5: Manual.** In `docs/user-manual.md`, at the end of the "FAA data badge is red" troubleshooting paragraph, add: "The day before a cycle change, FlyTab's startup banner says *New FAA cycle at 05:01 tomorrow (0901Z) — sync on home WiFi before flying*. The home server builds the new cycle in the week before and switches to it at 0901Z, so the sync works from then."
- [ ] **Step 6:** bump `FLYTAB_VERSION` in `web/app.js` (v11.58 → v11.59), then `bash build.sh`. Commit `web/ docs/user-manual.md web/user-manual.md android/app/build.gradle tests/`.

---

### Task 10: rehearsal on real data before 10-29 (no code)

- [ ] **10-22 or later:**
  - `cd ~/flytab-pipeline && python3 stage_next.py` (also runs from the timer). Watch `logs/cron.log`.
  - Expected: builds 2611 into `data-next/`; the audit `--for-date 2026-10-29` passes every due product, including the four chart layers (10-29 is a chart date).
  - If a product fails, read the reason. A 404 means the FAA has not posted it yet: retried the next day.
- [ ] **Check:**
  - `python3 -c "import stage_next as sn; print(sorted(sn.staged_ok(sn.NEXT_DIR)))"` lists all due products;
  - `du -sh data-next` is about 9 GB;
  - `df -h ~` has room.
- [ ] **Dry-run the swap with a time override:**

```bash
python3 -c "import promote as pr, stage_next as sn; from datetime import datetime, timezone; print(pr.promote(datetime(2026,10,29,9,5,tzinfo=timezone.utc), sn.NEXT_DIR, sn.LIVE_DIR, dry_run=True))"
```

  It lists the products and the paths it would move. Nothing changes.
- [ ] **Confirm the tablet still syncs today's cycle unchanged:** Data Status shows current and no `data-next` path is fetched (server log).
- [ ] **10-29 after 05:05:**
  - `logs/cron.log` shows "Promote: …"; the audit passes for 2611;
  - the tablet syncs, and the badge shows "FAA 27d" with cycle 2611 in the plate viewer.
