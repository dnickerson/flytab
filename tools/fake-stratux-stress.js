#!/usr/bin/env node
// Fake Stratux for stress-testing the silent-WS-death bug.
// Pumps realistic /traffic JSON at a configurable rate, /situation at 10Hz,
// responds to /getStatus, /getTowers. Logs every message sent so we can
// compare with what the client claims to have received.
//
// Usage: node fake-stratux-stress.js [--port 80] [--rate 270] [--targets 75] [--duration 1800]
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---- CLI args ----
const args = require('node:util').parseArgs({
  options: {
    port:     { type: 'string', default: process.env.FAKE_PORT || '8080' },
    rate:     { type: 'string', default: '270' },     // traffic msgs/sec
    targets:  { type: 'string', default: '75' },      // distinct aircraft
    duration: { type: 'string', default: '1800' },    // seconds
    logdir:   { type: 'string', default: 'tools' },
  },
}).values;

const PORT     = Number(args.port);
const RATE     = Number(args.rate);
const TARGETS  = Number(args.targets);
const DURATION = Number(args.duration);
const STAMP    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SENT_LOG = path.join(args.logdir, `fake-sent-${STAMP}.csv`);

fs.writeFileSync(SENT_LOG, 'iso,seq,channel,client_id,bytes\n');
let sentSeq = 0;
function logSend(channel, clientId, bytes) {
  sentSeq++;
  fs.appendFileSync(SENT_LOG, `${new Date().toISOString()},${sentSeq},${channel},${clientId},${bytes}\n`);
}

// ---- Synthetic aircraft fleet ----
// Each target gets a stable Icao_addr and a slow random-walk position.
const fleet = [];
for (let i = 0; i < TARGETS; i++) {
  fleet.push({
    Icao_addr: 0xA00000 + i,                          // non-zero, unique
    Tail:      `N${100 + i}AB`,
    Lat:       34.7 + (Math.random() - 0.5) * 2,      // ~spread around KLKR
    Lng:       -81.0 + (Math.random() - 0.5) * 2,
    Alt:       1000 + Math.floor(Math.random() * 35000),
    Track:     Math.floor(Math.random() * 360),
    Speed:     90 + Math.floor(Math.random() * 400),
    Vvel:      0,
    Squawk:    1200,
    OnGround:  false,
    Age:       0,
    ExtrapolatedPosition: false,
    SignalLevel: -10 - Math.random() * 30,
    TargetType:  1,                                    // ADS-B
    Last_seen:   new Date().toISOString(),
  });
}

function tick(target) {
  const dist = (target.Speed / 3600) * 0.05;          // nm in 50ms (rough)
  const rad  = target.Track * Math.PI / 180;
  target.Lat += dist / 60 * Math.cos(rad);
  target.Lng += dist / 60 * Math.sin(rad) / Math.cos(target.Lat * Math.PI / 180);
  target.Alt += target.Vvel * (0.05 / 60);
  target.Last_seen = new Date().toISOString();
}

// ---- HTTP / WS server ----
const trafficClients = new Map();   // id -> ws
const sitClients     = new Map();
let nextClientId = 0;
const startMs    = Date.now();

let totalSent = { traffic: 0, situation: 0 };

const server = http.createServer((req, res) => {
  if (req.url === '/getStatus') {
    const status = {
      Version: 'fake-stress-v1',
      Devices: 2,
      Connected_Users: trafficClients.size + sitClients.size,
      ES_messages_last_minute: Math.min(60 * RATE, totalSent.traffic),
      ES_messages_max:         60 * RATE,
      UAT_messages_last_minute: 0,
      ES_traffic_targets_tracking: TARGETS,
      GPS_satellites_locked: 12,
      GPS_satellites_seen:   14,
      GPS_solution: '3D GPS',
      Uptime: Date.now() - startMs,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }
  if (req.url === '/getTowers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  res.writeHead(404).end();
});

const wssTraffic = new WebSocketServer({ noServer: true });
const wssSit     = new WebSocketServer({ noServer: true });
const wssNoop    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/traffic') {
    wssTraffic.handleUpgrade(req, socket, head, ws => {
      const id = ++nextClientId;
      trafficClients.set(id, ws);
      console.log(`[${tElapsed()}s] traffic client #${id} connected (total=${trafficClients.size})`);
      ws.on('close', (code, reason) => {
        trafficClients.delete(id);
        console.log(`[${tElapsed()}s] traffic client #${id} closed code=${code} reason="${reason}"`);
      });
    });
  } else if (req.url === '/situation') {
    wssSit.handleUpgrade(req, socket, head, ws => {
      const id = ++nextClientId;
      sitClients.set(id, ws);
      console.log(`[${tElapsed()}s] sit client #${id} connected`);
      ws.on('close', () => sitClients.delete(id));
    });
  } else if (req.url === '/weather' || req.url === '/jsonio') {
    // Accept and idle so client doesn't reconnect-loop
    wssNoop.handleUpgrade(req, socket, head, () => {});
  } else {
    socket.destroy();
  }
});

function tElapsed() { return ((Date.now() - startMs) / 1000).toFixed(1); }

// ---- Traffic pump ----
// Send `RATE` /traffic messages per second across the fleet, round-robin.
let fleetIdx = 0;
const intervalMs  = Math.max(1, Math.floor(1000 / RATE));
const burstPerTick = Math.max(1, Math.round(RATE * intervalMs / 1000));

setInterval(() => {
  for (let i = 0; i < burstPerTick; i++) {
    const target = fleet[fleetIdx % fleet.length];
    fleetIdx++;
    tick(target);
    const json = JSON.stringify(target);
    for (const [id, ws] of trafficClients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(json);
        logSend('traffic', id, json.length);
        totalSent.traffic++;
      }
    }
  }
}, intervalMs);

// ---- Situation pump @ 10 Hz ----
setInterval(() => {
  const msg = {
    GPSLatitude: 34.717625,
    GPSLongitude: -80.86113,
    GPSAltitudeMSL: 525.5 + Math.sin(Date.now() / 5000) * 5,
    BaroPressureAltitude: 530.0,
    GPSGroundSpeed: 0.3,
    GPSTrueCourse: 262,
    GPSVerticalSpeed: 0,
    GPSFixQuality: 2,
    GPSSatellites: 12,
    GPSSatellitesSeen: 14,
    AHRSPitch: 0, AHRSRoll: 0, AHRSGLoad: 1,
  };
  const json = JSON.stringify(msg);
  for (const [id, ws] of sitClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
      logSend('situation', id, json.length);
      totalSent.situation++;
    }
  }
}, 100);

// ---- Console summary every 30s ----
setInterval(() => {
  console.log(`[${tElapsed()}s] sent traffic=${totalSent.traffic} sit=${totalSent.situation} clients t=${trafficClients.size} s=${sitClients.size}`);
}, 30000);

// ---- Auto-stop ----
setTimeout(() => {
  console.log(`[${tElapsed()}s] shutdown — total sent: traffic=${totalSent.traffic} sit=${totalSent.situation}`);
  for (const ws of trafficClients.values()) try { ws.close(); } catch {}
  for (const ws of sitClients.values())     try { ws.close(); } catch {}
  server.close(() => process.exit(0));
}, DURATION * 1000);

server.listen(PORT, () => {
  console.log(`fake-stratux-stress on :${PORT} rate=${RATE}msg/s targets=${TARGETS} duration=${DURATION}s`);
  console.log(`sent log → ${SENT_LOG}`);
});
