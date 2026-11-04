/**
 * Airport slide-out type scale (spec 2026-11-04 §4): nothing below 16 px, no weight below 700, no hex
 * colours, text colours only from the >= 7:1 list - in the panel's CSS and in the inline styles the
 * panel's JS writes.
 *
 * CSS (web/style.css, parsed here):
 *   1. every rule with a PANEL-ONLY class (.airport-panel, .apt-*, .glide-*, .wc-*; not the map's
 *      .apt-label* or the unused .apt-route-* sheet) must pass the checks itself;
 *   2. a global rule for a class the panel SHARES (from the panel's own markup: .popup-*, .wx-*,
 *      .freq-*, .ifr-*, .approach-currency, .btn-close) may break a check only where a rule
 *      ".airport-panel <same selector>" sets that property (and passes) - the scoped override wins
 *      by specificity, so wx-briefing and the Leaflet popups keep their look.
 * JS: style="..." attributes, .style.cssText and .style.<prop> = in airport-popup.js (less the
 * methods that are not the slide-out, EXCLUDED_METHODS), glide-panel.js, wind-compass.js,
 * airport-notes.js.
 * The rendered check (every text element's computed style in Chromium) is the Playwright harness in
 * the redesign report; this test is the static guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const CSS = read('web/style.css');

/** Allowed text colours: the >= 7:1 list; --text-on-accent only on the dark fills (listed below). */
const TEXT_COLOURS = new Set([
    'var(--text-primary)', 'var(--text-secondary)', 'var(--accent-active)',
    'var(--color-caution-on-light)', 'var(--color-danger-on-light)',
    'var(--text-on-accent)', 'inherit', 'currentColor', 'currentcolor', 'transparent',
]);
/** --text-on-accent (white) is allowed only on these fills (white on #003d7a 10.78:1, on #a30d0d 8.01:1). */
const ON_ACCENT_SELECTORS = [
    '.apt-glide-toggle.is-on', '.apt-chip:active', '.apt-topnav-btn.active', '.apt-tfr-tag',
    '.glide-danger .glide-verdict', '.wc-mode-metar.active, .wc-mode-manual.active',
    '.airport-panel .approach-currency.is-bad',
];
const FONT_SIZES = new Set(['var(--text-sm)', 'var(--text-base)', 'var(--text-md)', 'var(--text-lg)',
    'var(--text-xl)', 'var(--text-2xl)', 'inherit']);
/**
 * Explicit exceptions (graphics, not panel text): the wind rose's SVG text labels (user units, the
 * rose scales to the pane; spec: "the wind compass SVG drawing are graphics - keep them").
 */
const EXCEPTIONS = [
    { sel: '.wc-tick-label', prop: 'font-size', why: 'SVG compass-rose tick label (graphic)' },
    { sel: '.wc-frame-label', prop: 'font-size', why: 'SVG compass-rose MAG/TRUE label (graphic)' },
];
/** Not the slide-out: full-screen overlays, the navaid Leaflet popup, the no-panel fallback popup. */
const EXCLUDED_METHODS = ['_openAfdFullscreen', '_flashFrequency', 'showNavaid', '_buildHtml', '_headerHtml', '_actionsHtml'];

const PANEL_CLASS = /^(airport-panel|apt-(?!label|route-)|glide-|wc-)/;

