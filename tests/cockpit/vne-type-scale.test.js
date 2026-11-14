/**
 * Vne / Va card type scale and pill styling (web/style.css, the "Vne / Va map pill + card" block).
 *
 * Card (.vne-card and every .vne-* class inside it): the layers slide-out scale (Dana 2026-11-06,
 * applied to this card 2026-11-13) - var(--text-sm) 16 px for everything read or tapped,
 * var(--text-xs) 14 px for labels only, one font (--font-ui), weight >= 700, text colours only from
 * the >= 7:1 list, no hex colours.
 * Pill (.vne-pill*): a map instrument styled like an engine box row (Dana 2026-11-13: "same height
 * as the engine rows") - the same padding, border, corners and label / value fonts as
 * .engine-overlay-field / -label / -value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const CSS = readFileSync('web/style.css', 'utf8');
const BLOCK = CSS.slice(CSS.indexOf('/* ========== Vne / Va map pill + card'));

/** [{ selector, decls: { prop: value } }] for every rule in a CSS string (no nesting here). */
function rules(css) {
    const out = [];
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = {};
        for (const d of m[2].split(';')) {
            const i = d.indexOf(':');
            if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
        out.push({ selector: m[1].trim(), decls });
    }
    return out;
}
const rule = (css, sel) => rules(css).find((r) => r.selector === sel)?.decls || {};

const TEXT_COLOURS = new Set(['var(--text-primary)', 'var(--text-secondary)', 'var(--color-danger-on-light)',
    'var(--text-on-accent)', 'inherit']);
const FONT_SIZES = new Set(['var(--text-xs)', 'var(--text-sm)', 'inherit']);

const cardRules = rules(BLOCK).filter((r) => !r.selector.includes('.vne-pill'));

describe('card type scale', () => {
    it('the block exists and has card rules', () => {
        expect(BLOCK.length).toBeGreaterThan(1000);
        expect(cardRules.length).toBeGreaterThan(20);
    });

    it.each(cardRules.map((r) => [r.selector, r.decls]))('%s', (selector, d) => {
        if (d['font-size']) expect(FONT_SIZES.has(d['font-size']), `font-size ${d['font-size']}`).toBe(true);
        if (d['font-family']) expect(d['font-family'], 'font-family').toBe('var(--font-ui)');
        if (d['font-weight']) expect(Number(d['font-weight']), 'font-weight').toBeGreaterThanOrEqual(700);
        if (d.color) expect(TEXT_COLOURS.has(d.color), `color ${d.color}`).toBe(true);
        for (const [prop, v] of Object.entries(d)) expect(/#[0-9a-f]{3,6}\b/i.test(v), `${prop}: ${v}`).toBe(false);
    });

    it('labels are 14 px, values and entries 16 px', () => {
        expect(rule(BLOCK, '.vne-field-label')['font-size']).toBe('var(--text-xs)');
        expect(rule(BLOCK, '.vne-primary-label, .vne-primary-unit')['font-size']).toBe('var(--text-xs)');
        expect(rule(BLOCK, '.vne-primary-value')['font-size']).toBe('var(--text-sm)');
        expect(rule(BLOCK, '.vne-input')['font-size']).toBe('var(--text-sm)');
        expect(rule(BLOCK, '.vne-status')['font-size']).toBe('var(--text-sm)');
        expect(rule(BLOCK, '.vne-field-error')['font-size']).toBe('var(--text-sm)');   // a warning: 16, not 14
    });

    it('touch targets stay at least --touch-min', () => {
        for (const sel of ['.vne-input', '.vne-step, .vne-sign, .vne-clear', '.vne-close']) {
            expect(rule(BLOCK, sel)['min-height'], sel).toBe('var(--touch-min, 56px)');
        }
    });
});

describe('pill matches an engine box row', () => {
    const field = rule(CSS, '.engine-overlay-field');
    const label = rule(CSS, '.engine-overlay-label');
    const value = rule(CSS, '.engine-overlay-value');
    const pill = rule(BLOCK, '.vne-pill');

    it('same padding, border and corners; no min-height or shadow making it taller', () => {
        for (const p of ['padding', 'border', 'border-radius', 'background']) expect(pill[p], p).toBe(field[p]);
        expect(pill['min-height']).toBeUndefined();
        expect(pill['box-shadow']).toBeUndefined();
    });

    it('same label and value fonts', () => {
        const pl = rule(BLOCK, '.vne-pill-label, .vne-pill-alt');
        for (const p of ['font-family', 'font-size', 'font-weight', 'color', 'letter-spacing', 'text-transform']) {
            expect(pl[p], `label ${p}`).toBe(label[p]);
        }
        const pv = rule(BLOCK, '.vne-pill b');
        for (const p of ['font-family', 'font-size', 'font-weight', 'color']) expect(pv[p], `value ${p}`).toBe(value[p]);
    });

    it('its touch area still reaches --touch-min (8 px above and below)', () => {
        const hit = rule(BLOCK, '.vne-pill::after');
        expect(hit.top).toBe('-8px');
        expect(hit.bottom).toBe('-8px');
    });
});
