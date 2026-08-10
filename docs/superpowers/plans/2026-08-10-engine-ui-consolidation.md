# Engine UI Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FlyTab's ENG page the only human-facing engine-monitor UI — delete the Pi's embedded HTML dashboard, fix the auto-capture manual-stop bug it was masking, and port the three Pi-dashboard-only features worth keeping (TAS, cruise targets, ATIS override) into FlyTab.

**Architecture:** `engine-monitor/engine_monitor.py` keeps its HTTP/WebSocket API exactly as-is (no `PI_API_CONTRACT` bump) but stops serving `HTML_TEMPLATE` at `/`, and gets a `state.manually_stopped` latch so `auto_capture_monitor`'s ~15s serial-probe loop stops silently overriding a pilot's Stop. `web/cockpit/engine-page.js` gains three new pieces of UI (TAS gauge, Cruise Targets row, ATIS override panel) that all read/write fields already published on the wire today — no new Pi endpoints.

**Tech Stack:** Python 3 (stdlib `http.server`, no framework) on the Pi; vanilla JS (`<script>` tags, no bundler) + vitest for FlyTab.

## Global Constraints

- No `PI_API_CONTRACT` bump — every field this plan newly consumes (`tas`, `target_fuel_flow`, `target_power`, `target_mode`, `manual_altimeter`, `manual_oat`) is already published by `get_status()` today.
- `engine-monitor/engine_monitor.py` has zero automated test coverage in this repo — verify Python changes by running the script locally with `curl`, not `pytest`. Use `--playback` mode only for route/response checks; anything touching `auto_capture_monitor` requires *live* serial mode (`data_simulator.py`'s virtual pty), since that thread is gated `if not playback_mode:` and never runs in playback mode at all.
- Any change to `web/cockpit/engine-page.js` requires on-device or CDP verification that the ENG page still renders and updates correctly (per CLAUDE.md) — `npm test` passing is necessary but not sufficient.
- New UI must follow CLAUDE.md's Design Token Standards: no hardcoded hex, `var(--touch-min, 56px)` minimum touch targets, font-weight ≥ 700 for anything the pilot reads, instrument values in `var(--font-instrument)` at weight 900.
- `docs/user-manual.md` must be updated in the same commit as any user-visible change (new gauge, new section, new control).
- Work happens on branch `feat/engine-ui-consolidation` in worktree `.claude/worktrees/engine-ui-consolidation` (already created, based on `fix/critical-reliability-security` at `7c1b07c`).
- Bump `FLYTAB_VERSION` in `web/app.js` and run `bash build.sh` after each FlyTab-side task, per CLAUDE.md Build Policy.

---

## File Structure

| File | Change |
|---|---|
| `engine-monitor/engine_monitor.py` | Add `state.manually_stopped` latch (Task 1). Delete `HTML_TEMPLATE`, its `do_GET('/')`/`do_GET('/static/chart.min.js')` branches, `check_sticky_valve()`, its `CaptureState` fields, its call site, `/api/dismiss_sticky_valve`, `sticky_valve_*` in `get_status()`, `STICKY_VALVE_*` constants, `'sticky_valve'` from `PI_CAPABILITIES`, and the always-on `state.history`/`get_history()`/`/api/history` trend-chart backend (Task 2). |
| `tests/fixtures/engine-messages.js` | Drop `sticky_valve_alert`/`sticky_valve_dismissed`/`'sticky_valve'` (Task 2); add `target_fuel_flow`/`target_power`/`target_mode` (Task 4). |
| `tests/shared/engine-client.test.js` | Update the `piCapabilities` assertion to match the trimmed `PI_CAPABILITIES` (Task 2). |
| `web/cockpit/engine-page.js` | Add TAS gauge (Task 3), Cruise Targets section (Task 4), ATIS override panel (Task 5). |
| `tests/cockpit/engine-page-flight-data.test.js` | New file — created in Task 3, extended in Tasks 4 and 5. |
| `docs/user-manual.md` | New paragraphs for TAS, Cruise Targets, ATIS override (one per task, same commit as the feature). |
| `web/app.js` | `FLYTAB_VERSION` bump, once per FlyTab-side task (3, 4, 5). |

---

### Task 1: Root-cause fix — `auto_capture_monitor` manual-stop latch

**Files:**
- Modify: `engine-monitor/engine_monitor.py:653-729` (`CaptureState.__init__`), `:1993-2016` (`start_capture`), `:4341-4343` (`/api/stop` handler), `:4677-4711` (`auto_capture_monitor`)

**Interfaces:**
- Produces: `state.manually_stopped` (bool) — read by `auto_capture_monitor`, set by the `/api/stop` POST handler, cleared by `start_capture()` and by `auto_capture_monitor` itself when it parses a live RPM < 300 from its own serial probe.

**Problem:** `auto_capture_monitor` (a background thread) probes the serial port every ~15s whenever `state.capturing` is `False` and calls `start_capture()` if it sees EDM data — with no way to tell "capture never started" from "pilot just hit Stop and the engine is still running." A manual Stop gets silently overridden within ~15-20s, fragmenting the recording and reverting FlyTab's "✓ Saved" back to "● REC".

- [ ] **Step 1: Add the latch field to `CaptureState`**

In `engine-monitor/engine_monitor.py`, in `CaptureState.__init__` (starts line 653), add the field right after `self.capturing = False` (line 656):

```python
        self.capturing = False
        self.manually_stopped = False  # True after an explicit /api/stop; blocks
                                        # auto_capture_monitor's auto-restart until
                                        # cleared by Start or engine RPM < 300.
```

- [ ] **Step 2: Set the latch on explicit Stop**

In `do_POST`, the `/api/stop` branch (currently lines 4341-4343) reads:

```python
        elif path == '/api/stop':
            result = stop_capture()
            self.send_json(result)
```

Change to:

```python
        elif path == '/api/stop':
            state.manually_stopped = True
            result = stop_capture()
            self.send_json(result)
```

Set unconditionally (even if `stop_capture()` reports "Not capturing") — the pilot pressed Stop either way, and a duplicate call is harmless to latch again.

- [ ] **Step 3: Clear the latch on explicit Start**

In `start_capture()` (line 1993), after the early-return guard:

```python
def start_capture():
    """Start the capture thread."""
    if state.capturing:
        return {'success': False, 'message': 'Already capturing'}

    state.manually_stopped = False
```

(insert the new line right before the existing `# Check for orphan active file` comment at line 1998).

- [ ] **Step 4: Skip auto-restart while latched, clear it when the engine actually stops**

In `auto_capture_monitor` (line 4677-4711), the current body is:

```python
        def auto_capture_monitor():
            """Background thread: auto-start capture when serial port has EDM data."""
            import serial as _serial
            port = CONFIG['SERIAL_PORT']
            log("Auto-capture monitor started")
            while not state.stop_event.is_set():
                # Only act if not already capturing
                if state.capturing:
                    state.stop_event.wait(5)
                    continue

                # Check if serial port exists
                if not os.path.exists(port):
                    state.stop_event.wait(10)
                    continue

                # Probe the port briefly for EDM data
                try:
                    probe = _serial.Serial(port, CONFIG['BAUD_RATE'], timeout=3,
                                           bytesize=_serial.EIGHTBITS, parity=_serial.PARITY_NONE,
                                           stopbits=_serial.STOPBITS_ONE)
                    data = probe.read(256)
                    probe.close()

                    if data and len(data) > 10:
                        log(f"Auto-capture: EDM data detected on {port} ({len(data)} bytes), starting capture")
                        time.sleep(0.5)  # Let port fully release before capture thread opens it
                        if not state.capturing:
                            start_capture()
                except Exception as e:
                    # Port busy or unavailable — try again later
                    pass

                state.stop_event.wait(15)
            log("Auto-capture monitor stopped")
```

Replace the `if data and len(data) > 10:` block with:

```python
                    if data and len(data) > 10:
                        # If a manual Stop is latched, use this same probe data to
                        # check whether the engine has since shut down — if RPM has
                        # dropped below 300, clear the latch so the *next* flight's
                        # auto-capture still works. Independent of check_sticky_valve()
                        # (deleted in Task 2) — this is its own inline check against
                        # the most recent parseable line in the probe.
                        if state.manually_stopped:
                            last_rpm = None
                            for line in data.decode('utf-8', errors='ignore').split('\n'):
                                parsed = parse_line(line)
                                if parsed:
                                    last_rpm = parsed.get('RPM', 0)
                            if last_rpm is not None and last_rpm < 300:
                                state.manually_stopped = False
                                log("Auto-capture: engine RPM dropped below 300, manual-stop latch cleared")

                        if not state.manually_stopped:
                            log(f"Auto-capture: EDM data detected on {port} ({len(data)} bytes), starting capture")
                            time.sleep(0.5)  # Let port fully release before capture thread opens it
                            if not state.capturing:
                                start_capture()
```

`parse_line` is the same module-level EDM line parser used by `capture_thread_func` (line 1050) — no new import needed, `auto_capture_monitor` is defined in the same module scope.

**Behavioral boundary, not a bug:** the latch only clears on an explicit Start or when RPM drops below 300. A deliberate Stop mid-flight *without* shutting the engine down (e.g. pausing recording between two legs while taxiing) will **not** auto-resume — the pilot must hit Start again for the next leg. Only a Stop followed by an actual engine shutdown re-arms auto-capture automatically. This matches "next flight," not "next time RPM happens to look idle," and is the more conservative reading of a deliberate pilot action.

- [ ] **Step 5: Local verification with a live (non-playback) virtual serial port**

`auto_capture_monitor` — the thread this whole task is about — only starts `if not playback_mode:` (line 4676). A `--playback`-mode test would never exercise it, because that thread simply never runs in playback mode — it would pass identically whether the fix is correct, broken, or absent. Verify instead with `data_simulator.py`, which opens a real pty and feeds it EDM lines, letting `engine_monitor.py` run its normal *live*-serial code path (the one that actually starts `auto_capture_monitor`) with no physical Pi required:

Run (background both, same shell):
```bash
cd engine-monitor
ls *.txt 2>/dev/null || echo "no local sample — use ~/Engine_Analysis/*.txt if present"
python3 data_simulator.py <a-real-stream-file.txt> --rate 10 &
sleep 1   # let it create /tmp/ttyUSB0
python3 engine_monitor.py --port /tmp/ttyUSB0 --no-stratux --web-port 8081 &
sleep 3
curl -s http://localhost:8081/api/status | python3 -c "import json,sys; print('capturing before stop:', json.load(sys.stdin)['capturing'])"
curl -s -X POST http://localhost:8081/api/stop
curl -s http://localhost:8081/api/status | python3 -c "import json,sys; print('capturing right after stop:', json.load(sys.stdin)['capturing'])"
sleep 20
curl -s http://localhost:8081/api/status | python3 -c "import json,sys; print('capturing 20s after stop (must still be False -- this is what the fix prevents):', json.load(sys.stdin)['capturing'])"
kill %1 %2
```
Expected: `capturing` is `True` before Stop (auto-capture detected the simulated live EDM stream and started it), `False` immediately after `/api/stop`, and — this is the actual behavior under test — still `False` 20 seconds later, since a real flight file's RPM stays well above 300 throughout. Without the fix, `auto_capture_monitor`'s ~15-20s probe cycle would have silently called `start_capture()` again by this point, and this same command sequence would show `True`.

This still isn't full proof — real serial-port timing and the crash-restart scenario only exist on the actual Pi — see the plan's Final Acceptance section for the `test-pipeline.sh` run on real hardware.

- [ ] **Step 6: Commit**

```bash
cd /home/dananickerson/flytab/.claude/worktrees/engine-ui-consolidation
git add engine-monitor/engine_monitor.py
git commit -m "fix(engine-monitor): add manual-stop latch to auto_capture_monitor

Stop while the engine is still running was silently overridden by the
auto-capture probe within ~15-20s, fragmenting recordings and reverting
FlyTab's 'Saved' confirmation. state.manually_stopped now blocks the
auto-restart until an explicit Start or the engine RPM drops below 300."
```

---

### Task 2: Delete the Pi's embedded dashboard and dead sticky-valve server code

**Files:**
- Modify: `engine-monitor/engine_monitor.py:36` (`PI_CAPABILITIES`), `:49` (`deque` import), `:66` (`MAX_HISTORY_POINTS`), `:83-86` (`STICKY_VALVE_*` constants), `:653-729` (`CaptureState.__init__`), `:1251-1330` (`check_sticky_valve`), `:1810-1817` (call site), `:1838-1850` (`history_entry` build/append), `:2091-2179` (`get_status`), `:2249-2302` (`get_history`), `:2304-4130` (`HTML_TEMPLATE`), `:4170-4193` (`do_GET` `/`  and `/static/chart.min.js`), `:4204-4213` (`do_GET` `/api/history`), `:4354-4356` (`/api/dismiss_sticky_valve`)
- Modify: `tests/fixtures/engine-messages.js`, `tests/shared/engine-client.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /` now returns `text/plain` `"Engine Monitor API running — see FlyTab"` instead of the dashboard HTML. `GET /api/history` and `GET /static/chart.min.js` are gone (404). All other routes unchanged in shape. `get_status()` no longer includes `sticky_valve_alert`/`sticky_valve_dismissed`; `capabilities` no longer includes `'sticky_valve'`.

This task also removes `state.history` and its `/api/history` backend — not just the dashboard HTML. That deque is appended to on every parsed EDM sample (up to 6 Hz, for the life of every flight) inside the `state.lock` critical section, purely to feed the dashboard's own trend charts. FlyTab has never called `/api/history` (confirmed via `grep -rn "api/history" web/`, no hits) — it builds its own independent client-side trend buffer (`engine-page.js`'s `_trendHistory`). This is an *unconditional* per-sample cost, unlike the dashboard's own HTTP polling (which only mattered if a browser tab was left open) — leaving it in place would mean the "reduce Pi load" goal is only partially met.

