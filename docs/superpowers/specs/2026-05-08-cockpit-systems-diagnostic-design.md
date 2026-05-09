# Cockpit Systems Diagnostic Design

## Goal

Provide the pilot with a clear, actionable health check of every data source — Stratux, engine monitor, GPS, and internet weather — delivered inline in the Before Start checklist. When something is wrong, tell the pilot what it is and what to do about it.

## Background / What Went Wrong

On a test flight, Stratux traffic and weather were silent. Engine data worked. Root cause discovered post-landing: `stratux_ip` in localStorage had been cleared (likely by ExpressVPN or Tailscale resetting app storage). The app fell back silently to the hardcoded default `192.168.10.1` — the correct Stratux IP — so the IP itself wasn't the failure. The VPN was. But the pilot had no way to know this without inspecting DiagLog after landing.

Engine data worked because `EngineClient` is instantiated with `new EngineClient()` — no arguments — so it always connects to the hardcoded default `192.168.10.1:8082` regardless of Settings. This is a latent bug: if the Pi ever moves to a different IP, there is no Settings value to change.

## What We Are Building

1. **`SystemsMonitor`** — a new passive aggregator in `web/shared/systems-monitor.js`. Listens to existing client events, inspects Settings at startup, and maintains a live status map. Replaces the scattered polling in `_startDeviceStatusMonitor()`.

2. **Checklist integration** — a `"type": "systems_check"` item in `checklist.json` Before Start section. The checklist panel renders it as a live status table rather than a checkbox.

3. **Engine client IP fix** — `EngineClient` constructor reads `Settings.piIp` instead of hardcoding `192.168.10.1`. Both `Settings.DEFAULTS.pi_ip` and the existing hardcoded IP remain `192.168.10.1`, so behaviour is unchanged unless the pilot changes Settings.

## Simplifications Made Along the Way

The existing code has duplicated connection-monitoring logic across three files. This feature consolidates them.

| Existing | Replaced by |
|---|---|
| `_startDeviceStatusMonitor()` in `app.js` — 5s polling loop reading from 3 clients | SystemsMonitor event-driven status, updated on client events |
| Long-press DiagLog overlay "summary section" — manual string construction reading raw client state | Reads `SystemsMonitor.getStatus()` |
| GPS diagnostic panel source-state string — duplicates what GpsSource already exposes | Reads `SystemsMonitor.getStatus().gps` |

The 5s polling timer in `_startDeviceStatusMonitor` is deleted. Status badge updates that currently read from clients directly are wired to `'systems:changed'` events instead.

## Architecture

