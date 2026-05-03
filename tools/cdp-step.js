// One step at a time so we can see where it hangs
const WS = require('ws');
const http = require('http');

http.get('http://localhost:9222/json', (res) => {
    let buf = '';
    res.on('data', d => buf += d);
    res.on('end', async () => {
        const target = JSON.parse(buf).find(p => p.type === 'page');
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
        await new Promise(r => ws.on('open', r));
        function send(method, params = {}) {
            const reqId = ++id;
            return new Promise(r => {
                pending.set(reqId, { resolve: r });
                ws.send(JSON.stringify({ id: reqId, method, params }));
            });
        }
        async function evalRace(expression, awaitPromise = false, ms = 5000) {
            const r = await Promise.race([
                send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }),
                new Promise(res => setTimeout(() => res({ TIMEOUT: true }), ms)),
            ]);
            if (r.TIMEOUT) return 'TIMEOUT';
            return r.result?.result?.value ?? r.result?.result?.description ?? JSON.stringify(r);
        }

        console.log('1. databases():', await evalRace(`indexedDB.databases().then(JSON.stringify)`, true));
        console.log('2. open db (sync handle):', await evalRace(`(()=>{const q=indexedDB.open('FlyTabDB'); window.__q=q; return 'opened, readyState=' + q.readyState;})()`));
        console.log('3. wait then check result:', await evalRace(`new Promise(r=>setTimeout(()=>r('after delay: readyState='+window.__q?.readyState+', err='+window.__q?.error?.message+', stores='+(window.__q?.result?.objectStoreNames ? Array.from(window.__q.result.objectStoreNames).join(',') : 'no result')), 2000))`, true));
        console.log('4. nasrDb status:', await evalRace(`JSON.stringify({hasNasrDb: !!window.app?._nasrDb, dbName: window.app?._nasrDb?.db?.name, version: window.app?._nasrDb?.db?.version, stores: window.app?._nasrDb?.db ? Array.from(window.app._nasrDb.db.objectStoreNames) : null})`));
        console.log('5. count via nasrDb:', await evalRace(`(async () => {
            const db = window.app?._nasrDb?.db;
            if (!db) return 'no nasrDb.db';
            const counts = {};
            for (const name of Array.from(db.objectStoreNames)) {
                counts[name] = await new Promise((r,j)=>{const tx=db.transaction(name,'readonly');const q=tx.objectStore(name).count();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
            }
            return JSON.stringify(counts, null, 2);
        })()`, true, 15000));

        ws.close();
        process.exit(0);
    });
}).on('error', console.error);