This is a single coherent deletion: the HTML dashboard's own embedded JS reads `data.sticky_valve_alert`/`sticky_valve_dismissed` (lines 3469-3470, 3709 inside `HTML_TEMPLATE`), so both go together. Confirmed via `grep` that nothing in `web/` (FlyTab) reads `piCapabilities`, `'sticky_valve'`, or any `sticky_valve_*` field from the Pi — engine-page.js's own sticky-valve detection (`_checkStickyValve`, kept per Task design) is fully independent and reads only local EGT/RPM samples.

- [ ] **Step 1: Delete `check_sticky_valve()` and its state**

Delete the entire function at `engine_monitor.py:1251-1330` (from `def check_sticky_valve(egt1, egt2, egt3, egt4, rpm):` through its final `return state.sticky_valve_alert`, plus the two blank lines before the next function).

In `CaptureState.__init__` (line 653), delete these five lines (693-697):

```python
        # Sticky valve detection (TIME-BASED)
        self.engine_start_time = None  # When engine first started (RPM > 500)
        self.sticky_valve_alert = None  # Cylinder number if sticky valve detected (1-4)
        self.sticky_valve_start_times = [None, None, None, None]  # When each cylinder first showed low EGT
        self.sticky_valve_dismissed = False  # User dismissed the alert
```

