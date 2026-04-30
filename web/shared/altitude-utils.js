/**
 * Altitude parsing/formatting helpers for AWC G-AIRMET advisories.
 *
 * AWC G-AIRMET altitude convention (verified against the live API):
 *   "SFC"   → surface
 *   "FZL"   → "from the freezing level" (icing AIRMETs only — special token)
 *   "FL120" → flight level form, FL120 = 12,000 ft
 *   "120"   → bare numeric form, also FL120 = 12,000 ft  (HUNDREDS of feet)
 *   "080"   → FL080 = 8,000 ft
 *   ""/null → not specified
 *
 * The bare-numeric → hundreds-of-feet rule is the one that's easy to miss:
 * "260" in the API means 26,000 ft, NOT 260 ft. Apply *100 when parsing.
 */

/** Parse altitude value to integer feet. Returns null for empty/unparseable/special tokens. */
function parseAltFt(val) {
    if (val == null || val === '') return null;
    const s = String(val).trim().toUpperCase();
    if (!s) return null;
    if (s === 'SFC') return 0;
    if (s === 'FZL') return null; // sentinel: caller must handle
    if (s.startsWith('FL')) {
        const fl = parseInt(s.slice(2));
        return isNaN(fl) ? null : fl * 100;
    }
    const n = parseInt(s);
    if (isNaN(n)) return null;
    return n * 100;
}

/** Format altitude value for display. Returns null for empty/unparseable/special tokens. */
function formatAlt(val) {
    const ft = parseAltFt(val);
    if (ft == null) return null;
    if (ft === 0) return 'SFC';
    return ft >= 18000 ? `FL${Math.round(ft / 100).toString().padStart(3, '0')}` : ft.toLocaleString();
}

/** Format an altitude band: "8,000 – FL240", "Above SFC", "Below FL180", or "—". */
function formatAltBand(base, top) {
    const b = formatAlt(base);
    const t = formatAlt(top);
    if (b && t) return `${b} – ${t}`;
    if (b) return `Above ${b}`;
    if (t) return `Below ${t}`;
    return '—';
}

/**
 * Format the altitude band for a G-AIRMET advisory.
 *
 * Three hazard-specific cases that need explicit handling:
 *   - FRZLVL: altitude lives in `level` (and sometimes `fzlbase/fzltop`), NOT base/top.
 *   - ICING with `base === "FZL"`: icing extends from the freezing level (defined
 *     by fzlbase/fzltop) up to `top`. Display "FZL–<top>".
 *   - Everything else: ordinary base/top range, with `level` as fallback.
 */
function formatAdvisoryAltBand(adv) {
    const hazard = (adv.hazard || '').toUpperCase();

    if (hazard === 'FRZLVL') {
        const fb = formatAlt(adv.fzlbase);
        const ft = formatAlt(adv.fzltop);
        if (fb && ft) return `FZL ${fb}–${ft}`;
        const lvl = formatAlt(adv.level);
        if (lvl) return `FZL ${lvl}`;
        return '—';
    }

    const baseToken = String(adv.base || '').trim().toUpperCase();
    if (baseToken === 'FZL') {
        const t = formatAlt(adv.top);
        return t ? `FZL–${t}` : 'FZL';
    }

    const baseTop = formatAltBand(adv.base, adv.top);
    if (baseTop !== '—') return baseTop;
    const lvl = formatAlt(adv.level);
    return lvl || '—';
}
