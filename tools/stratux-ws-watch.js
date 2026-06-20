#!/usr/bin/env node
// Long-running diagnostic for Stratux WebSocket silent-death.
// Mirrors what FlyTab does: opens /traffic and /situation WS,
// polls /getStatus every 10s, logs everything to CSV.
//
// Goal: determine whether the WS goes silent while readyState stays OPEN,
// while Stratux's own ES message counter keeps climbing.
//
// Usage: node stratux-ws-watch.js [stratux_ip] [duration_seconds]
'use strict';

const fs = require('fs');
const path = require('path');

const HOST   = process.argv[2] || '192.168.1.212';
const DURSEC = Number(process.argv[3] || 3600);
const OUT    = path.join(__dirname, `stratux-watch-${new Date().toISOString().replace(/[:.]/g, '-').slice(0,19)}.csv`);

const startMs = Date.now();
let trafficMsgCount = 0, trafficLastMsgAt = 0;
let sitMsgCount     = 0, sitLastMsgAt     = 0;
let trafficWs = null, sitWs = null;
let lastTrafficClose = null, lastSitClose = null;
let trafficOpenAt = 0, sitOpenAt = 0;

const STATES = ['CONNECTING','OPEN','CLOSING','CLOSED'];

fs.writeFileSync(OUT,
  'iso,elapsed_s,traffic_state,sit_state,traffic_msgs_total,sit_msgs_total,'
  + 'traffic_silent_s,sit_silent_s,es_last_min,es_targets,uat_last_min,connected_users,'
  + 'event\n');

function log(eventTag, status) {
  const now = Date.now();
  const elapsed = ((now - startMs) / 1000).toFixed(1);
  const tSilent = trafficLastMsgAt ? ((now - trafficLastMsgAt) / 1000).toFixed(1) : '';
  const sSilent = sitLastMsgAt     ? ((now - sitLastMsgAt)     / 1000).toFixed(1) : '';
  const tState  = trafficWs ? STATES[trafficWs.readyState] : 'NULL';
  const sState  = sitWs     ? STATES[sitWs.readyState]     : 'NULL';
  fs.appendFileSync(OUT,
    `${new Date(now).toISOString()},${elapsed},${tState},${sState},`
    + `${trafficMsgCount},${sitMsgCount},${tSilent},${sSilent},`
    + `${status?.ES_messages_last_minute ?? ''},${status?.ES_traffic_targets_tracking ?? ''},`
    + `${status?.UAT_messages_last_minute ?? ''},${status?.Connected_Users ?? ''},`
    + `${eventTag}\n`);
}

function connectTraffic() {
  trafficWs = new WebSocket(`ws://${HOST}/traffic`);
  trafficWs.addEventListener('open', () => {
    trafficLastMsgAt = Date.now();
    trafficOpenAt    = Date.now();
    log('traffic_open');
  });
  trafficWs.addEventListener('message', () => {
    trafficMsgCount++;
    trafficLastMsgAt = Date.now();
  });
  trafficWs.addEventListener('close', (e) => {
    lastTrafficClose = { code: e.code, reason: e.reason, ts: Date.now() };
    log(`traffic_close_code=${e.code}`);
    setTimeout(connectTraffic, 2000);
  });
  trafficWs.addEventListener('error', () => log('traffic_error'));
}

function connectSit() {
  sitWs = new WebSocket(`ws://${HOST}/situation`);
  sitWs.addEventListener('open', () => {
    sitLastMsgAt = Date.now();
    sitOpenAt    = Date.now();
    log('sit_open');
  });
  sitWs.addEventListener('message', () => {
    sitMsgCount++;
    sitLastMsgAt = Date.now();
  });
  sitWs.addEventListener('close', (e) => {
    lastSitClose = { code: e.code, reason: e.reason, ts: Date.now() };
    log(`sit_close_code=${e.code}`);
    setTimeout(connectSit, 2000);
  });
  sitWs.addEventListener('error', () => log('sit_error'));
}

async function pollStatus() {
  try {
    const r = await fetch(`http://${HOST}/getStatus`, { cache: 'no-store' });
    if (r.ok) {
      const status = await r.json();
      log('poll', status);
    } else {
      log(`poll_http_${r.status}`);
    }
  } catch (err) {
    log(`poll_err_${err.code || err.name || 'unknown'}`);
  }
}

connectTraffic();
connectSit();
pollStatus();
const pollTimer = setInterval(pollStatus, 10000);

// Heartbeat row every 30s so we can see WS state evolution even with no events
const hbTimer = setInterval(() => log('heartbeat'), 30000);

// Console summary every minute so a tail of stdout is informative
const sumTimer = setInterval(() => {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  const tSilent = trafficLastMsgAt ? ((Date.now() - trafficLastMsgAt) / 1000).toFixed(0) : '?';
  const sSilent = sitLastMsgAt     ? ((Date.now() - sitLastMsgAt)     / 1000).toFixed(0) : '?';
  console.log(`[${elapsed}s] traffic=${STATES[trafficWs?.readyState ?? 3]} silent=${tSilent}s msgs=${trafficMsgCount}  sit=${STATES[sitWs?.readyState ?? 3]} silent=${sSilent}s msgs=${sitMsgCount}`);
}, 60000);

// Auto-stop
setTimeout(() => {
  log('shutdown');
  clearInterval(pollTimer); clearInterval(hbTimer); clearInterval(sumTimer);
  try { trafficWs?.close(); } catch {}
  try { sitWs?.close();     } catch {}
  console.log(`\nDone. Output: ${OUT}`);
  setTimeout(() => process.exit(0), 500);
}, DURSEC * 1000);

console.log(`Watching ws://${HOST}/{traffic,situation} for ${DURSEC}s. CSV → ${OUT}`);
