// tests/shared/altitude-utils.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// altitude-utils.js uses plain function declarations (no import/export).
// Use new Function to load it in a closure and extract the four functions.
const src = readFileSync('web/shared/altitude-utils.js', 'utf8');
const {
    parseAltFt,
    formatAlt,
    formatAltBand,
    formatAdvisoryAltBand,
} = new Function(`
    ${src}
    return { parseAltFt, formatAlt, formatAltBand, formatAdvisoryAltBand };
`)();

describe('parseAltFt', () => {
    it('parses bare numeric as hundreds of feet', () => {
        expect(parseAltFt('260')).toBe(26000);
        expect(parseAltFt('080')).toBe(8000);
        expect(parseAltFt('040')).toBe(4000);
    });

    it('parses FL prefix', () => {
        expect(parseAltFt('FL120')).toBe(12000);
        expect(parseAltFt('FL240')).toBe(24000);
    });

    it('returns 0 for SFC', () => {
        expect(parseAltFt('SFC')).toBe(0);
    });

    it('returns null for FZL token', () => {
        expect(parseAltFt('FZL')).toBeNull();
    });

    it('returns null for empty string and null', () => {
        expect(parseAltFt('')).toBeNull();
        expect(parseAltFt(null)).toBeNull();
    });

    it('returns null for unparseable strings', () => {
        expect(parseAltFt('UNKNOWN')).toBeNull();
    });
});

describe('formatAlt', () => {
    it('formats surface as SFC', () => {
        expect(formatAlt('SFC')).toBe('SFC');
        expect(formatAlt('000')).toBe('SFC');
    });

    it('formats FL levels for altitudes >= 18,000 ft', () => {
        expect(formatAlt('180')).toBe('FL180');
        expect(formatAlt('240')).toBe('FL240');
    });

    it('formats low altitudes as localized thousands', () => {
        expect(formatAlt('080')).toBe('8,000');
        expect(formatAlt('040')).toBe('4,000');
        // 12,000 ft is below the FL threshold (18,000 ft)
        expect(formatAlt('120')).toBe('12,000');
    });

    it('returns null for FZL and empty string', () => {
        expect(formatAlt('FZL')).toBeNull();
        expect(formatAlt('')).toBeNull();
    });
});

describe('formatAltBand', () => {
    it('formats a complete band (both below FL threshold)', () => {
        // 4,000 – 12,000 (both < 18,000 ft, so no FL prefix)
        expect(formatAltBand('040', '120')).toBe('4,000 – 12,000');
    });

    it('formats a band that spans the FL threshold', () => {
        // 4,000 – FL240
        expect(formatAltBand('040', '240')).toBe('4,000 – FL240');
    });

    it('handles missing base (empty string)', () => {
        expect(formatAltBand('', '120')).toBe('Below 12,000');
    });

    it('handles missing top (empty string)', () => {
        expect(formatAltBand('040', '')).toBe('Above 4,000');
    });

    it('returns em-dash when both base and top are missing', () => {
        expect(formatAltBand('', '')).toBe('—');
    });
});

describe('formatAdvisoryAltBand', () => {
    it('formats FRZLVL hazard using fzlbase/fzltop', () => {
        const adv = { hazard: 'FRZLVL', fzlbase: '040', fzltop: '080' };
        expect(formatAdvisoryAltBand(adv)).toBe('FRZLVL 4,000–8,000');
    });

    it('formats FRZLVL hazard using level when fzlbase/fzltop absent', () => {
        const adv = { hazard: 'FRZLVL', fzlbase: '', fzltop: '', level: '060' };
        expect(formatAdvisoryAltBand(adv)).toBe('FRZLVL 6,000');
    });

    it('formats ICING with base=FZL as FRZLVL → <top>', () => {
        const adv = { hazard: 'ICE', base: 'FZL', top: '180' };
        expect(formatAdvisoryAltBand(adv)).toBe('FRZLVL → FL180');
    });

    it('formats ICING with base=FZL and no top as Above FRZLVL', () => {
        const adv = { hazard: 'ICE', base: 'FZL', top: '' };
        expect(formatAdvisoryAltBand(adv)).toBe('Above FRZLVL');
    });

    it('formats ordinary advisory with base/top', () => {
        const adv = { hazard: 'TURB', base: '040', top: '180' };
        expect(formatAdvisoryAltBand(adv)).toBe('4,000 – FL180');
    });

    it('falls back to level when base/top both empty', () => {
        const adv = { hazard: 'TURB', base: '', top: '', level: '060' };
        expect(formatAdvisoryAltBand(adv)).toBe('6,000');
    });

    it('returns em-dash when all fields are absent', () => {
        const adv = { hazard: 'MT_OBSC', base: '', top: '', level: '' };
        expect(formatAdvisoryAltBand(adv)).toBe('—');
    });
});
