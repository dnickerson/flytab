/**
 * FlyTab — Logbook
 * Auto-generates logbook entries when flight recording stops.
 * Manual entry creation and editing via form overlay.
 * Stores entries in IndexedDB (local), syncs to flywhere.app when online.
 */

class Logbook {
    static IDB_STORE = 'flypi_logbook';
    static IDB_NAME = 'flypi-flights';
    static IDB_VERSION = 3;

    /**
     * @param {NasrDB} nasrDb - NasrDB instance for airport lookups
     */
    constructor(nasrDb) {
        this._nasrDb = nasrDb;
        this._syncQueue = [];
        this._syncInProgress = false;
        this._visible = false;

        // Config
        const cfg = CockpitConfig.get('logbook');
        this._autoCreate = cfg.autoCreate !== false;
        this._defaultConditions = cfg.defaultConditions || 'VFR';
        this._trackHobbs = cfg.trackHobbs !== false;
        this._hobbsSource = cfg.hobbsSource || 'engine_hours';

        // Build overlay DOM
        this._buildDOM();

        // Listen for FlightSync stop events (capture_v5 recording stopped)
        if (this._autoCreate) {
            window.addEventListener('flightsync:stopped', (e) => {
                this._onCaptureStopped(e.detail);
            });
        }
    }

    // ========== Overlay UI ==========

    show() {
        this._el.classList.add('visible');
        this._visible = true;
        this._setMapControlsVisible(false);
        // Fetch from server in background, then render
        this._fetchFromServer().finally(() => this._showActiveTab());
    }

    hide() {
        this._el.classList.remove('visible');
        this._visible = false;
        this._setMapControlsVisible(true);
    }

    toggle() {
        this._visible ? this.hide() : this.show();
    }

