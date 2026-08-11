# Code Review Fixes — Reliability & Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 12 independently-verified defects from a code review of the FlyTab cockpit app and Pi engine monitor — a wedge-prone engine WebSocket, a live-nav crash-loop risk, a permanent serial-reconnect failure, an unauthenticated file-write endpoint on the Pi, dead/misleading code in three subsystems, and several reconnect/config bugs — without touching the two items that need their own design pass first (a canonical trip-object facade and a composition-root refactor; see Appendix A).

**Architecture:** Three independently-shippable phases, ordered by risk. Phase 1 fixes defects that can strand the pilot mid-flight or let an unauthenticated device on the Pi's WiFi overwrite the engine monitor's own running script. Phase 2 fixes structural bugs (dead code paths, config bypasses, timer leaks) that are real but not immediately flight-dangerous. Phase 3 is mechanical cleanup. Each phase ends with its own version bump, build, and verification pass — phases do not need to ship together or in one PR.

**Tech Stack:** Vanilla JavaScript (`web/`, loaded via `<script>` tags, no bundler), Python 3 (`engine-monitor/engine_monitor.py`, stdlib `http.server`), Java/Capacitor (`android/`). Test runner is Vitest (`npm test`) with jsdom — cockpit and shared JS files are tested by loading their source through `new Function(src + '\nreturn ClassName;')()` and driving the real class directly (see any file under `tests/cockpit/` or `tests/shared/` for the established pattern; do not introduce a different one). The Python side has no unit test framework — verification is via `test-pipeline.sh` / `data_simulator.py` (full pipeline replay) and direct `curl`. Android native code has no test harness in this repo — verification is on-device via `adb logcat`.

## Re-verification against `main` (2026-08-09, before branching)

This plan was originally written against a checkout of `feat/route-cloud-display`, which turned out to be 26 commits behind `main` (the route-cloud-display feature itself had already merged to `main` via PRs #121/#122, plus follow-on fixes, taking it to `v10.22`). Before creating branches, every file this plan touches was re-diffed against current `main`:

- **Unaffected, confirmed byte-identical to what was verified**: `engine-client.js`, `stratux-client.js`, `weather-client.js`, `preflight-check.js`, `network-mode.js`, `device-status.js`, `fuel-overlay.js`, `engine-page.js`, `emergency-glide.js`, `engine-gps-bridge.js`, `nasr-db.js`, `engine_monitor.py`, `MainActivity.java`, `build.gradle`. No task touching these needed any correction.
- **`web/app.js`**: only the `FLYTAB_VERSION` line differs (now `v10.22` on `main`) — Task 12's Convective-guard target (lines 713–735) reconfirmed byte-identical.
- **`web/cockpit/route-table.js`**: grew by 158 lines (unrelated cloud-forecast feature code). Every line my plan targets is **content-identical**, just renumbered — Task 2 and Task 16 below have corrected line numbers. Investigating this also surfaced a genuinely new observation, noted inline in Task 16: a third call site (`_showUploadModal()`) has the identical `_applyPlan()`-bypass pattern as the plan picker, never flagged in the original review and **not** included in this plan's scope — flagged for a separate follow-up.
- **`web/style.css`**: gained 5 unrelated lines (`--cloud-fill`/`--cloud-contour` tokens) before the touch-target block, shifting it down. The dead `[data-mode="cockpit"]`/`[data-mode="night"]` blocks are **unaffected** (still lines 49–127, confirmed). Task 14 below has corrected line numbers for the touch-target block, plus two newly-noticed stale comments that will need updating alongside the value fix.

## Second verification pass — every file personally read, not just diffed (2026-08-09, before Phase 1 execution)

The bullets above came from `git diff`/`git show` against `main` — proof the files hadn't drifted, but not a read of their actual content. Every file this plan edits or cites a line number in was then read directly (in the `fix/critical-reliability-security` worktree) and cross-checked against every diff in this document. Three real issues surfaced and are already fixed in the tasks below — recorded here so the correction history isn't lost:

- **Task 13 (`engine-gps-bridge.js`)**: the "before" diff had `{ detail: {` condensed onto one line; the real source wraps `detail: {` onto its own line. Same fields, wrong brace placement — would have failed an exact-string edit. Fixed.
- **Task 10 (`stratux-client.js`)**: three issues. (1) The weather-`onclose` "before" state was missing a 3-line comment that's actually present in the real handler — fixed. (2) Two test assertions used `.not.toBeNull()`, which also passes when a field is simply `undefined` (i.e. doesn't discriminate "fix applied" from "fix absent") — changed to `.toBeTruthy()`. (3) One test tried `client.udpMode = true` — `udpMode` is a getter with no setter (confirmed directly in source), so that assignment throws in strict mode. Rewrote the test to re-evaluate the source with `Capacitor.Plugins.StratuxUDP` stubbed, the same way the class itself detects the native plugin, instead of trying to set the getter.
- **Task 3 (`engine_monitor.py`)**: minor prose-only fix — `check_sticky_valve()` is defined at line 1215, not 1234 as originally estimated. Doesn't affect any actual diff (the function body isn't touched by this plan), just a citation in the explanatory text.

Everything else — `StratuxWsPlugin.java`, `engine-client.js`, `weather-client.js`'s three deletion ranges, `preflight-check.js`'s two call sites, `network-mode.js`/`device-status.js`'s hardcoded-IP lines, `fuel-overlay.js`/`engine-page.js`'s Pi-URL sites, `nasr-db.js`'s dead methods and guard-pattern reference, `emergency-glide.js`'s three `window.stratuxClient` sites, and `engine_monitor.py`'s imports/`SCRIPT_DIR`/`log()`/lock block/exception handler/upload handler — matched this plan's diffs exactly, confirmed by direct read.

## Global Constraints

