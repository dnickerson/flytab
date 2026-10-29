/**
 * Home Stratux settings (MORE -> Configuration): prefilled with the home
 * network address, "Don't record on the home Stratux" on until switched off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const Settings = new Function(readFileSync('web/shared/settings.js', 'utf8') + '\nreturn Settings;')();

describe('Settings: home Stratux', () => {
    beforeEach(() => localStorage.clear());

    it('defaults: 192.168.1.212, no recording on it', () => {
        expect(Settings.homeStratuxIp).toBe('192.168.1.212');
        expect(Settings.homeStratuxNoRecord).toBe(true);
    });

    it('saved values come back; switched off stays off', () => {
        Settings.homeStratuxIp = '192.168.1.50';
        Settings.homeStratuxNoRecord = false;
        expect(Settings.homeStratuxIp).toBe('192.168.1.50');
        expect(Settings.homeStratuxNoRecord).toBe(false);
        expect(localStorage.getItem('flypi_home_stratux_no_record')).toBe('false');
        Settings.homeStratuxNoRecord = true;
        expect(Settings.homeStratuxNoRecord).toBe(true);
    });
});

describe('Stratux addresses are checked before they are saved (review 2026-10-29)', () => {
    // They go into http:// and ws:// URLs: "host/#..." or "user@host" would send
    // the Stratux traffic somewhere else.
    const ConfigEditor = new Function(readFileSync('web/cockpit/config-editor.js', 'utf8') + '\nreturn ConfigEditor;')();
    it('an address or host name (optional :port) passes; anything else does not', () => {
        for (const ok of ['192.168.10.1', '192.168.1.212', '192.168.1.212:80', 'stratux.local']) expect(ConfigEditor.validHost(ok)).toBe(true);
        for (const bad of ['evil.com/#', 'host@evil.com', 'a b', 'http://x', '1.2.3.4:999999', '"><img src=x>', '']) expect(ConfigEditor.validHost(bad)).toBe(false);
    });
});
