// tests/fixtures/global-setup.js
'use strict';
const { spawn }  = require('child_process');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');

const STATE_FILE = path.join(__dirname, '.server-pids.json');
const REPO_ROOT  = path.join(__dirname, '../..');

function spawnServer(cmd, args, label) {
    const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: REPO_ROOT,
    });
    if (!proc.pid) throw new Error(`Failed to spawn ${label}: process did not start`);
    proc.on('error', err => console.error(`[${label}] spawn error: ${err.message}`));
    proc.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
    proc.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
    return proc;
}

function waitForHttp(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            http.get(url, res => {
                res.resume();
                resolve();
            }).on('error', () => {
                if (Date.now() >= deadline) return reject(new Error(`Timeout waiting for ${url}`));
                setTimeout(attempt, 200);
            });
        };
        attempt();
    });
}

module.exports = async function globalSetup() {
    const procs = {};

    // Start fake-engine.js (HTTP :8080, WS :8082)
    const engine = spawnServer('node', ['tools/fake-engine.js', '86400'], 'engine');
    procs.enginePid = engine.pid;

    // Start mock-stratux.py (WS :5678)
    const stratux = spawnServer('python3', ['tools/mock-stratux.py', '--port', '5678'], 'stratux');
    procs.stratuxPid = stratux.pid;

    // Start mock home server (HTTP :8090)
    let homeServer = null;
    try {
        const { startMockHomeServer } = require('./mock-home-server.js');
        homeServer = await startMockHomeServer(8090);
        procs.homeServerPort = 8090;
    } catch (e) {
        console.warn('  [setup] mock-home-server.js not yet available — skipping home server');
    }

    // Store handles for teardown
    global.__testServers = { engine, stratux, homeServer };
    fs.writeFileSync(STATE_FILE, JSON.stringify(procs));

    // Verify servers bound successfully
    try {
        await waitForHttp('http://localhost:8080/api/status', 8000);
        console.log('  [setup] fake-engine HTTP ready');
    } catch (e) {
        engine.kill(); stratux.kill();
        throw new Error(`fake-engine did not start: ${e.message}`);
    }

    if (homeServer) {
        try {
            await waitForHttp('http://localhost:8090/nasr/cycle_info.json', 3000);
            console.log('  [setup] mock-home-server ready');
        } catch (e) {
            engine.kill(); stratux.kill(); homeServer.close();
            throw new Error(`mock-home-server did not start: ${e.message}`);
        }
    }

    console.log('  [setup] fixture servers started');
};
