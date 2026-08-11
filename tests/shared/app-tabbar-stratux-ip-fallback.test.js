/**
 * app.js and tab-bar.js carried the same dead fallback pattern removed from
 * network-mode.js/device-status.js in #130 — a different pair of files, not
 * caught by that review. app.js:935 snapshots Settings.stratuxIp (already
 * self-defaulting via Settings.get()) into _comps.stratuxIp with a redundant
 * `|| '192.168.10.1'`, then tab-bar.js:167 reads that snapshot and adds a
 * *second*, equally-redundant fallback on top. Settings.stratuxIp can never
 * be falsy, so both are unreachable dead code. Issue #131.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

describe('app.js / tab-bar.js: no redundant hardcoded-IP fallback on Settings.stratuxIp (#131)', () => {
    it('app.js builds the _comps.stratuxIp snapshot from Settings.stratuxIp alone', () => {
        const src = read('web/app.js');
        expect(src).toMatch(/stratuxIp:\s*Settings\.stratuxIp,/);
        expect(src).not.toMatch(/Settings\.stratuxIp \|\| '192\.168\.10\.1'/);
    });

    it('tab-bar.js builds the Stratux Status URL from the snapshot alone, no second fallback', () => {
        const src = read('web/cockpit/tab-bar.js');
        expect(src).not.toMatch(/c\.stratuxIp \|\| '192\.168\.10\.1'/);
    });
});
