/**
 * FlyTab — Logbook
 * Auto-generates logbook entries when flight recording stops.
 * Stores entries in IndexedDB (local-only), syncs to flywhere.app when online.
 * FlyTab architecture: Pi is data relay only — no stored data fetched from Pi.
 * All logbook/flight data lives on the Android device.
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
        this.renderEntries(this._body);
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
                <button class="btn-close logbook-close">✕</button>
            </div>
            <div class="logbook-body"></div>
        `;
        this._body = this._el.querySelector('.logbook-body');
        const closeBtn = this._el.querySelector('.logbook-close');
        closeBtn.addEventListener('click', () => this.hide());
        closeBtn.addEventListener('touchend', (e) => { e.preventDefault(); this.hide(); });
        document.body.appendChild(this._el);
    }

    // ========== Public API ==========

    /**
     * Create a logbook entry from a completed capture_v5 flight CSV.
     * Parses the CSV filename for airport IDs (format: YYYYMMDD_DEP-DEST.csv).
     * @param {string} csvFilename - The CSV filename from capture_v5
     * @returns {Promise<object>} The created logbook entry
     */
    async createEntry(csvFilename) {
        // Parse airport IDs from filename: 20260306_KLKR-KUZA.csv
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

        // Look up airport names from NASR
        let depName = depIcao, destName = destIcao;
        try {
            const dep = await this._nasrDb.getAirport(depIcao);
            if (dep) depName = dep.name;
        } catch { /* */ }
        try {
            const dest = await this._nasrDb.getAirport(destIcao);
            if (dest) destName = dest.name;
        } catch { /* */ }

        // Get route from active flight plan or default to LOCAL
        const route = await this._getRouteString();

        // Get capture duration from engine status
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
            route: route,
            flight_time_hours: flightTimeHours,
            conditions: this._defaultConditions,
            aircraft_tail: CockpitConfig.aircraft('tail') || 'N00000',
            aircraft_type: CockpitConfig.aircraft('type') || 'Unknown',
            point_count: engData?.csv_points || 0,
            created_at: new Date().toISOString(),
            synced: false,
            csvFilename: csvFilename,
            notes: '',
        };

        // Hobbs tracking
        if (this._trackHobbs) {
            const prevHobbs = await this._getLastHobbs();
            entry.hobbs_start = prevHobbs;
            entry.hobbs_end = Math.round((prevHobbs + flightTimeHours) * 100) / 100;
        }

        await this._saveEntry(entry);

        console.log(`[Logbook] Entry created: ${entry.departure_icao} -> ${entry.destination_icao}, ` +
            `${flightTimeHours}h, CSV: ${csvFilename}`);

        if (this._autoSync()) {
            this._syncQueue.push(entry.id);
            this.syncWhenOnline();
        }

        return entry;
    }

    /**
     * Get logbook entries sorted by date (newest first).
     * @param {number} limit - Maximum entries to return (0 = all)
     * @returns {Promise<Array>} Logbook entries
     */
    async getEntries(limit = 0) {
        try {
            const db = await this._openIdb();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(Logbook.IDB_STORE, 'readonly');
                const req = tx.objectStore(Logbook.IDB_STORE).getAll();
                req.onsuccess = () => {
                    let entries = (req.result || [])
                        .sort((a, b) => b.created_at.localeCompare(a.created_at));
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

    /**
     * Update fields on an existing logbook entry.
     * @param {string} id - Entry ID
     * @param {object} fields - Fields to update (merged into existing entry)
     * @returns {Promise<object>} Updated entry
     */
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

                    // Merge fields
                    Object.assign(entry, fields, {
                        updated_at: new Date().toISOString(),
                        synced: false, // Mark as needing re-sync
                    });

                    const putReq = store.put(entry);
                    putReq.onsuccess = () => {
                        db.close();
                        resolve(entry);
                    };
                    putReq.onerror = () => { db.close(); reject(putReq.error); };
                };
                getReq.onerror = () => { db.close(); reject(getReq.error); };
            });
        } catch (err) {
            console.error('[Logbook] Failed to update entry:', err);
            throw err;
        }
    }

    /**
     * Sync unsynced entries to flywhere.app when online.
     * Called automatically after creating entries, or manually.
     */
    async syncWhenOnline() {
        if (this._syncInProgress) return;
        if (!navigator.onLine) {
            // Register to try again when online
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
                signal: AbortSignal.timeout(3000),
            });

            if (resp.ok) {
                // Mark entries as synced
                for (const entry of unsynced) {
                    await this.updateEntry(entry.id, { synced: true });
                }
                console.log(`[Logbook] Synced ${unsynced.length} entries`);
            } else {
                console.warn(`[Logbook] Sync failed (${resp.status})`);
            }
        } catch (err) {
            console.warn('[Logbook] Sync error:', err.message);
            // Retry when back online
            window.addEventListener('online', () => this.syncWhenOnline(), { once: true });
        } finally {
            this._syncInProgress = false;
        }
    }

    /**
     * Export all logbook entries as a CSV string.
     * @returns {Promise<string>} CSV content
     */
    async exportCSV() {
        const entries = await this.getEntries();
        if (entries.length === 0) return '';

        const header = [
            'Date',
            'Departure',
            'Destination',
            'Route',
            'Aircraft',
            'Flight Time (hrs)',
            'Fuel Used (gal)',
            'Distance (nm)',
            'Conditions',
            'Hobbs Start',
            'Hobbs End',
            'Notes',
        ].join(',');

        const rows = entries.map(e => [
            e.date,
            e.departure_icao,
            e.destination_icao,
            this._csvEscape(e.route),
            e.aircraft_tail,
            e.flight_time_hours,
            e.fuel_used_gal,
            e.distance_nm,
            e.conditions,
            e.hobbs_start || '',
            e.hobbs_end || '',
            this._csvEscape(e.notes || ''),
        ].join(','));

        return header + '\n' + rows.join('\n') + '\n';
    }

    // ========== Internal: Event Handler ==========

    _onCaptureStopped(detail = {}) {
        // Delay to let FlightSync cache the CSV and filename resolution to complete
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

    // ========== Internal: Airport Lookup ==========

    async _findNearestAirport(lat, lon) {
        try {
            const nearby = await this._nasrDb.getAirportsNear(lat, lon, 10);
            if (nearby.length === 0) return null;

            // Sort by distance, return closest
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

    // ========== Internal: Route String ==========

    async _getRouteString() {
        try {
            const plan = await this._nasrDb.getActiveFlightPlan();
            if (plan && plan.route) {
                // Extract waypoint identifiers from plan
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

    // ========== Internal: Hobbs Tracking ==========

    async _getLastHobbs() {
        try {
            const entries = await this.getEntries(1);
            if (entries.length > 0 && entries[0].hobbs_end) {
                return entries[0].hobbs_end;
            }
        } catch { /* ignore */ }
        return 0;
    }

    // ========== Internal: Config Helpers ==========

    _autoSync() {
        return CockpitConfig.get('flightRecording').autoSyncWhenOnline !== false;
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
                // Clean up old FlightRecorder stores
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

    // ========== Flight CSV Download & Export ==========

    /**
     * Look up a flight CSV from local IndexedDB storage.
     * FlyTab architecture: all flight data is local — no Pi fetches.
     * @param {object} entry - Logbook entry with session_id and csvFilename
     */
    async downloadCsv(entry) {
        try {
            let csvString = null;
            let filename = entry.csvFilename;

            // Check IDB — flight recorder stores CSV locally on stop
            if (entry.session_id) {
                const existing = await this._getFlightCsv(entry.session_id);
                if (existing && existing.csv && existing.csv.length > 10) {
                    csvString = existing.csv;
                    filename = existing.filename || filename;
                }
            }

            // Also try by entry ID
            if (!csvString) {
                const existing = await this._getFlightCsv(entry.id);
                if (existing && existing.csv && existing.csv.length > 10) {
                    csvString = existing.csv;
                    filename = existing.filename || filename;
                }
            }

            if (!csvString || csvString.length < 10) {
                throw new Error('No flight data available in local storage');
            }

            // Update logbook entry
            await this.updateEntry(entry.id, {
                csvDownloaded: true,
                csvFilename: filename,
            });

            console.log(`[Logbook] Flight data found locally: ${filename}`);
            return true;
        } catch (err) {
            console.error('[Logbook] Flight data lookup failed:', err);
            return false;
        }
    }

    /**
     * Export a flight CSV as a browser file download.
     * Reads from IndexedDB and triggers Save As dialog.
     * @param {object} entry - Logbook entry with session_id and csvFilename
     */
    async exportCsv(entry) {
        try {
            const storeKey = entry.session_id || entry.id;
            const record = await this._getFlightCsv(storeKey);
            if (!record || !record.csv) {
                throw new Error('No CSV data in IndexedDB');
            }

            const filename = entry.csvFilename || record.filename || `flight_${entry.date || entry.id}.csv`;
            const blob = new Blob([record.csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();

            // Cleanup
            setTimeout(() => {
                URL.revokeObjectURL(url);
                a.remove();
            }, 1000);

            console.log(`[Logbook] CSV exported: ${filename}`);
            return true;
        } catch (err) {
            console.error('[Logbook] CSV export failed:', err);
            return false;
        }
    }

    /**
     * Render logbook entries into a container element with DOWNLOAD/EXPORT buttons.
     * @param {HTMLElement} container - Target container
     */
    /**
     * Import flight history from local flight CSVs.
     * FlyTab architecture: Pi is data relay only — no stored data from Pi.
     * In Phase 3 this will scan Capacitor Filesystem for flight CSVs.
     * For now returns 0 (no-op stub).
     * @returns {Promise<number>} Number of new entries imported
     */
    async importFromEngineMonitor() {
        // TODO Phase 3: scan Capacitor Filesystem for local flight CSVs
        console.log('[Logbook] Import not yet available — local CSV scanning coming in Phase 3');
        return 0;
    }

    async renderEntries(container) {
        const entries = await this.getEntries(20);

        if (entries.length === 0) {
            container.innerHTML = `
                <div class="logbook-empty">
                    No flights recorded yet.<br>
                    Entries are created automatically when a flight recording stops.
                </div>`;
            return;
        }

        container.innerHTML = entries.map(e => {
            const csvBtn = e.csvDownloaded
                ? `<button class="logbook-btn logbook-export-btn" data-id="${e.id}" data-session="${e.session_id}">EXPORT</button>`
                : `<button class="logbook-btn logbook-download-btn" data-id="${e.id}" data-session="${e.session_id}">DOWNLOAD</button>`;

            return `<div class="logbook-entry" data-id="${e.id}">
                <div class="logbook-entry-header">
                    <span class="logbook-date">${e.date}</span>
                    <span class="logbook-route">${e.departure_icao} → ${e.destination_icao}</span>
                </div>
                <div class="logbook-entry-details">
                    <span>${e.flight_time_hours}h</span>
                    <span>${e.fuel_used_gal} gal</span>
                    <span>${e.distance_nm} nm</span>
                    <span>${e.aircraft_tail}</span>
                </div>
                <div class="logbook-entry-actions">${csvBtn}</div>
            </div>`;
        }).join('');

        // Wire DOWNLOAD buttons
        container.querySelectorAll('.logbook-download-btn').forEach(btn => {
            this._wireButton(btn, async () => {
                const entry = entries.find(e => e.id === btn.dataset.id);
                if (!entry) return;

                btn.textContent = '...';
                btn.disabled = true;
                const ok = await this.downloadCsv(entry);
                if (ok) {
                    btn.textContent = 'EXPORT';
                    btn.className = 'logbook-btn logbook-export-btn';
                    btn.disabled = false;
                    entry.csvDownloaded = true;
                    // Re-wire as export button
                    this._wireButton(btn, () => this.exportCsv(entry));
                } else {
                    btn.textContent = 'FAILED';
                    setTimeout(() => {
                        btn.textContent = 'DOWNLOAD';
                        btn.disabled = false;
                    }, 2000);
                }
            });
        });

        // Wire EXPORT buttons
        container.querySelectorAll('.logbook-export-btn').forEach(btn => {
            const entry = entries.find(e => e.id === btn.dataset.id);
            if (entry) {
                this._wireButton(btn, () => this.exportCsv(entry));
            }
        });
    }

    // ========== Internal: iPad Touch Button Wiring ==========

    /**
     * Wire a button with touchstart + click fallback for iPad/Leaflet reliability.
     * touchstart fires before Leaflet's drag handler can cancel the touch sequence.
     */
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

    // ========== Internal: CSV Helpers ==========

    _csvEscape(value) {
        if (!value) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }
}
