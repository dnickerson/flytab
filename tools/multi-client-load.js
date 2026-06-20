#!/usr/bin/env node
// Open N parallel WebSocket clients to a Stratux /traffic endpoint.
// Used to push up Connected_Users and detect whether load triggers silent death.
//
// Usage: node multi-client-load.js [host] [num_clients] [duration_sec]
'use strict';

const fs = require('fs');
const path = require('path');

const HOST  = process.argv[2] || '192.168.1.212';
const N     = Number(process.argv[3] || 8);
const DUR   = Number(process.argv[4] || 1800);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT   = path.join('tools', `multi-client-${STAMP}.csv`);

const startMs = Date.now();
const STATES = ['CONNECTING','OPEN','CLOSING','CLOSED'];

const clients = [];
fs.writeFileSync(OUT, 'iso,elapsed_s,client_id,event,state,msgs_total,silent_s\n');

function logRow(c, event) {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const silent  = c.lastMsgAt ? ((Date.now() - c.lastMsgAt) / 1000).toFixed(1) : '';
  fs.appendFileSync(OUT,
    `${new Date().toISOString()},${elapsed},${c.id},${event},${STATES[c.ws?.readyState ?? 3]},${c.msgs},${silent}\n`);
}

function makeClient(id) {
  const c = { id, msgs: 0, lastMsgAt: 0, ws: null };
  function connect() {
    c.ws = new WebSocket(`ws://${HOST}/traffic`);
    c.ws.addEventListener('open',    () => { c.lastMsgAt = Date.now(); logRow(c, 'open'); });
    c.ws.addEventListener('message', () => { c.msgs++; c.lastMsgAt = Date.now(); });
    c.ws.addEventListener('close',   (e) => { logRow(c, `close_code=${e.code}`); setTimeout(connect, 2000); });
    c.ws.addEventListener('error',   () => logRow(c, 'error'));
  }
  connect();
  return c;
}

for (let i = 0; i < N; i++) clients.push(makeClient(i));

// Heartbeat every 30s for every client
setInterval(() => clients.forEach(c => logRow(c, 'heartbeat')), 30000);

// Console summary every 60s
setInterval(() => {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
  const summary = clients.map(c => {
    const silent = c.lastMsgAt ? Math.round((Date.now() - c.lastMsgAt) / 1000) : '?';
    return `#${c.id}:${STATES[c.ws?.readyState ?? 3].slice(0,1)}/${c.msgs}/${silent}s`;
  }).join(' ');
  console.log(`[${elapsed}s] ${summary}`);
}, 60000);

setTimeout(() => {
  console.log('shutdown');
  clients.forEach(c => { try { c.ws?.close(); } catch {} });
  setTimeout(() => process.exit(0), 500);
}, DUR * 1000);

console.log(`multi-client load → ws://${HOST}/traffic  N=${N} dur=${DUR}s  CSV=${OUT}`);