```
app.js (startup)
  ├── new SystemsMonitor(stratuxClient, engineClient, gpsSource, settings)
  └── systemsMonitor.start()           ← attaches event listeners, inspects Settings

SystemsMonitor (web/shared/systems-monitor.js)
  ├── listens: stratux:connect, stratux:disconnect, stratux:stale
  ├── listens: engine:connect, engine:disconnect, engine:stale
  ├── listens: gpssource:changed
  ├── inspects: Settings.stratuxIp, Settings.piIp, Settings.workerBase on start
  ├── probes: one fetch to Settings.workerBase on start (weather reachability)
  ├── emits: 'systems:changed' on every state transition
  └── getStatus() → { stratux, engine, gps, weather }

ChecklistPanel (web/cockpit/checklist.js)
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

### Stratux checks (in order)

1. `Settings.stratuxIp` is null → **cause:** "Stratux IP was cleared from Settings" → **suggestions:** ["Restored to default 192.168.10.1. Verify this is correct in Settings."]
2. 15 seconds elapsed, WebSocket never opened → **cause:** "Stratux unreachable at {ip}" → **suggestions:** ["Disable ExpressVPN and Tailscale — both can block Stratux.", "Verify WiFi is connected to the Stratux network.", "Check Stratux has power — blue and green LEDs."]
3. WebSocket open but no situation data for 30s → **cause:** "Stratux connected but GPS not locked" → **suggestions:** ["Wait 2–3 minutes outdoors for GPS lock."]
4. Connected and situation arriving → **ok**

### Engine checks

1. `Settings.piIp` differs from `192.168.10.1` after fix → **cause:** "Pi IP in Settings ({piIp}) does not match engine client default" → **suggestions:** ["Update Settings.piIp to {piIp} or verify Pi address."] — *this check becomes a no-op once EngineClient reads Settings.piIp*
2. 15 seconds elapsed, WebSocket never opened and HTTP fallback also failing → **cause:** "Engine monitor not reachable at {ip}:8082" → **suggestions:** ["Check Pi is powered.", "Disable ExpressVPN or Tailscale — port 8082 may be blocked."]
3. HTTP fallback active (WS failed 3x, polling) → **degraded** with **cause:** "Engine monitor WebSocket degraded — using HTTP fallback" → **suggestions:** ["Check Pi network stability.", "Consider restarting engine monitor."]
4. Data flowing (WS or HTTP) → **ok**

### GPS checks

1. Configured source is `'stratux'` or `'auto'`, but Stratux is degraded → **cause:** "GPS depends on Stratux (currently unavailable)" → **suggestions:** ["Fix Stratux connection first, or switch GPS source to Internal in Settings."]
2. Source is `'internal'`, no fix received after 30s → **cause:** "Device GPS has not acquired a fix" → **suggestions:** ["Move to open sky.", "GPS may take 1–2 minutes after app start."]
3. Fix received (internal or Stratux) → **ok**

### Weather checks

One fetch probe to `Settings.workerBase + '/health'` (or any AWC-proxied endpoint) on startup:
1. Fetch fails or times out in 10s → **degraded** with **cause:** "Internet weather (METAR/TAF/winds) unavailable — no network" → **suggestions:** ["Check cellular or WiFi internet.", "FIS-B weather from Stratux still works in-flight."]
2. Fetch succeeds → **ok**

### Event emission

Every time any status field changes, emit `'systems:changed'` on `document` with `detail: getStatus()`. Consumers (status bar, DiagLog overlay) update from this event rather than polling.

## Checklist Item Rendering

The item `{ "title": "Systems Check", "type": "systems_check" }` is placed after the "Tailscale" item in the Before Start section (where VPN items already exist, so context is set).

The checklist panel renders it as:

```
Systems Check
  ● Stratux      Traffic and ADS-B — OK
  ● Engine       Engine monitor — OK
  ● GPS          Stratux GPS, fix acquired — OK
  ● Weather      Internet weather — OK
  All systems nominal
```

When degraded:

```
Systems Check
  ● Stratux      Unreachable at 192.168.10.1
                 · Disable ExpressVPN and Tailscale — both can block Stratux.
                 · Verify WiFi is connected to the Stratux network.
                 · Check Stratux has power — blue and green LEDs.
  ● Engine       OK
  ● GPS          Depends on Stratux (unavailable)
                 · Fix Stratux connection first, or switch GPS source to Internal.
  ● Weather      OK
  2 issues — review before departure
```

Dot colours: green = ok, amber = unknown/settling, red = degraded. Text weight 600, no mid-tone greys. Suggestions are always visible — no expand tap required.

The item is informational, not blocking. Pilot can proceed.

## Files Changed

| File | Change |
|---|---|
| `web/shared/systems-monitor.js` | New file |
| `web/shared/engine-client.js` | Constructor reads `Settings.piIp ?? '192.168.10.1'` |
| `web/shared/settings.js` | `Settings.piIp` getter already exists — no change needed |
| `web/cockpit/checklist.js` | Render `systems_check` item type; accept `systemsMonitor` in constructor |
| `web/checklist.json` | Add Systems Check item to Before Start |
| `web/app.js` | Instantiate SystemsMonitor; replace `_startDeviceStatusMonitor` polling with `systems:changed` event; pass monitor to ChecklistPanel; feed DiagLog overlay summary from `getStatus()` |
| `web/index.html` | Add `<script>` tag for `systems-monitor.js` |

## Interface Contracts

**SystemsMonitor constructor:** `new SystemsMonitor(stratuxClient, engineClient, gpsSource)`  
— reads `Settings` directly; no Settings object parameter needed.

**`getStatus()` return fields used by checklist:**
- `status`: `'ok' | 'degraded' | 'unknown'` — drives dot colour
- `cause`: one-line string or null — shown after source name
- `suggestions`: string[] — shown as bulleted lines below cause

**`'systems:changed'` event:** fired on `document`, `detail` = `getStatus()` return value.

**Trigger conditions:**
- Status transitions to `'ok'` on: client connect event received
- Status transitions to `'degraded'` on: 15s timeout with no connect, or stale event, or fetch probe failure
- Status stays `'unknown'` for first 10s after `start()` to avoid false alarms during normal boot

## What Is Not In Scope

- Continuous in-flight re-notification when sources degrade mid-flight (the `systems:changed` event provides the data; a future feature can act on it)
- Home / dual-mode WiFi scenarios
- NOTAM or chart data source health
