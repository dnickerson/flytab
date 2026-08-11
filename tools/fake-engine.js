#!/usr/bin/env node
// Fake engine monitor — serves WS on :8082 and HTTP on :8080.
// Mimics what the Pi's engine_monitor.py produces, at 5Hz (matches real cadence).
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const WS_PORT   = Number(process.env.ENG_WS_PORT   || 8082);
const HTTP_PORT = Number(process.env.ENG_HTTP_PORT || 8080);
const RATE_HZ   = Number(process.env.ENG_RATE_HZ   || 5);
const DUR       = Number(process.argv[2] || 3600);

const startMs = Date.now();
let nextId = 0;
const wsClients = new Map();

function makeFrame() {
  const t = (Date.now() - startMs) / 1000;
  const rpm = Math.round(2200 + Math.sin(t / 30) * 50);
  const ff  = parseFloat((8.5 + Math.cos(t / 10) * 0.3).toFixed(1));
  const gallons = parseFloat(Math.max(0, 24.9 - t / 3600 * ff).toFixed(1));
  return {
    version:              '3.4.0',
    api_contract:          2,
    capabilities:         ['fuel_tracker', 'sticky_valve', 'peak_egt'],
    capturing:            true,
    serial_connected:     true,
    stratux_connected:    false,
    percent_power:        parseFloat((65 + Math.sin(t / 60) * 3).toFixed(1)),
    rop_lop_percent:      2.5,
    rop_lop_mode:         'RICH',
    sfc:                  0.42,
    gps_altitude:         5000,
    pressure_altitude:    4950,
    ground_speed:         150,
    tas:                  155,
    oat:                  12.0,
    density_altitude:     6200,
    sticky_valve_alert:   null,
    sticky_valve_dismissed: false,
    serial_warning:       null,
    degrees_from_peak:    {},
    peaks_valid:          false,
    manual_altimeter:     null,
    manual_oat:           null,
    fuel:                 null,
    data: {
      RPM:        rpm,
      MP:         parseFloat((24.5 + Math.cos(t / 25) * 0.5).toFixed(1)),
      Oil_Temp:   parseFloat((180 + Math.min(t / 60, 1) * 20).toFixed(1)),
      Oil_Press:  parseFloat((76 + Math.sin(t / 5) * 2).toFixed(1)),
      Fuel_Press: 4.7,
      Volts:      13.7,
      Amps:       34,
      Fuel_Flow:  ff,
      Gallons_Rem: gallons,
      Fuel_L1:    parseFloat((gallons * 0.55).toFixed(1)),
      Fuel_L2:    parseFloat((gallons * 0.45).toFixed(1)),
      EGT1: Math.round(1350 + Math.sin(t / 20) * 30),
      EGT2: Math.round(1320 + Math.sin(t / 22) * 25),
      EGT3: Math.round(1360 + Math.sin(t / 18) * 28),
      EGT4: Math.round(1340 + Math.sin(t / 24) * 22),
      CHT1: Math.round(380 + Math.sin(t / 40) * 10),
      CHT2: Math.round(365 + Math.sin(t / 42) * 8),
      CHT3: Math.round(370 + Math.sin(t / 38) * 9),
      CHT4: Math.round(355 + Math.sin(t / 44) * 7),
    },
  };
}

// ---- HTTP fallback ----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(makeFrame()));
  } else {
    res.writeHead(404).end();
  }
});

// ---- WS pump ----
const wss = new WebSocketServer({ port: WS_PORT });
wss.on('connection', (ws) => {
  const id = ++nextId;
  wsClients.set(id, ws);
  console.log(`[engine] WS client #${id} connected (total=${wsClients.size})`);
  ws.on('close', (c) => { wsClients.delete(id); console.log(`[engine] WS client #${id} closed code=${c}`); });
});

setInterval(() => {
  const json = JSON.stringify(makeFrame());
  for (const ws of wsClients.values()) {
    if (ws.readyState === ws.OPEN) ws.send(json);
  }
}, Math.round(1000 / RATE_HZ));

httpServer.listen(HTTP_PORT, () => {
  console.log(`fake engine: HTTP :${HTTP_PORT}/api/status  WS :${WS_PORT}/  rate=${RATE_HZ}Hz dur=${DUR}s`);
});

setTimeout(() => {
  console.log('[engine] shutdown');
  for (const ws of wsClients.values()) try { ws.close(); } catch {}
  wss.close(); httpServer.close(() => process.exit(0));
}, DUR * 1000);
