// Synchronous quick check — no promise await
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
                const { resolve } = pending.get(msg.id);
                pending.delete(msg.id);
                resolve(msg);
            }
        });
        ws.on('error', e => { console.error('ws error', e.message); process.exit(2); });
        await new Promise(res => ws.on('open', res));
        function send(method, params = {}) {
            const reqId = ++id;
            return new Promise(resolve => {
                pending.set(reqId, { resolve });
                ws.send(JSON.stringify({ id: reqId, method, params }));
            });
        }

        // Pure sync eval — read app state directly without IDB
        const script = `
(() => {
    const panel = window.app?.routePlannerPanel;
    if (!panel) return 'panel missing';
    return JSON.stringify({
        flytabVersion: typeof FLYTAB_VERSION !== 'undefined' ? FLYTAB_VERSION : 'unknown',
        plannerExists: !!panel._planner,
        plannerInitError: panel._plannerInitError ?? null,
        graphSize: panel._planner ? Object.keys(panel._planner._airwayGraph?.graph || {}).length : 0,
        suaCount: panel._planner?._suas?.length ?? null,
        nasrVersion: localStorage.getItem('flypi_nasr_version'),
    }, null, 2);
})()
        `.trim();

        const r = await Promise.race([
            send('Runtime.evaluate', { expression: script, returnByValue: true }),
            new Promise(res => setTimeout(() => res({ timeout: true }), 5000)),
        ]);
        if (r.timeout) console.log('TIMEOUT on eval');
        else console.log('=== APP STATE ===\n' + (r.result?.result?.value ?? JSON.stringify(r)));
        ws.close();
        process.exit(0);
    });
}).on('error', e => { console.error(e); process.exit(3); });
