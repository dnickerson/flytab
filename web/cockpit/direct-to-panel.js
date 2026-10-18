/**
 * FlyTab — Direct-To panel (map D→ button; Dana, 2026-10-18).
 *
 * Lists the route's waypoints (the next one first, then the rest ahead, then
 * the ones already passed) and takes any identifier -- an airport, navaid or
 * fix from the on-tablet NASR data, so it works in flight with no internet.
 * Picking one calls app.directTo(target): a route waypoint becomes the next
 * waypoint; anything else is inserted as the next waypoint, and the route
 * continues after it. The leg starts at the present position (ActiveRoute
 * leg origin), drawn as a fixed magenta course.
 */
class DirectToPanel {
    constructor(app, nasrDb) {
        this._app = app;
        this._nasr = nasrDb;
        this._el = null;
        this._busy = false;
    }

    isOpen() { return !!this._el; }

    open() {
        this.close();
        const el = document.createElement('div');
        el.className = 'dto-overlay';
        el.innerHTML = `
            <div class="dto-card" role="dialog" aria-label="Direct To">
                <div class="dto-head">
                    <span class="dto-title">Direct To</span>
                    <button class="dto-close" aria-label="Close">✕</button>
                </div>
                <div class="dto-entry">
                    <input class="dto-input" type="text" placeholder="Identifier" autocapitalize="characters"
                           autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
                    <button class="dto-go">GO</button>
                </div>
                <div class="dto-msg" hidden></div>
                <div class="dto-list"></div>
            </div>`;
        document.body.appendChild(el);
        this._el = el;
        this._openedAt = Date.now();
        const input = el.querySelector('.dto-input');
        wireTap(el.querySelector('.dto-close'), () => this.close());
        wireTap(el.querySelector('.dto-go'), () => this._goTyped());
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._goTyped(); } });
        // Backdrop tap closes -- but not the synthetic click that follows the
        // D→ tap itself (D→ is outside the card, so it lands on the backdrop):
        // the panel closed as it opened (review 2026-10-18).
        el.addEventListener('click', (e) => {
            if (e.target !== el) return;
            if (Date.now() - this._openedAt < 500) return;
            if (typeof _wireTapLastTouchAt !== 'undefined' && Date.now() - _wireTapLastTouchAt < 350) return;
            this.close();
        });
        this._renderList();
        if (!this._position()) this._say('No GPS position — direct-to needs a fix');
    }

    close() {
        if (this._el) this._el.remove();
        this._el = null;
        this._busy = false;
    }

    _position() { return this._app?.cockpitMap?.ownPosition?.() || null; }

    _say(text) {
        const m = this._el?.querySelector('.dto-msg');
        if (!m) return;
        m.textContent = text || '';
        m.hidden = !text;
    }

    /** Route waypoints: the active one, the rest ahead, then those passed (nearest first). */
    _ordered() {
        const rt = this._app?.routeTable;
        const wps = rt?._waypoints || [];
        if (wps.length < 2) return [];
        const a = Math.max(0, Math.min(rt._activeIndex, wps.length - 1));
        const ahead = wps.slice(a).map((wp, k) => ({ wp, i: a + k, passed: false }));
        const behind = wps.slice(0, a).map((wp, k) => ({ wp, i: k, passed: true })).reverse();
        return [...ahead, ...behind];
    }

    _renderList() {
        const list = this._el?.querySelector('.dto-list');
        if (!list) return;
        list.textContent = '';
        const pos = this._position();
        const rows = this._ordered();
        if (!rows.length) {
            const n = document.createElement('div');
            n.className = 'dto-none';
            n.textContent = 'No route loaded — type an identifier to fly direct from here';
            list.appendChild(n);
            return;
        }
        for (const { wp, i, passed } of rows) {
            const b = document.createElement('button');
            b.className = 'dto-row' + (passed ? ' is-passed' : '') + (i === this._app.routeTable._activeIndex ? ' is-next' : '');
            const id = document.createElement('span'); id.className = 'dto-row-id'; id.textContent = wp.icao || wp.name || '?';
            const name = document.createElement('span'); name.className = 'dto-row-name'; name.textContent = wp.name && wp.name !== wp.icao ? wp.name : '';
            const dist = document.createElement('span'); dist.className = 'dto-row-dist';
            const nm = pos && Number.isFinite(wp.lat) && Number.isFinite(wp.lon) ? NasrDB.haversineNm(pos.lat, pos.lon, wp.lat, wp.lon) : null;
            dist.textContent = [i === this._app.routeTable._activeIndex ? 'NEXT' : passed ? 'passed' : '', nm != null ? `${Math.round(nm)} nm` : ''].filter(Boolean).join(' · ');
            b.append(id, name, dist);
            wireTap(b, () => this._go(wp));
            list.appendChild(b);
        }
    }

    /** The route waypoint for these ids (first one still ahead), else null. */
    _onRoute(ids) {
        const want = new Set(ids.filter(Boolean).map((x) => String(x).toUpperCase()));
        const rows = this._ordered();
        const is = (r) => [r.wp.icao, r.wp.id].some((x) => x && want.has(String(x).toUpperCase()));
        return (rows.find((r) => !r.passed && is(r)) || rows.find(is))?.wp || null;
    }

    async _goTyped() {
        if (this._busy) return;
        const raw = this._el?.querySelector('.dto-input')?.value || '';
        const id = raw.trim().toUpperCase();
        if (!id) { this._say('Type an identifier'); return; }
        // Exactly this id on the route: that waypoint. (KCAE on the route for a
        // typed CAE is decided below: CAE may mean the VORTAC.)
        const onRoute = this._onRoute([id]);
        if (onRoute) { await this._go(onRoute); return; }
        let found = [];
        try { found = await DirectToPanel.lookupAll(this._nasr, id); } catch { found = []; }
        if (!this._el) return;
        if (!found.length) { this._say(`${id} not found in the airport, navaid or fix data`); return; }
        if (found.length === 1) { await this._go(found[0]); return; }
        this._showChoices(found);       // CAE: the VOR or KCAE, 6 nm apart -- the pilot picks
    }

    _showChoices(found) {
        const list = this._el?.querySelector('.dto-list');
        if (!list) return;
        this._say('More than one match — choose');
        list.textContent = '';
        const pos = this._position();
        for (const f of found) {
            const b = document.createElement('button');
            b.className = 'dto-row';
            const id = document.createElement('span'); id.className = 'dto-row-id'; id.textContent = f.icao;
            const name = document.createElement('span'); name.className = 'dto-row-name'; name.textContent = `${f.name} — ${f.kind}`;
            const dist = document.createElement('span'); dist.className = 'dto-row-dist';
            dist.textContent = pos ? `${Math.round(NasrDB.haversineNm(pos.lat, pos.lon, f.lat, f.lon))} nm` : '';
            b.append(id, name, dist);
            wireTap(b, () => this._go(f));
            list.appendChild(b);
        }
    }

    async _go(target) {
        if (this._busy || !this._el) return;          // one Direct-To per panel (GO twice, Enter + GO)
        if (!this._position()) { this._say('No GPS position — direct-to needs a fix'); return; }
        this._busy = true;
        try {
            // A looked-up point already on the route: that waypoint, not a copy.
            const t = this._app.routeTable?._waypoints?.includes(target) ? target : (this._onRoute([target.icao]) || target);
            const r = await this._app.directTo(t);
            if (r?.ok) this.close(); else this._say(r?.msg || 'Direct-To failed');
        } catch (err) {
            this._say(`Direct-To failed: ${err?.message || err}`);
        } finally {
            this._busy = false;
        }
    }

    /**
     * Every NASR point with this identifier: the airport as typed, the airport
     * with K added (3 characters), the navaid and the fix. CAE is both the
     * Columbia VOR and KCAE, 6 nm apart, so the panel asks rather than guess
     * (review 2026-10-18). Each: { icao, name, type?, kind, lat, lon }.
     */
    static async lookupAll(nasr, id) {
        if (!nasr || !id) return [];
        const out = [];
        const add = (r, icao, kind, type) => {
            if (!r || !Number.isFinite(r.lat) || !Number.isFinite(r.lon)) return;
            if (out.some((o) => o.icao === icao && o.kind === kind)) return;
            out.push({ icao, name: r.name || icao, kind, lat: r.lat, lon: r.lon, ...(type ? { type } : {}) });
        };
        const apt = await nasr.getAirport(id);
        add(apt, apt?.icao || id, 'airport', 'APT');
        if (/^[A-Z0-9]{3}$/.test(id)) { const k = await nasr.getAirport('K' + id); add(k, k?.icao || 'K' + id, 'airport', 'APT'); }
        const nav = await nasr.getNavaid?.(id);
        add(nav, nav?.id || id, nav?.type ? `navaid (${nav.type})` : 'navaid');
        const fix = await nasr.getFix?.(id);
        add(fix, fix?.id || id, 'fix');
        return out;
    }
}

if (typeof window !== 'undefined') window.DirectToPanel = DirectToPanel;
