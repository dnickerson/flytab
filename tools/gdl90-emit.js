#!/usr/bin/env node
// Emits valid GDL 90 frames over UDP for testing the StratuxUDP plugin.
// Sends:  Heartbeat (1 Hz)  + Ownship (1 Hz) + Geo Altitude (1 Hz)
//       + Traffic (5 fake aircraft, 1 Hz each)  + Stratux heartbeat (1 Hz)
//
// Usage: node gdl90-emit.js [target_ip] [port] [duration_sec]
'use strict';

const dgram = require('dgram');

const HOST = process.argv[2] || '192.168.1.82';
const PORT = Number(process.argv[3] || 4000);
const DUR  = Number(process.argv[4] || 60);
const sock = dgram.createSocket('udp4');

// ---- CRC-16-CCITT, poly 0x1021, init 0 (matches plugin) ----
function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

// ---- Byte-stuffing wrap: 0x7E flag, escape 0x7D/0x7E inside ----
function frame(payload) {
  const crc = crc16(payload);
  const withCrc = Buffer.concat([payload, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
  const stuffed = [];
  stuffed.push(0x7E);
  for (const b of withCrc) {
    if (b === 0x7D || b === 0x7E) { stuffed.push(0x7D); stuffed.push(b ^ 0x20); }
    else                          { stuffed.push(b); }
  }
  stuffed.push(0x7E);
  return Buffer.from(stuffed);
}

function send(buf) {
  sock.send(buf, PORT, HOST, (err) => { if (err) console.error('send err', err.message); });
}

// ---- Encode 24-bit signed semicircle for lat/lon ----
function semi24(deg) {
  let v = Math.round(deg * (1 << 23) / 180);
  if (v < 0) v += (1 << 24);
  return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

function buildHeartbeat() {
  // [0]=0x00 [1]=status1 (bit7=GPS valid) [2]=status2 [3..4]=ts [5..6]=counts
  const ts = (Math.floor(Date.now() / 1000) % 86400) & 0xFFFF;
  return Buffer.from([0x00, 0x80, 0x01, ts & 0xFF, (ts >> 8) & 0xFF, 0, 0]);
}

function buildOwnship(lat, lon, altFt, gsKt, trackDeg, vvFpm) {
  const [la0,la1,la2] = semi24(lat);
  const [lo0,lo1,lo2] = semi24(lon);
  // Altitude raw = (altFt + 1000) / 25
  const altRaw = Math.max(0, Math.min(0xFFE, Math.round((altFt + 1000) / 25)));
  const misc = 0x09; // airborne + true-track-heading
  const hVel = Math.max(0, Math.min(0xFFE, Math.round(gsKt)));
  let vVel = Math.round(vvFpm / 64); if (vVel < 0) vVel += 0x1000;
  const trackByte = Math.round((trackDeg % 360) * 256 / 360) & 0xFF;
  const cs = 'OWNSHIP '.padEnd(8, ' ').slice(0, 8);
  const buf = Buffer.alloc(28);
  buf[0] = 0x0A;            // ownship
  buf[1] = 0x00;            // alert=0, addr type=0 (ICAO)
  buf[2] = 0xAB; buf[3] = 0xCD; buf[4] = 0xEF;
  buf[5] = la0; buf[6] = la1; buf[7] = la2;
  buf[8] = lo0; buf[9] = lo1; buf[10] = lo2;
  buf[11] = (altRaw >> 4) & 0xFF;
  buf[12] = ((altRaw & 0x0F) << 4) | (misc & 0x0F);
  buf[13] = 0x88;           // NIC=8, NACp=8
  buf[14] = (hVel >> 4) & 0xFF;
  buf[15] = ((hVel & 0x0F) << 4) | ((vVel >> 8) & 0x0F);
  buf[16] = vVel & 0xFF;
  buf[17] = trackByte;
  buf[18] = 0x01;           // emitter category: light
  for (let i = 0; i < 8; i++) buf[19 + i] = cs.charCodeAt(i);
  buf[27] = 0x00;
  return buf;
}

function buildGeoAlt(altFt) {
  // [0]=0x0B [1..2]=alt (signed int16, 5-ft units, big-endian) [3..4]=vert metrics
  const v = Math.round(altFt / 5) & 0xFFFF;
  return Buffer.from([0x0B, (v >> 8) & 0xFF, v & 0xFF, 0x00, 0x0A]);
}

function buildTraffic(icao, callsign, lat, lon, altFt, gsKt, trackDeg, vvFpm) {
  const [la0,la1,la2] = semi24(lat);
  const [lo0,lo1,lo2] = semi24(lon);
  const altRaw = Math.max(0, Math.min(0xFFE, Math.round((altFt + 1000) / 25)));
  const misc = 0x09;
  const hVel = Math.max(0, Math.min(0xFFE, Math.round(gsKt)));
  let vVel = Math.round(vvFpm / 64); if (vVel < 0) vVel += 0x1000;
  const trackByte = Math.round((trackDeg % 360) * 256 / 360) & 0xFF;
  const cs = callsign.padEnd(8, ' ').slice(0, 8);
  const buf = Buffer.alloc(28);
  buf[0] = 0x14;
  buf[1] = 0x00;
  buf[2] = (icao >> 16) & 0xFF; buf[3] = (icao >> 8) & 0xFF; buf[4] = icao & 0xFF;
  buf[5] = la0; buf[6] = la1; buf[7] = la2;
  buf[8] = lo0; buf[9] = lo1; buf[10] = lo2;
  buf[11] = (altRaw >> 4) & 0xFF;
  buf[12] = ((altRaw & 0x0F) << 4) | (misc & 0x0F);
  buf[13] = 0x88;
  buf[14] = (hVel >> 4) & 0xFF;
  buf[15] = ((hVel & 0x0F) << 4) | ((vVel >> 8) & 0x0F);
  buf[16] = vVel & 0xFF;
  buf[17] = trackByte;
  buf[18] = 0x01;
  for (let i = 0; i < 8; i++) buf[19 + i] = cs.charCodeAt(i);
  buf[27] = 0x00;
  return buf;
}

// ---- Test fleet ----
const ownLat = 34.7176, ownLon = -80.8611;
const fleet = [
  { icao: 0xA00001, cs: 'TEST1',  lat: 34.80, lon: -80.85, alt: 5000,  gs: 120, trk: 90,  vv: 0   },
  { icao: 0xA00002, cs: 'TEST2',  lat: 34.65, lon: -80.90, alt: 18000, gs: 280, trk: 180, vv: 500 },
  { icao: 0xA00003, cs: 'JBLUE1', lat: 34.90, lon: -80.70, alt: 35000, gs: 450, trk: 270, vv: -200},
  { icao: 0xA00004, cs: 'GA42',   lat: 34.72, lon: -80.95, alt: 2500,  gs: 95,  trk: 45,  vv: 100 },
  { icao: 0xA00005, cs: 'HELO1',  lat: 34.71, lon: -80.86, alt: 800,   gs: 70,  trk: 0,   vv: 0   },
];

let tick = 0;
const intv = setInterval(() => {
  // Heartbeat + Stratux heartbeat
  send(frame(buildHeartbeat()));
  send(frame(Buffer.from([0xCC, 0x03])));    // ahrs+gps valid
  // Ownship
  send(frame(buildOwnship(ownLat, ownLon, 538, 0, 0, 0)));
  send(frame(buildGeoAlt(550)));
  // Traffic — drift each target a tiny bit so position changes
  for (const a of fleet) {
    a.lat += 0.00015 * Math.cos(a.trk * Math.PI / 180);
    a.lon += 0.00015 * Math.sin(a.trk * Math.PI / 180);
    send(frame(buildTraffic(a.icao, a.cs, a.lat, a.lon, a.alt, a.gs, a.trk, a.vv)));
  }
  tick++;
  if (tick % 5 === 0) console.log(`[${tick}s] sent: hb + ownship + ${fleet.length} traffic`);
}, 1000);

setTimeout(() => {
  clearInterval(intv);
  sock.close();
  console.log('done');
}, DUR * 1000);

console.log(`Emitting GDL 90 → ${HOST}:${PORT} for ${DUR}s`);
