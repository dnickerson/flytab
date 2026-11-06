/**
 * tools/prune-apks.sh: build.sh keeps the APK it just built plus the 5 highest earlier versions,
 * so the pilot can go back to a previous version (Dana 2026-11-06). It used to delete every
 * other flytab-debug-v*.apk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve('tools/prune-apks.sh');
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prune-apks-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const touch = (...names) => names.forEach((n) => writeFileSync(join(dir, n), 'x'));
const run = (current, ...extra) => execFileSync('bash', [SCRIPT, dir, current, ...extra], { encoding: 'utf8' });
const left = () => readdirSync(dir).sort();
const apk = (v) => `flytab-debug-v${v}.apk`;

describe('prune-apks.sh', () => {
    it('keeps the current APK and the 5 highest earlier versions', () => {
        touch(...['12.60', '12.61', '12.62', '12.63', '12.64', '12.65', '12.66', '12.67'].map(apk));
        run(apk('12.67'));
        expect(left()).toEqual(['12.62', '12.63', '12.64', '12.65', '12.66', '12.67'].map(apk));
    });

    it('orders by version code, not by name: v12.100-style names never occur, but v12.9 < v12.10 < v12.70', () => {
        touch(...['12.9', '12.10', '12.70', '11.99', '12.5', '12.8', '12.71'].map(apk));
        run(apk('12.71'));
        // codes: 1209, 1210, 1270, 1199, 1205, 1208 -> keep the 5 highest: 1270, 1210, 1209, 1208, 1205
        expect(left()).toEqual(['12.10', '12.5', '12.70', '12.71', '12.8', '12.9'].map(apk).sort());
    });

    it('keeps the current APK even when it is not the highest version (a branch build)', () => {
        touch(...['12.71', '12.72', '12.73', '12.74', '12.75', '12.76', '12.77'].map(apk));
        run(apk('12.71'));
        expect(left()).toEqual(['12.71', '12.73', '12.74', '12.75', '12.76', '12.77'].map(apk));
    });

    it('fewer than 5 earlier versions: nothing is deleted', () => {
        touch(apk('12.73'), apk('12.74'));
        run(apk('12.74'));
        expect(left()).toEqual([apk('12.73'), apk('12.74')]);
    });

    it('never touches files it cannot read as a version, the latest link, or other files', () => {
        touch(...['12.60', '12.61', '12.62', '12.63', '12.64', '12.65', '12.66'].map(apk),
            'flytab-debug-vtest.apk', 'flytab-debug-v12.apk.bak', 'notes.txt', 'other.apk');
        symlinkSync(join(dir, apk('12.60')), join(dir, 'flytab-latest.apk'));
        run(apk('12.66'));
        expect(left()).toEqual(['flytab-debug-v12.apk.bak', ...['12.61', '12.62', '12.63', '12.64', '12.65', '12.66'].map(apk),
            'flytab-debug-vtest.apk', 'flytab-latest.apk', 'notes.txt', 'other.apk'].sort());
    });

    it('the number kept is a parameter; --dry-run only lists', () => {
        touch(...['12.60', '12.61', '12.62', '12.63'].map(apk));
        const out = run(apk('12.63'), '1', '--dry-run');
        expect(left()).toHaveLength(4);
        expect(out).toMatch(/would delete .*flytab-debug-v12\.60\.apk/);
        expect(out).toMatch(/would delete .*flytab-debug-v12\.61\.apk/);
        expect(out).toMatch(/keep .*flytab-debug-v12\.62\.apk/);
        run(apk('12.63'), '1');
        expect(left()).toEqual([apk('12.62'), apk('12.63')]);
    });

    it('refuses to run without a directory or with the current APK missing', () => {
        expect(() => execFileSync('bash', [SCRIPT], { stdio: 'pipe' })).toThrow();
        touch(apk('12.60'));
        expect(() => run(apk('12.99'))).toThrow();
        expect(left()).toEqual([apk('12.60')]);
    });
});
