// tests/fixtures/global-teardown.js
'use strict';
const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.server-pids.json');

module.exports = async function globalTeardown() {
    // Prefer handles stored in global (same process)
    if (global.__testServers) {
        const { engine, stratux, homeServer } = global.__testServers;
        try { engine.kill(); }      catch (_) {}
        try { stratux.kill(); }     catch (_) {}
        try { homeServer?.close(); } catch (_) {}
    } else if (fs.existsSync(STATE_FILE)) {
        // Fallback: kill by PID (cross-worker case)
        const { enginePid, stratuxPid } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        try { process.kill(enginePid); }  catch (_) {}
        try { process.kill(stratuxPid); } catch (_) {}
    }
    try { fs.unlinkSync(STATE_FILE); } catch (_) {}
    console.log('  [teardown] fixture servers stopped');
};