In `capture_thread_func`'s main read loop, delete the call site (lines 1810-1817):

```python
                        # Check for sticky valve during warmup
                        check_sticky_valve(
                            parsed.get('EGT1', 0),
                            parsed.get('EGT2', 0),
                            parsed.get('EGT3', 0),
                            parsed.get('EGT4', 0),
                            rpm
                        )

```
(leave the `update_peak_tracking(...)` call immediately after it untouched — that stays).

Delete the four `STICKY_VALVE_*` constants (lines 83-86):

```python
STICKY_VALVE_WARMUP_MINUTES = 10  # Monitor for sticky valve during first 10 minutes
STICKY_VALVE_EGT_RATIO = 0.50  # Alert if one cylinder EGT < 50% of others' average
STICKY_VALVE_MIN_EGT = 200  # Minimum average EGT to consider engine "running" for detection
STICKY_VALVE_PERSIST_SECONDS = 30  # Must persist for 30 seconds to trigger alert
```

- [ ] **Step 2: Remove sticky-valve fields from `get_status()`**

In `get_status()` (line 2091), delete lines 2117-2119:

```python
        # Sticky valve alert
        sticky_valve_alert = state.sticky_valve_alert
        sticky_valve_dismissed = state.sticky_valve_dismissed
```

and delete lines 2166-2168 from the returned dict:

```python
        # Sticky valve alert
        'sticky_valve_alert': sticky_valve_alert,
        'sticky_valve_dismissed': sticky_valve_dismissed,
```

- [ ] **Step 3: Delete `/api/dismiss_sticky_valve`**

In `do_POST`, delete lines 4354-4356:

```python
        elif path == '/api/dismiss_sticky_valve':
            state.sticky_valve_dismissed = True
            self.send_json({'success': True, 'message': 'Alert dismissed'})

```

- [ ] **Step 4: Drop `'sticky_valve'` from `PI_CAPABILITIES`**

Line 36:
```python
PI_CAPABILITIES = ["fuel_tracker", "sticky_valve", "peak_egt"]
```
→
```python
PI_CAPABILITIES = ["fuel_tracker", "peak_egt"]
```

- [ ] **Step 5: Delete `HTML_TEMPLATE` and replace the `/` and `/static/chart.min.js` routes**

Delete the entire `HTML_TEMPLATE = '''<!DOCTYPE html> ... '''` block — line 2304 (the `# HTML Template...` comment) through line 4130 (the closing `'''`), plus the blank line immediately after.

In `do_GET` (line 4170), the current routing is:

```python
        if path == '/' or path == '/index.html':
            self.send_html(HTML_TEMPLATE)

        elif path == '/static/chart.min.js':
            # Serve local Chart.js file
            try:
                with open(CHART_JS_PATH, 'rb') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript')
                self.send_header('Content-Length', len(content))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_json({'error': 'Chart.js not found'}, 404)
            except BrokenPipeError:
                pass  # Client disconnected, ignore

        elif path == '/api/status':
```

