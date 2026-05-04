const WS = require('ws'); const http = require('http');

const SCRIPT = `
(() => {
    const out = [];
    const dump = (sel) => {
        const el = document.querySelector(sel);
        if (!el) { out.push(sel + ' = null'); return; }
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push(sel + ' rect=[' + Math.round(r.top) + '..' + Math.round(r.bottom) + ' h=' + Math.round(r.height) + ']');
        out.push('  display=' + cs.display + ' flexDir=' + cs.flexDirection + ' flex=' + cs.flex);
        out.push('  height=' + cs.height + ' maxHeight=' + cs.maxHeight + ' minHeight=' + cs.minHeight);
        out.push('  paddingBottom=' + cs.paddingBottom + ' marginBottom=' + cs.marginBottom);
        out.push('  position=' + cs.position + ' top=' + cs.top + ' bottom=' + cs.bottom);
    };
    dump('body');
    dump('#mainContent');
    dump('#cockpitView');
    dump('.cockpit-main');
    dump('#cockpitContainer');
    return out.join('\\n');
})()
`;

http.get('http://localhost:9222/json', res => {
    let buf = '';
    res.on('data', d => buf += d);
    res.on('end', async () => {
        const target = JSON.parse(buf).find(p => p.type === 'page');
        const ws = new WS(target.webSocketDebuggerUrl);
        let id = 0; const pending = new Map();
        ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }});
        await new Promise(r => ws.on('open', r));
        const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, { resolve: r }); ws.send(JSON.stringify({ id: i, method, params })); });
        const r = await send('Runtime.evaluate', { expression: SCRIPT, returnByValue: true });
        console.log(r.result?.result?.value || JSON.stringify(r.result?.exceptionDetails || r));
        ws.close();
        process.exit(0);
    });
}).on('error', console.error);