- **Traceability**: every task below cites the original review's finding number (e.g. "Finding 1"). Keep those references in commit messages so the review thread stays linked to the fix.
- **`FLYTAB_VERSION`** (top of `web/app.js`, `v10.22` as of this worktree's base commit — re-check with `grep FLYTAB_VERSION web/app.js` before bumping, since it moves with every merge to `main`) must be incremented before any `bash build.sh` run — this is an existing repo policy (`build.sh` reads it to set `versionCode`/`versionName`). Do not use three digits after the decimal (`v10.180` is invalid) and do not cross a major-version boundary casually (`v11.0` → versionCode `110`, which is *lower* than `v10.99`'s `1099`). Each phase batches its version bump into one build step at the end rather than bumping per-task — this matches how this repo's own prior plans (e.g. `docs/superpowers/plans/2026-06-07-stratux-reconnect-recording-gap.md`) already do it.
- **Engine monitor deploys**: any `engine_monitor.py` change requires `bash deploy-pi.sh` (add `--full` to restart the service) to reach the Pi — `bash build.sh` does not touch it.
- **`npm test` before considering any `web/shared/` or `web/cockpit/` task done.** CLAUDE.md states there is no test coverage for `cockpit/*.js` outside `web/shared/planning/` — that is stale as of this session; substantial Vitest coverage already exists under `tests/cockpit/` and `tests/shared/` using the `new Function` extraction pattern. Follow that pattern for every new test in this plan.
- **`PI_API_CONTRACT` bump discipline does NOT apply to this plan.** None of these fixes change a wire field name, unit, or shared physical constant — confirmed per task below. Do not bump `PI_API_CONTRACT` or `EngineClient.MIN_PI_CONTRACT`.
- **Tap Handler Regression Rule does NOT apply** — no task touches `onAirportClick`/`onNavaidClick`/`onFixClick`.
- **User manual**: none of these changes are pilot-visible *new* features. Task 14's touch-target correction (48px → 56/64px) restores this repo's own documented standard (CLAUDE.md's Design Token Standards table) rather than introducing new behavior, so it falls under "bug fixes that restore previously correct behavior" — no `docs/user-manual.md` update required. Flag this reasoning in that task's PR description so it isn't misread as a skipped doc update.
- **File overlaps** — two pairs of tasks touch the same file. Execute each pair sequentially (not as parallel subagents) to avoid a merge conflict: Task 2 and Task 16 both touch `web/cockpit/route-table.js`; Task 3 and Task 4 both touch `engine-monitor/engine_monitor.py`.
- **Open decision inside Task 4** (do not silently resolve — see that task's "Decision needed" callout): fixing `/api/upload`'s missing auth will 401 the existing browser-based "upload from iPad" admin page, which has no way to learn the new shared-secret token without defeating its purpose. Resolve before merging Task 4, not during.
- **Known stale artifact, not part of this plan**: `docs/superpowers/specs/2026-05-04-route-planner-best-practices-comparison.md:21` describes `WeatherClient.fetchAllForRoute()` as live, current behavior. Task 6 deletes that method as dead code; someone should correct that spec doc separately.

---

# Phase 1 — Critical (in-flight reliability & Pi security)

## Task 1: Detect a half-open engine WebSocket via a native ping/timeout plugin

**Finding 1.** The browser `WebSocket` API never fires `onclose` for a half-closed TCP link (peer stops sending, socket stays "open") — this is exactly why Stratux already has a native plugin (`StratuxWsPlugin.java`, confirmed at `android/app/src/main/java/app/flywhere/flytab/StratuxWsPlugin.java`: `pingInterval(30, TimeUnit.SECONDS)` + a synthesized `code=1006` close on ping failure). `web/shared/engine-client.js` has no equivalent — its `_ws` is a plain `new WebSocket(url)` (confirmed at line 100), and its 5-second stale-check (confirmed lines 157–168) only sets a UI flag; it never closes or reconnects the socket. A `WebSocket.close()` call on a truly half-open socket is not a sufficient fix on its own — RFC 6455 / the WHATWG spec leave completion of the closing handshake undefined when the peer never responds, and this codebase's own `StratuxWsPlugin.java` javadoc already documents this exact failure mode for the sister connection. `OkHttp` (`com.squareup.okhttp3:okhttp:4.12.0`) is already a build dependency (confirmed `android/app/build.gradle:52`, with a comment already citing it for exactly this half-closed-connection problem), so no build-config change is needed.

**Files:**
- Create: `android/app/src/main/java/app/flywhere/flytab/EngineWsPlugin.java`
- Modify: `android/app/src/main/java/app/flywhere/flytab/MainActivity.java:30` (insert one line)
- Modify: `web/shared/engine-client.js` (add native-bus wrapper; change `_doConnect`)
- Test: `tests/shared/engine-client.test.js` (extend)

**Interfaces:**
- Produces: a new Capacitor plugin `EngineWS` with JS-visible methods `open({channel, url, session})` / `close({channel})` and events `open`/`message`/`close`/`error`, each carrying `{channel, session, ...}`. Nothing else in this plan depends on it.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Create the native plugin**

`android/app/src/main/java/app/flywhere/flytab/EngineWsPlugin.java` (new file):

```java
package app.flywhere.flytab;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Native WebSocket transport for the Pi engine monitor. Mirrors StratuxWsPlugin —
 * same problem, same fix: the browser WebSocket API can't send/receive protocol-level
 * ping/pong and can't detect a half-closed connection (peer stops sending, no
 * FIN/RST — readyState stays OPEN forever, onclose never fires). OkHttp's
 * pingInterval kills a dead connection in ~30s and surfaces a real close event so
 * the JS reconnect / HTTP-fallback path in engine-client.js runs.
 *
 * JS API (identical shape to StratuxWS):
 *   EngineWS.open({ channel, url, session })
 *   EngineWS.close({ channel })
 *   EngineWS.addListener('message', ({channel, session, data}) => …)
 *   EngineWS.addListener('open',    ({channel, session}) => …)
 *   EngineWS.addListener('close',   ({channel, session, code, reason}) => …)
 *   EngineWS.addListener('error',   ({channel, session, message}) => …)
 */
@CapacitorPlugin(name = "EngineWS")
public class EngineWsPlugin extends Plugin {
    private static final String TAG = "EngineWS";
    private static final long PING_INTERVAL_SEC = 30;

    private final Map<String, WebSocket> sockets = new HashMap<>();
    private OkHttpClient client;

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
            .pingInterval(PING_INTERVAL_SEC, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .build();
    }

    @PluginMethod
    public void open(PluginCall call) {
        final String channel = call.getString("channel");
        final String url     = call.getString("url");
        final String session = call.getString("session", "");
        if (channel == null || url == null) {
            call.reject("channel and url are required");
            return;
        }

        WebSocket old = sockets.remove(channel);
        if (old != null) {
            try { old.cancel(); } catch (Exception ignored) {}
        }

        Request req = new Request.Builder().url(url).build();
        WebSocket ws = client.newWebSocket(req, new WebSocketListener() {
            private boolean current(WebSocket self) {
                return sockets.get(channel) == self;
            }

            private JSObject base() {
                JSObject ev = new JSObject();
                ev.put("channel", channel);
                ev.put("session", session);
                return ev;
            }

            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                if (!current(webSocket)) return;
                Log.i(TAG, channel + " WS opened: " + url);
                notifyListeners("open", base());
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                if (!current(webSocket)) return;
                JSObject ev = base();
                ev.put("data", text);
                notifyListeners("message", ev);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                if (!current(webSocket)) return;
                JSObject ev = base();
                ev.put("data", bytes.base64());
                ev.put("binary", true);
                notifyListeners("message", ev);
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (!current(webSocket)) return;
                Log.i(TAG, channel + " WS closed code=" + code + " reason=\"" + reason + "\"");
                sockets.remove(channel);
                JSObject ev = base();
                ev.put("code", code);
                ev.put("reason", reason == null ? "" : reason);
                notifyListeners("close", ev);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (!current(webSocket)) return;
                String msg = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                Log.w(TAG, channel + " WS failure: " + msg);
                sockets.remove(channel);
                JSObject errEv = base();
                errEv.put("message", msg);
                notifyListeners("error", errEv);
                JSObject closeEv = base();
                closeEv.put("code", 1006);
                closeEv.put("reason", "ping_timeout_or_network_failure");
                notifyListeners("close", closeEv);
            }
        });
        sockets.put(channel, ws);
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String channel = call.getString("channel");
        if (channel == null) { call.reject("channel required"); return; }
        WebSocket ws = sockets.remove(channel);
        if (ws != null) {
            try { ws.close(1000, "client_close"); } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (WebSocket ws : sockets.values()) {
            try { ws.cancel(); } catch (Exception ignored) {}
        }
        sockets.clear();
    }
}
```

- [ ] **Step 2: Register the plugin**

`android/app/src/main/java/app/flywhere/flytab/MainActivity.java` — confirmed current content at lines 26–31:

```java
        registerPlugin(TileServerPlugin.class);
        registerPlugin(ThermalMonitorPlugin.class);
        registerPlugin(EngineMLPlugin.class);
        registerPlugin(SftpPlugin.class);
        registerPlugin(StratuxWsPlugin.class);
        registerPlugin(StratuxUdpPlugin.class);
```

Insert one line after `StratuxWsPlugin.class` and before `StratuxUdpPlugin.class`:

```java
        registerPlugin(TileServerPlugin.class);
        registerPlugin(ThermalMonitorPlugin.class);
        registerPlugin(EngineMLPlugin.class);
        registerPlugin(SftpPlugin.class);
        registerPlugin(StratuxWsPlugin.class);
        registerPlugin(EngineWsPlugin.class);
        registerPlugin(StratuxUdpPlugin.class);
```

No new import needed — `EngineWsPlugin` is in the same package (`app.flywhere.flytab`) as `MainActivity`, matching how `StratuxWsPlugin`/`StratuxUdpPlugin` are already registered with no import.

- [ ] **Step 3: Write the failing tests for the JS wrapper**

Add to `tests/shared/engine-client.test.js`, after the existing top-of-file source load (after line 25, before the first `describe`):

```javascript
const { _createEngineWs } = new Function(`${src}\nreturn { _createEngineWs };`)();
```

Then append these two new `describe` blocks at the end of the file:

```javascript
// ---------------------------------------------------------------------------
// _createEngineWs — falls back to plain WebSocket outside Capacitor (Finding 1)
// ---------------------------------------------------------------------------
describe('_createEngineWs — no Capacitor present', () => {
    it('falls back to the plain browser WebSocket', () => {
        const ws = _createEngineWs('ws://127.0.0.1:8082/');
        expect(ws).toBeInstanceOf(WebSocket);
    });
});

// ---------------------------------------------------------------------------
// _createEngineWs — native plugin bridging (Finding 1)
// ---------------------------------------------------------------------------
describe('_createEngineWs — native EngineWS plugin present', () => {
    let mockPlugin, listeners, _createEngineWsNative;

    beforeEach(() => {
        listeners = {};
        mockPlugin = {
            addListener: vi.fn((type, cb) => { listeners[type] = cb; }),
            open: vi.fn(),
            close: vi.fn(),
        };
        global.Capacitor = { Plugins: { EngineWS: mockPlugin } };
        // Re-evaluate the source fresh so the _EngineNativeBus IIFE sees Capacitor.
        ({ _createEngineWs: _createEngineWsNative } = new Function(`${src}\nreturn { _createEngineWs };`)());
    });

    afterEach(() => {
        delete global.Capacitor;
    });

    it('opens via the native plugin, not the browser WebSocket', () => {
        const ws = _createEngineWsNative('ws://1.2.3.4:8082/');
        expect(ws).not.toBeInstanceOf(WebSocket);
        expect(mockPlugin.open).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'engine', url: 'ws://1.2.3.4:8082/' })
        );
    });

    it('routes a native open event to ws.onopen and flips readyState to 1', () => {
        const ws = _createEngineWsNative('ws://x');
        ws.onopen = vi.fn();
        const session = mockPlugin.open.mock.calls[0][0].session;
        listeners.open({ channel: 'engine', session });
        expect(ws.readyState).toBe(1);
        expect(ws.onopen).toHaveBeenCalled();
    });

    it('routes a native close event (e.g. ping-timeout 1006) to ws.onclose with code/reason', () => {
        const ws = _createEngineWsNative('ws://x');
        ws.onclose = vi.fn();
        const session = mockPlugin.open.mock.calls[0][0].session;
        listeners.close({ channel: 'engine', session, code: 1006, reason: 'ping_timeout_or_network_failure' });
        expect(ws.readyState).toBe(3);
        expect(ws.onclose).toHaveBeenCalledWith({ code: 1006, reason: 'ping_timeout_or_network_failure' });
    });

    it('ignores a close event carrying a stale session id from a socket that was replaced', () => {
        const ws1 = _createEngineWsNative('ws://x');
        ws1.onclose = vi.fn();
        const staleSession = mockPlugin.open.mock.calls[0][0].session;

        const ws2 = _createEngineWsNative('ws://x'); // reconnect before ws1's close event arrives
        ws2.onclose = vi.fn();

        listeners.close({ channel: 'engine', session: staleSession, code: 1006, reason: 'stale' });

        expect(ws1.onclose).not.toHaveBeenCalled();
        expect(ws2.onclose).not.toHaveBeenCalled(); // event belongs to neither current socket
    });

    it('close() tells the native plugin to close and detaches before the local synthesized event', async () => {
        const ws = _createEngineWsNative('ws://x');
        ws.onclose = vi.fn();
        ws.close();
        expect(mockPlugin.close).toHaveBeenCalledWith({ channel: 'engine' });
        await Promise.resolve(); // flush the queueMicrotask
        expect(ws.onclose).toHaveBeenCalledWith({ code: 1000, reason: 'client_close' });
    });
});
```

- [ ] **Step 4: Run the new tests to confirm they fail**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/shared/engine-client.test.js
```

Expected: `_createEngineWs` is not defined — every new test in both new `describe` blocks fails.

- [ ] **Step 5: Implement the JS wrapper**

Add to `web/shared/engine-client.js`, immediately before the `class EngineClient` declaration:

```javascript
// Mirrors _StratuxNativeBus/_createStratuxWs in stratux-client.js. Single fixed
// channel ('engine') since there's only one Pi socket. Backed by the native
// EngineWS plugin (ping-interval + synthesized 1006 close on a half-open Pi
// socket — see EngineWsPlugin.java); falls back to the browser WebSocket API
// outside Capacitor (e.g. desktop dev, or this test suite).
const _EngineNativeBus = (() => {
    const native = (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.EngineWS)
        ? Capacitor.Plugins.EngineWS : null;
    if (!native) return null;
    const sessions = new Map();
    const route = (type) => (ev) => {
        const s = sessions.get(ev.channel);
        if (!s || s.id !== ev.session) return;
        const h = s.handlers[type];
        if (h) h(ev);
    };
    native.addListener('open',    route('onopen'));
    native.addListener('message', route('onmessage'));
    native.addListener('close',   route('onclose'));
    native.addListener('error',   route('onerror'));
    let nextId = 1;
    return {
        attach(channel, handlers) {
            const id = String(nextId++);
            sessions.set(channel, { id, handlers });
            return id;
        },
        detach(channel, id) {
            const s = sessions.get(channel);
            if (s && s.id === id) sessions.delete(channel);
        },
        open(channel, url, session) { native.open({ channel, url, session }); },
        close(channel)              { native.close({ channel }); },
    };
})();

function _createEngineWs(url) {
    if (!_EngineNativeBus) return new WebSocket(url);
    const channel = 'engine';
    const ws = {
        url, readyState: 0,
        onopen: null, onmessage: null, onclose: null, onerror: null,
        _sid: '',
        close() {
            if (this.readyState >= 2) return;
            this.readyState = 3;
            _EngineNativeBus.detach(channel, this._sid);
            _EngineNativeBus.close(channel);
            const cb = this.onclose;
            if (cb) queueMicrotask(() => cb({ code: 1000, reason: 'client_close' }));
        },
    };
    ws._sid = _EngineNativeBus.attach(channel, {
        onopen:    ()   => { ws.readyState = 1; if (ws.onopen)  ws.onopen({}); },
        onmessage: (ev) => { if (ws.onmessage) ws.onmessage({ data: ev.data }); },
        onclose:   (ev) => {
            if (ws.readyState === 3) return;
            ws.readyState = 3;
            _EngineNativeBus.detach(channel, ws._sid);
            if (ws.onclose) ws.onclose({ code: ev.code, reason: ev.reason });
        },
        onerror:   (ev) => { if (ws.onerror) ws.onerror({ message: ev.message }); },
    });
    _EngineNativeBus.open(channel, url, ws._sid);
    return ws;
}
```

Then change `_doConnect()` (currently lines 98–104 — locate by searching for `new WebSocket(url)`):

```diff
         const url = `ws://${this._ip}:${this._port}/`;
         try {
-            this._ws = new WebSocket(url);
+            this._ws = _createEngineWs(url);
         } catch {
             this._scheduleReconnect();
             return;
         }
```

Everything else in the file — `onopen`/`onmessage`/`onclose`/`onerror` wiring, the stale-check, `disconnect()`'s `this._ws.close()` — is unchanged; the wrapper exposes the same surface a real `WebSocket` does.

- [ ] **Step 6: Run the tests again to confirm they pass, and check for regressions**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/shared/engine-client.test.js
```

Expected: all new tests pass, and every pre-existing test in this file (`_onData`, Pi contract handshake, `EnginePanel` data-flatten) still passes unchanged — the fallback path preserves plain-`WebSocket` behavior exactly, and none of those tests exercise `_doConnect()`.

- [ ] **Step 7: Bump version and build**

`web/app.js` line 6 — confirm current value first (`grep -n "FLYTAB_VERSION" web/app.js`), then increment by one minor version (e.g. `v10.18` → `v10.19` if unchanged since this plan was written):

```bash
cd /home/dananickerson/flytab
bash build.sh
```

Expected: build completes; `data/` contains an updated APK.

- [ ] **Step 8: Manual on-device verification (cannot be automated — native socket behavior)**

Install the new APK on the tablet (see CLAUDE.md's ADB section for the current device IP and `adb` binary path). Then:

```bash
~/Android/Sdk/platform-tools/adb logcat -s EngineWS:* FlyTab:*
```

1. Launch FlyTab with the Pi engine monitor running and connected. Confirm `EngineWS: engine WS opened: ws://<pi-ip>:<port>/` appears in logcat.
2. Simulate a half-open connection by **pausing** (not killing) the Pi's `engine_monitor.py` process, so its TCP socket stays established but stops sending data — this reproduces "peer stops sending, no FIN/RST" exactly:
   ```bash
   # on the Pi (via SSH or however deploy-pi.sh reaches it)
   kill -STOP $(pgrep -f engine_monitor.py)
   ```
3. Watch the ENG page in FlyTab. Within ~30–60s (one missed OkHttp ping interval plus a grace period), expect `EngineWS: engine WS failure: ...` and `EngineWS: engine WS closed code=1006 reason="ping_timeout_or_network_failure"` in logcat, followed by `engine-client.js`'s existing reconnect/HTTP-fallback logic taking over (confirm the ENG page recovers or shows the offline state — it must not stay silently frozen on the last-known values with no `engine:stale` badge).
4. Resume the Pi process and confirm the socket reconnects cleanly:
   ```bash
   kill -CONT $(pgrep -f engine_monitor.py)
   ```
5. Confirm live data resumes on the ENG page without an app restart.

This step needs your hands — I don't have access to the tablet or the Pi's shell.

- [ ] **Step 9: Commit**

```bash
cd /home/dananickerson/flytab
git add android/app/src/main/java/app/flywhere/flytab/EngineWsPlugin.java \
        android/app/src/main/java/app/flywhere/flytab/MainActivity.java \
        web/shared/engine-client.js tests/shared/engine-client.test.js web/app.js
git commit -m "$(cat <<'EOF'
fix(engine): detect half-open engine WebSocket via native ping/timeout plugin

The browser WebSocket API never fires onclose for a half-closed TCP link
(peer stops sending, socket stays OPEN) — the same problem StratuxWsPlugin
already solves for the Stratux link via OkHttp's pingInterval + a
synthesized 1006 close. engine-client.js had no equivalent: its 5s
stale-check only set a UI flag and never closed or reconnected the socket,
so a wedged Pi WS mid-flight had no recovery path.

Adds EngineWsPlugin.java (same OkHttp pingInterval(30s) pattern) and a JS
wrapper in engine-client.js that bridges to it when running under
Capacitor, falling back to the plain WebSocket API otherwise. The existing
onopen/onmessage/onclose/reconnect logic in engine-client.js is unchanged
since the wrapper exposes the same surface a real WebSocket does.

Finding 1.
EOF
)"
```

---

## Task 2: Guard the live-nav planning-lib calls in route-table.js

**Finding 2.** `web/shared/planning/index.js:7` sets `window.FlyTabPlanning = {}` before 11 dynamic `import()`s resolve and replace it. Six call sites in `web/cockpit/route-table.js` call `FlyTabPlanning.bearing`/`.windCorrectedMagHdg`/`.crossTrackDistanceNm` directly with no guard, on the code path that runs on every GPS tick (confirmed call chain: `app.js:665` → `routeTable.updateLive(situation)` on the `stratux:situation` event → `_computeEnroute()` → `_emitLegUpdate()`). If the planning lib is still loading when the first GPS fix arrives, any of these throws `TypeError: ... is not a function` — repeatably, every tick, until the lib finishes loading. The existing guard pattern elsewhere in this codebase (`route-table.js:1351`, `nasr-db.js:861`) is `if (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.someMethod) { ... }` — this task applies the same pattern here via three small wrapper methods. (Line numbers below are re-verified against current `main` — see "Re-verification against main" above; the code itself is unchanged from the original review, only its position in the file shifted.)

**Files:**
- Modify: `web/cockpit/route-table.js` (add 3 wrapper methods near line 1325; guard 6 call sites)
- Test: `tests/cockpit/route-table-planning-guard.test.js` (new)

**Interfaces:**
- Produces: `RouteTable.prototype._ftpBearing(lat1, lon1, lat2, lon2)`, `._ftpWindCorrectedMagHdg(brgTrue, lat, lon, tasKt, windDir, windSpd)`, `._ftpCrossTrackDistanceNm(lat1, lon1, lat2, lon2, lat3, lon3)` — each returns the real `FlyTabPlanning.*` result when the lib is loaded, else `null`. No other task consumes these.

- [ ] **Step 1: Write the failing tests**

Create `tests/cockpit/route-table-planning-guard.test.js`:

```javascript
/**
 * route-table.js — six FlyTabPlanning.* calls on the live GPS-tick path
 * (updateLive → _computeEnroute → _emitLegUpdate) had no guard against the
 * planning lib still being mid-load (window.FlyTabPlanning starts as `{}` per
 * planning/index.js:7, populated by 11 dynamic imports). Calling e.g.
 * FlyTabPlanning.bearing() while it's still `{}` throws every GPS tick.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();

const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));
const COCKPIT  = JSON.parse(read('web/cockpit-config.json'));
function dotted(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

/** 3-waypoint route, active on the middle waypoint. */
function makeRoute() {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints = [
        { icao: 'KLKR',  type: 'APT', lat: 34.72, lon: -80.78 },
        { icao: 'MDLIN', type: 'FIX', lat: 35.10, lon: -80.50 },
        { icao: 'KFGX',  type: 'APT', lat: 35.50, lon: -80.20,
          _legDist: 120, _segments: [{ phase: 'CRZ', gph: 9, ete_min: 60, tas: 120, gs: 120, dist: 120 }] },
    ];
    rt._activeIndex = 1;
    rt._flights = [];
    rt._destIcao = null;
    rt._cruisePower = null;
    rt._lastSituation = null;
    rt._editMode = false;
    rt._editBtn = null;
    rt._saveBtn = null;
    rt._updateSummary = () => {};
    rt._renderTable = () => {};
    rt._updateTableCells = () => true; // pretend the selective-update path succeeded
    return rt;
}

beforeEach(() => {
    globalThis.NasrDB = { haversineNm: () => 50 }; // >1nm — keeps "within 1nm" branch out of play
    FuelTankState._state = null;
    FuelTankState._loaded = true; // loaded, nothing tracked — fuel math isn't this test's concern
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null, get: () => null, set: () => {} };
    globalThis.CockpitConfig = { aircraft: (p) => dotted(AIRCRAFT, p), get: (p) => dotted(COCKPIT, p) };
});

afterEach(() => {
    delete globalThis.NasrDB;
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete window.enginePanel;
});

describe('_computeEnroute / _emitLegUpdate survive FlyTabPlanning not being ready (Finding 2)', () => {
    it('does not throw when FlyTabPlanning is {} — the real pre-load state per planning/index.js:7', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        expect(() => rt._computeEnroute()).not.toThrow();
    });

    it('leaves wp._brg/_hdg null instead of throwing while the lib loads', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        rt._computeEnroute();
        const wp = rt._waypoints[2];
        expect(wp._brg).toBeNull();
        expect(wp._hdg).toBeNull();
    });

    it('computes real bearing/heading once FlyTabPlanning finishes loading', () => {
        globalThis.FlyTabPlanning = {
            bearing: () => 42,
            windCorrectedMagHdg: () => 45,
            crossTrackDistanceNm: () => 0.3,
        };
        const rt = makeRoute();
        rt._computeEnroute();
        const wp = rt._waypoints[2];
        expect(wp._brg).toBe(42);
        expect(wp._hdg).toBe(45);
    });

    it('_emitLegUpdate publishes xtk as null via the real event while the lib loads, never throws', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        rt._lastSituation = { lat: 35.0, lon: -80.5 };
        let detail = null;
        const listener = (e) => { detail = e.detail; };
        window.addEventListener('activeroute:legupdate', listener);
        try {
            expect(() => rt._computeEnroute()).not.toThrow();
            expect(detail).not.toBeNull();
            expect(detail.xtk).toBeNull();
        } finally {
            window.removeEventListener('activeroute:legupdate', listener);
        }
    });
});

describe('updateLive survives FlyTabPlanning not being ready (Finding 2)', () => {
    it('does not throw on the first GPS tick while the lib is still {}', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        const situation = {
            lat: 35.30, lon: -80.35, true_course: 200, ground_speed: 90, gps_fix_quality: 1,
        };
        expect(() => rt.updateLive(situation)).not.toThrow();
    });

    it('leaves active._liveHdg null (not a bearing() crash) while the lib loads', () => {
        globalThis.FlyTabPlanning = {};
        const rt = makeRoute();
        const situation = {
            lat: 35.30, lon: -80.35, true_course: 200, ground_speed: 90, gps_fix_quality: 1,
        };
        rt.updateLive(situation);
        expect(rt._waypoints[rt._activeIndex]._liveHdg).toBeNull();
    });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/cockpit/route-table-planning-guard.test.js
```

Expected: every test fails with `TypeError: FlyTabPlanning.bearing is not a function` (or `.windCorrectedMagHdg`/`.crossTrackDistanceNm`), confirming the crash-loop is real and reproduced.

- [ ] **Step 3: Add the three guarded wrapper methods**

In `web/cockpit/route-table.js`, add immediately after the existing guarded helper near line 1351–1355 (locate by searching for `_cruiseBandGph` or the existing `typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.gphForPowerPct` guard):

```javascript
    /**
     * Guarded wrapper for FlyTabPlanning.bearing() — the planning lib loads
     * asynchronously (11 dynamic imports in shared/planning/index.js) and
     * window.FlyTabPlanning starts as {}. Returns null instead of throwing
     * when the lib hasn't finished loading; callers already treat a null
     * bearing/heading as "no data yet".
     */
    _ftpBearing(lat1, lon1, lat2, lon2) {
        if (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.bearing) {
            return FlyTabPlanning.bearing(lat1, lon1, lat2, lon2);
        }
        return null;
    }

    /** Guarded wrapper for FlyTabPlanning.windCorrectedMagHdg() — see _ftpBearing. */
    _ftpWindCorrectedMagHdg(brgTrue, lat, lon, tasKt, windDir, windSpd) {
        if (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.windCorrectedMagHdg) {
            return FlyTabPlanning.windCorrectedMagHdg(brgTrue, lat, lon, tasKt, windDir, windSpd);
        }
        return null;
    }

    /** Guarded wrapper for FlyTabPlanning.crossTrackDistanceNm() — see _ftpBearing. */
    _ftpCrossTrackDistanceNm(lat1, lon1, lat2, lon2, lat3, lon3) {
        if (typeof FlyTabPlanning !== 'undefined' && FlyTabPlanning.crossTrackDistanceNm) {
            return FlyTabPlanning.crossTrackDistanceNm(lat1, lon1, lat2, lon2, lat3, lon3);
        }
        return null;
    }
```

- [ ] **Step 4: Guard all 6 call sites**

**Site 1 — `updateLive()`, confirmed lines 450–458 on `main`:**

```diff
-                const dist = NasrDB.haversineNm(lat, lon, wp.lat, wp.lon);
-                const track = situation.true_course ?? situation.gps_track ?? null;
-                const bearingToWpt = FlyTabPlanning.bearing(lat, lon, wp.lat, wp.lon);
-
-                // Passed if within 1nm, OR if waypoint is >90° behind our track
-                // (handles flying past without getting within 1nm of it)
-                const isPast = dist < 1.0 ||
-                    (track !== null && gs > 30 &&
-                     Math.abs(((bearingToWpt - track + 540) % 360) - 180) > 90);
+                const dist = NasrDB.haversineNm(lat, lon, wp.lat, wp.lon);
+                const track = situation.true_course ?? situation.gps_track ?? null;
+                const bearingToWpt = this._ftpBearing(lat, lon, wp.lat, wp.lon);
+
+                // Passed if within 1nm, OR if waypoint is >90° behind our track
+                // (handles flying past without getting within 1nm of it).
+                // bearingToWpt != null guards the planning lib not being ready — without
+                // it, `null - track` coerces to 0 and can falsely satisfy the >90° test,
+                // advancing the active waypoint on bad data instead of just skipping this tick.
+                const isPast = dist < 1.0 ||
+                    (track !== null && gs > 30 && bearingToWpt != null &&
+                     Math.abs(((bearingToWpt - track + 540) % 360) - 180) > 90);
```

**Site 2 — `updateLive()`, confirmed lines 469–470 on `main`:**

```diff
-            active._liveDist = NasrDB.haversineNm(lat, lon, active.lat, active.lon);
-            active._liveHdg = FlyTabPlanning.bearing(lat, lon, active.lat, active.lon);
+            active._liveDist = NasrDB.haversineNm(lat, lon, active.lat, active.lon);
+            // null while the lib loads; _computeEnroute's `wp._liveHdg != null` check
+            // already falls back to planned bearing in that case.
+            active._liveHdg = this._ftpBearing(lat, lon, active.lat, active.lon);
```

**Site 3 — `_computeEnroute()`, confirmed lines 1498–1502 on `main`:**

```diff
             if (i > this._activeIndex && i > 0) {
                 const prev = this._waypoints[i - 1];
                 if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
-                    wp._brg = FlyTabPlanning.bearing(prev.lat, prev.lon, wp.lat, wp.lon);
+                    // null while the lib loads; render already shows '—' for null.
+                    wp._brg = this._ftpBearing(prev.lat, prev.lon, wp.lat, wp.lon);
                 }
             } else if (i === this._activeIndex) {
```

**Site 4 — `_computeEnroute()`, confirmed lines 1507–1511 on `main`:**

```diff
                 } else if (i > 0) {
                     const prev = this._waypoints[i - 1];
                     if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
-                        wp._brg = FlyTabPlanning.bearing(prev.lat, prev.lon, wp.lat, wp.lon);
+                        wp._brg = this._ftpBearing(prev.lat, prev.lon, wp.lat, wp.lon);
                     }
                 }
```

**Site 5 — `_computeEnroute()`, confirmed lines 1517–1520 on `main` (note: this call is `windCorrectedMagHdg`, not `bearing`):**

```diff
             wp._wind = wp.wind || null;
 
-            // Compute wind-corrected magnetic heading from bearing + wind + TAS
-            wp._hdg = (wp._brg != null && wp.lat != null && wp.lon != null)
-                ? FlyTabPlanning.windCorrectedMagHdg(wp._brg, wp.lat, wp.lon, wp._tas ?? 0, wp._wind?.dir ?? 0, wp._wind?.spd ?? 0)
-                : null;
+            // Compute wind-corrected magnetic heading from bearing + wind + TAS.
+            // Falls back to null (rendered as '—') while the planning lib loads.
+            wp._hdg = (wp._brg != null && wp.lat != null && wp.lon != null)
+                ? this._ftpWindCorrectedMagHdg(wp._brg, wp.lat, wp.lon, wp._tas ?? 0, wp._wind?.dir ?? 0, wp._wind?.spd ?? 0)
+                : null;
```

**Site 6 — `_emitLegUpdate()`, confirmed lines 1870–1878 on `main`:**

```diff
         let xtk = null; // nm, positive = right of track, negative = left
         const sit = this._lastSituation;
         if (sit?.lat != null && sit?.lon != null && active.lat != null && active.lon != null) {
             const prevIdx = this._activeIndex > 0 ? this._activeIndex - 1 : 0;
             const prevWp = this._waypoints[prevIdx];
             if (prevWp?.lat != null && prevWp?.lon != null && prevIdx !== this._activeIndex) {
-                xtk = FlyTabPlanning.crossTrackDistanceNm(prevWp.lat, prevWp.lon, active.lat, active.lon, sit.lat, sit.lon);
+                // Stays null (its default) while the lib loads; consumers already
+                // treat a null xtk as no-data.
+                xtk = this._ftpCrossTrackDistanceNm(prevWp.lat, prevWp.lon, active.lat, active.lon, sit.lat, sit.lon);
             }
         }
```

- [ ] **Step 5: Run the new tests, then the full suite, to confirm no regressions**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/cockpit/route-table-planning-guard.test.js
npm test
```

Expected: all new tests pass. Pay particular attention to `tests/cockpit/route-table-legupdate.test.js` and the other `route-table-*.test.js` files — they stub `globalThis.FlyTabPlanning` with real (non-null) `bearing`/`windCorrectedMagHdg`/`crossTrackDistanceNm` functions, so the guard's true-branch must keep producing identical output to the unguarded calls it replaces. All should still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/route-table.js tests/cockpit/route-table-planning-guard.test.js
git commit -m "$(cat <<'EOF'
fix(route-table): guard live-nav FlyTabPlanning.* calls against lib still loading

window.FlyTabPlanning starts as {} and is populated by 11 dynamic imports
(shared/planning/index.js:7). Six calls on the 1Hz live-nav path
(updateLive -> _computeEnroute -> _emitLegUpdate) called FlyTabPlanning.bearing
/.windCorrectedMagHdg/.crossTrackDistanceNm with no guard, so a GPS fix
arriving before the lib finishes loading (cold storage, slow boot) threw
every tick — a crash loop on the primary nav display.

Adds three guarded wrapper methods matching the existing guard pattern
already used elsewhere in this file (line ~1351) and in nasr-db.js
(line ~861), and routes all six call sites through them. Also adds an
explicit `bearingToWpt != null` check to the waypoint-passage test in
updateLive() — without it, a null bearing coerces to 0 in arithmetic and
can silently mis-trigger an early waypoint advance instead of just
skipping that tick's computation.

Finding 2.
EOF
)"
```

---

## Task 3: Recover from a vanished serial device in engine_monitor.py, and fix a lock-discipline gap

**Re-verified 2026-08-10, after PRs #123/#125/#126 merged to `main`.** `check_sticky_valve()` no longer exists — it was deleted, along with the Pi's entire embedded dashboard, by the engine-UI-consolidation work (#123). This task's lock-widening step originally covered both `check_sticky_valve()` and `update_peak_tracking()`; it now only touches `update_peak_tracking()`, confirmed to still have the exact same unlocked-write gap described below (re-checked directly against current `main`: it writes `state.peak_egts`/`state.degrees_from_peak`/`state.peaks_valid` with no lock anywhere in its body, at engine_monitor.py:1257–1351, while `get_status()` reads those same three fields locked at engine_monitor.py:2023–2024). The serial-reconnect half of this task is completely unaffected by today's changes — the generic `except Exception` handler and the "ready but no data" reconnect path it's structurally unreachable from are both still present, unchanged, currently at `capture_thread_func`'s exception handler around line 1867 (`log(f"Capture loop error: {e}")`).

**Finding 3.** In `engine-monitor/engine_monitor.py`'s `capture_thread_func()`, the generic `except Exception` handler catches the case where the EDM serial device is physically unplugged (`ser.in_waiting`/`ser.read()` raising) — but the exception fires *before* the existing "port ready but no data" reconnect logic's bookkeeping (`consecutive_empty`) ever runs, so that reconnect path is structurally unreachable for a vanished port. The handler just logs (real per-call file I/O, confirmed in `log()`) and sleeps 0.1s — forever, until a systemd restart. Separately, `update_peak_tracking()` writes shared `state` fields with no lock, while `get_status()` reads those same fields inside `with state.lock:` — a real writer/reader mismatch, safe today only because of the GIL. (`state.lock` is confirmed a plain `threading.Lock()`, defined at `CaptureState.__init__` — not an `RLock`, though it wouldn't matter either way since the function doesn't acquire it.)

**Files:**
- Modify: `engine-monitor/engine_monitor.py`

**Interfaces:** N/A — standalone fix, no automated test framework exists for this file.

- [ ] **Step 1: Add backoff state before the serial read loop**

Locate the block before the read loop (confirmed lines 1727–1730):

```diff
         lines_read = 0
         lines_parsed = 0
         consecutive_empty = 0  # Track consecutive empty reads
         last_warning_time = 0  # Avoid spamming logs
+        reconnect_backoff = 2.0        # seconds; doubles on repeated failures
+        reconnect_backoff_max = 30.0   # cap — matches EngineClient's JS backoff ceiling
+        next_reconnect_attempt = 0.0   # epoch gate; 0 = attempt on first failure
```

- [ ] **Step 2: Widen the `state.lock` block to cover `update_peak_tracking`**

The call currently runs unlocked immediately before the existing `with state.lock:` block that writes `state.latest_data` etc. (search for `# Track per-cylinder peak EGT during leaning` to locate it — line numbers have shifted since this plan was written):

```diff
-                        # Track per-cylinder peak EGT during leaning
-                        update_peak_tracking(
-                            parsed.get('EGT1', 0),
-                            parsed.get('EGT2', 0),
-                            parsed.get('EGT3', 0),
-                            parsed.get('EGT4', 0),
-                            fuel_flow,
-                            rpm,
-                            mp
-                        )
-
                         with state.lock:
+                            # Track per-cylinder peak EGT during leaning (writes
+                            # state.peak_egts/degrees_from_peak/peaks_valid —
+                            # get_status() reads these locked; this call must be too)
+                            update_peak_tracking(
+                                parsed.get('EGT1', 0),
+                                parsed.get('EGT2', 0),
+                                parsed.get('EGT3', 0),
+                                parsed.get('EGT4', 0),
+                                fuel_flow,
+                                rpm,
+                                mp
+                            )
+
                             state.latest_data = parsed
                             state.data_count += 1
                             state.percent_power = percent_power
```

`update_peak_tracking` itself (engine_monitor.py:1257–1351) is unchanged — this is a pure relocation, nothing inside the function needs to change since it doesn't acquire `state.lock` itself (confirmed — no reentrancy risk).

- [ ] **Step 3: Fix the exception handler to attempt a reopen, with backoff**

Confirmed current content at lines 1930–1934 (line numbers will have shifted by the insertions above — locate by searching for `Capture loop error:`):

```diff
             except Exception as e:
                 state.last_error = str(e)
                 state.last_serial_error = str(e)
-                log(f"Capture loop error: {e}")
-                time.sleep(0.1)
+                # Handles the device physically vanishing (ser.in_waiting / ser.read()
+                # raising, e.g. an unplugged USB-serial adapter) — distinct from the
+                # "ready but no data" case above, which never reaches this branch
+                # because the exception fires before consecutive_empty/data_was_waiting
+                # bookkeeping runs. Gated by next_reconnect_attempt so a permanently
+                # unplugged device doesn't spin open_serial()/log() at 10Hz forever.
+                # Excludes playback_mode — there is no live serial port to reopen when
+                # replaying a captured file; an exception here in playback is a
+                # different, rarer problem this fix isn't targeting.
+                if not playback_mode:
+                    now = time.time()
+                    if now >= next_reconnect_attempt:
+                        log(f"Capture loop error: {e} — attempting serial port reopen")
+                        try:
+                            if ser:
+                                try:
+                                    ser.close()
+                                except Exception:
+                                    pass
+                            ser = open_serial()
+                            state.reconnect_count += 1
+                            consecutive_empty = 0
+                            reconnect_backoff = 2.0
+                            log(f"Serial port reconnected after error (attempt #{state.reconnect_count})")
+                        except Exception as reconnect_err:
+                            err_msg = str(reconnect_err)
+                            state.last_serial_error = err_msg
+                            state.serial_warning = f"Reconnect failed: {err_msg}"
+                            next_reconnect_attempt = now + reconnect_backoff
+                            reconnect_backoff = min(reconnect_backoff * 2, reconnect_backoff_max)
+                            log(f"Reconnect failed: {err_msg} — next attempt in {reconnect_backoff:.0f}s")
+                else:
+                    log(f"Capture loop error: {e}")
+                time.sleep(0.1)
```

Indentation verified programmatically (`ast.parse` against a skeleton matching the real 3-level nesting depth — `except` at column 12, matching the real file) before writing this into the plan, not eyeballed — the extra `if not playback_mode:` level shifts every line of the original reconnect logic 4 columns deeper than a first pass produced, which is an easy place to get wrong by hand.

`open_serial()` is the same nested closure already called at initial open (line ~1705) and by the existing "ready but no data" reconnect path (line ~1919) — no new function needed. `state.last_error`/`state.last_serial_error` are still set unconditionally on every exception, matching current behavior. `log()`'s per-call file I/O now only fires on a backoff-gated reopen attempt instead of at 10Hz forever, which also resolves the "opens/writes/closes a file every iteration" concern as a side effect. Consistent with the existing sibling reconnect path, this does not toggle `state.serial_connected` — that path doesn't either. The `playback_mode` guard is new relative to the first draft of this diff: without it, an exception during `--playback` replay would try to `open_serial()` a real serial port that was never opened in that mode, which can only fail — old code was equally non-functional here (same 10Hz spin either way), so this isn't a regression, just an incomplete edge case this fix now also covers.

- [ ] **Step 4: Pipeline smoke test — confirms no regression, does NOT exercise the new exception-handler path**

No automated test framework exists for this file, and — verified empirically, not assumed — the ground-testable pipeline (`test-pipeline.sh` + `data_simulator.py`) **cannot reproduce the bug this step fixes**. `data_simulator.py`'s "virtual serial" is a PTY-backed reader; pausing or killing its writer process produces an empty read (EOF-like), never an `OSError`/`SerialException`. That's confirmed by direct reproduction: forking a PTY pair, then `SIGSTOP`-ing and separately `SIGKILL`-ing the writer, both land in the pre-existing "ready but no data" branch (lines 1913–1928, untouched by this task) — never in the new exception handler. A real unplugged USB-serial adapter fails differently at the OS level (an actual I/O error), which only a real disconnected device produces — the same category of limitation Step 8 in Task 1 already has for its own hardware-only check.

So this step verifies only that the change doesn't break normal operation — not that the fix works. Run:

```bash
cd /home/dananickerson/flytab
bash test-pipeline.sh --file <any-captured-sample>
```

Expected: data flows normally (`curl http://localhost:8080/api/status | jq .data_count` increasing), no new errors in the log, and the existing "ready but no data" reconnect path (lines 1913–1928) is unaffected — confirm by watching its log lines still appear unchanged if you trigger that path the way you normally would (briefly pausing the simulator, which lands there, not in the new handler, exactly as just described).

```bash
bash test-pipeline.sh --stop
```

- [ ] **Step 5: Deploy to the Pi**

```bash
cd /home/dananickerson/flytab
bash deploy-pi.sh --full
```

- [ ] **Step 6: Hardware verification — the only way to actually exercise this fix**

Requires the real Pi with the EDM connected over its actual USB-serial adapter — not reproducible on the ground with `data_simulator.py` (see Step 4). Do this after Step 5's deploy and before considering this task done:

1. With `engine_monitor.py` running against the real EDM and data flowing normally, physically unplug the EDM's USB-serial adapter from the Pi.
2. Watch the log (`CONFIG['DATA_DIR']`/`CONFIG['LOG_FILE']`, per `deploy-pi.sh`'s deployed location). Expected: `Capture loop error: ... — attempting serial port reopen` once (not repeating at 10Hz), then `Reconnect failed: ... — next attempt in 2s`, `4s`, `8s`, `16s`, `30s`, `30s`, ... (visibly capping, not spamming).
3. Reconnect the adapter. Within one backoff interval, expect `Serial port reconnected after error (attempt #N)` and `curl http://localhost:8080/api/status | jq .data_count` increasing again.
4. Record the actual log output as the reproducibility receipt for this task — a claim this works without this evidence isn't verification, per the standing project convention.

This needs your hands on the actual hardware — I don't have access to the Pi or the EDM.

- [ ] **Step 7: Commit**

```bash
git add engine-monitor/engine_monitor.py
git commit -m "$(cat <<'EOF'
fix(engine-monitor): reopen serial port on vanished device, fix lock gap

A physically unplugged EDM serial device raises inside ser.in_waiting/
ser.read(), landing in the generic except Exception handler — which never
attempted a reopen and looped forever at 10Hz (each iteration also opening,
writing, and closing the log file). The existing "port ready but no data"
reconnect path never fires here because the exception happens before its
consecutive_empty bookkeeping runs. Only escape was a systemd restart.

Now attempts open_serial() on the first failure and backs off exponentially
(2s -> 30s cap) on repeated failures, instead of spinning unconditionally.

Also widens the state.lock block to cover update_peak_tracking(), which
wrote peak_egts/degrees_from_peak/peaks_valid with no lock while
get_status() already read them locked — safe today only because of the
GIL, and would not be if the capture loop ever moved off-thread.
(check_sticky_valve(), originally also in scope here, was deleted
entirely by the engine-UI-consolidation work — #123 — before this task
was executed; nothing left to relocate for it.)

Finding 3.
EOF
)"
```

---

## Task 4: Authenticate and size-cap `/api/upload`

**Finding 8.** `engine_monitor.py`'s `/api/upload` handler (confirmed lines 4433–4518) has no authentication and reads `Content-Length` bytes into memory with no upper bound before any validation. Combined with an extension allowlist that includes `.py` (confirmed line ~4462) and a filename sanitized only via `os.path.basename()` (confirmed line ~4496 — this *does* block classic `../` traversal, refuting that specific original sub-claim), an unauthenticated device on the Pi's open ramp WiFi can overwrite any same-named file in `SCRIPT_DIR` **including `engine_monitor.py` itself** — the running script. No existing shared-secret/token mechanism exists to reuse (`PI_API_CONTRACT`/`PI_CAPABILITIES` are a version-negotiation handshake, not a credential — confirmed by grepping the file for `secret|token|auth|password`).

**Decision needed before this ships** (do not silently resolve): the existing browser-based "upload from iPad" admin page (served by this same process, confirmed calling `fetch('/api/upload', ...)` around line ~3775) has no way to learn the new token without it being visible in that page's HTML source — which anyone on the same open WiFi can view, defeating the check. This task implements the auth/size-cap fix; it does **not** decide how that page's workflow continues. Options to bring back to the person who uses that page: (a) prompt for the token on that page each session, read once off the Pi's own console/log; (b) retire that page in favor of `deploy-pi.sh`, which already exists for pushing script updates; (c) something else. Do not pick one unilaterally.

**Files:**
- Modify: `engine-monitor/engine_monitor.py`

**Interfaces:** N/A — standalone fix, no automated test framework exists for this file; verified via `curl`.

- [ ] **Step 1: Add imports**

Confirmed current imports at lines 38–54 — add two:

```diff
 import glob
 import uuid
 import shutil
+import hmac
+import secrets
```

- [ ] **Step 2: Add token provisioning and the size cap constant**

Insert after `log()`'s definition (confirmed lines 991–1001), before `extract_numeric()` (line 1003) — it must come after `log()` since it calls it, and `log()` isn't defined earlier:

```python
# Shared-secret token gating /api/upload (Finding 8: unauthenticated upload
# endpoint). Self-provisions on first boot — no manual deploy step required —
# and persists in DATA_DIR alongside fuel_data.json so it survives redeploys
# of this script.
UPLOAD_TOKEN_FILE = os.path.join(CONFIG['DATA_DIR'], '.upload_token')
MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # 5 MB — largest real upload target today
                                     # (engine_monitor.py) is ~193 KB; ~26x headroom.

def _load_or_create_upload_token():
    try:
        if os.path.exists(UPLOAD_TOKEN_FILE):
            with open(UPLOAD_TOKEN_FILE, 'r') as f:
                tok = f.read().strip()
                if tok:
                    return tok
        os.makedirs(os.path.dirname(UPLOAD_TOKEN_FILE), exist_ok=True)
        tok = secrets.token_hex(32)
        with open(UPLOAD_TOKEN_FILE, 'w') as f:
            f.write(tok)
        os.chmod(UPLOAD_TOKEN_FILE, 0o600)
        log(f"Generated new /api/upload token at {UPLOAD_TOKEN_FILE}")
        return tok
    except Exception as e:
        log(f"WARNING: could not load/create upload token ({e}) — /api/upload will reject all requests")
        return None

UPLOAD_TOKEN = _load_or_create_upload_token()
```

- [ ] **Step 3: Gate the handler on the token, and cap size before reading**

Confirmed current handler start at lines 4433–4444 — **but Task 3 runs before this task on the same file and adds ~32 lines above this point**, so by the time this step executes the real line numbers will be roughly 4465–4550, not 4433–4444. Before applying, re-run `grep -n "elif path == '/api/upload':"` and work from that result — the anchor text itself is unique and unaffected by the shift; only the raw line numbers below are stale. (Task 16 has this same defensive re-check for its own cross-task file overlap; Task 4 needs it too.)

```diff
         elif path == '/api/upload':
-            # File upload endpoint for updating scripts from iPad
+            # File upload endpoint for updating scripts from iPad.
             try:
+                supplied = self.headers.get('X-Upload-Token', '')
+                if not UPLOAD_TOKEN or not hmac.compare_digest(supplied, UPLOAD_TOKEN):
+                    log("Upload rejected: missing/invalid X-Upload-Token")
+                    self.send_json({'error': 'Unauthorized'}, 401)
+                    return
+
                 content_type = self.headers.get('Content-Type', '')
                 if 'multipart/form-data' not in content_type:
                     self.send_json({'error': 'Expected multipart/form-data'}, 400)
                     return
 
-                # Parse multipart form data
                 content_length = int(self.headers.get('Content-Length', 0))
+                if content_length <= 0:
+                    self.send_json({'error': 'Missing or empty Content-Length'}, 400)
+                    return
+                if content_length > MAX_UPLOAD_BYTES:
+                    log(f"Upload rejected: Content-Length {content_length} exceeds {MAX_UPLOAD_BYTES}-byte cap")
+                    self.send_json({'error': f'Upload too large (max {MAX_UPLOAD_BYTES // (1024*1024)} MB)'}, 413)
+                    return
+
+                # Parse multipart form data
                 body = self.rfile.read(content_length)
```

Everything from the original "Extract boundary from content-type" comment onward (boundary parsing, the `.py/.js/.html/.css/.json/.md` extension allowlist, `safe_filename = os.path.basename(filename)`) is unchanged. The size check runs entirely off the `Content-Length` header, before `self.rfile.read()` is ever called — the bug (unbounded read into memory) is fixed by never doing the read when the declared size exceeds the cap.

- [ ] **Step 4: Deploy to the Pi**

```bash
cd /home/dananickerson/flytab
bash deploy-pi.sh --full
```

- [ ] **Step 5: Verify with curl**

Replace `<pi-ip>` with the Pi's current address (see `reference_stratux_ip`/`reference_adb_debug` conventions — confirm the actual current IP rather than assuming):

```bash
# 1. No token -> 401
curl -i -X POST http://<pi-ip>:8080/api/upload \
  -F "file=@/dev/null;filename=test.py"
# Expected: HTTP/1.0 401, {"error": "Unauthorized"}

# 2. Wrong token -> 401
curl -i -X POST http://<pi-ip>:8080/api/upload \
  -H "X-Upload-Token: wrong" \
  -F "file=@/dev/null;filename=test.py"
# Expected: HTTP/1.0 401

# 3. Oversized declared Content-Length -> 413, rejected before the body is read
head -c 6000000 /dev/urandom > /tmp/big.bin
curl -i -X POST http://<pi-ip>:8080/api/upload \
  -H "X-Upload-Token: $(ssh <pi-host> cat <data-dir>/.upload_token)" \
  -F "file=@/tmp/big.bin;filename=test.py"
# Expected: HTTP/1.0 413, {"error": "Upload too large (max 5 MB)"}

# 4. Correct token, small file -> 200, file actually written
echo "# test upload" > /tmp/small.py
curl -i -X POST http://<pi-ip>:8080/api/upload \
  -H "X-Upload-Token: $(ssh <pi-host> cat <data-dir>/.upload_token)" \
  -F "file=@/tmp/small.py;filename=test.py"
# Expected: HTTP/1.0 200
ssh <pi-host> cat <SCRIPT_DIR>/test.py
# Expected: contents match /tmp/small.py; clean up the test file on the Pi afterward.
```

Record the actual output of each command as the reproducibility receipt for this task — this is a security control, and CLAUDE.md requires evidence, not a claim, before calling it done.

- [ ] **Step 6: Commit**

```bash
git add engine-monitor/engine_monitor.py
git commit -m "$(cat <<'EOF'
fix(engine-monitor): authenticate and size-cap /api/upload

/api/upload had no authentication and read Content-Length bytes into
memory with no upper bound. Combined with an extension allowlist that
includes .py and a filename sanitized only via os.path.basename() (which
does block ../ traversal), an unauthenticated device on the Pi's open
ramp WiFi could overwrite any same-named file in SCRIPT_DIR — including
engine_monitor.py itself, the running script.

Adds a self-provisioning shared-secret token (generated on first boot,
persisted in DATA_DIR, checked via hmac.compare_digest against a new
X-Upload-Token header) and a 5 MB size cap enforced off Content-Length
before the body is ever read.

Open item, not resolved here: the existing browser-based upload-from-iPad
admin page has no way to learn this token without embedding it in page
source (visible to anyone on the same WiFi) — needs a decision on how
that workflow continues before this token requirement reaches it in
practice.

Finding 8.
EOF
)"
```

---

## Task 5: Build, deploy & verify Phase 1

**Files:**
- Modify: `web/app.js` (version bump, if not already done as part of Task 1)

- [ ] **Step 1: Confirm the version bump from Task 1 is in place**

```bash
grep -n "FLYTAB_VERSION" /home/dananickerson/flytab/web/app.js
```

- [ ] **Step 2: Full build**

```bash
cd /home/dananickerson/flytab
bash build.sh
```

- [ ] **Step 3: Run the full JS test suite one more time**

```bash
npm test
```

Expected: all tests pass, including the new ones from Task 2 and Task 1.

- [ ] **Step 4: Confirm the Pi side is deployed**

```bash
bash deploy-pi.sh --full
```

(No-op if Tasks 3 and 4 already deployed individually — safe to re-run.)

- [ ] **Step 5: Combined on-device smoke check**

Install the APK. Confirm: app boots without a JS error in `adb logcat` filtered on `chromium`/`FlyTab`; the route table renders and updates on a live or simulated GPS feed without throwing (Task 2); the ENG page shows live data (Task 1's baseline, before deliberately testing the half-open scenario per Task 1 Step 8 if not already done in that task).

---

# Phase 2 — High (structural fixes)

## Task 6: Delete dead AWC direct-fetch code in weather-client.js

**Finding 4.** `web/shared/weather-client.js` documents the proxy rule (`// Route through flywhere.app proxy — direct AWC fetch is blocked by CORS...`, confirmed line 176) but a separate, older code path — `fetchAllForRoute()` (line 21) and the five methods it wraps (their `AWC_BASE` URL-construction lines: `fetchMetars` 60, `fetchTafs` 84, `fetchWindsAloft` 112, `fetchPireps` 153, `fetchSigmets` 327 — one line below each method's own declaration) — fetches `AWC_BASE` (`https://aviationweather.gov/api/data`, line 9) directly, which the Capacitor WebView's CORS policy silently blocks. Confirmed: zero live callers anywhere in the repo (predates this CORS policy — last touched in commit `2841619`, before it was superseded), zero test coverage, and `AWC_BASE` is used nowhere else in the file. This is dead code with a landmine in it, not a live bug — the fix is deletion, not a rewrite, per this repo's own convention of deleting confirmed-dead code rather than leaving a working-looking trap for someone to wire up later.

**Files:**
- Modify: `web/shared/weather-client.js` (delete 3 blocks)

**Interfaces:** N/A — pure deletion of unreferenced code.

- [ ] **Step 1: Confirm zero callers one more time immediately before deleting**

```bash
cd /home/dananickerson/flytab
grep -rn "fetchAllForRoute\|\.fetchMetars(\|\.fetchTafs(\|\.fetchWindsAloft(\|\.fetchPireps(\|\.fetchSigmets(" web/ tests/ --include="*.js"
```

Expected: no hits outside `web/shared/weather-client.js` itself.

- [ ] **Step 2: Delete the stale comment and `AWC_BASE` constant**

Confirmed lines 8–9:

```diff
-    // Fetch directly from aviationweather.gov (supports CORS)
-    static AWC_BASE = 'https://aviationweather.gov/api/data';
```

- [ ] **Step 3: Delete `fetchAllForRoute`, `fetchMetars`, `fetchTafs`, `fetchWindsAloft`, `fetchPireps`**

Confirmed lines 15–159 (full JSDoc + bodies, through the blank line trailing `fetchPireps`, immediately before `fetchMos`'s JSDoc) — delete the entire range. After deletion, `constructor(db) { this.db = db; }` is followed directly by `fetchMos`'s JSDoc (unchanged, proxy-routed, keep it).

- [ ] **Step 4: Delete `fetchSigmets`**

Confirmed lines 323–333 (its "Legacy: fetch raw AWC airsigmet response (used by fetchAllForRoute)" JSDoc + body + trailing blank line) — delete the entire range. After deletion, `_parseGairmet`'s closing brace is followed directly by `// ========== METAR Decoding ==========` (unchanged).

- [ ] **Step 5: Verify the file still parses and nothing else references the removed symbols**

```bash
node --check web/shared/weather-client.js
grep -n "AWC_BASE\|fetchAllForRoute\|fetchMetars\|fetchTafs\|fetchWindsAloft\|fetchPireps\|fetchSigmets" web/shared/weather-client.js
```

Expected: `node --check` prints nothing (valid syntax). The grep should return zero hits — everything named in Finding 4 is gone, including the constant.

- [ ] **Step 6: Run the full test suite**

```bash
npm test
```

Expected: no change in pass/fail count — this file has zero existing test coverage to begin with (confirmed).

- [ ] **Step 7: Commit**

```bash
git add web/shared/weather-client.js
git commit -m "$(cat <<'EOF'
fix(weather): delete dead AWC direct-fetch code (CORS landmine)

fetchAllForRoute() and the five methods it wrapped (fetchMetars, fetchTafs,
fetchWindsAloft, fetchPireps, fetchSigmets) fetched aviationweather.gov
directly, which the Capacitor WebView's CORS policy silently blocks —
exactly the failure mode CLAUDE.md's proxy rule exists to prevent. Zero
live callers anywhere in the repo, zero test coverage, predates the CORS
policy being documented (last touched before the proxy-based advisory
fetch superseded it). The live weather paths (wx-briefing.js) already
route through Settings.workerBase correctly and are unaffected.

Deleting rather than fixing in place: a working-looking-but-broken method
sitting in the class is the exact attractive nuisance the original review
flagged — someone reviving it for a new feature would silently lose
weather with no error. wx-briefing.js's existing batch-fetch methods are
the right template if route-corridor weather fetching becomes a real
feature later.

Finding 4.
EOF
)"
```

---

## Task 7: Point PreflightCheck at the real active-plan source

**Finding 6.** `preflight-check.js` calls `NasrDB.getActiveFlightPlan()` (confirmed calls at lines 28, 42), which reads the `flypi` IndexedDB's `flight_plans` store — but `saveFlightPlan()`, the only method that ever writes that store, has zero callers anywhere in the app (confirmed). The planning library's own `flytab-plans` IndexedDB is *also* dead for this purpose: `route-planner.js:102` requires a `plans` adapter but nothing anywhere calls `.plans.get/.put/.list/.delete` on it. **The actual live active-plan mechanism is `localStorage['flypi_active_plan']`**, written by `app.js:1331`, `route-table.js:2192` (`doSave`), `route-table.js:2265` (plan picker), and `plan-sync.js:410`, and already read the same way (`JSON.parse(localStorage.getItem('flypi_active_plan') || ...)`) by four other files: `app.js:1060`, `logbook.js:502`, `logbook.js:1569`, `plan-sync.js:182`, `plan-sync.js:383`. Confirmed field-for-field: both real writers include `flight_plan.departure`/`.destination`, which is all `_checkFlightPlan`/`_checkTiles` read; `_checkWeather` reads `weather_cache?.fetched_at`, present on cloud-synced plans. **Known pre-existing gap this does not fix** (flag, don't fold in): locally-built routes saved via route-table.js's "Save Route" flow never attach `weather_cache`, so `_checkWeather` will still show "Not fetched" for those regardless of which store is read.

**Files:**
- Modify: `web/cockpit/preflight-check.js`
- Test: `tests/cockpit/preflight-check-active-plan.test.js` (new)

**Interfaces:** N/A — standalone fix. `NasrDB.saveFlightPlan`/`getActiveFlightPlan`/`getFlightPlan`/`getAircraftProfiles`/`getAircraftProfile`/`saveAircraftProfile`/`saveAircraftProfiles` (all confirmed dead, `nasr-db.js:523–594`) are left in place — deleting them touches the DB migration path and is a separate, optional follow-up, not part of this fix.

- [ ] **Step 1: Write the failing test**

Create `tests/cockpit/preflight-check-active-plan.test.js`. This needs the real `PreflightCheck` class — locate its constructor/`autoTrigger`/`show` signatures first if they differ from what's assumed below by reading `web/cockpit/preflight-check.js` directly, then adjust; the shape below is based on the calls at confirmed lines 28/42 (`getActiveFlightPlan()` used inside `autoTrigger`/`show`):

```javascript
/**
 * PreflightCheck reads NasrDB.getActiveFlightPlan(), which reads the `flypi`
 * IDB's flight_plans store — but nothing in the app ever writes that store
 * (NasrDB.saveFlightPlan has zero callers). The real active plan lives in
 * localStorage['flypi_active_plan'], written by app.js/_applyPlan and
 * route-table.js, and already read that way by four other files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const PreflightCheck = new Function(read('web/cockpit/preflight-check.js') + '\nreturn PreflightCheck;')();

function makeCheck() {
    // db is only used for NASR/tiles checks (getCycleInfo/getAirport), unrelated
    // to the active-plan question — a stub is fine here.
    return Object.create(PreflightCheck.prototype, {
        db: { value: { open: async () => {}, getCycleInfo: async () => null, getAirport: async () => null } },
    });
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('PreflightCheck._getActivePlan reads the real active-plan source (Finding 6)', () => {
    it('reads flypi_active_plan from localStorage, not the dead flypi IDB store', () => {
        const plan = { flight_plan: { departure: 'KLKR', destination: 'KFGX' }, waypoints: [] };
        localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
        const pc = makeCheck();
        expect(pc._getActivePlan()).toEqual(plan);
    });

    it('returns null when no plan has ever been saved', () => {
        const pc = makeCheck();
        expect(pc._getActivePlan()).toBeNull();
    });

    it('returns null (not a throw) on malformed JSON', () => {
        localStorage.setItem('flypi_active_plan', '{not valid json');
        const pc = makeCheck();
        expect(() => pc._getActivePlan()).not.toThrow();
        expect(pc._getActivePlan()).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/cockpit/preflight-check-active-plan.test.js
```

Expected: fails — `pc._getActivePlan is not a function` (method doesn't exist yet).

- [ ] **Step 3: Implement `_getActivePlan` and switch the two call sites to it**

In `web/cockpit/preflight-check.js`, replace the two `NasrDB.getActiveFlightPlan()` call sites (confirmed lines 28 and 42) with a call to a new private method, and add that method:

```javascript
    /**
     * Read the pilot's currently active flight plan.
     *
     * Deliberately NOT this.db (NasrDB / the 'flypi' IDB database) — flypi's
     * flight_plans store is written only by NasrDB.saveFlightPlan(), which has
     * zero callers anywhere in the app. The live active plan lives in
     * localStorage['flypi_active_plan'], written by app.js's _applyPlan()
     * (every plan load, including flywhere.app cloud sync) and by
     * route-table.js's Save Route / Plan Picker flows — same key/shape
     * app.js, logbook.js, and plan-sync.js already read.
     *
     * Note: locally-built routes (route-table.js "Save Route") don't carry a
     * weather_cache field, so _checkWeather() below can still read "Not
     * fetched" for those plans even once the plan itself is found — a
     * separate, pre-existing gap this does not fix.
     */
    _getActivePlan() {
        try {
            return JSON.parse(localStorage.getItem('flypi_active_plan') || 'null');
        } catch (err) {
            console.warn('PreflightCheck: failed to parse flypi_active_plan', err);
            return null;
        }
    }
```

Replace each `const plan = await this.db.getActiveFlightPlan();` (or equivalent — match whatever the actual current call expression is at lines 28/42) with `const plan = this._getActivePlan();` (no `await` — this is now synchronous). `this.db.open()` stays wherever it currently runs — `_checkNasr`/`_checkTiles` still legitimately use `this.db.getCycleInfo()`/`getAirport()`.

- [ ] **Step 4: Run the test again to confirm it passes**

```bash
npx vitest run tests/cockpit/preflight-check-active-plan.test.js
```

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/preflight-check.js tests/cockpit/preflight-check-active-plan.test.js
git commit -m "$(cat <<'EOF'
fix(preflight): read the real active-plan source, not a dead IDB store

PreflightCheck called NasrDB.getActiveFlightPlan(), which reads the flypi
IndexedDB's flight_plans store — but nothing in the app ever writes that
store (saveFlightPlan has zero callers). The planning library's own
flytab-plans IDB is also dead for this purpose (nothing calls .plans.get/
.put/.list/.delete on it either). Preflight check could therefore only
ever see a stale-or-never-written plan.

The actual live active-plan mechanism is localStorage['flypi_active_plan'],
already written by app.js/_applyPlan and route-table.js and already read
the same way by four other files (app.js, logbook.js x2, plan-sync.js x2).
Points PreflightCheck at the same key instead of either IDB store.

Known gap not fixed here: locally-saved routes (route-table.js "Save
Route") don't carry a weather_cache field, so the weather check can still
read "Not fetched" for those even with the plan itself now found — a
separate, pre-existing issue in the save-route flow.

Finding 6.
EOF
)"
```

---

## Task 8: Fix hardcoded Stratux-IP bypasses in network-mode.js and device-status.js

**Finding 7a.** `network-mode.js:49` and `device-status.js:116` both probe `http://192.168.10.1/getStatus` directly, bypassing `Settings.stratuxIp` — confirmed identical to `stratux-client.js:219`'s already-correct pattern (`Settings.stratuxIp || '192.168.10.1'`). If the pilot changes the configured Stratux IP, these two probes keep hitting the default. Both files already load after `settings.js` in `web/index.html` (confirmed) with zero existing `Settings` references, so no wiring change is needed beyond the fetch URL itself.

(The other two files the original review grouped with this finding — `fuel-overlay.js:697` and `engine-page.js:963` — turned out to hit the **Pi engine-monitor**, not Stratux, a different bug with a different fix: see Task 9.)

**Files:**
- Modify: `web/shared/network-mode.js`
- Modify: `web/cockpit/device-status.js`
- Test: extend or add a small structural test (see Step 3)

**Interfaces:** N/A — standalone fix.

- [ ] **Step 1: Fix `network-mode.js`**

Confirmed current line 49:

```diff
-        const r = await fetch('http://192.168.10.1/getStatus', {
+        const r = await fetch(`http://${Settings.stratuxIp || '192.168.10.1'}/getStatus`, {
             signal: AbortSignal.timeout(2000),
         });
```

- [ ] **Step 2: Fix `device-status.js`**

Confirmed current line 116:

```diff
-        const r = await fetch('http://192.168.10.1/getStatus', {
+        const r = await fetch(`http://${Settings.stratuxIp || '192.168.10.1'}/getStatus`, {
             cache: 'no-store',
             signal: AbortSignal.timeout(3000),
         });
```

- [ ] **Step 3: Add a regression test pinning the fix**

Create `tests/shared/network-mode-stratux-ip.test.js` — a source-pinning test (same technique as the "structural contract" tests in `tests/cockpit/fuel-overlay-apply-guard.test.js`), since mocking `AbortSignal.timeout` + `fetch` timing for a full behavioral test is disproportionate to what this fix needs to prove:

```javascript
/**
 * network-mode.js / device-status.js hardcoded 192.168.10.1 for their Stratux
 * getStatus probe, bypassing Settings.stratuxIp — so a pilot who changed the
 * configured IP still got probed against the default. Pins the fix at the
 * source level: the probe URL must be built from Settings.stratuxIp.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

describe('Stratux getStatus probes read Settings.stratuxIp (Finding 7a)', () => {
    it('network-mode.js builds the probe URL from Settings.stratuxIp', () => {
        const src = read('web/shared/network-mode.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp \|\| '192\.168\.10\.1'\}\/getStatus`/);
    });

    it('device-status.js builds the probe URL from Settings.stratuxIp', () => {
        const src = read('web/cockpit/device-status.js');
        expect(src).toMatch(/fetch\(`http:\/\/\$\{Settings\.stratuxIp \|\| '192\.168\.10\.1'\}\/getStatus`/);
    });
});
```

- [ ] **Step 4: Run the test**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/shared/network-mode-stratux-ip.test.js
```

Expected: fails before Steps 1–2, passes after.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add web/shared/network-mode.js web/cockpit/device-status.js tests/shared/network-mode-stratux-ip.test.js
git commit -m "$(cat <<'EOF'
fix(stratux): use Settings.stratuxIp for the getStatus probe, not a hardcode

network-mode.js and device-status.js both probed 192.168.10.1 directly,
bypassing the pilot's configured Stratux IP — matching stratux-client.js's
existing correct pattern (Settings.stratuxIp || '192.168.10.1') instead.
If the pilot changed the IP in settings, the Devices page and
network-mode detection kept probing the default.

Finding 7 (network-mode.js / device-status.js half only — see Task 9 for
the other two files the original finding grouped in, which turned out to
be a different bug against the Pi engine-monitor, not Stratux).
EOF
)"
```

---

## Task 9: Remove the unreliable Pi-IP fallback in fuel-overlay.js and engine-page.js

**Re-verified 2026-08-10, after PRs #123/#125/#126 merged to `main`.** `engine-page.js` changed substantially today (the ATIS override panel, #123) — it now already has its own `_engineBaseUrl()` method (added for the new `_setAtis()`, same fallback-to-`192.168.10.1` pattern as `fuel-overlay.js`'s), and `_setAtis()` already routes through it. This task's original Step 4 only touched `_stopCapture()`'s separate hardcoded fetch and didn't know either of those existed. The corrected approach below fixes the one shared `_engineBaseUrl()` helper instead of inlining a second, duplicate IP check, and routes `_stopCapture()` through it too — `_setAtis()` already does. Without this reconciliation, fixing only `_stopCapture()` per the original diff would leave `_engineBaseUrl()`'s fallback in place, so `_setAtis()` would still silently guess an IP; and naively making `_engineBaseUrl()` return `null` without updating `_setAtis()` would make it build the literal broken URL `null/api/atis` on a missing IP instead of failing clearly. `fuel-overlay.js`'s half of this task is completely unaffected by today's changes (that file has zero diff since this plan was written) and applies exactly as originally written.

**Finding 7b.** `fuel-overlay.js:697` and `engine-page.js:963` fall back to a hardcoded `192.168.10.1` when `window.engineClient?.ip` is unavailable — but this targets the **Pi engine-monitor** (port 8080), not Stratux, and the setting that should govern it (`Settings.piIp`) is defined but read nowhere in the app. Confirmed: `window.engineClient` is assigned synchronously at `app.js:518`, and both call sites only fire from user-triggered button taps that can't happen before app bootstrap completes and these panels render — `window.engineClient?.ip` is reliably available by the time either fires. Not wiring up `Settings.piIp` here deliberately — that's a new feature (config UI, defaults) out of scope for a bug-fix pass; the fix is to stop guessing an address that's probably wrong anyway.

**Files:**
- Modify: `web/cockpit/fuel-overlay.js`
- Modify: `web/cockpit/engine-page.js`
- Test: `tests/cockpit/fuel-overlay-engine-base-url.test.js` (new)
- Test: `tests/cockpit/engine-page-flight-data.test.js` (extend — `setup()`/`afterEach()` plus 2 new cases)

**Interfaces:** N/A — standalone fix.

- [ ] **Step 1: Write the failing test for `fuel-overlay.js`'s `_engineBaseUrl()`**

Create `tests/cockpit/fuel-overlay-engine-base-url.test.js`:

```javascript
/**
 * fuel-overlay.js's _engineBaseUrl() fell back to a hardcoded 192.168.10.1
 * (a Stratux-shaped address, but this URL targets the Pi engine-monitor on
 * port 8080) when window.engineClient.ip was unavailable. engineClient is
 * assigned synchronously at app.js:518, before any panel that calls this can
 * render, so the fallback could only ever paper over a genuine bug — never a
 * real "not ready yet" state.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const FuelOverlay = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

afterEach(() => { delete window.engineClient; });

describe('FuelOverlay._engineBaseUrl (Finding 7b)', () => {
    it('returns null, not a guessed IP, when engineClient is unavailable', () => {
        delete window.engineClient;
        const overlay = Object.create(FuelOverlay.prototype);
        expect(overlay._engineBaseUrl()).toBeNull();
    });

    it('builds the URL from the real engineClient.ip when available', () => {
        window.engineClient = { ip: '192.168.1.50' };
        const overlay = Object.create(FuelOverlay.prototype);
        expect(overlay._engineBaseUrl()).toBe('http://192.168.1.50:8080');
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/cockpit/fuel-overlay-engine-base-url.test.js
```

Expected: the "returns null" case fails (current code returns `http://192.168.10.1:8080` instead of `null`).

- [ ] **Step 3: Fix `fuel-overlay.js`**

Confirmed current lines 696–720 (`_engineBaseUrl` and its two callers):

```diff
     _engineBaseUrl() {
-        const ip = window.engineClient?.ip || '192.168.10.1';
-        return `http://${ip}:8080`;
+        // No fallback IP: window.engineClient is assigned at app.js:518, before
+        // FuelOverlay can be constructed or shown, so a missing ip here means
+        // something is genuinely wrong — guessing an address is worse than skipping.
+        const ip = window.engineClient?.ip;
+        return ip ? `http://${ip}:8080` : null;
     }

     _syncFuelSetToEngine(gallons, reason = '') {
-        fetch(`${this._engineBaseUrl()}/api/fuel/set`, {
+        const base = this._engineBaseUrl();
+        if (!base) { console.warn('FuelOverlay: engineClient.ip unavailable, skipping Pi fuel/set sync'); return; }
+        fetch(`${base}/api/fuel/set`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ fuel_remaining: gallons, reason }),
             signal: AbortSignal.timeout(4000),
         }).catch(() => { /* best-effort — Pi may be unreachable at fuel station */ });
     }

     _syncFuelAddToEngine(gallons, airport = '', price = null) {
+        const base = this._engineBaseUrl();
+        if (!base) { console.warn('FuelOverlay: engineClient.ip unavailable, skipping Pi fuel/add sync'); return; }
         const body = { gallons };
         if (airport) body.airport = airport;
         if (price != null) body.price_per_gallon = price;
-        fetch(`${this._engineBaseUrl()}/api/fuel/add`, {
+        fetch(`${base}/api/fuel/add`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(body),
             signal: AbortSignal.timeout(4000),
         }).catch(() => { /* best-effort */ });
     }
```

Both callers are already fire-and-forget (`.catch()`-swallowed, no UI error path) — the primary fuel save already succeeded via `FuelState.saveMeasurement` before either runs, so a `console.warn` plus skipping the fetch is the right level of "loud" here; there is no status element wired to failure of this secondary Pi sync.

- [ ] **Step 4: Fix `engine-page.js`'s shared `_engineBaseUrl()`, and both its callers**

`_engineBaseUrl()` (search for `_engineBaseUrl() {` — added today by #123, not present when this task was first drafted) has the identical fallback pattern as `fuel-overlay.js`'s:

```diff
     _engineBaseUrl() {
-        const ip = window.engineClient?.ip || '192.168.10.1';
-        return `http://${ip}:8080`;
+        // No fallback IP: window.engineClient is assigned at app.js:518, before
+        // this page can be constructed or shown, so a missing ip here means
+        // something is genuinely wrong — guessing an address is worse than
+        // skipping. Matches fuel-overlay.js's _engineBaseUrl() (same fix, #Finding 7b).
+        const ip = window.engineClient?.ip;
+        return ip ? `http://${ip}:8080` : null;
     }
```

`_setAtis()` already calls `` `${this._engineBaseUrl()}/api/atis` `` — with the fallback removed, a `null` base would silently build the broken URL `null/api/atis` instead of failing clearly. Guard it explicitly (search for `async _setAtis(key, rawVal)`, add right after the existing range-guard block, before the `try`):

```diff
             if (key === 'oat' && (val < -60 || val > 60)) {
                 this._atisStatusError('OAT must be -60–60°C');
                 return;
             }
         }
 
+        const base = this._engineBaseUrl();
+        if (!base) {
+            this._atisStatusError('Engine monitor IP unavailable');
+            return;
+        }
+
         try {
             const resp = await fetch(`${this._engineBaseUrl()}/api/atis`, {
```

(the existing `${this._engineBaseUrl()}` call inside the `fetch(...)` on the following line can stay as-is — it's called again, but `_engineBaseUrl()` is a pure read of `window.engineClient?.ip`, calling it twice is harmless; not worth a diff hunk just to thread `base` through one more line.)

`_stopCapture()` still has its own separate hardcoded fetch — this one *does* have a real UI error path (the existing `catch` block already renders `✗ Stop failed: …`), so route it through the same helper and fail into that existing catch rather than swallowing:

```diff
     async _stopCapture() {
         const btn = this._dom.captureStop;
         if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
         try {
-            const resp = await fetch('http://192.168.10.1:8080/api/stop', { method: 'POST', signal: AbortSignal.timeout(5000) });
+            const base = this._engineBaseUrl();
+            if (!base) throw new Error('Engine monitor IP unavailable');
+            const resp = await fetch(`${base}/api/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) });
```

No other lines in `_stopCapture()` need to change — the existing `catch (err)` block already shows `✗ Stop failed: ${err.message}` and re-enables the button.

- [ ] **Step 4b: Extend `tests/cockpit/engine-page-flight-data.test.js`'s ATIS describe block**

**Confirmed (checked directly, not assumed):** this file's `setup()` never sets `window.engineClient`, and the three existing tests that assert on the ATIS fetch URL (`'SET posts only the altimeter key'`, `'CLEAR posts null for the given key'`, `'tapping SET with a populated input fires the wired fetch'`) all assert the literal string `'http://192.168.10.1:8080/api/atis'` — i.e. they currently pass only because they're exercising the fallback this step removes. Without the change below, all three break the moment `_engineBaseUrl()` stops falling back.

Fix `setup()` to set a default `window.engineClient` (so those three tests keep asserting the same URL, now via a real configured IP instead of the removed fallback) and `afterEach()` to clean it up (matching the existing `delete globalThis.Settings` etc. pattern immediately below it):

```diff
     window.enginePanel = { connected: true };
+    window.engineClient = { ip: '192.168.10.1' };
```

```diff
     delete window.enginePanel;
+    delete window.engineClient;
     delete globalThis.fetch;
```

No changes needed to the three existing fetch-URL assertions themselves — they keep passing unmodified, now for the right reason (a real configured IP, not a guessed fallback).

Then add two new cases to the existing `describe('EnginePage — ATIS override', ...)` block (do not create a second test file — this file already has the harness/fixture setup these need):

```javascript
    it('_engineBaseUrl returns null, not a guessed IP, when engineClient is unavailable', () => {
        setup();
        delete window.engineClient;
        expect(page._engineBaseUrl()).toBeNull();
    });

    it('_setAtis shows a clear error and does not fetch when the IP is unavailable', async () => {
        setup();
        delete window.engineClient;
        await page._setAtis('altimeter', '29.85');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(page._el.querySelector('#ep-atis-status').textContent).toBe('Engine monitor IP unavailable');
    });
```

- [ ] **Step 5: Run the tests again, then the full suite**

```bash
npx vitest run tests/cockpit/fuel-overlay-engine-base-url.test.js
npx vitest run tests/cockpit/engine-page-flight-data.test.js
npm test
```

Expected: all 3 pre-existing ATIS fetch-URL tests still pass (now via the explicit `window.engineClient` set in `setup()`), plus the 2 new ones. Pay attention to `tests/cockpit/fuel-overlay-apply-guard.test.js` and `fuel-overlay-fuelstop-guard.test.js` — neither sets `window.engineClient` and neither asserts anything about fetch calls to the Pi (fetch is globally mocked to reject in both), so this change should not affect them; confirm they still pass.

- [ ] **Step 6: Commit**

```bash
git add web/cockpit/fuel-overlay.js web/cockpit/engine-page.js tests/cockpit/fuel-overlay-engine-base-url.test.js tests/cockpit/engine-page-flight-data.test.js
git commit -m "$(cat <<'EOF'
fix(engine): stop guessing a Pi IP when engineClient.ip is unavailable

fuel-overlay.js and engine-page.js fell back to a hardcoded 192.168.10.1
(a Stratux-shaped default, but this targets the Pi engine-monitor on port
8080) when window.engineClient.ip wasn't set. engineClient is assigned
synchronously at app.js:518, before any call site can fire — a missing ip
means something is genuinely wrong, and guessing an address is worse than
skipping the sync or failing loudly.

fuel-overlay.js's two Pi-sync calls are fire-and-forget with no UI error
path, so they now warn and skip. engine-page.js's _engineBaseUrl() (added
after this task was first drafted, by the ATIS-override port in #123) had
the identical fallback; fixed once at the shared helper and routed both
its callers -- _setAtis() and _stopCapture() -- through it. _setAtis()
already had a status element to fail into; _stopCapture() already had a
catch block that renders "Stop failed: ...".

Not wiring up Settings.piIp here — it's defined but read nowhere in the
app, and giving it a real config UI/default is a new feature, out of
scope for this fix.

Finding 7 (fuel-overlay.js / engine-page.js half — see Task 8 for the
other two files, which were a genuine Settings.stratuxIp bypass).
EOF
)"
```

---

## Task 10: Fix untracked, uncancelable reconnect timers in stratux-client.js

**Finding 10.** Three inline `setTimeout` calls in `web/shared/stratux-client.js` — the `onclose` handlers for `_situationWs` (confirmed line 332), `_weatherWs` (454), `_jsonioWs` (496) — never store their handle, so `disconnect()` cannot cancel them. Confirmed worse than "race window": the guard on the weather/jsonio timers checks `this.udpMode`, which reflects static plugin/config availability and is never falsified by `disconnect()` — on real hardware with the native UDP plugin present, these two fire **unconditionally** after any close, not just in a rare timing race. `config-editor.js:443-444` calls `disconnect()` immediately followed by `connect()` on every Stratux-IP settings change, which means the fix's new "disconnected" flag must reset on `connect()` or reconnection would be permanently broken after the very first IP edit — confirmed by reading that call site.

**Files:**
- Modify: `web/shared/stratux-client.js`
- Test: `tests/shared/stratux-client.test.js` (extend)

**Interfaces:** N/A — standalone fix.

- [ ] **Step 1: Extend the shared `WebSocket` stub with a `close()` method**

Confirmed current top-of-file stub in `tests/shared/stratux-client.test.js`:

```javascript
global.WebSocket     = class { constructor() {} static OPEN = 1; };
```

`disconnect()` unconditionally calls `.close()` on `_trafficWs`/`_situationWs`/`_weatherWs`/`_jsonioWs` — this stub has no `close` method, so any new test that lets `disconnect()` run past a populated `_xxxWs` field throws `TypeError: ...close is not a function`. (`tests/shared/engine-client.test.js`'s equivalent stub already has `close() {}` — this file's stub was never updated to match when `disconnect()`-exercising tests were added.)

```diff
-global.WebSocket     = class { constructor() {} static OPEN = 1; };
+global.WebSocket     = class { constructor() {} close() {} static OPEN = 1; };
```

This is purely additive — the existing `_handleSituation`/`_handleTraffic` tests never call `disconnect()` or `.close()`, so they're unaffected.

- [ ] **Step 2: Write the failing tests**

Append to `tests/shared/stratux-client.test.js` (the existing top-of-file stubs — `global.WebSocket`, `Settings`, `DiagLog`, etc., now including the `close()` method just added — already cover what's needed):

```javascript
// ---------------------------------------------------------------------------
// disconnect() cancels all pending reconnect timers (Finding 10)
// ---------------------------------------------------------------------------
describe('StratuxClient.disconnect — cancels pending reconnect timers', () => {
    let client;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new StratuxClient();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a situation-WS reconnect scheduled before disconnect() never fires after it', () => {
        // Exercises the REAL _connectSituation()/onclose handler (spied, not
        // reimplemented) — priming call runs for real via the WebSocket stub at
        // the top of this file, so the assertion below is against Step 6's
        // actual code, not a hand-copied stand-in that could silently drift
        // from it.
        client._trafficWs = { readyState: WebSocket.OPEN }; // satisfies the reconnect guard
        const spy = vi.spyOn(client, '_connectSituation');
        client._connectSituation(); // priming call — installs the real onclose on a stub WS
        spy.mockClear();

        client._situationWs.onclose({ code: 1006, reason: 'test' }); // simulate the WS actually closing
        // toBeTruthy(), not not.toBeNull() — the latter also passes if the field is
        // simply undefined (i.e. doesn't exist yet on unfixed code), which would let
        // this assertion pass even before Step 3 adds the field.
        expect(client._situationReconnectTimer).toBeTruthy();

        client.disconnect();
        vi.advanceTimersByTime(5000);

        expect(spy).not.toHaveBeenCalled();
    });

    it('a weather-WS reconnect scheduled before disconnect() never fires, even when the UDP plugin makes udpMode permanently true', () => {
        // udpMode is a getter with no setter (`get udpMode() { return !!_StratuxUdpBus
        // && !this._simMode; }`, confirmed directly in source) — `client.udpMode = true`
        // throws (class bodies are strict mode). _StratuxUdpBus is a module-level
        // constant fixed at source-evaluation time, so reproducing udpMode===true (the
        // actual "fires unconditionally on real hardware" case from Finding 10, not a
        // timing race) requires re-evaluating the source with Capacitor.Plugins.StratuxUDP
        // present — mirroring how the class itself detects the native plugin.
        global.Capacitor = { Plugins: { StratuxUDP: { addListener: vi.fn(), start: vi.fn(), stop: vi.fn() } } };
        try {
            const freshSrc = readFileSync('web/shared/stratux-client.js', 'utf8');
            const StratuxClientUdp = new Function(`${freshSrc}\nreturn StratuxClient;`)();
            const udpClient = new StratuxClientUdp();
            expect(udpClient.udpMode).toBe(true); // sanity check the stub actually engaged udpMode

            const spy = vi.spyOn(udpClient, '_connectWeather');
            udpClient._connectWeather();
            spy.mockClear();

            udpClient._weatherWs.onclose({ code: 1006, reason: 'test' });
            expect(udpClient._weatherReconnectTimer).toBeTruthy();

            udpClient.disconnect();
            vi.advanceTimersByTime(10000);

            expect(spy).not.toHaveBeenCalled();
        } finally {
            delete global.Capacitor; // don't leak into other tests, even on assertion failure
        }
    });

    it('disconnect() clears the timer fields themselves, not just skipping the callback', () => {
        client._situationReconnectTimer = setTimeout(() => {}, 2000);
        client._weatherReconnectTimer = setTimeout(() => {}, 5000);
        client._jsonioReconnectTimer = setTimeout(() => {}, 5000);

        client.disconnect();

        expect(client._situationReconnectTimer).toBeNull();
        expect(client._weatherReconnectTimer).toBeNull();
        expect(client._jsonioReconnectTimer).toBeNull();
    });

    it('connect() resets _disconnected — reconnecting after a settings-driven IP change still works', () => {
        // config-editor.js calls disconnect() immediately followed by connect() on every
        // Stratux-IP settings edit. If _disconnected didn't reset here, every reconnect
        // scheduled after the FIRST IP edit would be permanently suppressed.
        client.disconnect();
        expect(client._disconnected).toBe(true);
        client.connect();
        expect(client._disconnected).toBe(false);
    });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/shared/stratux-client.test.js
```

Expected: the new `describe` block's tests fail — `close is not a function` before Step 1's stub fix is applied; after it, `_disconnected`/`_situationReconnectTimer`/etc. don't exist yet, or the callbacks fire because nothing clears them. Confirm the pre-existing `_handleSituation`/`_handleTraffic` tests still pass at this point (they should be untouched).

(`_connectSituation()`/`_connectWeather()`/`disconnect()` were read in full directly against this worktree's source — not just quoted excerpts — so the test setup above is grounded in their actual bodies, not inferred.)

- [ ] **Step 4: Add the lifecycle flag and new timer fields**

In the constructor, after the existing `this._towerTimer = null;`:

```diff
         this._reconnectTimer = null;
         this._statusTimer = null;
         this._towerTimer = null;
+        this._situationReconnectTimer = null;
+        this._weatherReconnectTimer = null;
+        this._jsonioReconnectTimer = null;
+        this._disconnected = false;
```

- [ ] **Step 5: Reset the flag in `connect()`**

As the first line of `connect()`:

```diff
     connect() {
+        this._disconnected = false;
         // Cancel any pending reconnect timer so the external call and the timer
         // don't both call _connectTraffic() independently.
         if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
```

- [ ] **Step 6: Rewrite `disconnect()`**

Confirmed current content, lines 201–215:

```diff
     disconnect() {
+        this._disconnected = true;
         if (_StratuxUdpBus) { _StratuxUdpBus.detach(); _StratuxUdpBus.stop(); }
         if (this._trafficWs) { this._trafficWs.close(); this._trafficWs = null; }
         if (this._situationWs) { this._situationWs.close(); this._situationWs = null; }
         if (this._weatherWs) { this._weatherWs.close(); this._weatherWs = null; }
         if (this._jsonioWs) { this._jsonioWs.close(); this._jsonioWs = null; }
         if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
+        if (this._situationReconnectTimer) { clearTimeout(this._situationReconnectTimer); this._situationReconnectTimer = null; }
+        if (this._weatherReconnectTimer) { clearTimeout(this._weatherReconnectTimer); this._weatherReconnectTimer = null; }
+        if (this._jsonioReconnectTimer) { clearTimeout(this._jsonioReconnectTimer); this._jsonioReconnectTimer = null; }
         if (this._purgeInterval) { clearInterval(this._purgeInterval); this._purgeInterval = null; }
         if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
         if (this._towerTimer) { clearInterval(this._towerTimer); this._towerTimer = null; }
         clearTimeout(this._staleTimer);
         this._staleTimer = null;
         this._stale = false;
         this._setConnected(false);
     }
```

- [ ] **Step 7: Fix the three `onclose` handlers to track their timers and check `_disconnected`**

`_situationWs.onclose` (confirmed lines 329–339 — note the existing "Guard:" comment inside the `setTimeout` in real source, shown removed below along with the rest of the old block, not silently dropped):

```diff
         this._situationWs.onclose = (e) => {
             if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Situation WS closed code=${e?.code} reason=${e?.reason || ''}`);
-            if (this._trafficWs?.readyState === WebSocket.OPEN) {
-                setTimeout(() => {
-                    // Guard: don't create a duplicate if already reconnected
-                    if (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN) {
-                        this._connectSituation();
-                    }
-                }, 2000);
-            }
+            if (!this._disconnected && this._trafficWs?.readyState === WebSocket.OPEN) {
+                this._situationReconnectTimer = setTimeout(() => {
+                    this._situationReconnectTimer = null;
+                    // Guard: don't create a duplicate if already reconnected, and never
+                    // reconnect if disconnect() ran while this timer was pending.
+                    if (!this._disconnected && (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN)) {
+                        this._connectSituation();
+                    }
+                }, 2000);
+            }
         };
```

`_weatherWs.onclose` (confirmed lines 449–459 — the existing 3-line comment in real source is shown removed below as part of the old block, replaced by the new 6-line comment, rather than left unaccounted for):

```diff
         this._weatherWs.onclose = (e) => {
             if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Weather WS closed code=${e?.code} reason=${e?.reason || ''}`);
-            // Reconnect after 5s if the overall Stratux connection is still alive
-            // (covers both WS-mode traffic OPEN and UDP-mode where traffic flows
-            // separately).
-            setTimeout(() => {
-                if (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN) {
-                    this._connectWeather();
-                }
-            }, 5000);
+            // Reconnect after 5s if the overall Stratux connection is still alive
+            // (covers both WS-mode traffic OPEN and UDP-mode where traffic flows
+            // separately). !this._disconnected is required because udpMode reflects
+            // static plugin/config availability, not connection lifecycle — it is
+            // never falsified by disconnect(), so without this check this fires
+            // unconditionally on any hardware with the native UDP plugin present.
+            this._weatherReconnectTimer = setTimeout(() => {
+                this._weatherReconnectTimer = null;
+                if (!this._disconnected && (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN)) {
+                    this._connectWeather();
+                }
+            }, 5000);
         };
```

`_jsonioWs.onclose` (confirmed lines 494–501) — same pattern:

```diff
         this._jsonioWs.onclose = (e) => {
             if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Jsonio WS closed code=${e?.code} reason=${e?.reason || ''}`);
-            setTimeout(() => {
-                if (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN) {
-                    this._connectJsonio();
-                }
-            }, 5000);
+            this._jsonioReconnectTimer = setTimeout(() => {
+                this._jsonioReconnectTimer = null;
+                if (!this._disconnected && (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN)) {
+                    this._connectJsonio();
+                }
+            }, 5000);
         };
```

All three before-states above were re-verified by directly reading `web/shared/stratux-client.js` in the `fix/critical-reliability-security` worktree (not just relayed from the verification pass) — line numbers and content confirmed exact, including the weather-onclose comment block that an earlier draft of this diff had dropped.

- [ ] **Step 8: Run the tests again, then the full suite**

```bash
npx vitest run tests/shared/stratux-client.test.js
npm test
```

Expected: all new tests pass; pre-existing `_handleSituation`/`_handleTraffic` tests unaffected (they don't touch `connect`/`disconnect`).

- [ ] **Step 9: Commit**

```bash
git add web/shared/stratux-client.js tests/shared/stratux-client.test.js
git commit -m "$(cat <<'EOF'
fix(stratux): track and cancel all reconnect timers in disconnect()

Three onclose-scheduled setTimeout calls (situation/weather/jsonio WS)
never stored their handles, so disconnect() couldn't cancel them. Worse
than a race window: the weather/jsonio guard checks udpMode, which
reflects static plugin/config availability and is never falsified by
disconnect() — on real hardware with the native UDP plugin, these fired
unconditionally after any close, not just in a narrow timing race.

Adds a _disconnected lifecycle flag (reset in connect(), since
config-editor.js calls disconnect() immediately followed by connect() on
every Stratux-IP settings change — without the reset, reconnection would
be permanently dead after the first IP edit) plus three new timer fields
that disconnect() now clears alongside the existing _reconnectTimer.

Finding 10.
EOF
)"
```

---

## Task 11: Build, deploy & verify Phase 2

**Files:**
- Modify: `web/app.js` (version bump)

- [ ] **Step 1: Bump `FLYTAB_VERSION`** in `web/app.js` (one minor version above wherever Phase 1 left it).

- [ ] **Step 2: Build**

```bash
cd /home/dananickerson/flytab
bash build.sh
```

- [ ] **Step 3: Full test suite**

```bash
npm test
```

- [ ] **Step 4: On-device smoke check**

Install the APK. Confirm: Devices page / network-mode still detect Stratux correctly after the Task 8 change (test with the default IP, since that's what most installs use); fuel-stop sync to the Pi still works normally when the Pi is reachable (Task 9); a normal Stratux disconnect/reconnect cycle (e.g. toggling Stratux WiFi) still recovers cleanly (Task 10) — this is the one change in this phase most likely to have a subtle regression, since it touches every WS reconnect path in `stratux-client.js`, so give it real air time rather than a five-second check.

---

# Phase 3 — Medium (cleanup & hardening)

## Task 12: Guard ConvectiveDisplay/ConvectiveAlerts against a missing script tag

**Finding 9 (stopgap only — see Appendix A for the full composition-root issue, which is out of scope here).** `app.js`'s `_initCockpit()` gates ~40 module instantiations behind `typeof X !== 'undefined'` checks so a missing/typo'd `<script>` tag in `index.html` degrades silently. Confirmed exception: `ConvectiveDisplay` and `ConvectiveAlerts` (lines 725–726) are instantiated with no such guard, inside a block that otherwise guards `ConvectiveIntelligenceEngine`/`HRRRPreflightStore` (lines 714–715) — so a typo'd path for just these two classes would throw at boot instead of degrading like everything else in this function. Both classes' script tags currently exist and load correctly, so this is latent, not an active bug.

**Files:**
- Modify: `web/app.js`
- Test: `tests/cockpit/app-convective-guard.test.js` (new)

**Interfaces:** N/A — standalone fix. Confirmed safe: `ConvectiveIntelligenceEngine`'s constructor sets `this._display = null; this._alerts = null;`, `.init()` is a plain field-setter, and every internal use is null-safe (`this._display?.setActive(on)`, `if (this._display) {...}`) — so calling `.loadPreflight()`/`.setActive(true)` without ever calling `.init()` (i.e., the guard-fails case) is already safe: the engine just runs headless.

- [ ] **Step 1: Write the failing test**

Create `tests/cockpit/app-convective-guard.test.js` — a source-pinning test, consistent with this repo's established style for asserting structural properties of `app.js` without instantiating the whole app (see `fuel-overlay-apply-guard.test.js`'s "structural contract" tests):

```javascript
/**
 * app.js's _initCockpit() gates ~40 module instantiations behind
 * `typeof X !== 'undefined'` so a missing/typo'd <script> tag degrades
 * silently. ConvectiveDisplay/ConvectiveAlerts were the one exception —
 * instantiated unguarded inside a block that otherwise guards
 * ConvectiveIntelligenceEngine/HRRRPreflightStore.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const APP_SRC = readFileSync('web/app.js', 'utf8');

describe('Convective classes are guarded like every other module in _initCockpit (Finding 9 stopgap)', () => {
    it('ConvectiveDisplay/ConvectiveAlerts are instantiated inside a typeof guard', () => {
        const block = APP_SRC.slice(
            APP_SRC.indexOf('typeof ConvectiveIntelligenceEngine'),
            APP_SRC.indexOf('this.convectiveEngine.loadPreflight()')
        );
        expect(block).toMatch(/typeof ConvectiveDisplay !== 'undefined'/);
        expect(block).toMatch(/typeof ConvectiveAlerts !== 'undefined'/);
        // The guard must wrap the instantiation, not just appear somewhere in the block.
        const guardIdx = block.indexOf("typeof ConvectiveDisplay !== 'undefined'");
        const newDisplayIdx = block.indexOf('new ConvectiveDisplay(');
        expect(guardIdx).toBeGreaterThan(-1);
        expect(guardIdx).toBeLessThan(newDisplayIdx);
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/cockpit/app-convective-guard.test.js
```

- [ ] **Step 3: Add the guard**

Confirmed current content, `web/app.js` lines 713–735:

```diff
         // Convective Intelligence Engine — must be after fisbClient and fisbNexrad are assigned
         if (typeof ConvectiveIntelligenceEngine !== 'undefined' &&
             typeof HRRRPreflightStore !== 'undefined' &&
             this.fisbNexrad && this.fisbClient) {
             const preflightStore = new HRRRPreflightStore();
             this.convectiveEngine = new ConvectiveIntelligenceEngine({
                 fisbNexrad: this.fisbNexrad,
                 fisbClient: this.fisbClient,
                 engineClient: this.engineClient,
                 stratuxClient: this.stratuxClient,
                 preflightStore,
             });
-            const convDisplay = new ConvectiveDisplay(this.cockpitMap?.map);
-            const convAlerts  = new ConvectiveAlerts();
-            this.convectiveEngine.init(convDisplay, convAlerts);
-            if (this.cockpitMap?.map) {
-                convAlerts.mount(this.cockpitMap.map.getContainer());
-            }
+            if (typeof ConvectiveDisplay !== 'undefined' && typeof ConvectiveAlerts !== 'undefined') {
+                const convDisplay = new ConvectiveDisplay(this.cockpitMap?.map);
+                const convAlerts  = new ConvectiveAlerts();
+                this.convectiveEngine.init(convDisplay, convAlerts);
+                if (this.cockpitMap?.map) {
+                    convAlerts.mount(this.cockpitMap.map.getContainer());
+                }
+            }
             this.convectiveEngine.loadPreflight().catch(e => DiagLog.log('convective', `Preflight load error: ${e.message}`));
             if (CockpitConfig.get('convective.enabled')) {
                 this.convectiveEngine.setActive(true);
             }
         }
```

`loadPreflight()`/`setActive()` stay outside the new inner guard, unchanged — confirmed safe per this task's header.

- [ ] **Step 4: Run the test again, then the full suite**

```bash
npx vitest run tests/cockpit/app-convective-guard.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git add web/app.js tests/cockpit/app-convective-guard.test.js
git commit -m "$(cat <<'EOF'
fix(app): guard ConvectiveDisplay/ConvectiveAlerts like every other module

_initCockpit() gates ~40 module instantiations behind typeof X !==
'undefined' checks so a missing/typo'd script tag degrades a feature
silently instead of throwing at boot. ConvectiveDisplay/ConvectiveAlerts
were instantiated unguarded inside a block that otherwise guards
ConvectiveIntelligenceEngine/HRRRPreflightStore — a typo'd path for just
these two would have thrown instead of degrading.

Confirmed safe to skip: ConvectiveIntelligenceEngine's internal use of
_display/_alerts is already null-safe throughout, so running headless
(guard fails, .init() never called) is the same degrade-gracefully
behavior every other guarded module in this function already gets.

This is a stopgap for one asymmetry, not the composition-root redesign —
see docs/superpowers/plans/2026-08-09-code-review-fixes.md Appendix A.

Finding 9 (partial).
EOF
)"
```

---

## Task 13: Fix GPS event/property divergence in EngineGpsBridge

**Finding 11.** `gps-source.js` (confirmed lines 303–304) both sets `this._stratux.situation = situation` *and* dispatches the `stratux:situation` event. `engine-gps-bridge.js` (confirmed line ~45, inside `_tick()`) fires the same event but never sets the property. Property readers — `track-log.js:48`, `device-status.js:77`, `map.js:1153` — silently see no position update while `EngineGpsBridge` is the active GPS source. Confirmed all five consumers (`GpsSource`, `CockpitMap`, `EngineGpsBridge`, `TrackLog`, `DeviceStatus`) hold the exact same `StratuxClient` object reference (`app.js:431` constructs it once), so a property write from `EngineGpsBridge` is immediately visible everywhere else — this is a same-object fix, not a wiring change. `StratuxClient.situation` is already a plain settable instance property (confirmed `stratux-client.js:123`, `this.situation = null;`, no getter/setter) and `StratuxClient` itself uses the identical set-then-dispatch pattern internally — this fix follows an established pattern, not a novel one. Confirmed trigger condition is narrow but real: Stratux WS down (`stale === true`), `GpsSource` not suppressing (i.e. not already on internal/fallback GPS), and the Pi's engine monitor independently reporting non-stale GPS.

**Files:**
- Modify: `web/shared/engine-gps-bridge.js`
- Test: `tests/shared/engine-gps-bridge.test.js` (new)

**Interfaces:** N/A — standalone fix.

- [ ] **Step 1: Write the failing test**

Create `tests/shared/engine-gps-bridge.test.js`, following the same stub pattern as `tests/shared/stratux-client.test.js`:

```javascript
/**
 * gps-source.js sets BOTH stratux.situation and fires 'stratux:situation'.
 * engine-gps-bridge.js fired the event only — property readers (track-log.js,
 * device-status.js, map.js) saw no position update while the engine-GPS
 * fallback was active, even though event-listener readers worked fine.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

global.DiagLog = { log: vi.fn() };
if (typeof global.CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(t, o) { super(t); this.detail = o?.detail; }
    };
}

const src = readFileSync('web/shared/engine-gps-bridge.js', 'utf8');
const EngineGpsBridge = new Function(`${src}\nreturn EngineGpsBridge;`)();

function makeStratux() {
    const target = new EventTarget();
    target.situation = null;
    target.stale = true;
    target._suppressGpsSituation = false;
    return target;
}

function makeEngine(data) {
    return { stale: false, lastData: data };
}

describe('EngineGpsBridge — sets stratux.situation, not just the event (Finding 11)', () => {
    let stratux, engine, bridge;

    beforeEach(() => {
        stratux = makeStratux();
        engine = makeEngine({ latitude: 35.1, longitude: -80.2, gps_altitude: 3500, ground_speed: 120, course: 270, pitch: 1, bank: 0, acc_vert: 1 });
        bridge = Object.create(EngineGpsBridge.prototype);
        bridge._stratux = stratux;
        bridge._engine = engine;
        bridge._active = false;
    });

    it('sets stratux.situation when injecting engine GPS', () => {
        bridge._tick();
        expect(stratux.situation).not.toBeNull();
        expect(stratux.situation.lat).toBe(35.1);
        expect(stratux.situation.lon).toBe(-80.2);
    });

    it('still fires the stratux:situation event with the same data', () => {
        const events = [];
        stratux.addEventListener('stratux:situation', (e) => events.push(e.detail));
        bridge._tick();
        expect(events).toHaveLength(1);
        expect(events[0].lat).toBe(35.1);
        expect(events[0]).toBe(stratux.situation); // same object, not a re-derived copy
    });

    it('does not touch stratux.situation when GpsSource is suppressing (internal GPS active)', () => {
        stratux._suppressGpsSituation = true;
        bridge._tick();
        expect(stratux.situation).toBeNull();
    });

    it('does not touch stratux.situation when Stratux is not actually stale', () => {
        stratux.stale = false;
        bridge._tick();
        expect(stratux.situation).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/shared/engine-gps-bridge.test.js
```

Expected: the first two tests fail (`stratux.situation` stays `null` even though the event fires).

- [ ] **Step 3: Fix `_tick()`**

In `web/shared/engine-gps-bridge.js`, inside the `if (shouldInject)` branch, extract the inline event-detail object into a named `situation` and assign it to the property before dispatching:

```diff
         if (shouldInject) {
             if (!this._active) {
                 this._active = true;
                 if (typeof DiagLog !== 'undefined')
                     DiagLog.log('gps', 'Engine GPS bridge active — injecting engine GPS as Stratux situation');
             }
-            this._stratux.dispatchEvent(new CustomEvent('stratux:situation', {
-                detail: {
-                    lat:             d.latitude,
-                    lon:             d.longitude,
-                    alt_msl:         d.gps_altitude,
-                    alt_baro:        d.gps_altitude,
-                    ground_speed:    d.ground_speed,
-                    true_course:     d.course,
-                    pitch:           d.pitch,
-                    roll:            d.bank,
-                    g_load:          d.acc_vert,
-                    gps_fix_quality: 1,
-                    gps_sats:        null,
-                    vertical_speed:  0,
-                    _source:         'engine',
-                }
-            }));
+            const situation = {
+                lat:             d.latitude,
+                lon:             d.longitude,
+                alt_msl:         d.gps_altitude,
+                alt_baro:        d.gps_altitude,
+                ground_speed:    d.ground_speed,
+                true_course:     d.course,
+                pitch:           d.pitch,
+                roll:            d.bank,
+                g_load:          d.acc_vert,
+                gps_fix_quality: 1,
+                gps_sats:        null,
+                vertical_speed:  0,
+                _source:         'engine',
+            };
+            // Mirror gps-source.js:303-304 — set the property so direct readers
+            // (track-log.js, device-status.js, map.js traffic filter) see engine
+            // GPS too, not just addEventListener('stratux:situation') subscribers.
+            this._stratux.situation = situation;
+            this._stratux.dispatchEvent(new CustomEvent('stratux:situation', { detail: situation }));
         } else if (this._active) {
```

(Confirm the exact current field list inside the `d?.latitude != null` / `shouldInject` computation and the object literal against the live file before applying — the diff above is based on the verified draft; do not add or remove fields beyond restructuring the literal into a named `const`.)

- [ ] **Step 4: Run the test again, then the full suite**

```bash
npx vitest run tests/shared/engine-gps-bridge.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git add web/shared/engine-gps-bridge.js tests/shared/engine-gps-bridge.test.js
git commit -m "$(cat <<'EOF'
fix(gps): EngineGpsBridge sets stratux.situation, not just the event

gps-source.js sets both stratux.situation and fires stratux:situation.
EngineGpsBridge fired the event only, so property readers (track-log.js,
device-status.js, map.js) silently saw no position update while the
engine-GPS fallback was active (Stratux WS down, not on internal GPS,
Pi engine monitor independently reporting GPS) — event-listener readers
worked fine the whole time, making this an inconsistent, hard-to-spot gap
rather than a total outage.

All five consumers (GpsSource, CockpitMap, EngineGpsBridge, TrackLog,
DeviceStatus) hold the same StratuxClient instance (app.js:431), so this
is a same-object property write, not a wiring change — and matches the
set-then-dispatch pattern StratuxClient already uses internally.

Finding 11.
EOF
)"
```

---

## Task 14: Delete dead CSS theme blocks and correct touch-target tokens

**Finding 12.** `style.css`'s `[data-mode="cockpit"]` (confirmed lines 49–94) and `[data-mode="night"]` (confirmed lines 97–127) blocks are dead — the file already says so in a comment at lines 81–88, but the dead code itself was never removed. Confirmed via grep: the only places JS ever sets a `data-mode` attribute are on `<button>` elements in `ifr-clearance.js` (`dep`/`apch`) and `wx-briefing.js` (`day`/`hour`) for tab-switching state, unrelated to page theming — nothing anywhere sets `data-mode="cockpit"` or `="night"` on `documentElement`/`body`. Separately, and NOT the "relies on a fallback" issue the original review described: `--touch-min`/`--touch-preferred` are defined **twice** — once (unreachably) inside the dead block, and again in the live `:root` block (confirmed lines 217–222 on `main`) at **48px/56px** — smaller than the 56px/64px this repo's own CLAUDE.md documents as the standard, and smaller than what CLAUDE.md explicitly says never to hardcode (48px). 38 call sites use `var(--touch-min...)` and 6 use `var(--touch-preferred...)`, mostly with no inline fallback, so they resolve directly to the live (currently too-small) values — **this will visibly grow buttons across the app**; a screenshot check is warranted, not optional. Re-verifying against `main` also surfaced two stale comments elsewhere in the file that reference the old/dead values and need updating alongside the fix (line numbers below, both confirmed on `main`) — small enough to fold into this same task rather than raise separately.

**Files:**
- Modify: `web/style.css`

**Interfaces:** N/A — standalone fix. No automated CSS test infra in this repo; verified visually.

- [ ] **Step 1: Delete both dead blocks and their header comments**

Confirmed contiguous range **lines 47–127** covers: the `/* ── Cockpit Mode ── */` header comment (47–48), the `[data-mode="cockpit"]` block including its own "this is dead code" explanatory comment (49–94), the blank separator line (95), the `/* ── Night Mode ── */` header (96), and the `[data-mode="night"]` block (97–127). Delete lines 47–127 in full. This leaves two adjacent blank lines where line 46 and the old line 128 meet — collapse to one for tidiness.

- [ ] **Step 2: Correct the live touch-target tokens**

Confirmed current content, `web/style.css` lines 217–222 on `main`:

```diff
     /* ── Touch targets — Apple HIG + sunlight glove tolerance ── */
     --touch-compact:     36px;      /* compact toolbar/table buttons (fixed, no cockpit override) */
-    --touch-min:         48px;      /* 18mm — iOS minimum, bare finger           */
-    --touch-preferred:   56px;      /* 21mm — preferred, sunglasses + bright sun */
+    --touch-min:         56px;      /* iOS minimum, bare finger                  */
+    --touch-preferred:   64px;      /* preferred, sunglasses + bright sun        */
     --touch-large:       64px;      /* 24mm — primary cockpit actions            */
     --touch-spacing:     6px;       /* gap between adjacent touch targets        */
```

(Dropped the `18mm`/`21mm` annotations rather than carry forward unverified mm conversions for the new px values.) `--touch-large` now equals the new `--touch-preferred` (both 64px) — leave it as-is; CLAUDE.md doesn't document a third tier, and consolidating or renaming it is a separate decision, not part of this fix.

- [ ] **Step 3: Fix two stale comments this value change orphans**

Found while re-verifying this file against `main` — both reference the old/dead values and would be actively misleading once Step 1/2 land, so fixing them here rather than leaving a landmine for the next person reading this file.

`web/style.css`, confirmed line 758 (`.btn-close` comment, references the dead `[data-mode="cockpit"]` block's 80px value that Step 1 just deleted):

```diff
 /* Close / dismiss button — turbulence-safe large tap target.
-   Uses --touch-large (64px global, 80px in cockpit mode).
+   Uses --touch-large (64px).
    Add this class to any dismiss button; keep module-specific class for binding. */
```

`web/style.css`, confirmed line 1945 (`.route-wp-main`, inline comment hardcodes the pre-fix pixel value):

```diff
-    min-height: var(--touch-preferred); /* 56px — cockpit turbulence target */
+    min-height: var(--touch-preferred); /* 64px — cockpit turbulence target */
```

(Line numbers for both will have shifted by however many lines Step 1's deletion and Step 2's edit move them — locate by searching for the quoted text rather than trusting the raw numbers if they don't match exactly.)

- [ ] **Step 4: Run the full test suite**

```bash
cd /home/dananickerson/flytab
npm test
```

Expected: unaffected (pure CSS, no test references these blocks or values).

- [ ] **Step 5: Visual verification — this WILL change button sizing**

Start the dev server preview and check a screen with dense touch targets (e.g. the route table or a settings/config panel) before and after, at minimum in portrait (this pilot's stated usage per project conventions):

1. Start the preview, screenshot a representative screen.
2. Confirm no layout breakage (overlapping buttons, overflow) from the larger minimum sizes — 8px larger on `--touch-min`, 8px larger on `--touch-preferred`.
3. Screenshot again for comparison.

- [ ] **Step 6: Commit**

```bash
git add web/style.css
git commit -m "$(cat <<'EOF'
fix(style): delete dead cockpit/night theme blocks, fix touch-target sizes

[data-mode="cockpit"] and [data-mode="night"] were already documented in
a comment as dead code (nothing ever sets that attribute value on
documentElement/body — confirmed by grep, the only data-mode writes are
unrelated button tab-state) but were never actually removed.

Separately: --touch-min/--touch-preferred were defined twice — once
inside the (now-removed) dead block, and again in the live :root block at
48px/56px, smaller than the 56px/64px this repo's own CLAUDE.md documents
as standard, and specifically smaller than the 48px CLAUDE.md says never
to hardcode. Corrected to 56px/64px. This visibly grows touch targets
across the app (38 call sites read --touch-min, 6 read --touch-preferred,
mostly with no inline fallback) — verified with a before/after screenshot,
no layout breakage found.

Also fixes two comments the value change would otherwise have orphaned:
.btn-close's comment referencing the deleted dead block's 80px value, and
.route-wp-main's inline comment hardcoding the old 56px figure.

Finding 12.
EOF
)"
```

---

## Task 15: Remove dead `window.stratuxClient` fallback in emergency-glide.js

**Finding 13a.** `emergency-glide.js` (confirmed lines 59, 543, 591 — identical text at all three) reads `window.app?.stratuxClient?.situation ?? window.stratuxClient?.situation`. `window.stratuxClient` is never assigned anywhere in the codebase (confirmed by grep) — the `?? window.stratuxClient?.situation` half is unreachable dead code at all three sites.

**Files:**
- Modify: `web/cockpit/emergency-glide.js`

**Interfaces:** N/A — standalone, provably no-op deletion (the right-hand side of `??` can never be reached, so removing it changes no behavior).

- [ ] **Step 1: Confirm the fallback is genuinely unreachable, immediately before editing**

```bash
cd /home/dananickerson/flytab
grep -rn "window\.stratuxClient\s*=" web/
```

Expected: no hits (nothing ever assigns it).

- [ ] **Step 2: Simplify all three call sites**

At lines 59, 543, and 591 (confirmed identical text at each):

```diff
-const sit = window.app?.stratuxClient?.situation ?? window.stratuxClient?.situation;
+const sit = window.app?.stratuxClient?.situation;
```

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: no change — this is a provable no-op given Step 1's confirmation.

- [ ] **Step 4: Commit**

```bash
git add web/cockpit/emergency-glide.js
git commit -m "$(cat <<'EOF'
chore(emergency-glide): remove dead window.stratuxClient fallback

window.stratuxClient is never assigned anywhere in the codebase — the
?? window.stratuxClient?.situation half of this expression (three
identical sites) was unreachable dead code. window.app.stratuxClient is
the only path ever populated.

Finding 13a.
EOF
)"
```

---

## Task 16: Route the plan-picker load through `applyRouteEdit`

**Finding 5 (partial mitigation only — see Appendix A for the full canonical-trip-object issue, out of scope here).** `route-table.js`'s plan picker (`_showPlanPicker()`, defined at line 2211; the item-click handler this task fixes is confirmed at lines 2259–2276 on `main`) writes `flypi_active_plan` to `localStorage` directly and then calls `app._applyPlan(plan)` directly — bypassing both `applyRouteEdit()`'s latest-wins queue (`app.js`'s `_pendingPlanEdit` mechanism, see `tests/cockpit/app-route-edit-queue.test.js` for its existing coverage) and the redundant localStorage write it does a few lines earlier gets clobbered by `_applyPlan`'s own write moments later anyway. Confirmed **safe** to route through `applyRouteEdit` instead: the same full `plan` object goes to `_applyPlan` either way, so no field is lost. **`doSave()` (the `const doSave = async () => {` closure inside `_saveRoute()`, confirmed at line 2169, with its own `localStorage.setItem('flypi_active_plan', ...)` at line 2192) is a separate call site this task does NOT touch** — confirmed unsafe to mechanically redirect: it builds a deliberately bare-bones plan object that would, for the first time, overwrite `app._currentTrip` via a destructive replace rather than a merge, dropping fields (`aircraft`, `weather_cache`, `flight_plan.legs`) that `ifrClearance`/`wxBriefing` read downstream — that's a real design decision belonging to the Appendix A brainstorm, not a mechanical fix.

**New discovery, also NOT touched by this task, flagged for a separate follow-up:** re-verifying this file against `main` surfaced a third call site with the identical bypass pattern — `_showUploadModal()` (confirmed at line 2281, its own direct `await app._applyPlan(plan)` at line 2339, no original review finding ever named it). It loads a route from an uploaded `.json`/`.fpl`/`.gpx` file and, unlike `doSave()`, doesn't even do the redundant localStorage pre-write — structurally it looks like an equally strong candidate for the same `applyRouteEdit` swap this task applies to the plan picker, but it hasn't had the same "is this actually safe" verification pass the plan-picker site got, so it's not included here. Worth a quick follow-up, not a reason to hold this task.

**Files:**
- Modify: `web/cockpit/route-table.js` (plan-picker item click handler only)
- Test: `tests/cockpit/route-table-plan-picker.test.js` (new)

**Interfaces:** N/A — standalone fix, consumes the existing `app.applyRouteEdit()` (already covered by `tests/cockpit/app-route-edit-queue.test.js`, unchanged by this task).

- [ ] **Step 1: Write the failing test**

Create `tests/cockpit/route-table-plan-picker.test.js` — a source-pinning test in the same style as Task 12's, since fully mounting the plan-picker overlay's DOM (built from a localStorage-read plans list) is disproportionate to what this fix needs to prove:

```javascript
/**
 * route-table.js's plan picker wrote localStorage['flypi_active_plan'] directly
 * and called app._applyPlan(plan) directly, bypassing applyRouteEdit()'s
 * latest-wins queue (app.js's _pendingPlanEdit mechanism, #74). Confirmed safe
 * to redirect: the same full plan object reaches _applyPlan either way, so no
 * field is lost — unlike doSave() a few hundred lines away, which is NOT
 * touched by this fix (see Task 16 / Appendix A in the plan doc).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const ROUTE_TABLE_SRC = readFileSync('web/cockpit/route-table.js', 'utf8');

describe('_showPlanPicker loads through applyRouteEdit, not a direct write (Finding 5 partial)', () => {
    // Anchor on the *selector string* `.plan-picker-item` (with the leading dot, as
    // used in `querySelectorAll('.plan-picker-item')`), not the bare class name —
    // the bare name also matches earlier in this file inside the button template's
    // `class="plan-picker-item"`, which would anchor the slice hundreds of
    // characters too early and miss the applyRouteEdit call entirely.
    it('the plan-picker item handler calls app.applyRouteEdit', () => {
        const pickerIdx = ROUTE_TABLE_SRC.indexOf('.plan-picker-item');
        const handlerBlock = ROUTE_TABLE_SRC.slice(pickerIdx, pickerIdx + 800);
        expect(handlerBlock).toMatch(/app\.applyRouteEdit\(/);
    });

    it('the plan-picker item handler no longer writes flypi_active_plan directly', () => {
        const pickerIdx = ROUTE_TABLE_SRC.indexOf('.plan-picker-item');
        const handlerBlock = ROUTE_TABLE_SRC.slice(pickerIdx, pickerIdx + 800);
        expect(handlerBlock).not.toMatch(/localStorage\.setItem\(\s*['"]flypi_active_plan['"]/);
    });

    it('doSave() is untouched by this fix — still its own bare-bones write (Appendix A, not this task)', () => {
        const saveIdx = ROUTE_TABLE_SRC.indexOf('const doSave');
        // Window sized generously (measured 1189 chars between the doSave closure and
        // its localStorage.setItem in the version this was checked against — 1500
        // leaves real headroom) — do not shrink without re-measuring the actual gap.
        const saveBlock = ROUTE_TABLE_SRC.slice(saveIdx, saveIdx + 1500);
        expect(saveBlock).toMatch(/localStorage\.setItem\(\s*['"]flypi_active_plan['"]/);
    });
});
```

- [ ] **Step 2: Run the test to confirm the first two fail**

```bash
cd /home/dananickerson/flytab
npx vitest run tests/cockpit/route-table-plan-picker.test.js
```

Expected: test 1 fails (no `applyRouteEdit` call yet), test 2 fails (the direct `localStorage.setItem` is still there), test 3 passes already (confirms the baseline understanding of `doSave()` before this task touches anything).

- [ ] **Step 3: Fix the plan-picker item handler**

Confirmed current content, `route-table.js` starting at line 2259 (`.plan-picker-item` forEach) — **note the write/remove order**: `localStorage.setItem` runs *before* `overlay.remove()` in the real current code, not after:

```diff
         // Plan items — load from localStorage by index
         overlay.querySelectorAll('.plan-picker-item').forEach(btn => {
             wireTap(btn, async () => {
                 try {
                     const idx = parseInt(btn.dataset.idx);
                     const plan = plans[idx];
                     if (plan) {
-                        localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
                         overlay.remove();
-                        if (typeof app !== 'undefined' && app._applyPlan) {
-                            await app._applyPlan(plan);
+                        if (typeof app !== 'undefined' && app.applyRouteEdit) {
+                            await app.applyRouteEdit(plan);
                             app.showToast('Plan loaded');
                         }
                     }
                 } catch (err) {
                     console.warn('Failed to load plan:', err);
                 }
             });
         });
```

This is safe because `_applyPlan` still receives the exact same `plan` object either way — `applyRouteEdit` just adds the latest-wins queue in front of it. One behavior change, strictly more correct: if `_applyPlan` throws before reaching its own `localStorage.setItem` (inside `app.js`'s `_applyPlan`), `localStorage` now keeps the previous active plan instead of a half-applied new one, since the redundant direct write here is gone.

Before applying, re-run `grep -n "plan-picker-item\|_applyPlan(plan)" web/cockpit/route-table.js` and diff the surrounding lines against the block above — this section was already found to have shifted once between when this plan was drafted and when it was branched; confirm it hasn't shifted again since.

- [ ] **Step 4: Run the test again, then the full suite**

```bash
npx vitest run tests/cockpit/route-table-plan-picker.test.js
npm test
```

Expected: all three tests pass now. Pay attention to any test that exercises the plan picker end-to-end (search `tests/` for `plan-picker` or `_showPlanPicker` beyond the new file) to confirm nothing relied on the old direct-write timing.

- [ ] **Step 5: Commit**

```bash
git add web/cockpit/route-table.js tests/cockpit/route-table-plan-picker.test.js
git commit -m "$(cat <<'EOF'
fix(route-table): load the plan picker through applyRouteEdit, not directly

_showPlanPicker's item-click handler wrote localStorage['flypi_active_plan']
directly and called app._applyPlan(plan) directly, bypassing
applyRouteEdit()'s latest-wins queue (#74) and doing a redundant write that
_applyPlan's own write clobbers moments later anyway.

Safe because the same full plan object reaches _applyPlan either way — no
field is lost. doSave() (a separate call site ~100 lines away) is
deliberately NOT touched here: it builds a bare-bones plan object that
would, for the first time, destructively replace app._currentTrip instead
of merging into it, dropping fields other panels read downstream — that
needs a real design decision, not a mechanical redirect. See Appendix A
in docs/superpowers/plans/2026-08-09-code-review-fixes.md.

Finding 5 (partial).
EOF
)"
```

---

## Task 17: Build, deploy & verify Phase 3

**Files:**
- Modify: `web/app.js` (version bump)

- [ ] **Step 1: Bump `FLYTAB_VERSION`** in `web/app.js` (one minor version above wherever Phase 2 left it).

- [ ] **Step 2: Build**

```bash
cd /home/dananickerson/flytab
bash build.sh
```

- [ ] **Step 3: Full test suite**

```bash
npm test
```

- [ ] **Step 4: On-device smoke check**

Install the APK. Confirm: touch targets visibly larger but no layout breakage (Task 14); loading a saved plan from the plan picker still works end-to-end, including a rapid double-tap on two different saved plans to sanity-check the queue is actually engaged (Task 16); emergency glide screen still renders position correctly (Task 15); Convective layer still initializes normally (Task 12, no behavior change expected — just confirm no new console error).

---

# Appendix A — Deferred: needs its own design pass, not a bite-sized fix

These two items are real, confirmed structural problems — but cramming an architectural redesign into bite-sized TDD tasks off the back of a code review would produce a worse design than giving them their own brainstorming session. Do not implement either from this document; use `superpowers:brainstorming` first.

**Finding 5, full scope — no canonical trip object.** `app._currentTrip`, `ActiveRoute` (a separate in-memory active-waypoint tracker, confirmed at `web/shared/active-route.js`), and `localStorage['flypi_active_plan']` are three different representations of "the current plan," written from four sites with genuinely different shapes (confirmed during verification), reconciled only by a partial latest-wins queue (`app.js`'s `_pendingPlanEdit`, which Task 16 above routes one more call site through) and a "#74 drift check" that — confirmed during verification — compares an unrelated pill-count/waypoint-count pair, not the actual shape divergence between the four write sites. There is effectively no reconciliation today beyond simple last-write-wins. This is comparable in scope to the `FuelState` facade that already exists for the fuel-quantity path — the trip path needs the same treatment, but the shape of that facade (what it owns, what `doSave()`'s bare-bones save should merge into vs. replace, whether `ActiveRoute` folds into it) is a design question, not a refactor with an obvious mechanical answer.

**Finding 9, full scope — composition root.** `app.js`'s `_initCockpit()` is a 542-line method (confirmed) hand-wiring ~46 module instantiations behind 45 `typeof X !== 'undefined'` guards with positional-ordering comments ("must be after fisbNexrad", "must init before EngineML"). Task 12 above fixes the one asymmetric unguarded case; the underlying pattern — a single giant method where init order is load-bearing and encoded only in comments — is a real design smell but changing it (a dependency-injection container, explicit phase ordering, whatever the brainstorm lands on) touches the boot sequence of the entire app and needs its own risk assessment, not a task buried in a review-fix plan.

# Appendix B — Backlog, not actioned in this plan

From the original review's Finding 13 grab-bag, confirmed real but intentionally not fixed here (raise separately if they become load-bearing):

- **(b)** Duplicated IDB schema code between `idb-plan.js` and `idb-profile.js` (both hand-roll identical `DB_NAME='flytab-plans'`/`onupgradeneeded`/`createObjectStore` boilerplate).
- **(c)** `flywhere-weather.js` adapter is a stub — every method throws `WeatherUnavailable` until a real endpoint exists. Relevant context: only FIS-B weather works in the planning tier today, consistent with this repo's no-internet-in-flight constraint.
- **(d)** Four hand-maintained copies of fuel constants, kept in sync only by `tests/planning/fuel-constants-sync.test.js` string-scanning source files rather than a single source of truth.
- **(f)** No central event-contract doc — `dispatchEvent`/`CustomEvent` contracts live in per-file header comments and plan docs across 9+ shared files.

Also not part of this plan: `docs/superpowers/specs/2026-05-04-route-planner-best-practices-comparison.md:21` incorrectly describes `WeatherClient.fetchAllForRoute()` (deleted by Task 6) as live, current behavior — someone should correct that spec doc.

# Appendix C — Confirmed non-issues from the original review

- **Finding 13(e), `thermalMonitor._updateWarning` monkey-patch (`app.js:1404-1405`)**: verified not broken. `_poll()` calls `this._updateWarning(data)` — a dynamic property lookup, not a cached function reference — so every poll tick picks up the patched version, including the first one (the patch runs synchronously right after `.start()`, no `await` in between, so there's no race where the timer could fire before the patch lands). This is a working wrap-and-call-through pattern, not a latent bug. No fix planned; revisit only if a concrete failure shows up.
- **Path traversal on `/api/upload`**: the original review didn't explicitly rule this in or out; verification confirmed `os.path.basename(filename)` already strips directory components, so classic `../../` traversal is blocked. Task 4 fixes the sharper risk that remains (unauthenticated same-directory overwrite, including of `engine_monitor.py` itself).
- **`--touch-min`/`--touch-preferred` "relying on an inline fallback"**: verification found they're fully defined in the live `:root` block (not falling back to anything) — just defined at the wrong (too-small) value. Task 14 fixes the actual value, not a missing definition.
- **`fuel-overlay.js`/`engine-page.js` IP hardcodes as a `Settings.stratuxIp` bypass**: verification found these two target the Pi engine-monitor, not Stratux — a different bug (Task 9) from the genuine `Settings.stratuxIp` bypasses in `network-mode.js`/`device-status.js` (Task 8).