Replace the `if`/`elif` for `/`, `/index.html`, and `/static/chart.min.js` with a single plain-text branch:

```python
        if path == '/' or path == '/index.html':
            try:
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.end_headers()
                self.wfile.write(b'Engine Monitor API running -- see FlyTab\n')
            except BrokenPipeError:
                pass  # Client disconnected, ignore

        elif path == '/api/status':
```

`/static/chart.min.js` had no consumer other than the now-deleted dashboard (FlyTab loads its own vendored `web/lib/chart.min.js` and never fetches from the Pi) — its route is dropped entirely, not replaced.

Also delete the now-unused `CHART_JS_PATH` constant (line 60: `CHART_JS_PATH = os.path.join(SCRIPT_DIR, 'chart.min.js')`). Leave the vendored `engine-monitor/chart.min.js` file itself on disk — deleting it is unnecessary and out of scope.

- [ ] **Step 6: Delete the dead `state.history` / `/api/history` trend-chart backend**

This is the other half of the Pi-workload reduction goal, separate from the dashboard's own HTTP polling deleted above: `state.history` is appended to on every parsed EDM sample regardless of whether a dashboard was ever open. Deleting it removes an always-on cost, not just a conditional one.

Delete the unused import (line 49):
```python
from collections import deque
```

Delete the now-unused constant (line 66):
```python
MAX_HISTORY_POINTS = 20000  # Max points to store (auto-pruned by time, not count)
```
(leave `HISTORY_SECONDS` at line 65 alone — it is separately unused today, predates this change, and is out of scope here.)

In `CaptureState.__init__`, delete the history buffer (lines 664-665):
```python
        # History for plotting (30 minutes)
        self.history = deque(maxlen=MAX_HISTORY_POINTS)
```

In `capture_thread_func`'s main read loop, inside the `with state.lock:` block, delete the history-entry build and append (lines 1838-1850):
```python
                            # Add to history with timestamp
                            history_entry = {
                                'timestamp': time.time(),
                                'EGT1': parsed.get('EGT1', 0),
                                'EGT2': parsed.get('EGT2', 0),
                                'EGT3': parsed.get('EGT3', 0),
                                'EGT4': parsed.get('EGT4', 0),
                                'CHT1': parsed.get('CHT1', 0),
                                'CHT2': parsed.get('CHT2', 0),
                                'CHT3': parsed.get('CHT3', 0),
                                'CHT4': parsed.get('CHT4', 0),
                            }
                            state.history.append(history_entry)
```
(the other assignments in the same `with state.lock:` block — `state.latest_data`, `state.data_count`, `state.percent_power`, `state.rop_lop_percent`, `state.rop_lop_mode`, `state.sfc` — are unrelated and stay untouched).

Delete `get_history()` in full (lines 2249-2302 — the entire function, from `def get_history(duration_minutes=30):` through its final closing `}`).

In `do_GET`, delete the `/api/history` branch (lines 4204-4213):
```python
        elif path == '/api/history':
            # Get duration from query parameter (default 30 minutes)
            duration = 30
            if 'duration' in query:
                try:
                    duration = int(query['duration'][0])
                    duration = max(1, min(duration, 120))  # Clamp to 1-120 minutes
                except (ValueError, IndexError):
                    pass
            self.send_json(get_history(duration))

```
(the blank line after it, before `elif path.startswith('/download/'):`, goes too — leave exactly one blank line between the two `elif` branches, matching the surrounding style).

- [ ] **Step 7: Update the JS fixture and its dependent test**

In `tests/fixtures/engine-messages.js`, in `ENGINE_FRAME`:
- Change `capabilities: ['fuel_tracker', 'sticky_valve', 'peak_egt'],` to `capabilities: ['fuel_tracker', 'peak_egt'],`
- Delete the two lines `sticky_valve_alert: null,` and `sticky_valve_dismissed: false,`

In `tests/shared/engine-client.test.js:118`, change:
```javascript
        expect(client.piCapabilities).toEqual(['fuel_tracker', 'sticky_valve', 'peak_egt']);
```
to:
```javascript
        expect(client.piCapabilities).toEqual(['fuel_tracker', 'peak_egt']);
```

- [ ] **Step 8: Run the JS test suite**

Run: `npm test`
Expected: PASS, including the updated `engine-client.test.js` assertion.

- [ ] **Step 9: Local playback smoke-test of the route changes**

`--playback` mode is fine here — this step checks route *responses*, not `auto_capture_monitor` (that's Task 1 Step 5's job, using the live pty simulator).

Run:
```bash
cd engine-monitor
python3 engine_monitor.py --playback <a-real-stream-file.txt> --no-stratux --web-port 8081 &
sleep 2
curl -s http://localhost:8081/ ; echo
curl -s http://localhost:8081/api/status | python3 -m json.tool | grep -i sticky
curl -s http://localhost:8081/api/status | python3 -c "import json,sys; print('capabilities:', json.load(sys.stdin)['capabilities'])"
curl -s -o /dev/null -w "/api/history -> %{http_code}\n" http://localhost:8081/api/history
kill %1
```
Expected: `GET /` prints `Engine Monitor API running -- see FlyTab`; the `grep -i sticky` line prints nothing (fields gone); `capabilities` prints `['fuel_tracker', 'peak_egt']`; `/api/history` returns `404` (falls through to the `do_GET` default `{"error": "Not found"}` branch now that its `elif` is deleted).

- [ ] **Step 10: Commit**

```bash
git add engine-monitor/engine_monitor.py tests/fixtures/engine-messages.js tests/shared/engine-client.test.js
git commit -m "refactor(engine-monitor): delete embedded dashboard and dead sticky-valve/history server code

FlyTab's ENG page is now the only human-facing engine UI. The dashboard's
own JS was the last reader of sticky_valve_alert/dismissed and the sole
consumer of /api/history's trend-chart data on the Pi side (engine-page.js's
on-device sticky-valve check and trend buffer are both fully independent),
so all three go together. state.history was being appended to on every
EDM sample regardless of whether a dashboard was ever open -- removing it
is the larger, unconditional half of the Pi CPU/lock-contention reduction
this change is for. All other API routes are unchanged; no PI_API_CONTRACT
bump needed."
```

