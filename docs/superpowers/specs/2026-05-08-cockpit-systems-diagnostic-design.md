# Cockpit Systems Diagnostic Design

## Goal

Provide the pilot with a clear, actionable health check of every in-cockpit data source — Stratux, engine monitor, GPS, and FIS-B weather — delivered inline in the Before Start checklist. When something is wrong, tell the pilot what it is and what to do about it.

## Background / What Went Wrong

On a test flight, Stratux traffic and FIS-B weather were silent. Engine data worked fine. Root cause discovered post-landing: `stratux_ip` in localStorage was null. Some code paths fell back silently to the hardcoded default `192.168.10.1` but others did not, so Stratux never connected and the pilot had no indication anything was wrong during the flight.

Engine data worked because `EngineClient` is instantiated with `new EngineClient()` — no arguments — so it always connects to the hardcoded default `192.168.10.1:8082` regardless of Settings. This is a latent bug: if the Pi ever moves to a different IP there is no Settings value to change.

The diagnostic must catch a null or cleared `stratux_ip` before the pilot leaves the ramp.

## What We Are Building

1. **`SystemsMonitor`** — a new passive aggregator in `web/shared/systems-monitor.js`. Listens to existing client events, inspects Settings at startup, and maintains a live status map. Replaces the scattered polling in `_startDeviceStatusMonitor()`.

2. **Checklist integration** — a `"type": "systems_check"` item in `checklist.json` Before Start section. The checklist panel renders it as a live status table rather than a checkbox.

3. **Engine client IP fix** — `EngineClient` constructor reads `Settings.piIp` instead of hardcoding `192.168.10.1`. Both `Settings.DEFAULTS.pi_ip` and the existing hardcoded IP remain `192.168.10.1`, so behaviour is unchanged unless the pilot changes Settings.

## Simplifications Made Along the Way

The existing code has duplicated connection-monitoring logic scattered across three files. This feature consolidates them.

| Existing | Replaced by |
|---|---|
| `_startDeviceStatusMonitor()` in `app.js` — 5s polling loop reading from 3 clients | SystemsMonitor event-driven status, updated on client events |
| Long-press DiagLog overlay "summary section" — manual string construction reading raw client state | Reads `SystemsMonitor.getStatus()` |
| GPS diagnostic panel source-state string — duplicates what GpsSource already exposes | Reads `SystemsMonitor.getStatus().gps` |

The 5s polling timer in `_startDeviceStatusMonitor` is deleted. Status badge updates that currently read from clients directly are wired to `'systems:changed'` events instead.

## Architecture

```
app.js (startup)
  ├── new SystemsMonitor(stratuxClient, engineClient, gpsSource, fisbClient)
  └── systemsMonitor.start()           ← attaches event listeners, inspects Settings

SystemsMonitor (web/shared/systems-monitor.js)
  ├── listens: stratux:connect, stratux:disconnect, stratux:stale
  ├── listens: engine:connect, engine:disconnect, engine:stale
  ├── listens: gpssource:changed
  ├── listens: fisb:metar, fisb:winds  ← FIS-B weather frame arrival
  ├── inspects: Settings.stratuxIp, Settings.piIp on start
  ├── emits: 'systems:changed' on every state transition
  └── getStatus() → { stratux, engine, gps, weather }

checklist.js (web/cockpit/checklist.js)
  ├── detects item type === 'systems_check'
  └── renders live status table from systemsMonitor.getStatus()

checklist.json Before Start section
  └── { "title": "Systems Check", "type": "systems_check" }  ← new item

EngineClient (web/shared/engine-client.js)
  └── constructor(ip = Settings.piIp ?? '192.168.10.1', port = 8082)  ← fix
```

## SystemsMonitor Detail

### Status shape

```javascript
// getStatus() returns:
{
  stratux: { status: 'ok'|'degraded'|'unknown', cause: string|null, suggestions: string[] },
  engine:  { status: 'ok'|'degraded'|'unknown', cause: string|null, suggestions: string[] },
  gps:     { status: 'ok'|'degraded'|'unknown', cause: string|null, suggestions: string[] },
  weather: { status: 'ok'|'degraded'|'unknown', cause: string|null, suggestions: string[] },
}
```

`'unknown'` = not enough time has elapsed to conclude anything (first 10s after start).  
`'ok'` = source confirmed healthy.  
`'degraded'` = source confirmed unhealthy, cause and suggestions populated.

### Stratux checks (evaluated in order)

1. `Settings.stratuxIp` is null → **degraded** · **cause:** "Stratux IP was cleared from Settings" · **suggestions:** ["Open Settings and verify Stratux IP is set to 192.168.10.1."]
2. 15s elapsed, WebSocket never opened → **degraded** · **cause:** "Stratux not reachable at {ip}" · **suggestions:** ["Disable ExpressVPN and Tailscale — both can block Stratux.", "Verify tablet WiFi is connected to the Stratux network.", "Check Stratux has power — blue and green LEDs."]
3. WebSocket open but no situation data after 30s → **degraded** · **cause:** "Stratux connected — waiting for GPS lock" · **suggestions:** ["Normal on first power-up. Wait 2–3 minutes outdoors."]
4. Connected and situation arriving → **ok**

