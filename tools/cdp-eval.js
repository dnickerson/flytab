#!/usr/bin/env node
// Evaluate a JS expression in the FlyTab WebView via Chrome DevTools Protocol.
// Requires `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>` first.
'use strict';

const expr = process.argv.slice(2).join(' ');
if (!expr) { console.error('usage: cdp-eval.js "<expr>"'); process.exit(2); }

(async () => {
  const list = await (await fetch('http://localhost:9223/json')).json();
  const page = list.find(p => p.type === 'page' && p.title === 'FlyTab') || list[0];
  if (!page) { console.error('no page found'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const cid = ++id;
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id === cid) { ws.removeEventListener('message', handler); res(msg); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: cid, method, params }));
  });

  const r = await send('Runtime.evaluate', {
    expression: `(() => { try { return JSON.stringify(${expr}); } catch (e) { return 'ERR: '+e.message; } })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    console.error('exception:', JSON.stringify(r.result.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(r.result?.result?.value ?? '(no value)');
  ws.close();
})().catch(e => { console.error(e); process.exit(1); });
