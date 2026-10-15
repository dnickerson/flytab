/**
 * Toasts must sit above the tab bar. .toast used bottom: 80px while the tab bar
 * is 72px tall and lifted by the Android nav-bar inset (bottom:
 * var(--android-nav-height), z-index 99999), so on the tablet every toast was
 * hidden behind it -- including PR A's restart and pause notices (2026-10-15,
 * measured with elementFromPoint: the toast's centre hit #tabBar).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const css = readFileSync('web/style.css', 'utf8');
const rule = (sel) => {
    const i = css.search(new RegExp(`^${sel.replace('.', '\\.')}\\s*\\{`, 'm'));
    return css.slice(i, css.indexOf('}', i));
};

describe('toast placement', () => {
    it('the tab bar height variable includes the Android nav-bar inset', () => {
        expect(css).toMatch(/--tab-bar-height:\s*calc\(72px \+ var\(--android-nav-height\)\)/);
        expect(rule('#tabBar')).toMatch(/bottom:\s*var\(--android-nav-height/);
    });

    it('.toast is placed above the tab bar, not at a fixed offset', () => {
        const t = rule('.toast');
        expect(t).toMatch(/bottom:\s*calc\(var\(--tab-bar-height\)\s*\+\s*\d+px\)/);
        expect(t).not.toMatch(/bottom:\s*80px/);
    });
});