---

### Task 3: Port TAS to the ENG page

**Files:**
- Modify: `web/cockpit/engine-page.js:224-230` (FLIGHT DATA section HTML), `:429-` (`update()`), `:1162-1166` (`.ep-flight-row` CSS)
- Modify: `web/app.js` (version bump)
- Modify: `docs/user-manual.md:146` (add paragraph)
- Create: `tests/cockpit/engine-page-flight-data.test.js`

**Interfaces:**
- Consumes: `d.tas` (number, knots) — already present on every status payload (`engine_monitor.py`'s `get_status()`, unchanged by this plan). `EnginePage.update(data)` receives the flattened status object exactly as today (no change to how data arrives — `EnginePanel.lastData` already carries the raw payload; `d.tas` is read the same way `d.density_altitude`/`d.oat` already are at lines 461-462).
- Produces: new DOM id `ep-tas` (gauge value), new CSS class `.ep-tas-note` (footnote).

- [ ] **Step 1: Add the TAS gauge to the FLIGHT DATA row**

In `web/cockpit/engine-page.js`, the FLIGHT DATA section (lines 224-230) currently reads:

```javascript
            <!-- Section 7: Flight data -->
            <div class="ep-section-title">FLIGHT DATA</div>
            <div class="ep-section ep-flight-row">
                ${this._gaugeHtml('ep-alt',  'ALT MSL',   '-----', 'ft')}
                ${this._gaugeHtml('ep-da',   'DENS ALT',  '-----', 'ft')}
                ${this._gaugeHtml('ep-oat',  'OAT',       '--',    '°C')}
                ${this._gaugeHtml('ep-gs',   'GND SPD',   '---',   'kts')}
            </div>
```

Change to:

```javascript
            <!-- Section 7: Flight data -->
            <div class="ep-section-title">FLIGHT DATA</div>
            <div class="ep-section ep-flight-row">
                ${this._gaugeHtml('ep-alt',  'ALT MSL',   '-----', 'ft')}
                ${this._gaugeHtml('ep-da',   'DENS ALT',  '-----', 'ft')}
                ${this._gaugeHtml('ep-oat',  'OAT',       '--',    '°C')}
                ${this._gaugeHtml('ep-gs',   'GND SPD',   '---',   'kts')}
                ${this._gaugeHtml('ep-tas',  'EST. TAS',  '---',   'kts')}
            </div>
            <div class="ep-tas-note">TAS is estimated from ground speed + density altitude (no wind correction) — not a pitot-derived airspeed.</div>
```

- [ ] **Step 2: Widen the flight-row grid and add the footnote style**

`.ep-flight-row` (line 1162-1166) is currently a 4-column grid:

```css
/* Flight data row -- 4 columns */
.ep-flight-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
}
```

Change to 5 columns and add a footnote class matching the existing `.ep-tank-source-note` convention (13px / weight 700 / `--text-muted`):

```css
/* Flight data row -- 5 columns */
.ep-flight-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
}

.ep-tas-note {
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--text-muted);
    text-align: center;
}
```

- [ ] **Step 3: Render `tas` in `update()`**

In `update(data)`, immediately after the existing flight-data render calls at lines 674-676:

```javascript
        this._setText('ep-da',  densAlt !== 0 ? Math.round(densAlt) : '-----');
        this._setText('ep-oat', oat !== 0 ? Math.round(oat) : '--');
        this._setText('ep-gs',  gs > 0 ? Math.round(gs) : '---');
```

add:

```javascript
        this._setText('ep-tas', d.tas ? Math.round(d.tas) : '---');
```

- [ ] **Step 4: Write the test file**

Create `tests/cockpit/engine-page-flight-data.test.js`, following the exact harness pattern already used by `tests/cockpit/engine-page-pi-contract.test.js`:

```javascript
/**
 * Engine Page — flight-data port (TAS, Cruise Targets, ATIS override)
 *
 * Covers the fields ported from the Pi's now-deleted embedded dashboard into
 * FlyTab's ENG page: EST. TAS, CRUISE TARGETS, and ATIS OVERRIDE. All three
 * fields already existed on the wire (engine_monitor.py get_status()) — this
 * only tests the new render/interaction code in engine-page.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');

const flatten = (frame) => (frame.data ? { ...frame, ...frame.data } : frame);
const FRAME = flatten(ENGINE_FRAME);

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

globalThis.EngineClient = { MIN_PI_CONTRACT: 2 };

let page = null;

function setup() {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = true;

    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null };
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? 36 : undefined),
    };
    window.enginePanel = { connected: true };

    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();
    return page;
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

describe('EnginePage — EST. TAS', () => {
    it('renders tas rounded to the nearest knot', () => {
        setup();
        page.update({ ...FRAME, tas: 154.6 });
        expect(page._el.querySelector('#ep-tas').textContent).toBe('155');
    });

    it('shows placeholder when tas is 0', () => {
        setup();
        page.update({ ...FRAME, tas: 0 });
        expect(page._el.querySelector('#ep-tas').textContent).toBe('---');
    });
});
```

- [ ] **Step 5: Run the test**

Run: `npm test -- engine-page-flight-data`
Expected: PASS (2 tests).

- [ ] **Step 6: Update the user manual**

In `docs/user-manual.md`, after the "Engine ML" paragraph (line 146) and before the closing `---` (line 148), add:

```markdown

**FLIGHT DATA** now also shows **EST. TAS** — an estimate from ground speed and density altitude (roughly +2%/1000 ft DA), not a wind-corrected true airspeed. Treat it as approximate.
```

- [ ] **Step 7: Bump version and build**

In `web/app.js`, increment `FLYTAB_VERSION` (check current value first — do not guess it; read the constant, then increment the minor number by one, e.g. `v10.23` → `v10.24`, avoiding the three-decimal-digit trap: `v10.99` → `v10.100` is invalid, must go to `v11.0`).

Run: `bash build.sh`
Expected: build succeeds.

- [ ] **Step 8: On-device / CDP verification**

Per CLAUDE.md, confirm on-device or via CDP that the ENG page still opens and the FLIGHT DATA row renders 5 gauges with EST. TAS showing a live value (or `---` if GS is 0). Record what was actually checked in the task summary — do not report this step done without having run it.

- [ ] **Step 9: Commit**

```bash
git add web/cockpit/engine-page.js web/app.js docs/user-manual.md tests/cockpit/engine-page-flight-data.test.js
git commit -m "feat(engine-page): port estimated TAS from the Pi dashboard

Ported from engine_monitor.py's HTML_TEMPLATE (deleted in a prior commit).
The tas field was already published by get_status() and just unconsumed."
```

---

### Task 4: Port Cruise Targets to the ENG page

**Files:**
- Modify: `web/cockpit/engine-page.js:230-231` (insert new section), `:429-` (`update()`), `:1162-1166` area (CSS)
- Modify: `tests/fixtures/engine-messages.js` (add fields)
- Modify: `tests/cockpit/engine-page-flight-data.test.js` (extend)
- Modify: `web/app.js` (version bump)
- Modify: `docs/user-manual.md` (add paragraph)

**Interfaces:**
- Consumes: `d.target_fuel_flow` (number, GPH), `d.target_power` (number, %), `d.target_mode` (string, e.g. `"LEAN"`) — all already published by `get_status()` (`engine_monitor.py:2156-2158`).
- Produces: new DOM ids `ep-target-ff`, `ep-target-pwr`, `ep-target-mode`; new CSS class `.ep-target-row`.

- [ ] **Step 1: Add fixture fields**

In `tests/fixtures/engine-messages.js`, in `ENGINE_FRAME`, add three fields alongside the existing `tas`/`density_altitude` lines:

```javascript
    tas:                    155,
    target_fuel_flow:        9.2,
    target_power:            65,
    target_mode:            'LEAN',
```

- [ ] **Step 2: Insert the Cruise Targets section**

In `web/cockpit/engine-page.js`, immediately after the FLIGHT DATA section and its `.ep-tas-note` (added in Task 3, currently ending around line 231) and before `<!-- Section 8: Recording indicator -->`, insert:

```javascript
            <!-- Section 7.5: Cruise targets (recommended power/mixture for current density altitude) -->
            <div class="ep-section-title">CRUISE TARGETS</div>
            <div class="ep-section ep-target-row">
                ${this._gaugeHtml('ep-target-ff',   'TARGET FF',  '--.-', 'GPH')}
                ${this._gaugeHtml('ep-target-pwr',  'TARGET PWR', '--',   '%')}
                ${this._gaugeHtml('ep-target-mode', 'MODE',       '---',  '')}
            </div>
```

- [ ] **Step 3: Add the CSS grid for the new row**

Add, next to the `.ep-flight-row` block:

```css
/* Cruise targets row -- 3 columns */
.ep-target-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
}
```

- [ ] **Step 4: Render the fields in `update()`**

Immediately after the `this._setText('ep-tas', ...)` line added in Task 3, add:

```javascript
        this._setText('ep-target-ff',   d.target_fuel_flow ? d.target_fuel_flow.toFixed(1) : '--.-');
        this._setText('ep-target-pwr',  d.target_power || '--');
        this._setText('ep-target-mode', d.target_mode || '---');
```

- [ ] **Step 5: Extend the test file**

In `tests/cockpit/engine-page-flight-data.test.js`, add a new `describe` block after the existing `EST. TAS` block:

```javascript
describe('EnginePage — Cruise Targets', () => {
    it('renders target fuel flow, power, and mode', () => {
        setup();
        page.update({ ...FRAME, target_fuel_flow: 9.2, target_power: 65, target_mode: 'LEAN' });
        expect(page._el.querySelector('#ep-target-ff').textContent).toBe('9.2');
        expect(page._el.querySelector('#ep-target-pwr').textContent).toBe('65');
        expect(page._el.querySelector('#ep-target-mode').textContent).toBe('LEAN');
    });

    it('shows placeholders when target fields are zero/empty', () => {
        setup();
        page.update({ ...FRAME, target_fuel_flow: 0, target_power: 0, target_mode: '' });
        expect(page._el.querySelector('#ep-target-ff').textContent).toBe('--.-');
        expect(page._el.querySelector('#ep-target-pwr').textContent).toBe('--');
        expect(page._el.querySelector('#ep-target-mode').textContent).toBe('---');
    });
});
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- engine-page-flight-data`
Expected: PASS (4 tests total).

Run: `npm test`
Expected: PASS (full suite — confirms the fixture change didn't break another consumer).

- [ ] **Step 7: Update the user manual**

In `docs/user-manual.md`, after the TAS paragraph added in Task 3, add:

```markdown

**CRUISE TARGETS** — recommended fuel flow, power setting, and mixture mode for the current density altitude (below 8,000 ft DA: 65% power LEAN; 8,000–12,000 ft: 60%; above 12,000 ft: 55%), aimed at best-economy LOP operation. A guideline, not a limit — cross-check against your own POH power charts.
```

- [ ] **Step 8: Bump version and build**

Increment `FLYTAB_VERSION` in `web/app.js` (read current value first, don't guess).
Run: `bash build.sh`
Expected: build succeeds.

- [ ] **Step 9: On-device / CDP verification**

Confirm the CRUISE TARGETS row renders correctly on the ENG page with live data. Record what was actually checked.

- [ ] **Step 10: Commit**

```bash
git add web/cockpit/engine-page.js tests/fixtures/engine-messages.js tests/cockpit/engine-page-flight-data.test.js web/app.js docs/user-manual.md
git commit -m "feat(engine-page): port cruise fuel-flow/power/mode targets from the Pi dashboard

Ported from engine_monitor.py's HTML_TEMPLATE (deleted in a prior commit).
target_fuel_flow/target_power/target_mode were already published by
get_status() and just unconsumed."
```

---

### Task 5: Port ATIS manual override to the ENG page

**Files:**
- Modify: `web/cockpit/engine-page.js` (HTML section, `_dom` cache, wiring in `_buildDom`, new `_setAtis`/`_updateAtisStatus` methods, `update()`, CSS)
- Modify: `tests/cockpit/engine-page-flight-data.test.js` (extend)
- Modify: `web/app.js` (version bump)
- Modify: `docs/user-manual.md` (add paragraph)

**Interfaces:**
- Consumes: `d.manual_altimeter` (number in inHg, or `null`), `d.manual_oat` (number in °C, or `null`) — already published by `get_status()` (`engine_monitor.py:2175-2176`).
- Produces: `POST http://192.168.10.1:8080/api/atis` with body `{altimeter: number|null}` or `{oat: number|null}` (one key per call — a key omitted from the body means "no change" per the Pi's existing contract at `engine_monitor.py:4358-4391`; this plan always sends exactly one key per request, matching the two independent SET/CLEAR pairs below).
- Note: setting either override changes what `d.oat`/`d.density_altitude`/`d.tas` already display elsewhere on this page (`engine_monitor.py:1537-1554`) — this is not a cosmetic-only field, which is why an active override must stay visibly flagged.

- [ ] **Step 1: Insert the ATIS override panel**

Immediately after the Cruise Targets section added in Task 4 and before `<!-- Section 8: Recording indicator -->`, insert:

```javascript
            <!-- Section 7.6: ATIS manual override for altimeter/OAT (feeds density alt + TAS calcs above) -->
            <div class="ep-section-title">ATIS OVERRIDE</div>
            <div class="ep-atis-panel">
                <div class="ep-atis-row">
                    <span class="ep-atis-label">ALTIMETER (inHg)</span>
                    <input type="number" class="ep-atis-input" id="ep-atis-alt-input" placeholder="29.92" min="27" max="32" step="0.01" inputmode="decimal">
                    <button class="ep-atis-btn ep-atis-set-btn" id="ep-atis-alt-set">SET</button>
                    <button class="ep-atis-btn ep-atis-clear-btn" id="ep-atis-alt-clear">CLEAR</button>
                </div>
                <div class="ep-atis-row">
                    <span class="ep-atis-label">OAT (°C)</span>
                    <input type="number" class="ep-atis-input" id="ep-atis-oat-input" placeholder="15" min="-40" max="50" step="1" inputmode="decimal">
                    <button class="ep-atis-btn ep-atis-set-btn" id="ep-atis-oat-set">SET</button>
                    <button class="ep-atis-btn ep-atis-clear-btn" id="ep-atis-oat-clear">CLEAR</button>
                </div>
                <div class="ep-atis-status" id="ep-atis-status">Using calculated OAT / altimeter</div>
            </div>
```

- [ ] **Step 2: Add the CSS**

Add, after the `.ep-target-row` block from Task 4:

```css
/* ATIS override panel */
.ep-atis-panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 8px;
}
.ep-atis-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
}
.ep-atis-label {
    flex: 1;
    font-family: var(--font-ui);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
}
.ep-atis-input {
    width: 90px;
    height: var(--touch-min, 56px);
    text-align: center;
    font-size: 18px;
    font-weight: 900;
    font-family: var(--font-instrument);
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 2px solid var(--border-strong);
    border-radius: 6px;
}
.ep-atis-btn {
    height: var(--touch-min, 56px);
    padding: 0 14px;
    border-radius: 6px;
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 800;
    cursor: pointer;
    border: none;
}
.ep-atis-set-btn {
    background: var(--accent);
    color: #000;
}
.ep-atis-clear-btn {
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 2px solid var(--border-strong);
}
.ep-atis-btn:active { opacity: 0.6; }
.ep-atis-status {
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-muted);
    text-align: center;
    margin-top: 4px;
}
.ep-atis-status--active {
    color: var(--accent);
    font-weight: 800;
}
```

- [ ] **Step 3: Cache the status element and wire the four buttons**

In the `_dom` cache object (lines 277-299), add one entry after `ticGrade`:

```javascript
            ticGrade: this._el.querySelector('#ep-tic-grade'),
            atisStatus: this._el.querySelector('#ep-atis-status'),
```

In `_buildDom`, immediately after the existing sticky-valve-dismiss wiring block (lines 252-256), add:

```javascript
        // Wire ATIS override controls
        const atisAltInput = this._el.querySelector('#ep-atis-alt-input');
        const atisOatInput = this._el.querySelector('#ep-atis-oat-input');
        wireTap(this._el.querySelector('#ep-atis-alt-set'), () => this._setAtis('altimeter', atisAltInput.value));
        wireTap(this._el.querySelector('#ep-atis-alt-clear'), () => { atisAltInput.value = ''; this._setAtis('altimeter', null); });
        wireTap(this._el.querySelector('#ep-atis-oat-set'), () => this._setAtis('oat', atisOatInput.value));
        wireTap(this._el.querySelector('#ep-atis-oat-clear'), () => { atisOatInput.value = ''; this._setAtis('oat', null); });
```

- [ ] **Step 4: Add `_setAtis` and `_updateAtisStatus` methods**

Add these two methods near `_stopCapture` (after it, before the `/* DOM helpers */` section):

```javascript
    async _setAtis(key, rawVal) {
        const val = (rawVal === '' || rawVal === null || rawVal === undefined) ? null : parseFloat(rawVal);
        if (val !== null && Number.isNaN(val)) return;
        try {
            await fetch('http://192.168.10.1:8080/api/atis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: val }),
                signal: AbortSignal.timeout(5000),
            });
        } catch (_) {
            // Next status poll reflects whatever the Pi actually has; no local
            // optimistic state to roll back.
        }
    }

    _updateAtisStatus(d) {
        const altInput = this._el.querySelector('#ep-atis-alt-input');
        const oatInput = this._el.querySelector('#ep-atis-oat-input');
        const statusEl = this._dom.atisStatus;
        if (!statusEl) return;

        const altOverride = d.manual_altimeter != null;
        const oatOverride = d.manual_oat != null;

        if (altInput && altInput.value === '' && altOverride) altInput.value = d.manual_altimeter;
        if (oatInput && oatInput.value === '' && oatOverride) oatInput.value = d.manual_oat;

        if (!altOverride && !oatOverride) {
            statusEl.textContent = 'Using calculated OAT / altimeter';
            statusEl.className = 'ep-atis-status';
        } else {
            const parts = [];
            if (altOverride) parts.push(`ALT ${d.manual_altimeter} inHg`);
            if (oatOverride) parts.push(`OAT ${d.manual_oat}°C`);
            statusEl.textContent = `ATIS OVERRIDE ACTIVE — ${parts.join(' / ')}`;
            statusEl.className = 'ep-atis-status ep-atis-status--active';
        }
    }
```

- [ ] **Step 5: Call `_updateAtisStatus` from `update()`**

Immediately after the `this._setText('ep-target-mode', ...)` line added in Task 4, add:

```javascript
        this._updateAtisStatus(d);
```

- [ ] **Step 6: Extend the test file**

In `tests/cockpit/engine-page-flight-data.test.js`, add `beforeEach`/`afterEach` fetch stubbing and a new `describe` block. Change the top-level `beforeEach`/`afterEach` to also stub `fetch`:

```javascript
beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
});

afterEach(() => {
    page = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete window.enginePanel;
    delete globalThis.fetch;
});
```

Then add:

```javascript
describe('EnginePage — ATIS override', () => {
    it('shows "using calculated" when no override is active', () => {
        setup();
        page.update({ ...FRAME, manual_altimeter: null, manual_oat: null });
        expect(page._el.querySelector('#ep-atis-status').textContent).toBe('Using calculated OAT / altimeter');
    });

    it('shows active-override text and pre-fills empty inputs', () => {
        setup();
        page.update({ ...FRAME, manual_altimeter: 29.92, manual_oat: 15 });
        expect(page._el.querySelector('#ep-atis-status').textContent).toContain('ATIS OVERRIDE ACTIVE');
        expect(page._el.querySelector('#ep-atis-status').textContent).toContain('ALT 29.92 inHg');
        expect(page._el.querySelector('#ep-atis-status').textContent).toContain('OAT 15°C');
        expect(page._el.querySelector('#ep-atis-alt-input').value).toBe('29.92');
        expect(page._el.querySelector('#ep-atis-oat-input').value).toBe('15');
    });

    it('does not clobber an in-progress pilot edit', () => {
        setup();
        const input = page._el.querySelector('#ep-atis-alt-input');
        input.value = '30.01';
        page.update({ ...FRAME, manual_altimeter: 29.92 });
        expect(input.value).toBe('30.01');
    });

    it('SET posts only the altimeter key', async () => {
        setup();
        await page._setAtis('altimeter', '29.85');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'http://192.168.10.1:8080/api/atis',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ altimeter: 29.85 }),
            })
        );
    });

    it('CLEAR posts null for the given key', async () => {
        setup();
        await page._setAtis('oat', null);
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'http://192.168.10.1:8080/api/atis',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ oat: null }),
            })
        );
    });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test -- engine-page-flight-data`
Expected: PASS (9 tests total).

Run: `npm test`
Expected: PASS (full suite).

- [ ] **Step 8: Update the user manual**

In `docs/user-manual.md`, after the Cruise Targets paragraph added in Task 4, add:

```markdown

**ATIS OVERRIDE** — enter a fresher altimeter setting and/or OAT than the Pi's own calculated values (e.g. right after copying ATIS/AWOS before an approach). SET applies one field at a time; CLEAR reverts that field to the calculated value. An active override is flagged below the inputs ("ATIS OVERRIDE ACTIVE — ...") because it also feeds DENS ALT and EST. TAS above, not just the OAT gauge — those three numbers reflect your entered value, not a live measurement, until cleared.
```

- [ ] **Step 9: Bump version and build**

Increment `FLYTAB_VERSION` in `web/app.js` (read current value first, don't guess).
Run: `bash build.sh`
Expected: build succeeds.

- [ ] **Step 10: On-device / CDP verification**

Confirm on-device or via CDP: the ATIS OVERRIDE panel renders, entering an altimeter value and tapping SET issues the POST (check via CDP network tab or Pi-side log line `ATIS: Altimeter set to ... inHg`), the status line updates to show the override active, and CLEAR reverts it. Record what was actually checked — this is the one piece of new UI in this plan with a real side effect (a POST to the Pi that changes displayed values), so do not skip live verification.

- [ ] **Step 11: Commit**

```bash
git add web/cockpit/engine-page.js tests/cockpit/engine-page-flight-data.test.js web/app.js docs/user-manual.md
git commit -m "feat(engine-page): port ATIS manual altimeter/OAT override from the Pi dashboard

Ported from engine_monitor.py's HTML_TEMPLATE (deleted in a prior commit).
POST /api/atis already existed and already fed density-altitude/TAS calcs
on the Pi side; this just gives FlyTab a way to set/clear it and see that
it's active."
```

---

## Final Acceptance (after Task 5)

- [ ] Deploy to the real Pi and run the manual-stop-latch scenario end-to-end: `bash test-pipeline.sh` (or `test-pipeline.sh --file <name>` for a specific flight), start capture, hit Stop from FlyTab's ENG page while the simulated engine is still "running," and confirm capture does **not** resume within the old ~15-20s window — then confirm it **does** resume automatically once that simulated flight ends and a new one starts (or after a real engine RPM < 300 is observed).
- [ ] `bash deploy-pi.sh` to the real Pi; confirm `GET http://<pi-ip>:8080/` returns the plain-text response and every route FlyTab depends on (`/api/status`, `/api/start`, `/api/stop`, `/api/atis`, `/api/fuel/*`) still returns the same shape as before this plan.
- [ ] On the tablet, open the ENG page and confirm: EST. TAS, CRUISE TARGETS, and ATIS OVERRIDE all render and update with live data; setting/clearing an ATIS override visibly changes OAT/DENS ALT/EST. TAS elsewhere on the same page.
- [ ] `npm test` passes on the final state of the branch.
