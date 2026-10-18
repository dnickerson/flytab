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
        const input = el.querySelector('.dto-input');
        wireTap(el.querySelector('.dto-close'), () => this.close());
        wireTap(el.querySelector('.dto-go'), () => this._goTyped());
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._goTyped(); } });
        el.addEventListener('click', (e) => { if (e.target === el) this.close(); });
        this._renderList();
        if (!this._position()) this._say('No GPS position — direct-to needs a fix');
    }

    close() {
        if (this._el) this._el.remove();
        this._el = null;
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

    async _goTyped() {
        const raw = this._el?.querySelector('.dto-input')?.value || '';
        const id = raw.trim().toUpperCase();
        if (!id) { this._say('Type an identifier'); return; }
        // On the route already: that waypoint (the first one still ahead), not a copy.
        const rows = this._ordered();
        const hit = rows.find((r) => !r.passed && [r.wp.icao, r.wp.id].includes(id))
                 || rows.find((r) => [r.wp.icao, r.wp.id].includes(id));
        if (hit) { await this._go(hit.wp); return; }
        let found = null;
        try { found = await DirectToPanel.lookup(this._nasr, id); } catch { found = null; }
        if (!found) { this._say(`${id} not found in the airport, navaid or fix data`); return; }
        await this._go(found);
    }

    async _go(target) {
        if (!this._position()) { this._say('No GPS position — direct-to needs a fix'); return; }
        const r = await this._app.directTo(target);
        if (r?.ok) this.close(); else this._say(r?.msg || 'Direct-To failed');
    }

    /** An airport (also K + 3 letters), navaid or fix from NASR: { icao, name, type?, lat, lon } or null. */
    static async lookup(nasr, id) {
        if (!nasr || !id) return null;
        const pt = (r, icao, type) => (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)
            ? { icao, name: r.name || icao, lat: r.lat, lon: r.lon, ...(type ? { type } : {}) } : null);
        let apt = await nasr.getAirport(id);
        if (!apt && /^[A-Z0-9]{3}$/.test(id)) apt = await nasr.getAirport('K' + id);
        if (apt) return pt(apt, apt.icao || id, 'APT');
        const nav = await nasr.getNavaid?.(id);
        if (nav) return pt(nav, nav.id || id);
        const fix = await nasr.getFix?.(id);
        if (fix) return pt(fix, fix.id || id);
        return null;
    }
}

if (typeof window !== 'undefined') window.DirectToPanel = DirectToPanel;
