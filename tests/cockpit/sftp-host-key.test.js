/**
 * SFTP server host-key check (SftpHostKey, web/cockpit/sftp-host-key.js) and its use by
 * Flight Upload and the SFTP app update (config-editor.js).
 *
 * SftpPlugin (HostKeyStore.java) stops an upload/download before the password or any
 * file is sent when the server key is unknown or changed, and resolves
 * { ok:false, error, hostKey:{status, host, port, keyType, shortType, fingerprint,
 *   keyBase64 | knownFingerprints} }. The stub below reproduces that: the key is
 * "unknown" until trustHostKey() stores it, or "changed" when told so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const SftpHostKey = new Function(
    readFileSync('web/cockpit/sftp-host-key.js', 'utf8') + '\nreturn SftpHostKey;'
)();
const FlightUpload = new Function(
    readFileSync('web/cockpit/flight-upload.js', 'utf8') + '\nreturn FlightUpload;'
)();
const ConfigEditor = new Function(
    readFileSync('web/cockpit/config-editor.js', 'utf8') + '\nreturn ConfigEditor;'
)();

const FP = 'SHA256:ON2ydI0tWsSXS0ENWhKCm+8eq540S41W1c/HN9qSR6w';
const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIJReGdxcansVWKF8ej8vO85zu0wGIH6tINAXErzcqIZL';
const CFG = { host: 'nas.local', username: 'u', port: 22, remotePath: '~/flights' };

let serverKey;   // 'unknown' | 'trusted' | 'changed'
let local, remote, sftp;

function hostKeyResult(status) {
    const hostKey = {
        status, host: CFG.host, port: 22, keyType: 'ssh-ed25519', shortType: 'ed25519', fingerprint: FP,
    };
    if (status === 'unknown') hostKey.keyBase64 = KEY;
    else hostKey.knownFingerprints = ['SHA256:oldOLDold (ssh-ed25519)'];
    return {
        ok: false,
        error: status === 'changed' ? `Server key for ${CFG.host} has CHANGED — possible interception.` : `Unknown server key for ${CFG.host}`,
        hostKey,
    };
}

function setup({ key = 'unknown', files = ['A.csv', 'A_weather.ndjson'], uploaded = [] } = {}) {
    document.body.innerHTML = '';
    localStorage.clear();
    if (uploaded.length) localStorage.setItem('flytab_uploaded_flights', JSON.stringify(uploaded));
    serverKey = key;
    local = new Set(files);
    remote = [];
    sftp = {
        getPassword: async () => ({ password: 'pw' }),
        upload: vi.fn(async ({ filename }) => {
            if (!local.has(filename)) throw new Error('File not found: ' + filename);
            if (serverKey !== 'trusted') return hostKeyResult(serverKey);
            remote.push(filename);
            return { ok: true };
        }),
        download: vi.fn(async () => (serverKey !== 'trusted' ? hostKeyResult(serverKey) : { ok: true })),
        installApk: vi.fn(async () => {}),
        trustHostKey: vi.fn(async ({ keyBase64, fingerprint }) => {
            if (keyBase64 === KEY && fingerprint === FP && serverKey === 'unknown') serverKey = 'trusted';
            return { ok: true };
        }),
        forgetHostKey: vi.fn(async () => ({ removed: 1 })),
    };
    globalThis.Capacitor = { Plugins: { Sftp: sftp } };
    globalThis.SftpHostKey = SftpHostKey;
    globalThis.CockpitConfig = { get: (k) => (k === 'flightUpload' ? CFG : undefined), _config: { flightUpload: CFG } };
    globalThis.DiagLog = { log: vi.fn() };
    globalThis.wireTap = (el, fn) => el.addEventListener('click', fn);
    globalThis.window.app = { showToast: vi.fn() };
    globalThis.fetch = vi.fn(async (url) => {
        if (url.endsWith('/flights/list')) {
            return { ok: true, status: 200, json: async () => [...local].filter(f => f.endsWith('.csv')).map(name => ({ name, size_bytes: 1, modified_ms: 1 })) };
        }
        const name = decodeURIComponent(url.split('/flights/')[1]);
        return local.has(name) ? { ok: true, status: 200 } : { ok: false, status: 404 };
    });
}

const dialog = () => document.querySelector('.shk-overlay');
const tapButton = (cls) => document.querySelector(`.shk-overlay .${cls}`).click();
/** Resolve the dialog once it appears (the run awaits it). */
async function answer(cls) {
    for (let i = 0; i < 50 && !dialog(); i++) await new Promise(r => setTimeout(r, 0));
    expect(dialog()).not.toBeNull();
    const text = dialog().textContent;
    tapButton(cls);
    return text;
}
const toasts = () => window.app.showToast.mock.calls.map(c => c[0]);
const rowFor = (fu, name) => { fu._render(); return fu._el.querySelector(`[data-filename="${name}"]`).closest('.fu-row'); };