### Engine checks (evaluated in order)

1. 15s elapsed, WebSocket never opened and HTTP fallback also failing → **degraded** · **cause:** "Engine monitor not reachable at {ip}:8082" · **suggestions:** ["Check Pi is powered.", "Disable ExpressVPN or Tailscale — port 8082 may be blocked."]
2. HTTP fallback active (WS failed 3×, polling HTTP) → **degraded** · **cause:** "Engine monitor in HTTP fallback mode" · **suggestions:** ["Engine data is available but WebSocket is down.", "Check Pi network stability or restart engine monitor."]
3. Data flowing (WS or HTTP) → **ok**

### GPS checks (evaluated in order)

1. Configured source is `'stratux'` or `'auto'` and Stratux is degraded → **degraded** · **cause:** "GPS source is Stratux — unavailable until Stratux connects" · **suggestions:** ["Fix Stratux first, or switch GPS source to Internal in Settings."]
2. Source is `'internal'`, no fix after 30s → **degraded** · **cause:** "Device GPS has not acquired a fix" · **suggestions:** ["Move to open sky.", "GPS lock may take 1–2 minutes."]
3. Fix received → **ok**

### FIS-B weather checks (evaluated in order)

FIS-B weather is delivered via Stratux only. There is no internet weather check.

1. Stratux is degraded → **degraded** · **cause:** "FIS-B weather requires Stratux connection" · **suggestions:** ["Fix Stratux connection first."]
2. Stratux connected, `deviceStatus.UAT_Towers === 0` after 60s → **degraded** · **cause:** "No UAT towers in range" · **suggestions:** ["FIS-B requires UAT ground stations.", "Check Stratux UAT receiver — yellow LED should be lit.", "Weather will become available as you approach an airport."]
3. Stratux connected and at least one `fisb:metar` or `fisb:winds` event received → **ok**
4. Stratux connected, towers > 0, no frames yet → **unknown** (still settling)

### Event emission

Every time any status field changes, emit `'systems:changed'` on `document` with `detail: getStatus()`. Consumers (status bar, DiagLog overlay) update from this event rather than polling.

## Checklist Item Rendering

The item `{ "title": "Systems Check", "type": "systems_check" }` is placed after the "Tailscale" item in the Before Start section.

Healthy display:

```
Systems Check
  ● Stratux      Traffic and ADS-B — OK
  ● Engine       Engine monitor — OK
  ● GPS          Stratux GPS, fix acquired — OK
  ● FIS-B Wx     Weather frames received — OK
  All systems nominal
```

Degraded display (example — the scenario that triggered this feature):

```
Systems Check
  ● Stratux      IP was cleared from Settings
                 · Open Settings and verify Stratux IP is set to 192.168.10.1.
  ● Engine       OK
  ● GPS          GPS source is Stratux — unavailable until Stratux connects
                 · Fix Stratux first, or switch GPS source to Internal.
  ● FIS-B Wx     FIS-B weather requires Stratux connection
                 · Fix Stratux connection first.
  3 issues — review before departure
```

Dot colours: green = ok, amber = unknown/settling, red = degraded. Text weight 600, no mid-tone greys. Suggestions always visible — no expand tap required. Item is informational, not blocking.

## Files Changed

| File | Change |
|---|---|
| `web/shared/systems-monitor.js` | New file |
| `web/shared/engine-client.js` | Constructor reads `Settings.piIp ?? '192.168.10.1'` |
| `web/shared/settings.js` | `Settings.piIp` getter already exists — no change needed |
| `web/cockpit/checklist.js` | Render `systems_check` item type; accept `systemsMonitor` in constructor |
| `web/checklist.json` | Add Systems Check item to Before Start after "Tailscale" |
| `web/app.js` | Instantiate SystemsMonitor; replace `_startDeviceStatusMonitor` polling with `systems:changed` event; pass monitor to checklist; feed DiagLog overlay summary from `getStatus()` |
| `web/index.html` | Add `<script>` tag for `systems-monitor.js` before cockpit components |

## Interface Contracts

**SystemsMonitor constructor:** `new SystemsMonitor(stratuxClient, engineClient, gpsSource, fisbClient)`  
— reads `Settings` directly (no Settings parameter).  
— `fisbClient` may be null if FisbClient failed to load; weather status stays `'unknown'` in that case.

**`getStatus()` return fields used by checklist:**
- `status`: `'ok' | 'degraded' | 'unknown'` — drives dot colour
- `cause`: one-line string or null — shown on same line as source name
- `suggestions`: string[] — shown as indented bullet lines below cause

**`'systems:changed'` event:** fired on `document`, `detail` = `getStatus()` return value.

**Trigger conditions:**
- Status → `'ok'` on: connect event received, fix received, FIS-B frame received
- Status → `'degraded'` on: 15s timeout with no connect, stale event, null IP detected at start
- Status stays `'unknown'` for first 10s after `start()` to avoid false alarms during normal boot

## What Is Not In Scope

- Internet weather (METAR/TAF/winds from AWC) — in-cockpit weather is FIS-B only
- Home / dual-mode WiFi scenarios
- Continuous in-flight re-alerting when sources degrade mid-flight
- NOTAM or chart data source health
