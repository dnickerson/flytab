/**
 * FlyTab — COM frequency entry and history (radio frequency tool).
 *
 * The pilot types a frequency a controller gives, without the leading "1"
 * (every VHF COM frequency starts with it): "3575" -> 135.750, "21725" ->
 * 121.725. Valid: 118.000-136.975 MHz in 25 kHz steps (US channel spacing).
 * The history keeps the last HISTORY_MAX entries, newest first, on this tablet.
 */
class FreqEntry {
    static MIN_KHZ = 118000;
    static MAX_KHZ = 136975;
    static STEP_KHZ = 25;
    static MAX_DIGITS = 5;          // after the assumed "1": 2 for the MHz, up to 3 decimals

    /** What the display shows while typing: "1", "13", "135.", "135.7", "135.75", "135.750". */
    static display(digits) {
        const d = String(digits || '').replace(/\D/g, '').slice(0, FreqEntry.MAX_DIGITS);
        if (d.length <= 2) return `1${d}`;
        return `1${d.slice(0, 2)}.${d.slice(2)}`;
    }

    /**
     * Typed digits (without the leading "1") -> { ok: true, khz, mhz: '135.750' }
     * or { ok: false, reason }. Needs at least one decimal digit.
     */
    static parse(digits) {
        const d = String(digits || '').replace(/\D/g, '');
        if (d.length < 3) return { ok: false, reason: 'Enter at least one digit after the decimal point' };
        if (d.length > FreqEntry.MAX_DIGITS) return { ok: false, reason: 'Too many digits' };
        const mhz = 100 + Number(d.slice(0, 2));
        const khz = mhz * 1000 + Number(d.slice(2).padEnd(3, '0'));
        if (khz < FreqEntry.MIN_KHZ || khz > FreqEntry.MAX_KHZ) {
            return { ok: false, reason: 'Not a COM frequency (118.000–136.975)' };
        }
        if (khz % FreqEntry.STEP_KHZ !== 0) {
            return { ok: false, reason: 'Not on a 25 kHz channel' };
        }
        return { ok: true, khz, mhz: FreqEntry.format(khz) };
    }

    /** 135750 -> "135.750" */
    static format(khz) {
        return `${Math.floor(khz / 1000)}.${String(khz % 1000).padStart(3, '0')}`;
    }
}

class FreqHistory {
    static KEY = 'flytab_freq_history';
    static HISTORY_MAX = 20;

    /** Newest first. Never throws: storage unavailable or damaged -> []. */
    static list() {
        try {
            const raw = JSON.parse(localStorage.getItem(FreqHistory.KEY) || '[]');
            if (!Array.isArray(raw)) return [];
            return raw.filter((e) => e && typeof e.mhz === 'string' && /^1[1-3]\d\.\d{3}$/.test(e.mhz)
                && typeof e.at === 'string');
        } catch { return []; }
    }

    /**
     * Add a frequency (moves it to the top if already there).
     * ctx: { altFt, lat, lon, label } -- where and how it was entered; all optional.
     */
    static add(mhz, ctx = {}) {
        const entry = {
            mhz,
            at: new Date().toISOString(),
            ...(Number.isFinite(ctx.altFt) ? { altFt: Math.round(ctx.altFt) } : {}),
            ...(Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon)
                ? { lat: Math.round(ctx.lat * 1e4) / 1e4, lon: Math.round(ctx.lon * 1e4) / 1e4 } : {}),
            ...(typeof ctx.label === 'string' && ctx.label ? { label: ctx.label.slice(0, 40) } : {}),
        };
        const list = [entry, ...FreqHistory.list().filter((e) => e.mhz !== mhz)].slice(0, FreqHistory.HISTORY_MAX);
        try { localStorage.setItem(FreqHistory.KEY, JSON.stringify(list)); } catch { /* storage full: keep going */ }
        return list;
    }

    static remove(mhz) {
        const list = FreqHistory.list().filter((e) => e.mhz !== mhz);
        try { localStorage.setItem(FreqHistory.KEY, JSON.stringify(list)); } catch { /* ignore */ }
        return list;
    }

    static clear() {
        try { localStorage.removeItem(FreqHistory.KEY); } catch { /* ignore */ }
    }
}

if (typeof window !== 'undefined') { window.FreqEntry = FreqEntry; window.FreqHistory = FreqHistory; }