describe('SftpHostKey.run', () => {
    beforeEach(() => setup());

    it('unknown key: shows host, fingerprint, type and the ssh-keygen command; Trust stores the SAME key and retries once', async () => {
        const op = vi.fn(() => sftp.upload({ filename: 'A.csv' }));
        const p = SftpHostKey.run(op);
        const text = await answer('shk-ok');
        const result = await p;
        expect(text).toContain('First connection to nas.local.');
        expect(text).toContain(`Server key fingerprint: ${FP} (ED25519).`);
        expect(text).toContain('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
        expect(text).toContain('Trust this server?');
        expect(sftp.trustHostKey).toHaveBeenCalledTimes(1);
        expect(sftp.trustHostKey).toHaveBeenCalledWith({
            host: 'nas.local', port: 22, keyType: 'ssh-ed25519', keyBase64: KEY, fingerprint: FP,
        });
        expect(op).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(true);
        expect(dialog()).toBeNull();
    });

    it('unknown key: Cancel sends nothing, does not trust and does not retry', async () => {
        const op = vi.fn(() => sftp.upload({ filename: 'A.csv' }));
        const p = SftpHostKey.run(op);
        await answer('shk-cancel');
        const result = await p;
        expect(result.ok).toBe(false);
        expect(result.hostKeyHandled).toBe(true);
        expect(sftp.trustHostKey).not.toHaveBeenCalled();
        expect(op).toHaveBeenCalledTimes(1);
        expect(remote).toEqual([]);
    });

    it('changed key: refusal toast and DiagLog with both fingerprints; no prompt, no trust, no retry', async () => {
        setup({ key: 'changed' });
        const op = vi.fn(() => sftp.upload({ filename: 'A.csv' }));
        const result = await SftpHostKey.run(op);
        expect(dialog()).toBeNull();
        expect(sftp.trustHostKey).not.toHaveBeenCalled();
        expect(op).toHaveBeenCalledTimes(1);
        expect(result.hostKeyHandled).toBe(true);
        expect(toasts()).toEqual(['Server key for nas.local has CHANGED — possible interception. Upload stopped.']);
        const logged = DiagLog.log.mock.calls.map(c => c[1]).join('\n');
        expect(logged).toContain(FP);
        expect(logged).toContain('SHA256:oldOLDold');
    });

    it('a still-unknown key after Trust is not prompted for a second time', async () => {
        sftp.trustHostKey = vi.fn(async () => ({ ok: true }));   // server keeps presenting an unknown key
        const op = vi.fn(() => sftp.upload({ filename: 'A.csv' }));
        const p = SftpHostKey.run(op);
        await answer('shk-ok');
        const result = await p;
        expect(op).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(false);
        expect(dialog()).toBeNull();
        expect(sftp.trustHostKey).toHaveBeenCalledTimes(1);
    });

    it('passes a non-host-key result straight through and lets exceptions propagate', async () => {
        serverKey = 'trusted';
        expect(await SftpHostKey.run(async () => ({ ok: false, error: 'Auth fail' }))).toEqual({ ok: false, error: 'Auth fail' });
        await expect(SftpHostKey.run(async () => { throw new Error('File not found: X'); })).rejects.toThrow('File not found');
    });

    it('dialog text is inserted as text, not HTML', async () => {
        const evil = hostKeyResult('unknown');
        evil.hostKey.host = '<img src=x onerror=alert(1)>';
        const p = SftpHostKey.run(async () => evil);
        await answer('shk-cancel');
        await p;
        expect(document.querySelector('img')).toBeNull();
    });

    it('toasts pass plain text (showToast renders it as text) and never a null actions arg', async () => {
        setup({ key: 'changed' });
        const r = hostKeyResult('changed');
        r.hostKey.host = '<b>x</b>';
        await SftpHostKey.run(async () => r);
        expect(window.app.showToast.mock.calls[0]).toEqual(['Server key for <b>x</b> has CHANGED — possible interception. Upload stopped.']);
    });
});

describe('SftpHostKey.forget', () => {
    beforeEach(() => setup());

    it('calls forgetHostKey only after its own confirmation', async () => {
        const p = SftpHostKey.forget('nas.local', 2222);
        const text = await answer('shk-ok');
        expect(await p).toBe(true);
        expect(text).toContain('nas.local:2222');
        expect(sftp.forgetHostKey).toHaveBeenCalledWith({ host: 'nas.local', port: 2222 });
    });

    it('Cancel does not call the plugin', async () => {
        const p = SftpHostKey.forget('nas.local', 22);
        await answer('shk-cancel');
        expect(await p).toBe(false);
        expect(sftp.forgetHostKey).not.toHaveBeenCalled();
    });
});

describe('Flight Upload with the host-key check', () => {
    it('single upload: Trust then the CSV and its companion are sent', async () => {
        setup();
        const fu = new FlightUpload();
        await fu._loadFlights();
        const p = fu._uploadOne('A.csv', rowFor(fu, 'A.csv'));
        await answer('shk-ok');
        await p;
        expect(sftp.trustHostKey).toHaveBeenCalledTimes(1);
        expect(remote).toEqual(['A.csv', 'A_weather.ndjson']);
    });

    it('single upload: Cancel uploads nothing and retries nothing', async () => {
        setup();
        const fu = new FlightUpload();
        await fu._loadFlights();
        const row = rowFor(fu, 'A.csv');
        const p = fu._uploadOne('A.csv', row);
        await answer('shk-cancel');
        await p;
        expect(sftp.upload).toHaveBeenCalledTimes(1);
        expect(remote).toEqual([]);
        expect(row.querySelector('.fu-upload-btn').textContent).toBe('Retry');
        expect(JSON.parse(localStorage.getItem('flytab_uploaded_flights') || '[]')).toEqual([]);
    });

    it('Upload All Pending: changed key refuses with a toast, no prompt, and stops the run', async () => {
        setup({ key: 'changed', files: ['A.csv', 'B.csv', 'A_weather.ndjson'] });
        const fu = new FlightUpload();
        await fu._loadFlights();
        await fu._uploadAllPending();
        expect(dialog()).toBeNull();
        expect(sftp.trustHostKey).not.toHaveBeenCalled();
        expect(sftp.upload).toHaveBeenCalledTimes(1);
        expect(toasts()).toContain('Server key for nas.local has CHANGED — possible interception. Upload stopped.');
        expect(remote).toEqual([]);
    });

    it('Upload All Pending, companions only (backfill): the first companion prompts; Cancel stops the run', async () => {
        setup({ files: ['OLD.csv', 'OLD_weather.ndjson', 'OLD_traffic.ndjson'], uploaded: ['OLD.csv'] });
        const fu = new FlightUpload();
        await fu._loadFlights();
        const p = fu._uploadAllPending();
        await answer('shk-cancel');
        await p;
        expect(sftp.upload).toHaveBeenCalledTimes(1);
        expect(remote).toEqual([]);
        expect(dialog()).toBeNull();
    });
});

describe('SFTP app update (config-editor download) with the host-key check', () => {
    function editorStub() {
        const el = document.createElement('div');
        el.innerHTML = `<div class="config-editor-body">
            <button class="ce-update-btn"></button><span class="ce-update-status"></span>
            <input id="ce-fu-host" value="nas.local"><input id="ce-fu-port" value="22">
            <input id="ce-fu-user" value="u"><input id="ce-fu-apk" value="~/flytab.apk"></div>`;
        document.body.appendChild(el);
        const ed = Object.create(ConfigEditor.prototype);
        ed._el = el;
        ed._cockpitConfig = { flightUpload: CFG };
        ed._getOrPromptPassword = async () => 'pw';
        return ed;
    }

    it('unknown key: Trust, download retried once, then the installer is launched', async () => {
        setup();
        const ed = editorStub();
        const p = ed._downloadAndInstall();
        const text = await answer('shk-ok');
        await p;
        expect(text).toContain(FP);
        expect(sftp.download).toHaveBeenCalledTimes(2);
        expect(sftp.trustHostKey).toHaveBeenCalledWith(expect.objectContaining({ keyBase64: KEY, fingerprint: FP }));
        expect(sftp.installApk).toHaveBeenCalledTimes(1);
    });

    it('unknown key: Cancel means no install', async () => {
        setup();
        const ed = editorStub();
        const p = ed._downloadAndInstall();
        await answer('shk-cancel');
        await p;
        expect(sftp.download).toHaveBeenCalledTimes(1);
        expect(sftp.installApk).not.toHaveBeenCalled();
    });

    it('changed key: refused, no prompt, no install, status names the change', async () => {
        setup({ key: 'changed' });
        const ed = editorStub();
        await ed._downloadAndInstall();
        expect(dialog()).toBeNull();
        expect(sftp.installApk).not.toHaveBeenCalled();
        expect(ed._el.querySelector('.ce-update-status').textContent)
            .toBe('Server key for nas.local has CHANGED — possible interception. Download stopped.');
    });

    it('an APK the plugin refuses to install (wrong signer / not newer) shows the reason', async () => {
        setup({ key: 'trusted' });
        serverKey = 'trusted';
        sftp.installApk = vi.fn(async () => {
            throw new Error('Update refused: it is not signed with the same key as the installed FlyTab. The downloaded file was deleted.');
        });
        const ed = editorStub();
        await ed._downloadAndInstall();
        expect(sftp.installApk).toHaveBeenCalledTimes(1);
        expect(ed._el.querySelector('.ce-update-status').textContent)
            .toBe('Error: Update refused: it is not signed with the same key as the installed FlyTab. The downloaded file was deleted.');
    });

    it('Forget server key uses the SAVED host and port (what uploads use), not unsaved form edits', async () => {
        setup();
        CFG.port = 2222;
        try {
            const ed = editorStub();
            ed._el.querySelector('#ce-fu-host').value = 'unsaved.example';   // edited, not saved
            ed._el.querySelector('#ce-fu-port').value = '9999';
            const p = ed._forgetHostKey();
            expect(sftp.forgetHostKey).not.toHaveBeenCalled();
            await answer('shk-ok');
            await p;
            expect(sftp.forgetHostKey).toHaveBeenCalledWith({ host: 'nas.local', port: 2222 });
        } finally {
            CFG.port = 22;
        }
    });

    it('Forget server key with no saved host asks to save one and calls nothing', async () => {
        setup();
        const saved = CFG.host;
        CFG.host = '';
        try {
            const ed = editorStub();
            expect(await ed._forgetHostKey()).toBe(false);
            expect(dialog()).toBeNull();
            expect(sftp.forgetHostKey).not.toHaveBeenCalled();
        } finally {
            CFG.host = saved;
        }
    });

    it('the Flight Upload card renders a Forget server key button wired to _forgetHostKey', () => {
        const src = readFileSync('web/cockpit/config-editor.js', 'utf8');
        expect(src).toMatch(/id="ce-fu-forget-hostkey"[^>]*>Forget server key</);
        expect(src).toMatch(/wireTap\(body\.querySelector\('#ce-fu-forget-hostkey'\), \(\) => this\._forgetHostKey\(\)\)/);
    });
});

describe('SftpHostKey: damaged store, refused trust, reset', () => {
    beforeEach(() => setup());

    it('a damaged trusted-key store stops the upload with its message; no prompt, no trust', async () => {
        const damaged = {
            ok: false,
            error: 'Server key store damaged — forget the server key in Configuration → Flight Upload to reset',
            hostKey: { status: 'damaged', host: 'nas.local', port: 22 },
        };
        const op = vi.fn(async () => damaged);
        const r = await SftpHostKey.run(op);
        expect(r.hostKeyHandled).toBe(true);
        expect(op).toHaveBeenCalledTimes(1);
        expect(dialog()).toBeNull();
        expect(sftp.trustHostKey).not.toHaveBeenCalled();
        expect(toasts()[0]).toBe(`Upload stopped: ${damaged.error}.`);
        expect(toasts()[0]).not.toMatch(/CHANGED/);
    });

    it('when the plugin refuses trustHostKey (key not the one presented), nothing is retried', async () => {
        sftp.trustHostKey = vi.fn(async () => { throw new Error('Could not trust server key: not the key the server presented — try the upload again'); });
        const op = vi.fn(() => sftp.upload({ filename: 'A.csv' }));
        const p = SftpHostKey.run(op);
        await answer('shk-ok');
        const r = await p;
        expect(op).toHaveBeenCalledTimes(1);
        expect(r.hostKeyHandled).toBe(true);
        expect(remote).toEqual([]);
        expect(toasts()[0]).toMatch(/^Could not save the server key: .*not the key the server presented/);
    });

    it('forget on a damaged store reports the reset', async () => {
        sftp.forgetHostKey = vi.fn(async () => ({ removed: 0, reset: true }));
        const p = SftpHostKey.forget('nas.local', 22);
        await answer('shk-ok');
        await p;
        expect(toasts()[0]).toMatch(/^Server key store reset\./);
    });
});
