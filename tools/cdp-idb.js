// Read IDB stores via CDP — async, use Runtime.evaluate with awaitPromise
const WS = require('ws');
const http = require('http');

http.get('http://localhost:9222/json', (res) => {
    let buf = '';
    res.on('data', d => buf += d);
    res.on('end', async () => {
        const pages = JSON.parse(buf);
        const target = pages.find(p => p.type === 'page');
        const ws = new WS(target.webSocketDebuggerUrl);
        let id = 0;
        const pending = new Map();
        ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.id && pending.has(msg.id)) {
                pending.get(msg.id).resolve(msg);
                pending.delete(msg.id);
            }
        });
        ws.on('error', e => console.error('ws err', e.message));
        await new Promise(r => ws.on('open', r));
        function send(method, params = {}) {
            const reqId = ++id;
            return new Promise(r => {
                pending.set(reqId, { resolve: r });
                ws.send(JSON.stringify({ id: reqId, method, params }));
            });
        }

        // First, list databases
        const r1 = await send('Runtime.evaluate', {
            expression: `(async () => {
                const dbs = await indexedDB.databases();
                return JSON.stringify(dbs);
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log('DBs:', r1.result?.result?.value);

        // Now count records in FlyTabDB stores — open without version, list stores
        const r2 = await send('Runtime.evaluate', {
            expression: `(async () => {
                const db = await new Promise((res, rej) => {
                    const q = indexedDB.open('FlyTabDB');
                    q.onsuccess = () => res(q.result);
                    q.onerror = () => rej(q.error);
                });
                return JSON.stringify({ version: db.version, stores: Array.from(db.objectStoreNames) });
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log('FlyTabDB:', r2.result?.result?.value);

        // Count each store one at a time
        const r3 = await send('Runtime.evaluate', {
            expression: `(async () => {
                const out = {};
                const db = await new Promise((res, rej) => {
                    const q = indexedDB.open('FlyTabDB');
                    q.onsuccess = () => res(q.result);
                    q.onerror = () => rej(q.error);
                });
                for (const name of Array.from(db.objectStoreNames)) {
                    out[name] = await new Promise((res, rej) => {
                        const tx = db.transaction(name, 'readonly');
                        const q = tx.objectStore(name).count();
                        q.onsuccess = () => res(q.result);
                        q.onerror = () => rej(q.error);
                    });
                }
                db.close();
                return JSON.stringify(out, null, 2);
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log('Counts:\n' + (r3.result?.result?.value ?? JSON.stringify(r3)));

        ws.close();
        process.exit(0);
    });
}).on('error', console.error);
