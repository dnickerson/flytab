/**
 * FlyPi — Adaptive Range Calculator
 * Real-time range/endurance from live engine data fused with route and winds.
 * No other EFB provides this — actual fuel remaining + actual burn rate + actual GS.
 */

class RangeCalc {
    constructor(stratuxClient, enginePanel, cockpitMap) {
        this.stratux = stratuxClient;
        this.enginePanel = enginePanel;
        this.cockpitMap = cockpitMap;
        this.plan = null;
        this._rangeRing = null;
        this._showRangeRing = false;
        this._updateTimer = null;
    }

    init() {
        // Update every 2s (matches engine poll cycle)
        this._updateTimer = setInterval(() => this._update(), 2000);
    }

    destroy() {
        if (this._updateTimer) { clearInterval(this._updateTimer); this._updateTimer = null; }
        this._removeRangeRing();
    }

    setPlan(plan) {
        this.plan = plan;
    }

    _update() {
        const engData = this.enginePanel ? this.enginePanel.lastData : null;
        const sit = this.stratux ? this.stratux.situation : null;

        // Canonical live fuel read (manual override > tracked tank state > capacity).
        // Was: engData.fuel_remaining_gal || engData.fuel_gal || engData.Gallons_Rem — none
        // of those names exist anywhere in the engine_monitor payload (the EDM parser emits
        // `Fuel_Remaining`, the Pi fuel tracker is nested at `fuel.fuel_remaining`), so this
        // always resolved to 0 and the nav strip was permanently "—" with no range ring.
        //
        // A `capacity` source means nothing is actually tracked — it is a planning default,
        // not a measurement. Rendering it here would show FUEL 36.0 / RANGE 540 / ENDURANCE
        // 4:00 in green and paint a 540 nm range ring on the map with no fuel data behind it
        // (measured). That is the unacceptable error direction, so fall through to the
        // existing "—" placeholders instead.
        const fuelRead = (typeof FuelState !== 'undefined')
            ? FuelState.getCurrentFuel()
            : { gallons: 0, source: 'none' };
        const fuelRemaining = (fuelRead.source === 'capacity') ? 0 : fuelRead.gallons;
        // GPH stays sourced from live engine data — the plan's Non-goals preserve the
        // live-burn-rate override; only the gallons source is unified here.
        const gph = engData ? (engData.fuel_flow_gph || engData.gph || engData.Fuel_Flow || 0) : 0;
        const gs = sit ? (sit.ground_speed || 0) : 0;

        // Update nav strip RANGE
        const rangeEl = document.getElementById('ns-range');
        const fuelEl = document.getElementById('ns-fuel-rem');
        const endurEl = document.getElementById('ns-fuel-endur');

        if (!fuelRemaining || !gph || gph <= 0) {
            if (rangeEl) rangeEl.textContent = '—';
            if (fuelEl) fuelEl.textContent = '—';
            if (endurEl) endurEl.textContent = '';
            this._removeRangeRing();
            return;
        }

        // Range NM
        const rangeNm = gs > 10 ? (fuelRemaining / gph) * gs : 0;
        if (rangeEl) rangeEl.textContent = rangeNm > 0 ? Math.round(rangeNm) : '—';

        // Fuel remaining + endurance
        const endurance = FuelEngine.endurance(fuelRemaining, gph);
        if (fuelEl) fuelEl.textContent = fuelRemaining.toFixed(1);
        if (endurEl) endurEl.textContent = `${endurance.hours}:${String(endurance.minutes).padStart(2, '0')}`;

        // Fuel at destination + reserve
        this._updateFuelAtDest(fuelRemaining, gph, gs, sit);

        // Range ring on map
        if (this._showRangeRing && sit && sit.lat && sit.lon && rangeNm > 0) {
            this._drawRangeRing(sit.lat, sit.lon, rangeNm);
        } else {
            this._removeRangeRing();
        }
    }

    _updateFuelAtDest(fuelRemaining, gph, gs, sit) {
        const fuelEl = document.getElementById('ns-fuel-rem');
        const endurEl = document.getElementById('ns-fuel-endur');
        if (!fuelEl) return;

        if (!this.plan || !sit || !sit.lat || !sit.lon) {
            // No plan — just color by total endurance
            this._colorFuelIndicator(fuelEl, endurEl, fuelRemaining, gph);
            return;
        }

        // Calculate fuel needed for remaining route
        const fuelForRoute = this._fuelForRemainingRoute(fuelRemaining, gph, gs, sit);
        if (fuelForRoute === null) {
            this._colorFuelIndicator(fuelEl, endurEl, fuelRemaining, gph);
            return;
        }

        const fuelAtDest = fuelRemaining - fuelForRoute;
        const reserveMin = gph > 0 ? (fuelAtDest / gph) * 60 : 0;

        // Color coding based on reserve
        if (reserveMin >= 60) {
            // Green: > 1 hour reserve
            fuelEl.className = 'nav-strip-value fuel-green';
            if (endurEl) endurEl.className = 'nav-strip-sub fuel-green';
        } else if (reserveMin >= 30) {
            // Yellow: > 30 min reserve (VFR day minimum)
            fuelEl.className = 'nav-strip-value fuel-yellow';
            if (endurEl) endurEl.className = 'nav-strip-sub fuel-yellow';
        } else {
            // Red: < 30 min reserve — ALERT
            fuelEl.className = 'nav-strip-value fuel-red';
            if (endurEl) endurEl.className = 'nav-strip-sub fuel-red';
        }
    }