// ---- a small CSS parser (comments stripped; @media / @supports bodies descended) ----
function parseCss(src) {
    const out = [];
    const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const walk = (s) => {
        let i = 0;
        while (i < s.length) {
            const open = s.indexOf('{', i);
            if (open < 0) break;
            const head = s.slice(i, open).trim();
            let depth = 1, j = open + 1;
            while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
            const body = s.slice(open + 1, j - 1);
            if (head.startsWith('@media') || head.startsWith('@supports')) walk(body);
            else if (!head.startsWith('@')) {
                const decls = {};
                for (const d of body.split(';')) {
                    const k = d.indexOf(':');
                    if (k < 0) continue;
                    decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim().replace(/\s*!important$/, '');
                }
                out.push({ head: head.replace(/\s+/g, ' '), sels: head.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), decls });
            }
            i = j;
        }
    };
    walk(text);
    return out;
}
const RULES = parseCss(CSS);
const classesOf = (sel) => [...sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
const isPanelSel = (sel) => classesOf(sel).some((c) => PANEL_CLASS.test(c));

/** The problems of one declaration (empty = fine). `head` decides the --text-on-accent fill rule. */
function problems(prop, value, head) {
    const p = [];
    if (/#[0-9a-f]{3,8}\b/i.test(value)) p.push(`hex colour in ${prop}: ${value}`);
    if (prop === 'font-size') {
        const px = /^([\d.]+)px$/.exec(value);
        if (px ? Number(px[1]) < 16 : !FONT_SIZES.has(value)) p.push(`font-size ${value}`);
    }
    if (prop === 'font-weight') {
        const n = Number(value);
        if (Number.isFinite(n) ? n < 700 : !['bold', 'bolder', 'inherit'].includes(value)) p.push(`font-weight ${value}`);
    }
    if (prop === 'color') {
        if (!TEXT_COLOURS.has(value)) p.push(`text colour ${value}`);
        else if (value === 'var(--text-on-accent)' && !ON_ACCENT_SELECTORS.includes(head)) p.push(`--text-on-accent off a dark fill (${head})`);
    }
    if (prop === 'font' ) p.push(`font shorthand ${value} (use font-size / font-weight)`);
    return p;
}
const excepted = (sel, prop) => EXCEPTIONS.some((e) => e.sel === sel && e.prop === prop);

// ---- the panel's markup classes (for the shared-class check) ----
function stripMethods(src, names) {
    let out = src;
    for (const name of names) {
        const m = new RegExp(`\\n    (?:static |async )?${name}\\([^)]*\\)\\s*\\{`).exec(out);
        if (!m) throw new Error(`method ${name} not found`);
        let depth = 1, j = m.index + m[0].length;
        while (j < out.length && depth) { if (out[j] === '{') depth++; else if (out[j] === '}') depth--; j++; }
        out = out.slice(0, m.index) + `\n    /* ${name} excluded */` + out.slice(j);
    }
    return out;
}
const POPUP = stripMethods(read('web/cockpit/airport-popup.js'), EXCLUDED_METHODS);
const PANEL_JS = {
    'airport-popup.js (slide-out methods)': POPUP,
    'glide-panel.js': read('web/cockpit/glide-panel.js'),
    'wind-compass.js': read('web/cockpit/wind-compass.js'),
    'airport-notes.js': read('web/cockpit/airport-notes.js'),
};
function markupClasses(src) {
    const set = new Set();
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
        for (const t of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[a-z][\w-]*$/i.test(t)) set.add(t);
    }
    for (const m of src.matchAll(/(?:className\s*=\s*|classList\.add\(\s*|el\(\s*'[a-z]+',\s*)'([^']+)'/g)) {
        for (const t of m[1].split(/\s+/)) if (/^[a-z][\w-]*$/i.test(t)) set.add(t);
    }
    return set;
}
const PANEL_MARKUP = new Set(Object.values(PANEL_JS).flatMap((s) => [...markupClasses(s)]));
const SHARED = new Set([...PANEL_MARKUP].filter((c) => !PANEL_CLASS.test(c)));

describe('the panel\'s CSS', () => {
    it('finds the panel and shared classes it is meant to check (sanity)', () => {
        for (const c of ['apt-tab', 'apt-chip', 'glide-verdict', 'wc-table']) expect(PANEL_MARKUP.has(c)).toBe(true);
        for (const c of ['popup-section-title', 'popup-freq-table', 'wx-row-lbl', 'wx-metar', 'freq-value', 'ifr-phone', 'btn-close']) {
            expect(SHARED.has(c)).toBe(true);
        }
        expect(RULES.filter((r) => r.sels.some(isPanelSel)).length).toBeGreaterThan(150);
    });

    it('panel-only rules: no font-size < 16 px, no weight < 700, no hex, text colours from the 7:1 list', () => {
        const bad = [];
        for (const r of RULES) {
            if (!r.sels.some(isPanelSel)) continue;
            for (const [prop, value] of Object.entries(r.decls)) {
                if (r.sels.every((s) => excepted(s, prop))) continue;
                for (const msg of problems(prop, value, r.head)) bad.push(`${r.head} { ${msg} }`);
            }
        }
        expect(bad).toEqual([]);
    });

    it('shared classes: every rule that breaks a check is overridden by an .airport-panel rule for that property', () => {
        const scoped = new Map();      // ".airport-panel <sel>" -> set of props
        for (const r of RULES) {
            for (const s of r.sels) {
                if (!s.startsWith('.airport-panel ')) continue;
                const set = scoped.get(s) || new Set();
                Object.keys(r.decls).forEach((k) => set.add(k));
                scoped.set(s, set);
            }
        }
        const missing = [];
        for (const r of RULES) {
            for (const sel of r.sels) {
                if (isPanelSel(sel)) continue;
                const cls = classesOf(sel);
                if (!cls.length || !cls.every((c) => SHARED.has(c))) continue;
                for (const [prop, value] of Object.entries(r.decls)) {
                    if (!problems(prop, value, r.head).length) continue;
                    if (prop === 'color' && value === 'var(--text-on-accent)') continue;   // judged on the override's fill
                    if (!scoped.get(`.airport-panel ${sel}`)?.has(prop)) missing.push(`${sel} { ${prop}: ${value} }`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('LABEL controls: tabs, pills, ENGINE OUT, top-nav and remark toggles are >= --touch-min tall', () => {
        const get = (h) => RULES.find((r) => r.head === h)?.decls || {};
        for (const h of ['.apt-tab', '.apt-chip', '.apt-glide-toggle', '.apt-topnav-btn', '.apt-rmk-toggle',
            '.wc-mode-metar, .wc-mode-manual', '.apt-plate-back-btn', '.apt-search-row']) {
            expect(get(h)['min-height'], h).toMatch(/var\(--touch-min(, 56px)?\)/);
        }
        expect(get('.apt-chip')['border-radius']).toBe('28px');
        expect(get('.apt-chip').border).toBe('2px solid var(--accent)');
        expect(get('.apt-chip').background).toBe('var(--bg-primary)');
        expect(get('.apt-tab.active').color).toBe('var(--accent-active)');
        expect(get('.apt-tab')['border-bottom']).toBe('3px solid transparent');
        expect(get('.apt-tabs')['overflow-x']).toBe('auto');                 // horizontal-scroll safety kept
    });

    it('the exceptions are only the listed SVG labels, and they really are SVG text', () => {
        const wc = read('web/cockpit/wind-compass.js');
        for (const e of EXCEPTIONS) expect(wc).toMatch(new RegExp(`<text class="${e.sel.slice(1)}"`));
    });
});

describe('inline styles written by the panel\'s JS', () => {
    function inlineProblems(src) {
        const bad = [];
        const check = (where, css) => {
            for (const d of css.split(';')) {
                const k = d.indexOf(':');
                if (k < 0) continue;
                const prop = d.slice(0, k).trim().toLowerCase(), value = d.slice(k + 1).trim();
                if (/\$\{/.test(value) && /^(color|font|font-size|font-weight|background)$/.test(prop)) bad.push(`${where}: dynamic ${prop}`);
                for (const msg of problems(prop, value, '(inline)')) bad.push(`${where}: ${msg}`);
            }
        };
        for (const m of src.matchAll(/style="([^"]*)"/g)) check('style=""', m[1]);
        for (const m of src.matchAll(/\.style\.cssText\s*=\s*(['`])([\s\S]*?)\1/g)) check('style.cssText', m[2]);
        for (const m of src.matchAll(/\.style\.(color|fontSize|fontWeight|background|backgroundColor)\s*=\s*([^;\n]+)/g)) {
            const prop = m[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
            const value = m[2].trim().replace(/^['"`]|['"`]$/g, '');
            if (prop === 'background' || prop === 'background-color') {
                if (/#[0-9a-f]{3,8}\b/i.test(value)) bad.push(`.style.${m[1]}: hex ${value}`);
            } else check(`.style.${m[1]}`, `${prop}:${value}`);
        }
        return bad;
    }
    it.each(Object.keys(PANEL_JS))('%s: no small / light / hex / off-list inline text styles', (name) => {
        expect(inlineProblems(PANEL_JS[name])).toEqual([]);
    });
    it('the excluded methods exist (so the exclusion list stays honest) and nothing else is cut', () => {
        const full = read('web/cockpit/airport-popup.js');
        for (const n of EXCLUDED_METHODS) expect(full).toMatch(new RegExp(`\\n    ${n}\\(`));
        expect(POPUP).toContain('_buildPanelHtml(apt, wx)');
        expect(POPUP).toContain('_weatherHtml(wx)');
        expect(POPUP).toContain('_loadAfdPane(containerEl, icao, state)');
    });
    it('the in-panel phone-copy flash uses a token', () => {
        expect(POPUP).toMatch(/phoneEl\.style\.background = 'var\(--border\)'/);
    });
});
