/**
 * Connect to the tablet's WebView via Chrome DevTools Protocol.
 * Run a diagnostic in the live page: count IDB records, test planner init,
 * inspect graph state, capture recent console output.
 */
const WS = require('ws');
const http = require('http');

function getJson(path) {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222' + path, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => resolve(JSON.parse(buf)));
        }).on('error', reject);
    });
}

(async () => {
    const pages = await getJson('/json');
    const target = pages.find(p => p.type === 'page' && p.url.includes('localhost')) || pages[0];
    if (!target) { console.error('No page found'); process.exit(1); }
    console.log('Target:', target.url);

    const ws = new WS(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();

    function send(method, params = {}) {
        const reqId = ++id;
        return new Promise((resolve, reject) => {
            pending.set(reqId, { resolve, reject });
            ws.send(JSON.stringify({ id: reqId, method, params }));
        });
    }

    ws.on('message', data => {
        const msg = JSON.parse(data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        } else if (msg.method === 'Runtime.consoleAPICalled') {
            const txt = msg.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
            console.log(`[console.${msg.params.type}] ${txt}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
            console.log(`[exception] ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ''}`);
        }
    });

    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    await send('Runtime.enable');

    // Run our diagnostic in the page
    const diagnosticScript = `
(async () => {
    const STORES = ['airports', 'airways', 'navaids', 'fixes', 'sua', 'aircraft_profiles'];
    const counts = {};
    let dbVersion = null;
    let storeNames = [];

    try {
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('FlyTabDB');
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
        dbVersion = db.version;
        storeNames = Array.from(db.objectStoreNames);
        for (const name of STORES) {
            if (!db.objectStoreNames.contains(name)) { counts[name] = 'missing'; continue; }
            counts[name] = await new Promise((resolve, reject) => {
                const tx = db.transaction(name, 'readonly');
                const req = tx.objectStore(name).count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
        // Sample one airway
        let sample = null;
        if (db.objectStoreNames.contains('airways')) {
            sample = await new Promise((resolve, reject) => {
                const tx = db.transaction('airways', 'readonly');
                const req = tx.objectStore('airways').openCursor();
                req.onsuccess = (e) => {
                    const cur = e.target.result;
                    resolve(cur ? cur.value : null);
                };
                req.onerror = () => reject(req.error);
            });
        }
        db.close();

        const sampleSummary = sample ? {
            name: sample.name,
            type: sample.type,
            waypointCount: sample.waypoints?.length,
            firstWp: sample.waypoints?.[0],
            segmentCount: sample.segments?.length,
            firstSeg: sample.segments?.[0],
        } : null;

        return JSON.stringify({
            dbVersion,
            storeNames,
            counts,
            sampleAirway: sampleSummary,
            plannerExists: !!window.app?.routePlannerPanel?._planner,
            graphSize: Object.keys(window.app?.routePlannerPanel?._planner?._airwayGraph?.graph || {}).length,
            plannerInitError: window.app?.routePlannerPanel?._plannerInitError || null,
            flyTabVersion: typeof FLYTAB_VERSION !== 'undefined' ? FLYTAB_VERSION : 'unknown',
            nasrVersionLs: localStorage.getItem('flypi_nasr_version'),
        }, null, 2);
    } catch (err) {
        return 'ERROR: ' + (err.message || String(err));
    }
})();
    `.trim();

    const result = await send('Runtime.evaluate', {
        expression: diagnosticScript,
        awaitPromise: true,
        returnByValue: true,
    });

    console.log('\n── DIAGNOSTIC ──');
    console.log(result.result.value);

    ws.close();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