    _colorFuelIndicator(fuelEl, endurEl, fuelRemaining, gph) {
        if (!fuelEl) return;
        const endurMin = gph > 0 ? (fuelRemaining / gph) * 60 : 0;

        if (endurMin >= 90) {
            fuelEl.className = 'nav-strip-value fuel-green';
            if (endurEl) endurEl.className = 'nav-strip-sub fuel-green';
        } else if (endurMin >= 45) {
            fuelEl.className = 'nav-strip-value fuel-yellow';
            if (endurEl) endurEl.className = 'nav-strip-sub fuel-yellow';
        } else {
            fuelEl.className = 'nav-strip-value fuel-red';
            if (endurEl) endurEl.className = 'nav-strip-sub fuel-red';
        }
    }

    _fuelForRemainingRoute(fuelRemaining, gph, gs, sit) {
        if (!this.plan || !this.plan.waypoints || this.plan.waypoints.length < 2) return null;

        const wps = this.plan.waypoints;
        // Find active waypoint index (closest ahead)
        let activeIdx = 0;
        if (typeof app !== 'undefined' && app.instrumentStrip) {
            activeIdx = app.instrumentStrip._activeWpIndex || 0;
        }
        if (activeIdx >= wps.length) return null;

        let totalFuel = 0;

        // Active leg: use actual GS
        const nextWp = wps[activeIdx];
        if (nextWp && nextWp.lat && nextWp.lon) {
            const distToNext = CockpitMap._distNm(sit.lat, sit.lon, nextWp.lat, nextWp.lon);
            totalFuel += FuelEngine.fuelForDistance(distToNext, gs > 10 ? gs : 120, gph);
        }

        // Subsequent legs: use planned GS or fall back to current GS
        for (let i = activeIdx; i < wps.length - 1; i++) {
            const from = wps[i];
            const to = wps[i + 1];
            if (!from.lat || !to.lat) continue;
            const dist = CockpitMap._distNm(from.lat, from.lon, to.lat, to.lon);
            const legGs = to.gs || gs || 120;
            const legGph = to.gph || gph;
            totalFuel += FuelEngine.fuelForDistance(dist, legGs, legGph);
        }

        return totalFuel;
    }

    // ========== Range Ring ==========

    _addRangeRingControl() {
        if (!this.cockpitMap || !this.cockpitMap.map) {
            // Map not ready yet, try again after delay
            setTimeout(() => this._addRangeRingControl(), 1000);
            return;
        }

        const RangeControl = L.Control.extend({
            options: { position: 'topleft' },
            onAdd: () => {
                const btn = L.DomUtil.create('button', 'map-control-btn range-ring-btn');
                btn.textContent = 'RNG';
                btn.title = 'Toggle range ring';
                let touchFired = false;
                const toggle = () => {
                    this._showRangeRing = !this._showRangeRing;
                    btn.classList.toggle('active', this._showRangeRing);
                    if (!this._showRangeRing) this._removeRangeRing();
                };
                btn.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    touchFired = true;
                    toggle();
                    setTimeout(() => { touchFired = false; }, 400);
                });
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!touchFired) toggle();
                });
                L.DomEvent.disableClickPropagation(btn);
                return btn;
            },
        });
        new RangeControl().addTo(this.cockpitMap.map);
    }

    _drawRangeRing(lat, lon, rangeNm) {
        if (!this.cockpitMap || !this.cockpitMap.map) return;

        this._removeRangeRing();

        const nmToMeters = 1852;
        this._rangeRing = L.circle([lat, lon], {
            radius: rangeNm * nmToMeters,
            color: '#00d4ff',
            weight: 2,
            opacity: 0.6,
            fill: false,
            dashArray: '8,6',
        }).addTo(this.cockpitMap.map);
    }

    _removeRangeRing() {
        if (this._rangeRing && this.cockpitMap && this.cockpitMap.map) {
            this.cockpitMap.map.removeLayer(this._rangeRing);
            this._rangeRing = null;
        }
    }
}