    _setMapControlsVisible(visible) {
        document.querySelectorAll('.leaflet-control-container')
            .forEach(c => c.style.display = visible ? '' : 'none');
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'logbook-page';
        this._el.innerHTML = `
            <div class="logbook-header">
                <span class="logbook-title">Pilot Logbook</span>
                <div class="logbook-header-actions">
                    <button class="logbook-btn logbook-add-btn">+ NEW</button>
                    <button class="logbook-btn logbook-sync-btn">SYNC</button>
                    <button class="btn-close logbook-close">\u2715</button>
                </div>
            </div>
            <div class="logbook-tabs">
                <button class="logbook-tab active" data-tab="flights">Flights</button>
                <button class="logbook-tab" data-tab="currency">Currency</button>
                <button class="logbook-tab" data-tab="oil">Oil</button>
            </div>
            <div class="logbook-body"></div>
        `;
        this._body = this._el.querySelector('.logbook-body');
        this._activeTab = 'flights';

        const closeBtn = this._el.querySelector('.logbook-close');
        closeBtn.addEventListener('click', () => this.hide());
        closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); this.hide(); });

        const addBtn = this._el.querySelector('.logbook-add-btn');
        this._wireButton(addBtn, () => {
            if (this._activeTab === 'oil') this._showOilForm(null);
            else this._showForm(null);
        });

        const syncBtn = this._el.querySelector('.logbook-sync-btn');
        this._wireButton(syncBtn, () => {
            syncBtn.textContent = '...';
            this._fetchFromServer().then(() => this.syncWhenOnline()).finally(() => {
                syncBtn.textContent = 'SYNC';
                this._showActiveTab();
            });
        });

        // Tab switching
        this._el.querySelectorAll('.logbook-tab').forEach(tab => {
            this._wireButton(tab, () => {
                this._el.querySelectorAll('.logbook-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this._activeTab = tab.dataset.tab;
                // Update + NEW button label
                const addBtn = this._el.querySelector('.logbook-add-btn');
                if (this._activeTab === 'oil') addBtn.textContent = '+ OIL';
                else if (this._activeTab === 'currency') addBtn.style.display = 'none';
                else { addBtn.textContent = '+ NEW'; addBtn.style.display = ''; }
                if (this._activeTab !== 'currency') addBtn.style.display = '';
                this._showActiveTab();
            });
        });

        document.body.appendChild(this._el);
    }

    _showActiveTab() {
        if (this._activeTab === 'flights') this._renderList();
        else if (this._activeTab === 'currency') this._renderCurrency();
        else if (this._activeTab === 'oil') this._renderOil();
    }

    // ========== Entry List ==========

    async _renderList() {
        const entries = await this.getEntries(50);

        if (entries.length === 0) {
            this._body.innerHTML = `
                <div class="logbook-empty">
                    No flights recorded yet.<br>
                    Entries are created automatically when a flight recording stops,<br>
                    or tap <b>+ NEW</b> to add a manual entry.
                </div>`;
            return;
        }

        // Summary row
        const totalHrs = entries.reduce((s, e) => s + (e.flight_time_hours || e.total_time || 0), 0);
        const totalLdg = entries.reduce((s, e) => s + (e.day_landings_full_stop || 0) + (e.night_landings_full_stop || 0), 0);
        const unsyncedCount = entries.filter(e => !e.synced).length;

        let html = `<div class="logbook-summary">
            <span>${entries.length} flights</span>
            <span>${totalHrs.toFixed(1)} hrs</span>
            <span>${totalLdg} landings</span>
            ${unsyncedCount > 0 ? `<span class="logbook-unsynced">${unsyncedCount} unsynced</span>` : ''}
        </div>`;

        html += entries.map(e => {
            const dep = e.departure_icao || e.from_airport || '????';
            const dest = e.destination_icao || e.to_airport || '????';
            const hrs = e.flight_time_hours || e.total_time || 0;
            const tail = e.aircraft_tail || e.aircraft_id || '';
            const cond = e.conditions || '';
            const ldg = (e.day_landings_full_stop || 0) + (e.night_landings_full_stop || 0);
            const source = e.source === 'flypi' ? 'AUTO' : (e.source === 'manual' ? '' : '');
            const syncDot = e.synced ? '' : '<span class="logbook-unsync-dot"></span>';

            return `<div class="logbook-entry" data-id="${e.id}">
                <div class="logbook-entry-header">
                    <span class="logbook-date">${e.date}${syncDot}</span>
                    <span class="logbook-route">${dep} \u2192 ${dest}</span>
                </div>
                <div class="logbook-entry-details">
                    <span>${hrs}h</span>
                    ${ldg > 0 ? `<span>${ldg} ldg</span>` : ''}
                    <span>${tail}</span>
                    ${cond ? `<span>${cond}</span>` : ''}
                    ${source ? `<span class="logbook-source">${source}</span>` : ''}
                </div>
                <div class="logbook-entry-actions">
                    <button class="logbook-btn logbook-edit-btn" data-id="${e.id}">EDIT</button>
                    <button class="logbook-btn logbook-delete-btn" data-id="${e.id}">DEL</button>
                </div>
            </div>`;
        }).join('');

        this._body.innerHTML = html;

        // Wire edit buttons
        this._body.querySelectorAll('.logbook-edit-btn').forEach(btn => {
            this._wireButton(btn, () => {
                const entry = entries.find(e => e.id === btn.dataset.id);
                if (entry) this._showForm(entry);
            });
        });

        // Wire delete buttons
        this._body.querySelectorAll('.logbook-delete-btn').forEach(btn => {
            this._wireButton(btn, async () => {
                const entry = entries.find(e => e.id === btn.dataset.id);
                if (!entry) return;
                btn.textContent = '?';
                // Second tap confirms
                this._wireButton(btn, async () => {
                    await this._deleteEntry(entry.id);
                    this._renderList();
                });
            });
        });
    }

    // ========== Entry Form (New + Edit) ==========

    _showForm(entry) {
        // Remove existing form overlay
        document.getElementById('logbookForm')?.remove();

        const isEdit = !!entry;
        const e = entry || {};
        const today = new Date().toISOString().slice(0, 10);

        const overlay = document.createElement('div');
        overlay.id = 'logbookForm';
        overlay.className = 'logbook-form-overlay';

        overlay.innerHTML = `
            <div class="logbook-form-header">
                <span>${isEdit ? 'Edit Flight' : 'New Flight'}</span>
                <button class="btn-close logbook-form-cancel">\u2715</button>
            </div>
            <div class="logbook-form-body">
                <div class="lb-form-section">Flight Info</div>
                <div class="lb-form-row">
                    <label>Date<input type="date" name="date" value="${e.date || today}"></label>
                    <label>Conditions
                        <select name="conditions">
                            <option value="VFR" ${(e.conditions || this._defaultConditions) === 'VFR' ? 'selected' : ''}>VFR</option>
                            <option value="IFR" ${e.conditions === 'IFR' ? 'selected' : ''}>IFR</option>
                            <option value="SVFR" ${e.conditions === 'SVFR' ? 'selected' : ''}>SVFR</option>
                        </select>
                    </label>
                </div>
                <div class="lb-form-row">
                    <label>From<input type="text" name="from_airport" value="${e.departure_icao || e.from_airport || ''}" placeholder="KLKR" maxlength="10" autocapitalize="characters"></label>
                    <label>To<input type="text" name="to_airport" value="${e.destination_icao || e.to_airport || ''}" placeholder="KUZA" maxlength="10" autocapitalize="characters"></label>
                </div>
                <div class="lb-form-row">
                    <label>Route<input type="text" name="route" value="${this._escHtml(e.route || '')}" placeholder="DCT"></label>
                </div>
                <div class="lb-form-row">
                    <label>Aircraft<input type="text" name="aircraft_id" value="${e.aircraft_tail || e.aircraft_id || CockpitConfig.aircraft('tail') || ''}" maxlength="10" autocapitalize="characters"></label>
                </div>

                <div class="lb-form-section">Times</div>
                <div class="lb-form-row lb-form-4col">
                    <label>Out<input type="text" name="time_out" value="${e.time_out || ''}" placeholder="HH:MM"></label>
                    <label>Off<input type="text" name="time_off" value="${e.time_off || ''}" placeholder="HH:MM"></label>
                    <label>On<input type="text" name="time_on" value="${e.time_on || ''}" placeholder="HH:MM"></label>
                    <label>In<input type="text" name="time_in" value="${e.time_in || ''}" placeholder="HH:MM"></label>
                </div>

                <div class="lb-form-section">Hours</div>
                <div class="lb-form-row lb-form-3col">
                    <label>Total<input type="number" name="total_time" value="${e.flight_time_hours || e.total_time || ''}" step="0.1" min="0"></label>
                    <label>PIC<input type="number" name="pic" value="${e.pic || ''}" step="0.1" min="0"></label>
                    <label>XC<input type="number" name="cross_country" value="${e.cross_country || ''}" step="0.1" min="0"></label>
                </div>
                <div class="lb-form-row lb-form-3col">
                    <label>Night<input type="number" name="night" value="${e.night || ''}" step="0.1" min="0"></label>
                    <label>Act Inst<input type="number" name="actual_instrument" value="${e.actual_instrument || ''}" step="0.1" min="0"></label>
                    <label>Sim Inst<input type="number" name="simulated_instrument" value="${e.simulated_instrument || ''}" step="0.1" min="0"></label>
                </div>
                <div class="lb-form-row lb-form-3col">
                    <label>Solo<input type="number" name="solo" value="${e.solo || ''}" step="0.1" min="0"></label>
                    <label>Dual Rcvd<input type="number" name="dual_received" value="${e.dual_received || ''}" step="0.1" min="0"></label>
                    <label>Dual Given<input type="number" name="dual_given" value="${e.dual_given || ''}" step="0.1" min="0"></label>
                </div>

                <div class="lb-form-section">Landings &amp; Approaches</div>
                <div class="lb-form-row lb-form-4col">
                    <label>Day T/O<input type="number" name="day_takeoffs" value="${e.day_takeoffs || ''}" min="0"></label>
                    <label>Day Ldg<input type="number" name="day_landings_full_stop" value="${e.day_landings_full_stop || ''}" min="0"></label>
                    <label>Night T/O<input type="number" name="night_takeoffs" value="${e.night_takeoffs || ''}" min="0"></label>
                    <label>Night Ldg<input type="number" name="night_landings_full_stop" value="${e.night_landings_full_stop || ''}" min="0"></label>
                </div>
                <div class="lb-form-row lb-form-3col">
                    <label>Holds<input type="number" name="holds" value="${e.holds || ''}" min="0"></label>
                    <label>Appr 1<input type="text" name="approach_1" value="${this._escHtml(e.approach_1 || '')}" placeholder="ILS 19"></label>
                    <label>Appr 2<input type="text" name="approach_2" value="${this._escHtml(e.approach_2 || '')}" placeholder="RNAV 1"></label>
                </div>

                <div class="lb-form-section">Hobbs / Tach</div>
                <div class="lb-form-row lb-form-4col">
                    <label>Hobbs Out<input type="number" name="hobbs_start" value="${e.hobbs_start || ''}" step="0.1" min="0"></label>
                    <label>Hobbs In<input type="number" name="hobbs_end" value="${e.hobbs_end || ''}" step="0.1" min="0"></label>
                    <label>Tach Out<input type="number" name="tach_start" value="${e.tach_start || ''}" step="0.1" min="0"></label>
                    <label>Tach In<input type="number" name="tach_end" value="${e.tach_end || ''}" step="0.1" min="0"></label>
                </div>

                <div class="lb-form-section">People &amp; Notes</div>
                <div class="lb-form-row">
                    <label>Instructor<input type="text" name="instructor_name" value="${this._escHtml(e.instructor_name || '')}"></label>
                    <label>Passengers<input type="text" name="person_1" value="${this._escHtml(e.person_1 || '')}"></label>
                </div>
                <div class="lb-form-row">
                    <label>Notes<textarea name="notes" rows="2">${this._escHtml(e.notes || e.pilot_comments || '')}</textarea></label>
                </div>

                <div class="lb-form-actions">
                    <button class="logbook-btn logbook-form-save">SAVE</button>
                    <button class="logbook-btn logbook-form-cancel-btn">CANCEL</button>
                </div>
            </div>
        `;

        this._el.appendChild(overlay);

        // Wire cancel
        const cancelBtns = overlay.querySelectorAll('.logbook-form-cancel, .logbook-form-cancel-btn');
        cancelBtns.forEach(btn => {
            this._wireButton(btn, () => overlay.remove());
        });

        // Wire save
        const saveBtn = overlay.querySelector('.logbook-form-save');
        this._wireButton(saveBtn, async () => {
            saveBtn.textContent = '...';
            saveBtn.disabled = true;
            try {
                await this._saveFormData(overlay, entry);
                overlay.remove();
                this._renderList();
            } catch (err) {
                console.error('[Logbook] Save failed:', err);
                saveBtn.textContent = 'SAVE';
                saveBtn.disabled = false;
            }
        });

        // Auto-uppercase airport fields
        overlay.querySelectorAll('input[autocapitalize="characters"]').forEach(inp => {
            inp.addEventListener('input', () => { inp.value = inp.value.toUpperCase(); });
        });
    }

    async _saveFormData(overlay, existingEntry) {
        const form = overlay.querySelector('.logbook-form-body');
        const getValue = (name) => {
            const el = form.querySelector(`[name="${name}"]`);
            if (!el) return undefined;
            const v = el.value.trim();
            return v === '' ? undefined : v;
        };
        const getNum = (name) => {
            const v = getValue(name);
            if (v === undefined) return undefined;
            const n = parseFloat(v);
            return isNaN(n) ? undefined : n;
        };
        const getInt = (name) => {
            const v = getValue(name);
            if (v === undefined) return undefined;
            const n = parseInt(v, 10);
            return isNaN(n) ? undefined : n;
        };

        const fields = {
            date: getValue('date'),
            from_airport: getValue('from_airport'),
            to_airport: getValue('to_airport'),
            departure_icao: getValue('from_airport'),
            destination_icao: getValue('to_airport'),
            route: getValue('route'),
            aircraft_id: getValue('aircraft_id'),
            aircraft_tail: getValue('aircraft_id'),
            conditions: getValue('conditions'),
            time_out: getValue('time_out'),
            time_off: getValue('time_off'),
            time_on: getValue('time_on'),
            time_in: getValue('time_in'),
            total_time: getNum('total_time'),
            flight_time_hours: getNum('total_time'),
            pic: getNum('pic'),
            cross_country: getNum('cross_country'),
            night: getNum('night'),
            actual_instrument: getNum('actual_instrument'),
            simulated_instrument: getNum('simulated_instrument'),
            solo: getNum('solo'),
            dual_received: getNum('dual_received'),
            dual_given: getNum('dual_given'),
            day_takeoffs: getInt('day_takeoffs'),
            day_landings_full_stop: getInt('day_landings_full_stop'),
            night_takeoffs: getInt('night_takeoffs'),
            night_landings_full_stop: getInt('night_landings_full_stop'),
            holds: getInt('holds'),
            approach_1: getValue('approach_1'),
            approach_2: getValue('approach_2'),
            hobbs_start: getNum('hobbs_start'),
            hobbs_end: getNum('hobbs_end'),
            tach_start: getNum('tach_start'),
            tach_end: getNum('tach_end'),
            instructor_name: getValue('instructor_name'),
            person_1: getValue('person_1'),
            notes: getValue('notes'),
            pilot_comments: getValue('notes'),
        };

        // Remove undefined fields
        for (const k of Object.keys(fields)) {
            if (fields[k] === undefined) delete fields[k];
        }

        if (existingEntry) {
            // Edit existing
            await this.updateEntry(existingEntry.id, fields);
            console.log(`[Logbook] Entry updated: ${existingEntry.id}`);
        } else {
            // New manual entry
            const entry = {
                id: crypto.randomUUID ? crypto.randomUUID() : `lb-${Date.now()}`,
                ...fields,
                source: 'manual',
                created_at: new Date().toISOString(),
                synced: false,
            };

            // Look up airport names
            if (entry.from_airport) {
                try {
                    const apt = await this._nasrDb.getAirport(entry.from_airport);
                    if (apt) entry.departure_name = apt.name;
                } catch { /* */ }
            }
            if (entry.to_airport) {
                try {
                    const apt = await this._nasrDb.getAirport(entry.to_airport);
                    if (apt) entry.destination_name = apt.name;
                } catch { /* */ }
            }

            await this._saveEntry(entry);
            console.log(`[Logbook] Manual entry created: ${entry.from_airport} -> ${entry.to_airport}`);
        }

        // Queue sync
        if (this._autoSync()) this.syncWhenOnline();
    }

    // ========== Auto-create from Flight Recording ==========

    async createEntry(csvFilename) {
        let depIcao = 'UNKN', destIcao = 'UNKN';
        let dateStr = new Date().toISOString().slice(0, 10);

        if (csvFilename) {
            const stem = csvFilename.replace(/\.csv$/i, '');
            const match = stem.match(/^(\d{8})_(\w+)-(\w+)/);
            if (match) {
                const d = match[1];
                dateStr = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
                depIcao = match[2];
                destIcao = match[3];
            }
        }

        let depName = depIcao, destName = destIcao;
        try {
            const dep = await this._nasrDb.getAirport(depIcao);
            if (dep) depName = dep.name;
        } catch { /* */ }
        try {
            const dest = await this._nasrDb.getAirport(destIcao);
            if (dest) destName = dest.name;
        } catch { /* */ }

        const route = await this._getRouteString();
        const engData = window.enginePanel?.lastData;
        const durationStr = engData?.duration || '';
        let flightTimeHours = 0;
        if (durationStr) {
            const parts = durationStr.split(':');
            if (parts.length === 2) {
                flightTimeHours = Math.round((parseInt(parts[0]) / 60 + parseInt(parts[1]) / 3600) * 100) / 100;
            }
        }

        const entry = {
            id: crypto.randomUUID ? crypto.randomUUID() : `lb-${Date.now()}`,
            date: dateStr,
            departure_icao: depIcao,
            departure_name: depName,
            destination_icao: destIcao,
            destination_name: destName,
            from_airport: depIcao,
            to_airport: destIcao,
            route: route,
            flight_time_hours: flightTimeHours,
            total_time: flightTimeHours,
            conditions: this._defaultConditions,
            aircraft_tail: CockpitConfig.aircraft('tail') || 'N00000',
            aircraft_id: CockpitConfig.aircraft('tail') || 'N00000',
            aircraft_type: CockpitConfig.aircraft('type') || 'Unknown',
            point_count: engData?.csv_points || 0,
            source: 'flypi',
            created_at: new Date().toISOString(),
            synced: false,
            csvFilename: csvFilename,
            notes: '',
        };

        if (this._trackHobbs) {
            const prevHobbs = await this._getLastHobbs();
            entry.hobbs_start = prevHobbs;
            entry.hobbs_end = Math.round((prevHobbs + flightTimeHours) * 100) / 100;
        }

        await this._saveEntry(entry);
        console.log(`[Logbook] Auto entry: ${depIcao} -> ${destIcao}, ${flightTimeHours}h`);

        if (this._autoSync()) {
            this._syncQueue.push(entry.id);
            this.syncWhenOnline();
        }

        return entry;
    }

    // ========== Data Access ==========

    async getEntries(limit = 0) {
        try {
            const db = await this._openIdb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(Logbook.IDB_STORE, 'readonly');
                const req = tx.objectStore(Logbook.IDB_STORE).getAll();
                req.onsuccess = () => {
                    let entries = (req.result || [])
                        .sort((a, b) => (b.date || b.created_at || '').localeCompare(a.date || a.created_at || ''));
                    if (limit > 0) entries = entries.slice(0, limit);
                    db.close();
                    resolve(entries);
                };
                req.onerror = () => { db.close(); reject(req.error); };
            });
        } catch (err) {
            console.error('[Logbook] Failed to load entries:', err);
            return [];
        }
    }

    async updateEntry(id, fields) {
        try {
            const db = await this._openIdb();
            const tx = db.transaction(Logbook.IDB_STORE, 'readwrite');
            const store = tx.objectStore(Logbook.IDB_STORE);

            return new Promise((resolve, reject) => {
                const getReq = store.get(id);
                getReq.onsuccess = () => {
                    const entry = getReq.result;
                    if (!entry) {
                        db.close();
                        reject(new Error(`Logbook entry ${id} not found`));
                        return;
                    }

                    Object.assign(entry, fields, {
                        updated_at: new Date().toISOString(),
                        synced: false,
                    });

                    const putReq = store.put(entry);
                    putReq.onsuccess = () => { db.close(); resolve(entry); };
                    putReq.onerror = () => { db.close(); reject(putReq.error); };
                };
                getReq.onerror = () => { db.close(); reject(getReq.error); };
            });
        } catch (err) {
            console.error('[Logbook] Failed to update entry:', err);
            throw err;
        }
    }

    async _deleteEntry(id) {
        try {
            const db = await this._openIdb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(Logbook.IDB_STORE, 'readwrite');
                tx.objectStore(Logbook.IDB_STORE).delete(id);
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            });
        } catch (err) {
            console.error('[Logbook] Failed to delete entry:', err);
        }
    }

    // ========== Sync ==========

    async syncWhenOnline() {
        if (this._syncInProgress) return;
        if (!navigator.onLine) {
            window.addEventListener('online', () => this.syncWhenOnline(), { once: true });
            return;
        }

        this._syncInProgress = true;

        try {
            const entries = await this.getEntries();
            const unsynced = entries.filter(e => !e.synced);

            if (unsynced.length === 0) {
                this._syncInProgress = false;
                return;
            }

            const workerBase = Settings.workerBase;
            const resp = await fetch(`${workerBase}/flights/logbook`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: unsynced }),
                signal: AbortSignal.timeout(10000),
            });

            if (resp.ok) {
                for (const entry of unsynced) {
                    await this.updateEntry(entry.id, { synced: true });
                }
                console.log(`[Logbook] Synced ${unsynced.length} entries`);
            } else {
                console.warn(`[Logbook] Sync failed (${resp.status})`);
            }
        } catch (err) {
            console.warn('[Logbook] Sync error:', err.message);
            window.addEventListener('online', () => this.syncWhenOnline(), { once: true });
        } finally {
            this._syncInProgress = false;
        }
    }

    // ========== CSV Export ==========

    async exportCSV() {
        const entries = await this.getEntries();
        if (entries.length === 0) return '';

        const header = [
            'Date', 'From', 'To', 'Route', 'Aircraft',
            'Total Time', 'PIC', 'XC', 'Night', 'Act Inst', 'Sim Inst',
            'Solo', 'Dual Rcvd', 'Dual Given',
            'Day TO', 'Day Ldg', 'Night TO', 'Night Ldg',
            'Hobbs Start', 'Hobbs End', 'Conditions', 'Notes',
        ].join(',');

        const rows = entries.map(e => [
            e.date,
            e.departure_icao || e.from_airport,
            e.destination_icao || e.to_airport,
            this._csvEscape(e.route),
            e.aircraft_tail || e.aircraft_id,
            e.flight_time_hours || e.total_time || 0,
            e.pic || 0, e.cross_country || 0, e.night || 0,
            e.actual_instrument || 0, e.simulated_instrument || 0,
            e.solo || 0, e.dual_received || 0, e.dual_given || 0,
            e.day_takeoffs || 0, e.day_landings_full_stop || 0,
            e.night_takeoffs || 0, e.night_landings_full_stop || 0,
            e.hobbs_start || '', e.hobbs_end || '',
            e.conditions,
            this._csvEscape(e.notes || ''),
        ].join(','));

        return header + '\n' + rows.join('\n') + '\n';
    }

    // ========== Server Fetch ==========

    async _fetchFromServer() {
        if (!navigator.onLine) return;
        const workerBase = Settings.workerBase;
        try {
            const resp = await fetch(`${workerBase}/flights/logbook?limit=200`, {
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
            if (!resp.ok) return;
            const { entries } = await resp.json();
            if (!Array.isArray(entries) || entries.length === 0) return;

            // Merge server entries into local IDB (server wins on conflict by id)
            for (const serverEntry of entries) {
                // Map server column names to local names
                serverEntry.departure_icao = serverEntry.departure_icao || serverEntry.from_airport;
                serverEntry.destination_icao = serverEntry.destination_icao || serverEntry.to_airport;
                serverEntry.aircraft_tail = serverEntry.aircraft_tail || serverEntry.aircraft_id;
                serverEntry.flight_time_hours = serverEntry.flight_time_hours || serverEntry.total_time;
                serverEntry.synced = true;
                serverEntry.created_at = serverEntry.created_at || new Date().toISOString();
                await this._saveEntry(serverEntry);
            }
            console.log(`[Logbook] Merged ${entries.length} entries from server`);
        } catch (err) {
            console.warn('[Logbook] Server fetch failed:', err.message);
        }
    }

    // ========== Currency Tab ==========

    async _renderCurrency() {
        this._body.innerHTML = '<div class="logbook-empty">Loading currency...</div>';
        const workerBase = Settings.workerBase;

        // Compute locally first (fast), then overlay with server data
        const entries = await this.getEntries();
        const now = Date.now();
        const d90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const recent = entries.filter(e => (e.date || '') >= d90);
        const dayLdg = recent.reduce((s, e) => s + (e.day_landings_full_stop || 0), 0);
        const nightLdg = recent.reduce((s, e) => s + (e.night_landings_full_stop || 0), 0);
        const totalHrs = entries.reduce((s, e) => s + (e.flight_time_hours || e.total_time || 0), 0);

        // Find last BFR/IPC from local entries
        const lastBfr = entries.find(e => e.flight_review)?.date || null;
        const lastIpc = entries.find(e => e.ipc)?.date || null;

        let currency = null;
        // Try server for certificate/medical data
        try {
            if (navigator.onLine) {
                const resp = await fetch(`${workerBase}/flights/currency`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    currency = data.currency;
                }
            }
        } catch { /* offline — use local only */ }

        const bfrExpiry = lastBfr ? this._addMonths(lastBfr, 24) : null;
        const bfrCurrent = bfrExpiry ? new Date(bfrExpiry) > new Date() : false;

        const statusBadge = (ok) => ok
            ? '<span class="lb-currency-ok">CURRENT</span>'
            : '<span class="lb-currency-expired">EXPIRED</span>';

        let html = '<div class="lb-currency-section">';
        html += '<h3 class="lb-section-title">Landing Currency (90 days)</h3>';
        html += `<div class="lb-currency-row">
            <span>Day Landings (90d)</span>
            <span>${dayLdg} of 3 ${statusBadge(dayLdg >= 3)}</span>
        </div>`;
        html += `<div class="lb-currency-row">
            <span>Night Landings (90d)</span>
            <span>${nightLdg} of 3 ${statusBadge(nightLdg >= 3)}</span>
        </div>`;
        html += '</div>';

        html += '<div class="lb-currency-section">';
        html += '<h3 class="lb-section-title">Flight Review</h3>';
        html += `<div class="lb-currency-row">
            <span>Last BFR</span>
            <span>${lastBfr || 'None'} ${bfrExpiry ? statusBadge(bfrCurrent) : ''}</span>
        </div>`;
        if (bfrExpiry) {
            html += `<div class="lb-currency-row">
                <span>BFR Expires</span><span>${bfrExpiry}</span>
            </div>`;
        }
        if (lastIpc) {
            html += `<div class="lb-currency-row">
                <span>Last IPC</span><span>${lastIpc}</span>
            </div>`;
        }
        html += '</div>';

        if (currency) {
            html += '<div class="lb-currency-section">';
            html += '<h3 class="lb-section-title">Medical &amp; Certificate</h3>';
            if (currency.medical_class) {
                const medExp = currency.medical_expiry_date;
                const medCurrent = medExp ? new Date(medExp) > new Date() : false;
                html += `<div class="lb-currency-row">
                    <span>Medical (${currency.medical_class})</span>
                    <span>${medExp || '?'} ${statusBadge(medCurrent)}</span>
                </div>`;
            }
            if (currency.certificate_type) {
                html += `<div class="lb-currency-row">
                    <span>Certificate</span><span>${currency.certificate_type}</span>
                </div>`;
            }
            if (currency.ratings?.length) {
                html += `<div class="lb-currency-row">
                    <span>Ratings</span><span>${currency.ratings.join(', ')}</span>
                </div>`;
            }
            html += '</div>';
        }

        html += '<div class="lb-currency-section">';
        html += '<h3 class="lb-section-title">Totals</h3>';
        html += `<div class="lb-currency-row">
            <span>Total Time</span><span>${totalHrs.toFixed(1)} hrs</span>
        </div>`;
        html += `<div class="lb-currency-row">
            <span>Flights</span><span>${entries.length}</span>
        </div>`;
        html += '</div>';

        this._body.innerHTML = html;
    }

    _addMonths(dateStr, months) {
        const d = new Date(dateStr + 'T00:00:00');
        d.setMonth(d.getMonth() + months);
        // Last day of the month rule (FAR 61.56)
        return d.toISOString().slice(0, 10);
    }

    // ========== Oil Tab ==========

    async _renderOil() {
        this._body.innerHTML = '<div class="logbook-empty">Loading oil history...</div>';
        const tail = CockpitConfig.aircraft('tail') || 'N194JT';

        // Try server first
        let events = [];
        try {
            if (navigator.onLine) {
                const workerBase = Settings.workerBase;
                const resp = await fetch(`${workerBase}/flights/oil?aircraft_id=${tail}`, {
                    signal: AbortSignal.timeout(5000),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    events = data.events || [];
                }
            }
        } catch { /* offline */ }

        // Also check local storage
        const localOil = JSON.parse(localStorage.getItem('flypi_oil_events') || '[]');
        // Merge: server wins by id
        const serverIds = new Set(events.map(e => e.id));
        for (const le of localOil) {
            if (!serverIds.has(le.id)) events.push(le);
        }
        events.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        if (events.length === 0) {
            this._body.innerHTML = `<div class="logbook-empty">
                No oil events recorded.<br>Tap <b>+ OIL</b> to log an oil change or addition.
            </div>`;
            return;
        }

        // Find last change and compute tach since change
        const lastChange = events.find(e => e.event_type === 'change');
        const addsSinceChange = lastChange
            ? events.filter(e => e.event_type === 'add' && (e.date || '') > (lastChange.date || ''))
            : [];
        const qtAdded = addsSinceChange.reduce((s, e) => s + (e.oil_quarts || 0), 0);

        let html = '';
        if (lastChange) {
            const tachSince = lastChange.tach_time
                ? `Tach at change: ${lastChange.tach_time}`
                : '';
            html += `<div class="lb-oil-summary">
                <div class="lb-oil-summary-title">Since Last Oil Change</div>
                <div class="lb-currency-row"><span>Date</span><span>${lastChange.date}</span></div>
                ${tachSince ? `<div class="lb-currency-row"><span>Tach Time</span><span>${lastChange.tach_time}</span></div>` : ''}
                <div class="lb-currency-row"><span>Oil Added Since</span><span>${qtAdded.toFixed(1)} qt</span></div>
                ${lastChange.oil_filter_changed ? '<div class="lb-currency-row"><span>Filter</span><span>Changed</span></div>' : ''}
            </div>`;
        }

        html += '<div class="lb-oil-history">';
        html += events.map(e => {
            const icon = e.event_type === 'change' ? '\u{1F6E2}\uFE0F' : '+';
            const label = e.event_type === 'change' ? 'OIL CHANGE' : 'OIL ADDED';
            const qty = e.oil_quarts ? `${e.oil_quarts} qt` : '';
            const tach = e.tach_time ? `Tach: ${e.tach_time}` : '';
            const filter = e.oil_filter_changed ? ' + filter' : '';
            const brand = e.oil_brand || '';
            const notes = e.notes || '';

            return `<div class="logbook-entry" data-id="${e.id}">
                <div class="logbook-entry-header">
                    <span class="logbook-date">${e.date}</span>
                    <span class="logbook-route">${label}</span>
                </div>
                <div class="logbook-entry-details">
                    ${qty ? `<span>${qty}${filter}</span>` : ''}
                    ${tach ? `<span>${tach}</span>` : ''}
                    ${brand ? `<span>${brand}</span>` : ''}
                </div>
                ${notes ? `<div class="logbook-entry-details"><span>${this._escHtml(notes)}</span></div>` : ''}
                <div class="logbook-entry-actions">
                    <button class="logbook-btn logbook-delete-btn" data-id="${e.id}">DEL</button>
                </div>
            </div>`;
        }).join('');
        html += '</div>';

        this._body.innerHTML = html;

        // Wire delete buttons
        this._body.querySelectorAll('.logbook-delete-btn').forEach(btn => {
            this._wireButton(btn, () => {
                btn.textContent = '?';
                this._wireButton(btn, async () => {
                    await this._deleteOilEvent(btn.dataset.id);
                    this._renderOil();
                });
            });
        });
    }

    _showOilForm(existing) {
        document.getElementById('logbookForm')?.remove();
        const e = existing || {};
        const today = new Date().toISOString().slice(0, 10);
        const tail = CockpitConfig.aircraft('tail') || 'N194JT';

        const overlay = document.createElement('div');
        overlay.id = 'logbookForm';
        overlay.className = 'logbook-form-overlay';

        overlay.innerHTML = `
            <div class="logbook-form-header">
                <span>${existing ? 'Edit Oil Event' : 'Log Oil Event'}</span>
                <button class="btn-close logbook-form-cancel">\u2715</button>
            </div>
            <div class="logbook-form-body">
                <div class="lb-form-section">Oil Event</div>
                <div class="lb-form-row">
                    <label>Type
                        <select name="event_type">
                            <option value="change" ${(e.event_type || 'change') === 'change' ? 'selected' : ''}>Oil Change</option>
                            <option value="add" ${e.event_type === 'add' ? 'selected' : ''}>Oil Added</option>
                        </select>
                    </label>
                    <label>Date<input type="date" name="date" value="${e.date || today}"></label>
                </div>
                <div class="lb-form-row">
                    <label>Tach Time<input type="number" name="tach_time" value="${e.tach_time || ''}" step="0.1" min="0" placeholder="1234.5"></label>
                    <label>Quarts<input type="number" name="oil_quarts" value="${e.oil_quarts || ''}" step="0.25" min="0" placeholder="6.0"></label>
                </div>
                <div class="lb-form-row">
                    <label>Oil Brand<input type="text" name="oil_brand" value="${this._escHtml(e.oil_brand || '')}" placeholder="Phillips X/C 20W-50"></label>
                    <label>Filter Changed
                        <select name="oil_filter_changed">
                            <option value="false" ${!e.oil_filter_changed ? 'selected' : ''}>No</option>
                            <option value="true" ${e.oil_filter_changed ? 'selected' : ''}>Yes</option>
                        </select>
                    </label>
                </div>
                <div class="lb-form-row">
                    <label>Notes<textarea name="notes" rows="2">${this._escHtml(e.notes || '')}</textarea></label>
                </div>
                <div class="lb-form-actions">
                    <button class="logbook-btn logbook-form-save">SAVE</button>
                    <button class="logbook-btn logbook-form-cancel-btn">CANCEL</button>
                </div>
            </div>
        `;

        this._el.appendChild(overlay);

        overlay.querySelectorAll('.logbook-form-cancel, .logbook-form-cancel-btn').forEach(btn => {
            this._wireButton(btn, () => overlay.remove());
        });

        const saveBtn = overlay.querySelector('.logbook-form-save');
        this._wireButton(saveBtn, async () => {
            saveBtn.textContent = '...';
            saveBtn.disabled = true;
            try {
                const form = overlay.querySelector('.logbook-form-body');
                const val = (n) => { const el = form.querySelector(`[name="${n}"]`); return el?.value?.trim() || ''; };

                const event = {
                    id: existing?.id || (crypto.randomUUID ? crypto.randomUUID() : `oil-${Date.now()}`),
                    event_type: val('event_type'),
                    date: val('date'),
                    aircraft_id: tail,
                    tach_time: parseFloat(val('tach_time')) || null,
                    oil_quarts: parseFloat(val('oil_quarts')) || null,
                    oil_brand: val('oil_brand') || null,
                    oil_filter_changed: val('oil_filter_changed') === 'true',
                    notes: val('notes') || null,
                };

                // Save locally
                const localOil = JSON.parse(localStorage.getItem('flypi_oil_events') || '[]');
                const idx = localOil.findIndex(e => e.id === event.id);
                if (idx >= 0) localOil[idx] = event;
                else localOil.push(event);
                localStorage.setItem('flypi_oil_events', JSON.stringify(localOil));

                // Sync to server
                if (navigator.onLine) {
                    try {
                        const workerBase = Settings.workerBase;
                        await fetch(`${workerBase}/flights/oil`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(event),
                            signal: AbortSignal.timeout(5000),
                        });
                    } catch { /* will retry later */ }
                }

                overlay.remove();
                this._renderOil();
            } catch (err) {
                console.error('[Logbook] Oil save failed:', err);
                saveBtn.textContent = 'SAVE';
                saveBtn.disabled = false;
            }
        });
    }

    async _deleteOilEvent(id) {
        // Remove locally
        const localOil = JSON.parse(localStorage.getItem('flypi_oil_events') || '[]');
        localStorage.setItem('flypi_oil_events', JSON.stringify(localOil.filter(e => e.id !== id)));

        // Delete on server
        if (navigator.onLine) {
            try {
                const workerBase = Settings.workerBase;
                await fetch(`${workerBase}/flights/oil?id=${id}`, {
                    method: 'DELETE',
                    signal: AbortSignal.timeout(5000),
                });
            } catch { /* best effort */ }
        }
    }

    // ========== Legacy: renderEntries (called by external code) ==========

    async renderEntries(container) {
        this._body = container;
        await this._renderList();
    }

    // ========== Internal: Event Handler ==========

    _onCaptureStopped(detail = {}) {
        setTimeout(() => {
            const csvFilename = detail.csvFilename || null;
            if (!csvFilename) {
                console.warn('[Logbook] No CSV filename from FlightSync, skipping entry');
                return;
            }
            this.createEntry(csvFilename).catch(err => {
                console.error('[Logbook] Auto-create failed:', err);
            });
        }, 2000);
    }

    // ========== Internal: Helpers ==========

    async _findNearestAirport(lat, lon) {
        try {
            const nearby = await this._nasrDb.getAirportsNear(lat, lon, 10);
            if (nearby.length === 0) return null;
            nearby.sort((a, b) => {
                const distA = NasrDB.haversineNm(lat, lon, a.lat, a.lon);
                const distB = NasrDB.haversineNm(lat, lon, b.lat, b.lon);
                return distA - distB;
            });
            return nearby[0];
        } catch (err) {
            console.warn('[Logbook] Airport lookup failed:', err);
            return null;
        }
    }

    async _getRouteString() {
        try {
            const plan = await this._nasrDb.getActiveFlightPlan();
            if (plan && plan.route) {
                if (typeof plan.route === 'string') return plan.route;
                if (Array.isArray(plan.route)) {
                    return plan.route.map(wp => wp.id || wp.name || wp.icao || '???').join(' ');
                }
                if (plan.waypoints && Array.isArray(plan.waypoints)) {
                    return plan.waypoints.map(wp => wp.id || wp.name || wp.icao || '???').join(' ');
                }
            }
        } catch { /* ignore */ }
        return 'LOCAL';
    }

    async _getLastHobbs() {
        try {
            const entries = await this.getEntries(1);
            if (entries.length > 0 && entries[0].hobbs_end) return entries[0].hobbs_end;
        } catch { /* ignore */ }
        return 0;
    }

    _autoSync() {
        return CockpitConfig.get('flightRecording').autoSyncWhenOnline !== false;
    }

    async importFromEngineMonitor() {
        console.log('[Logbook] Import not yet available — local CSV scanning coming in Phase 3');
        return 0;
    }

    // ========== Internal: IndexedDB ==========

    async _openIdb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(Logbook.IDB_NAME, Logbook.IDB_VERSION);

            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(Logbook.IDB_STORE)) {
                    const store = db.createObjectStore(Logbook.IDB_STORE, { keyPath: 'id' });
                    store.createIndex('date', 'date', { unique: false });
                    store.createIndex('created_at', 'created_at', { unique: false });
                    store.createIndex('synced', 'synced', { unique: false });
                }
                for (const name of db.objectStoreNames) {
                    if (name === 'flight_recordings' || name === 'flight_csvs') {
                        db.deleteObjectStore(name);
                    }
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async _saveEntry(entry) {
        const db = await this._openIdb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(Logbook.IDB_STORE, 'readwrite');
            tx.objectStore(Logbook.IDB_STORE).put(entry);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    // ========== Internal: Touch Button Wiring ==========

    _wireButton(el, action) {
        let touchFired = false;
        el.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            touchFired = true;
            action();
        }, { passive: false });
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            if (touchFired) { touchFired = false; return; }
            action();
        });
    }

    // ========== Internal: CSV / HTML Helpers ==========

    _csvEscape(value) {
        if (!value) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    _escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}
