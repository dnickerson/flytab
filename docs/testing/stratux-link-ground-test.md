# Stratux link — ground test (PR #150, v10.78+)

Verifies the fix for "FlyTab doesn't use Stratux data until the app is restarted"
(2026-10-02) and the reconnect/health-check changes that came with it. Desk
review and unit tests cannot cover these — they need the real tablet, real
Stratux, real Android.

Run it on the ramp with the Stratux powered and a GPS fix (Stratux status page:
"3D GPS"). Allow ~45 min. **If T1 fails, stop and send the logs.**

## Where the evidence comes from

| Source | How | Survives restart? |
|---|---|---|
| In-app diag log (full) | Long-press the **version badge** (top right, e.g. `v10.78`) ~1 s | Yes (last 200 entries) |
| In-app diag log (last 10 GPS/Stratux) | Tap the **GPS badge** | Yes |
| Native socket log | `adb logcat` (below) | No — keep it running |

Screenshot the diag log after each test. Times in the log are UTC (Z).

## Prep

1. Install the build (check that the version badge then reads **v10.78** or higher):
   ```bash
   ~/Android/Sdk/platform-tools/adb install -r ~/flytab/flytab-debug-v10.78.apk
   ```
   This APK does **not** include the uncommitted work on `main` (airport popup,
   wind compass, styles) — expected for this test.
2. ADB while the tablet is on Stratux WiFi: use a **USB cable**, or join the
   laptop to the Stratux WiFi too (the home-network wireless pairing won't reach it).
3. Start the native log capture and leave it running for the whole session:
   ```bash
   ~/Android/Sdk/platform-tools/adb logcat -v time -s StratuxWS StratuxUDP > ~/stratux-ground-$(date +%Y%m%d-%H%M).log
   ```
4. In Android Settings → Wi-Fi → Stratux network: make sure the tablet stays on
   it even though it has no internet (turn off any "switch to better network" /
   "auto switch to mobile data" option, and answer "stay connected" if asked).

## Strings to look for

**Good** (diag log):
- `[stratux] Connecting to Stratux at 192.168.10.1 (sim=false, udp=true)`
- `GDL 90 UDP listening on :4000`
- `Traffic WS connected`
- `First situation: fix=… sats=…`
- `[net] Network mode: flight`

**Good** (logcat): `StratuxWS: situation WS opened`, `StratuxUDP: first datagram from /192.168.10.1`

**Bad — note the time, screenshot, keep going unless it's T1:**
- `client_close` that you didn't cause — **the original bug**
- `Situation WS closed code=1006` repeating about every 60 s, or logcat
  `situation WS failure: sent ping but didn't receive pong` — the no-ping fix didn't take
- `Link down:` or `stuck connecting` while Stratux is up and in range
- Network badge showing **OFFL** while on Stratux WiFi

**Informational** (expected only in the tests that cause them):
- `Situation WS silent …ms — link dead, reconnecting all channels` (T5)
- `Watchdog: JS was suspended ~Ns` (T3/T4 — tells us Android does freeze the app's JS; record whether it appears)

## Tests

### T1 — Cold start (the original bug)
1. Force-stop FlyTab (Settings → Apps → FlyTab → Force stop).
2. Tablet on Stratux WiFi. Launch FlyTab. Don't touch it.
3. **Pass:** within ~10 s ownship appears and the GPS badge goes green (`STX …`);
   network badge reads **FLT**. Then leave it for **10 minutes**: ownship stays
   live the whole time, and the diag log shows **no** `client_close` and **no**
   `Situation WS closed` entries.
4. Record: time to first ownship ____ s · badge ____ · any bad strings ____

### T2 — Traffic and FIS-B present
1. Stay in T1's session. Look for ADS-B traffic targets on the map (the Stratux
   page showed ~8000 1090ES msgs/s) and for the FIS-B badge if a UAT tower is in range.
2. **Pass:** traffic targets appear and move.

### T3 — Background and return
1. Press Home, open Chrome (as you did when the bug happened), stay **2 minutes**.
2. Return to FlyTab.
3. **Pass:** ownship is live within ~2 s; it does not blink off or show the
   device-GPS fallback; no `Link down:` right after the return.
4. Record: did `Watchdog: JS was suspended` appear? Y / N

### T4 — Screen off and on
1. Screen off **2 minutes**, then on.
2. **Pass:** same as T3. Record whether `Watchdog: JS was suspended` appeared.

### T5 — Stratux reboot (power-cycle Stratux)
1. With FlyTab running, cut Stratux power for ~10 s, then restore it.
2. **Expect:** within ~5–6 s ownship hides/dims and
   `Situation WS silent … reconnecting all channels` appears; the GPS falls back
   to the tablet's GPS.
3. **Pass:** once Stratux has booted (~1–2 min), position **and traffic** return
   **without restarting FlyTab**, traffic within ~10 s of position.
4. Record: Stratux power-on → ownship back ____ s · → traffic back ____ s

### T6 — Tablet WiFi off and on
1. Turn the tablet's WiFi **off for 60 s**.
2. **Expect:** ownship goes stale within ~6 s; network badge leaves FLT after 30–45 s.
3. Turn WiFi back on and confirm it rejoins the **Stratux** network.
4. **Pass:** data returns **without restarting FlyTab**, within ~45 s of the
   WiFi reconnecting (retries back off to 30 s at most).
5. Record: WiFi on → ownship back ____ s

### T7 — Engine data (if the engine monitor Pi is running)
1. Open the ENG page during T1, and again after T5 and T6.
2. **Pass:** engine values are live each time, with no app restart.

### T8 — Away from Stratux (home WiFi)
1. On home WiFi, force-stop and launch FlyTab.
2. **Pass:** network badge **HOME** (or **NET**); the app falls back to the
   tablet's GPS after ~5 s; nothing hangs or crashes.

## Send back

- The logcat file from Prep step 3
- Diag-log screenshots after each test (long-press the version badge)
- The recorded times and Y/N answers above, plus any FAIL with its time
