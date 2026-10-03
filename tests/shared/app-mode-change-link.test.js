// tests/shared/app-mode-change-link.test.js
//
// FlyTabApp._onModeChanged must never tear down or re-create the live
// Stratux / engine links. Both clients reconnect on their own forever; a
// network-mode transition (which is only a periodic 2s-timeout HTTP probe)
// used to call disconnect() on leaving 'flight' — and disconnect() also
// disables the clients' own reconnect, so one bad probe killed GPS, traffic
// and engine data until the app was restarted (field bug 2026-10-02).
//
// Exercises the REAL method body extracted from web/app.js (app.js can't be
// loaded whole under jsdom — it instantiates the entire cockpit).
import { describe, it, expect, vi } from 'vitest';
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

const appSrc = readFileSync('web/app.js', 'utf8');
const body = extractMethod(appSrc, '_onModeChanged(mode, previous)');
const onModeChanged = new Function('mode', 'previous', body);

function fakeApp({ stratuxConnected = false, engineConnected = false } = {}) {
    return {
        stratuxClient: { connected: stratuxConnected, connect: vi.fn(), disconnect: vi.fn() },
        engineClient:  { connected: engineConnected,  connect: vi.fn(), disconnect: vi.fn() },
        vectorLayers: null,
        _fetchAdvisories: vi.fn(),
    };
}

describe('FlyTabApp._onModeChanged leaves the live data links alone', () => {
    const transitions = [
        ['offline', 'flight'], ['internet', 'flight'], ['home', 'flight'],
        ['flight', 'offline'], ['flight', 'internet'], ['flight', 'home'],
    ];

    for (const [previous, mode] of transitions) {
        it(`${previous} → ${mode}: no disconnect() and no connect() on Stratux or engine`, () => {
            for (const connected of [true, false]) {
                const app = fakeApp({ stratuxConnected: connected, engineConnected: connected });
                onModeChanged.call(app, mode, previous);
                expect(app.stratuxClient.disconnect).not.toHaveBeenCalled();
                expect(app.engineClient.disconnect).not.toHaveBeenCalled();
                // connect() on a client whose sockets are still CONNECTING tears
                // them down and rebuilds them (startup churn) — never needed,
                // because the clients' own reconnect loops never stop.
                expect(app.stratuxClient.connect).not.toHaveBeenCalled();
                expect(app.engineClient.connect).not.toHaveBeenCalled();
            }
        });
    }

    it('still refreshes advisories when coming back online from offline', () => {
        const app = fakeApp();
        onModeChanged.call(app, 'internet', 'offline');
        expect(app._fetchAdvisories).toHaveBeenCalledTimes(1);
    });
});
