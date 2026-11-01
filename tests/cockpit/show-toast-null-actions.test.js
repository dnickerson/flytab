/**
 * app.showToast(message, actions = []) defaulted only on undefined: flight-upload.js
 * calls showToast(msg, null, 4000) (9 places), so `null.map` threw and none of those
 * messages ("Upload failed", "No pending flights.", the log-failure toast) ever showed.
 * Exercises the REAL showToast body extracted from web/app.js, and a flight-upload
 * failure path wired to it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

function extractMethod(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`method not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error('unbalanced braces');
}

const showToast = new Function('message', 'actions = []',
    extractMethod(readFileSync('web/app.js', 'utf8'), 'showToast(message, actions = []) {'));
const FlightUpload = new Function(
    readFileSync('web/cockpit/flight-upload.js', 'utf8') + '\nreturn FlightUpload;'
)();

const toastText = () => document.querySelector('.toast span')?.textContent;

describe('showToast with a null / non-array actions argument', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it("showToast('x', null, 4000) shows the message and does not throw", () => {
        let t;
        expect(() => { t = showToast.call({}, 'x', null, 4000); }).not.toThrow();
        expect(t.isConnected).toBe(true);
        expect(toastText()).toBe('x');
        expect(t.querySelector('[data-action="dismiss"]')).not.toBeNull();
        expect(t.querySelectorAll('.btn-primary')).toHaveLength(0);
    });

    it('a non-array actions value is ignored the same way', () => {
        expect(() => showToast.call({}, 'y', 4000)).not.toThrow();
        expect(toastText()).toBe('y');
    });

    it('actions given as an array still work', () => {
        const fn = vi.fn();
        const t = showToast.call({}, 'z', [{ label: 'Undo', action: fn }]);
        t.querySelector('[data-action="0"]').click();
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('flight-upload messages reach the screen', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        globalThis.wireTap = (el, fn) => el.addEventListener('click', fn);
        globalThis.CockpitConfig = { get: (k) => (k === 'flightUpload' ? { host: 'h', username: 'u' } : undefined) };
        globalThis.DiagLog = { log: vi.fn() };
        delete globalThis.SftpHostKey;
        globalThis.window.app = { showToast(m, a) { return showToast.call(this, m, a); } };
        globalThis.fetch = vi.fn(async (url) => (url.endsWith('/flights/list')
            ? { ok: true, status: 200, json: async () => [{ name: 'A.csv', size_bytes: 1, modified_ms: 1 }] }
            : { ok: false, status: 404 }));
    });

    it('a failed upload shows "Upload failed: …"', async () => {
        globalThis.Capacitor = { Plugins: { Sftp: {
            getPassword: async () => ({ password: 'pw' }),
            upload: vi.fn(async () => ({ ok: false, error: 'Auth fail' })),
        } } };
        const fu = new FlightUpload();
        await fu._loadFlights();
        const row = fu._el.querySelector('[data-filename="A.csv"]').closest('.fu-row');
        await fu._uploadOne('A.csv', row);
        expect(toastText()).toBe('Upload failed: Auth fail');
        expect(row.querySelector('.fu-upload-btn').textContent).toBe('Retry');
    });

    it('Upload All with nothing pending shows "No pending flights."', async () => {
        localStorage.setItem('flytab_uploaded_flights', JSON.stringify(['A.csv']));
        globalThis.Capacitor = { Plugins: { Sftp: { getPassword: async () => ({ password: 'pw' }), upload: vi.fn() } } };
        const fu = new FlightUpload();
        await fu._loadFlights();
        await expect(fu._uploadAllPending()).resolves.toBeUndefined();
        expect(toastText()).toBe('No pending flights.');
    });
});
