// Trigger app.openRoutePlanner + run plan() with KRCZ → KLKR on the live tablet
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

        const script = `(async () => {
            const panel = window.app?.routePlannerPanel;
            if (!panel) return 'no panel';
            const result = await panel._planner.plan({
                departure: 'KRCZ',
                destination: 'KLKR',
                preferredLegHrs: 2.0,
                reserveGal: 10,
                selfServeOnly: false,
            });
            return JSON.stringify({
                routeString: result.routeString,
                waypointCount: result.waypoints?.length,
                legCount: result.routeLegs?.length,
                fuelStops: result.fuelStops?.length,
                totalDistNm: result.summary?.totalDistNm,
                firstThreeWpts: result.waypoints?.slice(0,3).map(w => w.fix),
                lastWpt: result.waypoints?.[result.waypoints.length-1]?.fix,
            }, null, 2);
        })()`;

        const r = await Promise.race([
            send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }),
            new Promise(res => setTimeout(() => res({ TIMEOUT: true }), 30000)),
        ]);
        if (r.TIMEOUT) console.log('TIMEOUT');
        else console.log('=== PLAN RESULT ===\n' + (r.result?.result?.value ?? JSON.stringify(r)));
        ws.close();
        process.exit(0);
    });
}).on('error', console.error);
