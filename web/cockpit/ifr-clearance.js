/**
 * FlyPi — IFR Clearance Panel
 * Two-mode panel: DEP (CRAFT departure clearance) + APCH (approach clearance).
 * Custom numpad bottom sheet for squawk and frequency entry.
 * Opens as full-screen overlay; replaces LOG tab in bottom tab bar.
 */

class IfrClearance {
    constructor(container, nasrDb) {
        this._container = container;
        this._nasrDb = nasrDb;
        this._visible = false;
        this._mode = 'dep'; // 'dep' | 'apch'
        this._flightPlan = null;
        this._departureAirport = null;
        this._activeLegIdx = 0;
        this._legToggleEl  = null;

        // DEP (CRAFT) state
        this._craft = {
            clearance: '',
            route: '',
            altitude: '',
            expect: '',
            expectMin: '10',
            frequency: '',
            transponder: '',
            void: '',
        };

        // APCH state
        this._apch = {
            type: 'ILS',
            runway: '',
            altEstab: '',
            altimeter: '',
            freq: '',
            restrictions: '',
            missed: '',
        };

        this._numpadTarget = null;
        this._numpadDecimal = false;
        this._el = null;
        this._numpadEl = null;
        this._dom = {};

        this._buildDom();
    }

    // ========== Public API ==========

    async show(flightPlan, departureAirport, currentPos) {
        if (flightPlan) this._flightPlan = flightPlan;
        if (departureAirport) this._departureAirport = departureAirport;

        // Auto-select leg based on GPS proximity to fuel stop
        if (this._flightPlan?.legs?.length > 1) {
            const leg1 = this._flightPlan.legs[0];
            const fuelStopWp = leg1.waypoints?.[leg1.waypoints.length - 1];
            if (currentPos?.lat != null && fuelStopWp?.lat != null &&
                (currentPos.gps_fix_quality == null || currentPos.gps_fix_quality >= 1)) {
                const distNm = this._haversineNm(currentPos.lat, currentPos.lon, fuelStopWp.lat, fuelStopWp.lon);
                this._activeLegIdx = distNm <= 5 ? 1 : 0;
            } else {
                this._activeLegIdx = 0;
            }
        } else {
            this._activeLegIdx = 0;
        }

        this._visible = true;
        this._el.style.display = 'flex';
        this._renderLegToggle();
        if (this._mode === 'dep') {
            await this._prefillDep();
        }
        this._renderActiveMode();
    }

    hide() {
        this._visible = false;
        this._el.style.display = 'none';
        this._hideNumpad();
    }

    _getActiveLeg() {
        const fp = this._flightPlan;
        if (!fp) return null;
        if (fp.legs) return fp.legs[this._activeLegIdx] || fp.legs[0]; // trip object
        return fp; // legacy single-plan — unchanged behavior
    }

    get visible() { return this._visible; }

