/**
 * FlyTab — Sticky-valve verdict banner.
 *
 * Shows StickyValveMonitor's state (web/shared/sticky-valve.js): the pre-takeoff
 * verdict block (NO-GO red, CAUTION yellow, VALVES OK green, CHECKING / PARTIAL /
 * NOT CHECKED neutral) with any context notes, and a separate amber in-flight
 * block (in-flight warnings, and advisories from a run restarted in flight
 * after a data gap). One instance sits over the map, one on the ENG page; both read the same
 * monitor, so dismissing either hides both. The latch rules live in the monitor:
 * this only draws state.dismissable (NO-GO has no DISMISS before a seen stop;
 * CHECKING resolves by itself, so it has none either).
 *
 * In flight (state.phase 'airborne') with a NO-GO on the banner, the 'map'
 * variant collapses to a compact red pill ("NO-GO · CYL 3") so it does not cover
 * the map (Dana Q1, 2026-11-06); it has no DISMISS. The 'inline' ENG page banner
 * keeps the full text. Back on the ground (a seen stop ends the run) the normal
 * banner returns.
 *
 * Every value goes into the DOM through textContent.
 */

class StickyValveBanner {
    /**
     * @param {HTMLElement} container  where the banner goes
     * @param {StickyValveMonitor} monitor
     * @param {'map'|'inline'} [variant]  'map' floats over the map; 'inline' sits in the ENG page flow
     */
    constructor(container, monitor, variant = 'inline') {
        this._monitor = monitor;
        this._variant = variant;
        // The outer element keeps the classes PositionHealthBanner looks for
        // (:scope > .sv-banner--map) and is shown/hidden through style.display.
        this._el = document.createElement('div');
        this._el.className = `sv-banner sv-banner--${variant}`;
        this._el.setAttribute('role', 'alert');
        this._el.style.display = 'none';
        this._verdict = this._block('verdict');
        this._inflight = this._block('inflight');
        container.appendChild(this._el);

        this._onChange = () => this.render();
        monitor.addEventListener('change', this._onChange);
        this.render();
    }

    get element() { return this._el; }

    /** One block: title, lines (findings / notes), references, DISMISS. */
    _block(part) {
        const el = document.createElement('div');
        el.className = 'sv-banner-block';
        el.dataset.part = part;
        const body = document.createElement('div');
        body.className = 'sv-banner-body';
        const title = document.createElement('div');
        title.className = 'sv-banner-title';
        const lines = document.createElement('div');
        lines.className = 'sv-banner-lines';
        const hint = document.createElement('div');
        hint.className = 'sv-banner-hint';
        body.append(title, lines, hint);
        const btn = document.createElement('button');
        btn.className = 'sv-banner-dismiss';
        btn.type = 'button';
        btn.textContent = 'DISMISS';
        el.append(body, btn);
        this._el.appendChild(el);
        const dismiss = () => this._monitor.dismiss(part);
        if (typeof wireTap === 'function') wireTap(btn, dismiss);
        else btn.addEventListener('click', dismiss);
        return { el, title, lines, hint, btn };
    }

    /** Replace a block's lines: [{ text, cls }]. */
    static _setLines(block, lines) {
        block.lines.replaceChildren(...lines.map(({ text, cls }) => {
            const d = document.createElement('div');
            d.className = cls;
            d.textContent = text;
            return d;
        }));
    }

    render() {
        const st = this._monitor.state;
        this._el.style.display = st.visible ? 'flex' : 'none';
        this._renderVerdict(st);
        this._renderInflight(st);
    }

    _renderVerdict(st) {
        const b = this._verdict;
        b.el.style.display = st.verdictVisible ? 'flex' : 'none';
        if (!st.verdictVisible) return;
        const v = st.verdict;
        const kind = { 'NO-GO': 'nogo', 'CAUTION': 'caution', 'VALVES OK': 'ok' }[v] || 'neutral';
        if (this._variant === 'map' && v === 'NO-GO' && st.phase === 'airborne') {
            this._renderCompactNoGo(st);
            return;
        }
        b.el.className = `sv-banner-block sv-banner--${kind}`;
        const names = (rules) => rules.map(StickyValveMonitor.ruleName).join(', ');
        const finding = (f) => ({ text: StickyValveMonitor.describe(f), cls: 'sv-banner-cyl' });
        let title;
        let lines = [];
        switch (v) {
            case 'NO-GO':
                title = 'STICKY VALVE — NO-GO';
                lines = [{ text: 'Do not take off.', cls: 'sv-banner-action' },
                    ...st.findings.filter(f => f.level === 'NO-GO').map(finding)];
                break;
            case 'CAUTION':
                title = 'STICKY VALVE — CAUTION';
                lines = [{ text: 'Check before flight.', cls: 'sv-banner-action' }, ...st.findings.map(finding)];
                break;
            case 'VALVES OK':
                title = 'VALVES OK';
                break;
            case 'PARTIAL':
                title = `VALVE CHECK PARTIAL — not run: ${names(st.rulesNotRun)}`;
                break;
            case 'NOT CHECKED':
                title = `VALVE CHECK NOT RUN — ${st.reason
                    || (st.rulesNotRun.length ? `not enough engine data for: ${names(st.rulesNotRun)}` : 'no engine data')}`;
                break;
            case 'CHECKING':
            default:
                title = 'VALVE CHECK… checking';
                break;
        }
        // Context notes: yellow advisory lines inside whichever verdict shows.
        lines.push(...st.context.map(c => ({ text: StickyValveMonitor.describeContext(c), cls: 'sv-banner-note' })));
        b.title.textContent = title;
        StickyValveBanner._setLines(b, lines);
        const refs = v === 'NO-GO' || v === 'CAUTION';
        b.hint.textContent = refs ? StickyValve.REFERENCES : '';
        b.hint.style.display = refs ? '' : 'none';
        b.btn.style.display = st.dismissable && v !== 'CHECKING' ? '' : 'none';
    }

    /** In flight over the map: a small red pill naming the latched NO-GO cylinders. */
    _renderCompactNoGo(st) {
        const b = this._verdict;
        b.el.className = 'sv-banner-block sv-banner--nogo sv-banner--compact';
        const cyls = [];
        for (const f of st.findings) {
            if (f.level === 'NO-GO' && f.cyl != null && !cyls.includes(f.cyl)) cyls.push(f.cyl);
        }
        cyls.sort((a, c) => a - c);
        b.title.textContent = cyls.length ? `NO-GO · CYL ${cyls.join(', ')}` : 'NO-GO';
        StickyValveBanner._setLines(b, []);
        b.hint.textContent = '';
        b.hint.style.display = 'none';
        b.btn.style.display = 'none';
    }

    _renderInflight(st) {
        const b = this._inflight;
        b.el.style.display = st.inflightVisible ? 'flex' : 'none';
        if (!st.inflightVisible) return;
        b.el.className = 'sv-banner-block sv-banner--inflight';
        const [first, ...more] = [
            ...st.inflight.map(StickyValveMonitor.describeInflight),
            ...(st.advisories || []).map(StickyValveMonitor.describeAdvisory),
        ];
        b.title.textContent = first;
        StickyValveBanner._setLines(b, more.map(text => ({ text, cls: 'sv-banner-cyl' })));
        b.hint.textContent = StickyValve.REFERENCES;
        b.hint.style.display = '';
        b.btn.style.display = '';
    }

    destroy() {
        this._monitor.removeEventListener('change', this._onChange);
        this._el.remove();
    }
}
