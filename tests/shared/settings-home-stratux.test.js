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