    getCdPhone(icao, airport) {
        const phones = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('ifr.cdPhones')) || {};
        const code = (icao || '').toUpperCase();
        if (phones[code]) {
            return { phone: phones[code].phone || phones[code], facility: phones[code].facility || code };
        }
        if (airport?.cd_phone) {
            return { phone: airport.cd_phone, facility: airport.cd_facility || code };
        }
        return {
            phone: (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('ifr.defaultCdPhone')) || '1-888-766-8267',
            facility: 'FSS',
        };
    }

    _haversineNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065; // Earth radius in nautical miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 +
                  Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // ========== DOM construction ==========

    _buildDom() {
        const el = document.createElement('div');
        el.className = 'clr-overlay';
        el.style.display = 'none';

        el.innerHTML = `
        <div class="clr-header">
            <div class="clr-mode-tabs">
                <button class="clr-mode-tab active" data-mode="dep">DEP</button>
                <button class="clr-mode-tab" data-mode="apch">APCH</button>
            </div>
            <div class="clr-leg-toggle" id="clr-leg-toggle" style="display:none"></div>
            <button class="ep-close clr-close">✕</button>
        </div>
        <div class="clr-body">
            <!-- DEP panel -->
            <div class="clr-panel" id="clr-dep-panel">
                <div class="clr-phone-box" id="clr-phone-box">
                    <div class="clr-phone-label">CLEARANCE DELIVERY</div>
                    <div class="clr-phone-number" id="clr-phone-num">—</div>
                    <div class="clr-phone-facility" id="clr-phone-fac"></div>
                </div>

                <div class="clr-section-title">C R A F T</div>

                <div class="clr-craft-grid">
                    <!-- C -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">C</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Clearance Limit</div>
                            <input class="clr-input" id="clr-c" type="text" inputmode="text"
                                placeholder="Destination ICAO" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
                        </div>
                    </div>

                    <!-- R -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">R</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Route</div>
                            <div style="display:flex;gap:6px;align-items:flex-start;">
                                <input class="clr-input" id="clr-r" type="text" inputmode="text" style="flex:1"
                                    placeholder="As filed" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
                                <button class="clr-pill-btn" id="clr-as-filed">AS FILED</button>
                            </div>
                        </div>
                    </div>

                    <!-- A -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">A</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Altitude</div>
                            <div class="clr-alt-row">
                                <input class="clr-input clr-input-sm" id="clr-a" type="text" inputmode="numeric"
                                    placeholder="ft" autocomplete="off" spellcheck="false">
                                <span class="clr-unit">ft</span>
                                <span class="clr-expect-sep">Expect</span>
                                <input class="clr-input clr-input-sm" id="clr-expect" type="text" inputmode="numeric"
                                    placeholder="ft" autocomplete="off" spellcheck="false">
                                <span class="clr-unit">in</span>
                                <input class="clr-input clr-input-xs" id="clr-expect-min" type="text" inputmode="numeric"
                                    placeholder="10" autocomplete="off" spellcheck="false" value="10">
                                <span class="clr-unit">min</span>
                            </div>
                        </div>
                    </div>

                    <!-- F -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">F</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Departure Frequency</div>
                            <div class="clr-numpad-row">
                                <input class="clr-input clr-input-freq" id="clr-f" type="text" inputmode="decimal"
                                    placeholder="118.0" autocomplete="off" spellcheck="false">
                                <button class="clr-numpad-btn" data-target="clr-f" data-decimal="1" aria-label="Open keypad">⌨</button>
                            </div>
                        </div>
                    </div>

                    <!-- T -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">T</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Transponder (Squawk)</div>
                            <div class="clr-numpad-row">
                                <input class="clr-input clr-input-sqk" id="clr-t" type="text" inputmode="tel"
                                    placeholder="0000" maxlength="4" autocomplete="off" spellcheck="false">
                                <button class="clr-numpad-btn" data-target="clr-t" data-maxlen="4" aria-label="Open keypad">⌨</button>
                            </div>
                        </div>
                    </div>

                    <!-- Void -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter clr-letter-void">V</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Void Time (if applicable)</div>
                            <input class="clr-input" id="clr-void" type="text" inputmode="numeric"
                                placeholder="e.g. 1500Z" autocomplete="off" spellcheck="false">
                        </div>
                    </div>
                </div>

                <div class="clr-readback-box" id="clr-dep-readback">
                    <div class="clr-readback-label">READBACK</div>
                    <div class="clr-readback-text" id="clr-dep-readback-text">Fill in C, A, F, T to generate readback…</div>
                </div>

                <div class="clr-actions">
                    <button class="clr-action-btn clr-action-clear" id="clr-dep-clear">CLEAR</button>
                    <button class="clr-action-btn clr-action-copy" id="clr-dep-copy">COPY READBACK</button>
                </div>
            </div>

            <!-- APCH panel -->
            <div class="clr-panel" id="clr-apch-panel" style="display:none">
                <div class="clr-section-title">APPROACH TYPE</div>
                <div class="clr-apch-types" id="clr-apch-types">
                    <button class="clr-type-btn active" data-type="ILS">ILS</button>
                    <button class="clr-type-btn" data-type="RNAV">RNAV</button>
                    <button class="clr-type-btn" data-type="VOR">VOR</button>
                    <button class="clr-type-btn" data-type="VIS">VIS</button>
                    <button class="clr-type-btn" data-type="CIRC">CIRC</button>
                </div>

                <div class="clr-craft-grid">
                    <!-- Runway -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">RWY</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Runway</div>
                            <div class="clr-numpad-row">
                                <input class="clr-input clr-input-sm" id="clr-apch-rwy" type="text" inputmode="text"
                                    placeholder="28L" maxlength="4" autocomplete="off" spellcheck="false">
                                <button class="clr-numpad-btn" data-target="clr-apch-rwy" data-maxlen="4" aria-label="Open keypad">⌨</button>
                            </div>
                        </div>
                    </div>

                    <!-- Alt until established -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">ALT</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Altitude Until Established</div>
                            <div class="clr-numpad-row">
                                <input class="clr-input clr-input-sm" id="clr-apch-alt" type="text" inputmode="numeric"
                                    placeholder="2500" autocomplete="off" spellcheck="false">
                                <span class="clr-unit">ft</span>
                                <button class="clr-numpad-btn" data-target="clr-apch-alt" data-decimal="0" aria-label="Open keypad">⌨</button>
                            </div>
                        </div>
                    </div>

                    <!-- Altimeter -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">BARO</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Altimeter Setting</div>
                            <div class="clr-numpad-row">
                                <input class="clr-input clr-input-freq" id="clr-apch-baro" type="text" inputmode="decimal"
                                    placeholder="29.92" autocomplete="off" spellcheck="false">
                                <button class="clr-numpad-btn" data-target="clr-apch-baro" data-decimal="1" aria-label="Open keypad">⌨</button>
                            </div>
                        </div>
                    </div>

                    <!-- Tower freq -->
                    <div class="clr-craft-row">
                        <div class="clr-craft-letter">TWR</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Tower / Contact Freq</div>
                            <div class="clr-numpad-row">
                                <input class="clr-input clr-input-freq" id="clr-apch-freq" type="text" inputmode="decimal"
                                    placeholder="118.0" autocomplete="off" spellcheck="false">
                                <button class="clr-numpad-btn" data-target="clr-apch-freq" data-decimal="1" aria-label="Open keypad">⌨</button>
                            </div>
                        </div>
                    </div>

                    <!-- Crossing restrictions -->
                    <div class="clr-craft-row clr-craft-row-tall">
                        <div class="clr-craft-letter">X</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Crossing Restrictions</div>
                            <textarea class="clr-textarea" id="clr-apch-restrictions"
                                placeholder="e.g. cross DADES at 2000" rows="2" autocorrect="off" spellcheck="false"></textarea>
                        </div>
                    </div>

                    <!-- Missed approach -->
                    <div class="clr-craft-row clr-craft-row-tall">
                        <div class="clr-craft-letter">MAP</div>
                        <div class="clr-craft-field">
                            <div class="clr-field-label">Missed Approach</div>
                            <textarea class="clr-textarea" id="clr-apch-missed"
                                placeholder="e.g. Climb 4000, fly runway hdg, contact App 124.1" rows="2" autocorrect="off" spellcheck="false"></textarea>
                        </div>
                    </div>
                </div>

                <div class="clr-readback-box" id="clr-apch-readback">
                    <div class="clr-readback-label">READBACK</div>
                    <div class="clr-readback-text" id="clr-apch-readback-text">Fill in approach type and runway…</div>
                </div>

                <div class="clr-actions">
                    <button class="clr-action-btn clr-action-clear" id="clr-apch-clear">CLEAR</button>
                    <button class="clr-action-btn clr-action-copy" id="clr-apch-copy">COPY READBACK</button>
                </div>
            </div>
        </div>

        <!-- Custom numpad bottom sheet -->
        <div class="clr-numpad-sheet" id="clr-numpad-sheet" style="display:none">
            <div class="clr-numpad-target-label" id="clr-numpad-label"></div>
            <div class="clr-numpad-value" id="clr-numpad-value">—</div>
            <div class="clr-numpad-grid">
                <button class="clr-np-key" data-digit="7">7</button>
                <button class="clr-np-key" data-digit="8">8</button>
                <button class="clr-np-key" data-digit="9">9</button>
                <button class="clr-np-key" data-digit="4">4</button>
                <button class="clr-np-key" data-digit="5">5</button>
                <button class="clr-np-key" data-digit="6">6</button>
                <button class="clr-np-key" data-digit="1">1</button>
                <button class="clr-np-key" data-digit="2">2</button>
                <button class="clr-np-key" data-digit="3">3</button>
                <button class="clr-np-key clr-np-decimal" id="clr-np-dot" data-digit=".">.</button>
                <button class="clr-np-key" data-digit="0">0</button>
                <button class="clr-np-key clr-np-back" id="clr-np-back">⌫</button>
            </div>
            <button class="clr-np-done" id="clr-np-done">DONE</button>
        </div>
        `;

        this._container.appendChild(el);
        this._el = el;
        this._numpadEl = el.querySelector('#clr-numpad-sheet');
        this._legToggleEl = this._el.querySelector('#clr-leg-toggle');

        this._wireEvents();
    }

    _wireEvents() {
        const el = this._el;

        // Close button
        this._tap(el.querySelector('.clr-close'), () => this.hide());

        // Mode tabs
        el.querySelectorAll('.clr-mode-tab').forEach(btn => {
            this._tap(btn, () => this._switchMode(btn.dataset.mode));
        });

        // Approach type buttons
        el.querySelectorAll('.clr-type-btn').forEach(btn => {
            this._tap(btn, () => {
                el.querySelectorAll('.clr-type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._apch.type = btn.dataset.type;
                this._updateApchReadback();
            });
        });

        // "As Filed" button
        this._tap(el.querySelector('#clr-as-filed'), () => this._fillAsFiledRoute());

        // DEP field inputs — live readback update
        ['clr-c', 'clr-r', 'clr-a', 'clr-expect', 'clr-expect-min', 'clr-f', 'clr-t', 'clr-void'].forEach(id => {
            const inp = el.querySelector(`#${id}`);
            if (inp) inp.addEventListener('input', () => this._updateDepReadback());
        });

        // Squawk: auto-close numpad at 4 chars
        const sqkInp = el.querySelector('#clr-t');
        if (sqkInp) {
            sqkInp.addEventListener('input', () => {
                if (sqkInp.value.length >= 4 && this._numpadTarget === sqkInp) {
                    this._hideNumpad();
                }
            });
        }

        // APCH field inputs — live readback update
        ['clr-apch-rwy', 'clr-apch-alt', 'clr-apch-baro', 'clr-apch-freq',
         'clr-apch-restrictions', 'clr-apch-missed'].forEach(id => {
            const inp = el.querySelector(`#${id}`);
            if (inp) inp.addEventListener('input', () => this._updateApchReadback());
        });

        // Numpad open buttons
        el.querySelectorAll('.clr-numpad-btn').forEach(btn => {
            this._tap(btn, () => {
                const target = el.querySelector(`#${btn.dataset.target}`);
                if (target) this._showNumpad(target, {
                    decimal: btn.dataset.decimal === '1',
                    maxlen: btn.dataset.maxlen ? parseInt(btn.dataset.maxlen) : 0,
                    label: target.closest('.clr-craft-field')?.querySelector('.clr-field-label')?.textContent || '',
                });
            });
        });

        // Numpad keys
        el.querySelectorAll('.clr-np-key').forEach(key => {
            this._tap(key, () => this._numpadPress(key.dataset.digit));
        });
        this._tap(el.querySelector('#clr-np-back'), () => this._numpadBack());
        this._tap(el.querySelector('#clr-np-done'), () => this._hideNumpad());

        // Clear buttons
        this._tap(el.querySelector('#clr-dep-clear'), () => this._clearDep());
        this._tap(el.querySelector('#clr-apch-clear'), () => this._clearApch());

        // Copy readback buttons
        this._tap(el.querySelector('#clr-dep-copy'), () => this._copyReadback('dep'));
        this._tap(el.querySelector('#clr-apch-copy'), () => this._copyReadback('apch'));

    }

    // ========== Mode switching ==========

    _switchMode(mode) {
        this._mode = mode;
        this._hideNumpad();

        this._el.querySelectorAll('.clr-mode-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
        });

        this._el.querySelector('#clr-dep-panel').style.display = mode === 'dep' ? '' : 'none';
        this._el.querySelector('#clr-apch-panel').style.display = mode === 'apch' ? '' : 'none';
    }

    // ========== Numpad ==========

    _showNumpad(inputEl, { decimal = false, maxlen = 0, label = '' } = {}) {
        this._numpadTarget = inputEl;
        this._numpadDecimal = decimal;
        this._numpadMaxlen = maxlen;

        const sheet = this._numpadEl;
        const dotBtn = sheet.querySelector('#clr-np-dot');
        dotBtn.style.visibility = decimal ? 'visible' : 'hidden';

        sheet.querySelector('#clr-numpad-label').textContent = label;
        sheet.querySelector('#clr-numpad-value').textContent = inputEl.value || '—';
        sheet.style.display = 'flex';

        // Blur native keyboard
        inputEl.blur();
    }

    _hideNumpad() {
        this._numpadTarget = null;
        if (this._numpadEl) this._numpadEl.style.display = 'none';
    }

    _numpadPress(digit) {
        const inp = this._numpadTarget;
        if (!inp) return;

        // Only one decimal point
        if (digit === '.' && inp.value.includes('.')) return;

        // Enforce maxlen
        if (this._numpadMaxlen && inp.value.length >= this._numpadMaxlen) return;

        inp.value += digit;
        inp.dispatchEvent(new Event('input', { bubbles: true }));

        // Update display
        this._numpadEl.querySelector('#clr-numpad-value').textContent = inp.value || '—';

        // Auto-close when squawk hits 4 digits
        if (this._numpadMaxlen && inp.value.length >= this._numpadMaxlen) {
            this._hideNumpad();
        }
    }

    _numpadBack() {
        const inp = this._numpadTarget;
        if (!inp) return;
        inp.value = inp.value.slice(0, -1);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        this._numpadEl.querySelector('#clr-numpad-value').textContent = inp.value || '—';
    }

    // ========== DEP (CRAFT) ==========

    async _prefillDep() {
        const leg = this._getActiveLeg();
        if (!leg) return;
        const plan = leg.flight_plan || leg;

        // C — destination
        const destIcao = leg.dest || plan.destination || '';
        if (destIcao) {
            let name = '';
            if (this._nasrDb) {
                try { const apt = await this._nasrDb.getAirport(destIcao); name = apt?.name || ''; } catch { /**/ }
            }
            const inp = this._el.querySelector('#clr-c');
            if (inp && !inp.value) inp.value = name ? `${destIcao} — ${name}` : destIcao;
        }

        // R — route (raw identifiers, not expanded — pilot reads it from here)
        const routeInp = this._el.querySelector('#clr-r');
        if (routeInp && !routeInp.value) {
            const routeStr = plan.route || '';
            if (routeStr) {
                routeInp.value = routeStr;
            } else if (leg.waypoints?.length > 0) {
                routeInp.value = leg.waypoints.map(w => w.icao || w.name).filter(Boolean).join(' ');
            }
        }

        // A — filed altitude
        const altInp = this._el.querySelector('#clr-a');
        if (altInp && !altInp.value && (plan.altitude || plan.cruise_altitude)) {
            altInp.value = String(plan.altitude || plan.cruise_altitude);
        }

        // F — departure frequency from airport
        const freqInp = this._el.querySelector('#clr-f');
        if (freqInp && !freqInp.value) {
            const freq = this._getDeparureFreq();
            if (freq) freqInp.value = freq;
        }

        // CD phone
        this._updateCdPhone();
        this._updateDepReadback();
    }

    _fillAsFiledRoute() {
        const leg  = this._getActiveLeg();
        const plan = leg ? (leg.flight_plan || leg) : null;
        const inp  = this._el.querySelector('#clr-r');
        if (!inp) return;
        if (plan?.route) {
            inp.value = plan.route;
        } else if (leg?.waypoints?.length > 0) {
            inp.value = leg.waypoints.map(w => w.icao || w.name).filter(Boolean).join(' ');
        } else {
            inp.value = 'AS FILED';
        }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
    }

    _clearDep() {
        ['clr-c', 'clr-r', 'clr-a', 'clr-expect', 'clr-expect-min', 'clr-f', 'clr-t', 'clr-void'].forEach(id => {
            const inp = this._el.querySelector(`#${id}`);
            if (inp) inp.value = id === 'clr-expect-min' ? '10' : '';
        });
        this._updateDepReadback();
    }

    _updateDepReadback() {
        const v = (id) => (this._el.querySelector(`#${id}`)?.value || '').trim();
        const acType = (typeof CockpitConfig !== 'undefined' && CockpitConfig.aircraft?.('type')) || '';
        const tail = (typeof CockpitConfig !== 'undefined' && CockpitConfig.aircraft?.('tail')) ||
                     (typeof Settings !== 'undefined' && Settings.get?.('tail_number')) || 'N____';
        const callsign = acType ? `${acType} ${tail}` : tail;

        const c = v('clr-c');
        const r = v('clr-r');
        const a = v('clr-a');
        const exp = v('clr-expect');
        const expMin = v('clr-expect-min') || '10';
        const f = v('clr-f');
        const t = v('clr-t');
        const voidT = v('clr-void');

        const parts = [];
        parts.push(`${callsign}, cleared to ${c || '____'}`);
        if (r) parts.push(`${r.toUpperCase() === 'AS FILED' ? 'as filed' : r}`);

        if (a) {
            const alt = parseInt(a, 10);
            if (!isNaN(alt)) {
                if (alt >= 18000) {
                    parts.push(`climb and maintain flight level ${String(Math.round(alt / 100)).padStart(3, '0')}`);
                } else {
                    parts.push(`climb and maintain ${alt.toLocaleString()}`);
                }
                if (exp) {
                    const expAlt = parseInt(exp, 10);
                    if (!isNaN(expAlt)) {
                        parts.push(`expect ${expAlt >= 18000 ? 'FL' + Math.round(expAlt / 100) : expAlt.toLocaleString()} in ${expMin} minutes`);
                    }
                }
            }
        }

        if (f) parts.push(`departure frequency ${f}`);
        parts.push(`squawk ${t || '____'}`);
        if (voidT) parts.push(`clearance void if not off by ${voidT}`);

        const text = parts.join(', ') + '.';
        const el = this._el.querySelector('#clr-dep-readback-text');
        if (el) el.textContent = text;
    }

    _updateCdPhone() {
        const fp = this._flightPlan;
        const plan = fp ? (fp.flight_plan || fp) : {};
        const depIcao = plan.departure || '';
        const cd = this.getCdPhone(depIcao, this._departureAirport);
        const numEl = this._el.querySelector('#clr-phone-num');
        const facEl = this._el.querySelector('#clr-phone-fac');
        if (numEl) numEl.textContent = cd.phone;
        if (facEl) facEl.textContent = depIcao ? `${cd.facility} — ${depIcao}` : cd.facility;
    }

    _getDeparureFreq() {
        const apt = this._departureAirport;
        if (!apt?.frequencies) return '';
        const order = [/DEP|DEPARTURE/, /APP|APPROACH/, /TWR|TOWER|LC/];
        for (const pattern of order) {
            for (const f of apt.frequencies) {
                if (pattern.test((f.use || f.purpose || '').toUpperCase())) {
                    return f.freq || f.frequency || '';
                }
            }
        }
        return '';
    }

    // ========== APCH (Approach) ==========

    _clearApch() {
        ['clr-apch-rwy', 'clr-apch-alt', 'clr-apch-baro', 'clr-apch-freq',
         'clr-apch-restrictions', 'clr-apch-missed'].forEach(id => {
            const inp = this._el.querySelector(`#${id}`);
            if (inp) inp.value = '';
        });
        this._apch.type = 'ILS';
        this._el.querySelectorAll('.clr-type-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.type === 'ILS');
        });
        this._updateApchReadback();
    }

    _updateApchReadback() {
        const v = (id) => (this._el.querySelector(`#${id}`)?.value || '').trim();
        const type = this._apch.type;
        const rwy = v('clr-apch-rwy');
        const alt = v('clr-apch-alt');
        const baro = v('clr-apch-baro');
        const freq = v('clr-apch-freq');
        const restrictions = v('clr-apch-restrictions');
        const missed = v('clr-apch-missed');

        const parts = [];

        if (type === 'VIS') {
            parts.push(`Cleared visual approach runway ${rwy || '____'}`);
        } else if (type === 'CIRC') {
            parts.push(`Cleared ${type} approach, circle to land runway ${rwy || '____'}`);
        } else {
            parts.push(`Cleared ${type} runway ${rwy || '____'} approach`);
        }

        if (alt) {
            const altNum = parseInt(alt, 10);
            if (!isNaN(altNum)) {
                parts.push(`maintain ${altNum.toLocaleString()} until established`);
            }
        }

        if (restrictions) parts.push(restrictions);
        if (baro) parts.push(`altimeter ${baro}`);
        if (freq) parts.push(`contact tower ${freq} when established`);
        if (missed) parts.push(`missed: ${missed}`);

        const text = parts.join('. ') + '.';
        const el = this._el.querySelector('#clr-apch-readback-text');
        if (el) el.textContent = text;
    }

    // ========== Copy readback ==========

    _copyReadback(mode) {
        const id = mode === 'dep' ? '#clr-dep-readback-text' : '#clr-apch-readback-text';
        const text = this._el.querySelector(id)?.textContent || '';
        if (!text) return;
        if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(() => {
                const btnId = mode === 'dep' ? '#clr-dep-copy' : '#clr-apch-copy';
                const btn = this._el.querySelector(btnId);
                if (btn) {
                    const orig = btn.textContent;
                    btn.textContent = 'COPIED ✓';
                    setTimeout(() => { btn.textContent = orig; }, 2000);
                }
            });
        }
    }

    _renderActiveMode() {
        // nothing extra — fields are persistent DOM, state lives in inputs
    }

    _renderLegToggle() {
        if (!this._legToggleEl) return;
        const legs = this._flightPlan?.legs;
        if (!legs || legs.length <= 1) {
            this._legToggleEl.style.display = 'none';
            this._legToggleEl.innerHTML = '';
            return;
        }
        this._legToggleEl.style.display = 'flex';
        this._legToggleEl.innerHTML = legs.map((_, i) =>
            `<button class="clr-leg-btn${i === this._activeLegIdx ? ' clr-leg-active' : ''}" data-leg="${i}">Leg ${i + 1}</button>`
        ).join('');
        this._legToggleEl.querySelectorAll('.clr-leg-btn').forEach(btn => {
            btn.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            btn.addEventListener('click', () => {
                this._activeLegIdx = Number(btn.dataset.leg);
                this._renderLegToggle();
                if (this._mode === 'dep') this._prefillDep();
            });
        });
    }

    // ========== Tap helper ==========

    _tap(el, handler) {
        if (!el) return;
        let fired = false;
        el.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            fired = true;
            handler(e);
        }, { passive: true });
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (fired) { fired = false; return; }
            handler(e);
        });
    }
}
