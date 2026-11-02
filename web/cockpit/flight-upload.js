/**
 * FlyTab — Flight Upload
 * Lists completed flight CSV files and uploads them via SFTP.
 * Upload status persisted in localStorage; password stored encrypted via SftpPlugin.
 */

class FlightUpload {
    static LOCAL_BASE = 'http://localhost:9090';
    static STORAGE_KEY = 'flytab_uploaded_flights';
    // Companion files sent next to each flight CSV: <stem><suffix>. The weather log is
    // renamed by fisb-logger.js on flight end to the CSV's final name + '_weather.ndjson'.
    static COMPANION_SUFFIXES = ['_traffic.ndjson', '_weather.ndjson'];
    // Names of companion files already sent (a Set of file names). Separate from
    // STORAGE_KEY so the flight list's shape is unchanged; lets "Upload All Pending"
    // backfill companions for flights whose CSV was uploaded before they were sent.
    static COMPANION_KEY = 'flytab_uploaded_companions';
    // A log file name Upload All may send on its own (no matching CSV needed).
    static LOG_NAME_RE = /^[A-Za-z0-9_.-]+_(weather|traffic)\.ndjson$/;

    /** Text for HTML (file names, error messages). */
    static _esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    constructor() {
        this._el = null;
        this._visible = false;
        this._flights = [];
        this._uploadedSet = new Set(
            JSON.parse(localStorage.getItem(FlightUpload.STORAGE_KEY) || '[]')
        );
        this._companionSet = new Set(
            JSON.parse(localStorage.getItem(FlightUpload.COMPANION_KEY) || '[]')
        );
        this._buildDOM();
    }

    show() {
        this._el.classList.add('visible');
        this._visible = true;
        this._setMapControlsVisible(false);
        this._loadFlights();
    }

    hide() {
        this._el.classList.remove('visible');
        this._visible = false;
        this._setMapControlsVisible(true);
    }

    toggle() { this._visible ? this.hide() : this.show(); }

    // ── Private ──────────────────────────────────────────────────────────────

    async _loadFlights() {
        const listEl = this._el.querySelector('.fu-list');
        listEl.innerHTML = '<div class="ds-loading">Loading flights...</div>';
        try {
            const resp = await fetch(`${FlightUpload.LOCAL_BASE}/flights/list`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            this._flights = await resp.json();
            this._render();
        } catch (err) {
            listEl.innerHTML = `<div class="ds-error">Failed to load flights: ${FlightUpload._esc(err.message)}</div>`;
        }
    }

    _render() {
        const listEl = this._el.querySelector('.fu-list');
        if (!this._flights.length) {
            listEl.innerHTML = '<div style="padding:24px;color:var(--text-secondary);text-align:center;">No flight files found.</div>';
            return;
        }
        const sorted = [...this._flights].sort((a, b) => this._sortKey(b) - this._sortKey(a));
        listEl.innerHTML = '';
        for (const flight of sorted) {
            const name = flight.name;
            const date = this._parseDate(name, flight.modified_ms);
            const size = this._formatSize(flight.size_bytes);
            const uploaded = this._uploadedSet.has(name);

            // File names come from the shared flights folder (any app can write there): text only.
            const row = document.createElement('div');
            row.className = 'fu-row';
            row.innerHTML = `
                <span class="fu-filename">${FlightUpload._esc(name)}</span>
                <span class="fu-meta">${date}${size ? ' · ' + size : ''}</span>
                <div class="fu-row-actions">
                    <span class="fu-badge ${uploaded ? 'fu-badge--uploaded' : 'fu-badge--pending'}">
                        ${uploaded ? 'UPLOADED' : 'PENDING'}
                    </span>
                    <button class="fu-upload-btn${uploaded ? ' fu-upload-btn--done' : ''}"
                            data-filename="${FlightUpload._esc(name)}"${uploaded ? ' disabled' : ''}>
                        ${uploaded ? '✓' : 'Upload'}
                    </button>
                </div>
            `;

            if (!uploaded) {
                const btn = row.querySelector('.fu-upload-btn');
                wireTap(btn, () => this._uploadOne(name, row));
            }
            listEl.appendChild(row);
        }
    }

    _sortKey(flight) {
        const m = flight.name.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}`);
        return flight.modified_ms || 0;
    }

    _parseDate(name, modifiedMs) {
        const m = name.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) {
            const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
            return d.toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
            });
        }
        if (modifiedMs) {
            return new Date(modifiedMs).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            });
        }
        return '';
    }

    _formatSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    async _uploadOne(filename, rowEl) {
        if (this._busy) return;           // a run is in progress (double tap / row tap)
        this._busy = true;
        try {
            await this._uploadOneInner(filename, rowEl);
        } finally {
            this._busy = false;
        }
    }

    async _uploadOneInner(filename, rowEl) {
        const cfg = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('flightUpload')) || {};
        if (!cfg.host || !cfg.username) {
            window.app?.showToast('Set SFTP host and username in Configuration → Flight Upload first.', null, 4000);
            return;
        }

        const password = await this._getOrPromptPassword();
        if (password === null) return;

        const btn = rowEl.querySelector('.fu-upload-btn');
        btn.textContent = '...';
        btn.disabled = true;

        try {
            const result = await this._sftpUpload(filename, cfg, password);

            if (result.ok) {
                this._markUploaded(filename, rowEl);
                await this._uploadCompanions(filename, cfg, password);
            } else {
                btn.textContent = 'Retry';
                btn.disabled = false;
                // A host-key stop (cancelled / changed key) was already shown by SftpHostKey.
                if (!result.hostKeyHandled) window.app?.showToast(`Upload failed: ${result.error}`, null, 4000);
            }
        } catch (err) {
            btn.textContent = 'Retry';
            btn.disabled = false;
            window.app?.showToast(`Upload error: ${err.message}`, null, 4000);
        }
    }

    /**
     * One SFTP upload through the shared server host-key check (SftpHostKey): an unknown
     * key asks the pilot to confirm its fingerprint, a changed key is refused. Without
     * SftpHostKey loaded the plugin still refuses both; only the prompt is missing.
     */
    _sftpUpload(filename, cfg, password) {
        const op = () => Capacitor.Plugins.Sftp.upload({
            host: cfg.host,
            port: cfg.port || 22,
            username: cfg.username,
            filename,
            remotePath: cfg.remotePath || '~/flights',
            password,
        });
        return typeof SftpHostKey !== 'undefined' ? SftpHostKey.run(op, { action: 'Upload' }) : op();
    }

    /** Companion file names for a flight CSV, e.g. X.csv -> [X_traffic.ndjson, X_weather.ndjson]. */
    _companionNames(csvFilename) {
        return FlightUpload.COMPANION_SUFFIXES.map(sfx => csvFilename.replace(/\.csv$/i, sfx));
    }

    /**
     * Upload one companion file (traffic or weather log). Never throws and never
     * toasts: companions are supplementary and must not block or alarm. SftpPlugin
     * rejects with "File not found: <name>" when the local file is missing (a flight
     * without FIS-B or traffic), which is the normal case and only logged.
     * Recorded in COMPANION_KEY only on a confirmed ok. 'hostkey': stopped by the server
     * host-key check (pilot cancelled or key changed; SftpHostKey told the pilot) — the
     * caller stops its run.
     * @returns {Promise<'ok'|'missing'|'failed'|'hostkey'>}
     */
    async _uploadCompanion(name, cfg, password) {
        const log = (m) => { if (typeof DiagLog !== 'undefined') DiagLog.log('upload', m); };
        try {
            const result = await this._sftpUpload(name, cfg, password);
            if (result?.ok === false && result.hostKeyHandled) {
                log(`Companion upload stopped by the server key check: ${name}`);
                return 'hostkey';
            }
            if (result?.ok === false) {
                log(`Companion upload failed (non-fatal): ${name}: ${result.error || 'unknown'}`);
                return 'failed';
            }
            this._markCompanionUploaded(name);
            log(`Companion uploaded: ${name}`);
            return 'ok';
        } catch (err) {
            if (/^File not found/.test(err?.message || '')) {
                log(`Companion not present (skipped): ${name}`);
                return 'missing';
            }
            log(`Companion upload failed (non-fatal): ${name}: ${err?.message}`);
            return 'failed';
        }
    }

    /** Upload every companion of a CSV that has not been sent yet. */
    async _uploadCompanions(csvFilename, cfg, password) {
        let ok = 0;
        for (const name of this._companionNames(csvFilename)) {
            if (this._companionSet.has(name)) continue;
            const res = await this._uploadCompanion(name, cfg, password);
            if (res === 'ok') ok++;
            else if (res === 'hostkey') break;
        }
        return ok;
    }

    /**
     * True only if the file is in the tablet's flights/ dir (200). 404 / errors -> false.
     * GET aborted once the headers arrive, not HEAD: NanoHTTPD 2.3.1 writes a response
     * body for HEAD too, which breaks the next request on the same keep-alive connection.
     */
    async _existsLocally(name) {
        const c = new AbortController();
        try {
            const r = await fetch(`${FlightUpload.LOCAL_BASE}/flights/${encodeURIComponent(name)}`,
                { signal: c.signal, cache: 'no-store' });
            return !!r.ok;
        } catch (_) {
            return false;
        } finally {
            c.abort();
        }
    }

    /**
     * Weather / traffic log names in the tablet's flights/ dir (GET /flights/logs).
     * Only safe *_weather.ndjson / *_traffic.ndjson names. [] if the endpoint is missing
     * (older APK) or fails: the CSV-driven backfill still runs.
     */
    async _listLogFiles() {
        try {
            const r = await fetch(`${FlightUpload.LOCAL_BASE}/flights/logs`, { cache: 'no-store' });
            if (!r.ok) return [];
            const list = await r.json();
            if (!Array.isArray(list)) return [];
            return list.map((f) => f?.name)
                .filter((n) => typeof n === 'string' && !n.includes('..') && FlightUpload.LOG_NAME_RE.test(n));
        } catch (_) {
            return [];
        }
    }

    /** The flight CSV being recorded right now (FlightRecorder._fileName while recording). */
    _isActiveRecording(name) {
        const fr = (typeof window !== 'undefined') ? window.app?.flightRecorder : null;
        return !!(fr?.recording && (fr.fileName ?? fr._fileName) === name);
    }

    /** The weather or traffic log being written right now (never marked uploaded half-written). */
    _isActiveLog(name) {
        const app = (typeof window !== 'undefined') ? window.app : null;
        if (app?.fisbLogger?._fileName && app.fisbLogger._fileName === name) return true;   // recording or awaiting rename
        const fr = app?.flightRecorder;
        return !!(fr?.recording && fr._trafficFileName === name);
    }

    async _uploadAllPending() {
        if (this._busy) return;           // a run is in progress (double tap)
        this._busy = true;
        try {
            await this._uploadAllPendingInner();
        } finally {
            this._busy = false;
        }
    }

    async _uploadAllPendingInner() {
        // Work list, newest flight first: the CSV if not yet sent, then each companion
        // (traffic / weather log) not yet sent AND present on the tablet. The companion
        // check covers flights already marked uploaded, whose logs were never sent.
        const plan = [];
        for (const f of this._flights) {
            if (this._isActiveRecording(f.name)) continue;   // still being written: it and its logs wait
            if (!this._uploadedSet.has(f.name)) plan.push({ kind: 'csv', name: f.name });
            for (const name of this._companionNames(f.name)) {
                if (this._companionSet.has(name)) continue;
                if (await this._existsLocally(name)) plan.push({ kind: 'companion', name, csv: f.name });
            }
        }
        // Weather / traffic logs with no matching CSV (kept their start-time name after a
        // restart or a failed rename): listed by GET /flights/logs, each sent once.
        const planned = new Set(plan.map((p) => p.name));
        for (const name of await this._listLogFiles()) {
            if (planned.has(name) || this._companionSet.has(name) || this._isActiveLog(name)) continue;
            plan.push({ kind: 'companion', name });
            planned.add(name);
        }
        if (!plan.length) {
            window.app?.showToast('No pending flights.', null, 2000);
            return;
        }

        const cfg = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('flightUpload')) || {};
        if (!cfg.host || !cfg.username) {
            window.app?.showToast('Set SFTP host and username in Configuration → Flight Upload first.', null, 4000);
            return;
        }

        const password = await this._getOrPromptPassword();
        if (password === null) return;

        const btn = this._el.querySelector('.fu-upload-all-btn');
        btn.disabled = true;
        btn.textContent = `Uploading 0 / ${plan.length} files...`;

        let flightsDone = 0, logsDone = 0, logsFailed = 0, processed = 0;
        for (const item of plan) {
            if (item.kind === 'csv') {
                const rowEl = [...this._el.querySelectorAll('.fu-upload-btn')]
                    .find((b) => b.dataset.filename === item.name)?.closest('.fu-row');
                try {
                    const result = await this._sftpUpload(item.name, cfg, password);
                    if (result.ok) {
                        this._markUploaded(item.name, rowEl);
                        flightsDone++;
                    } else {
                        if (!result.hostKeyHandled) window.app?.showToast(`Stopped: ${item.name} — ${result.error}`, null, 4000);
                        break;
                    }
                } catch (err) {
                    window.app?.showToast(`Error: ${err.message}`, null, 4000);
                    break;
                }
            } else {
                const res = await this._uploadCompanion(item.name, cfg, password);
                if (res === 'hostkey') break;     // cancelled / changed key: already shown
                if (res === 'ok') logsDone++;
                else if (res === 'failed') logsFailed++;   // 'missing' = vanished since the probe: not a failure
            }
            processed++;
            btn.textContent = `Uploading ${processed} / ${plan.length} files...`;
        }

        btn.disabled = false;
        btn.textContent = 'Upload All Pending';
        const sent = [];
        if (flightsDone > 0) sent.push(`${flightsDone} flight${flightsDone !== 1 ? 's' : ''}`);
        if (logsDone > 0) sent.push(`${logsDone} log${logsDone !== 1 ? 's' : ''}`);
        let msg = sent.length ? `Uploaded ${sent.join(' + ')}` : '';
        if (logsFailed > 0) {
            msg += `${msg ? '; ' : ''}${logsFailed} log${logsFailed !== 1 ? 's' : ''} failed (see diagnostic log)`;
        }
        if (msg) window.app?.showToast(`${msg}.`, null, logsFailed > 0 ? 4000 : 3000);
    }

    async _getOrPromptPassword() {
        try {
            const stored = await Capacitor.Plugins.Sftp.getPassword();
            if (stored.password) return stored.password;
        } catch (_) {}

        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:300000',
                'background:rgba(0,0,0,0.75)',
                'display:flex', 'align-items:center', 'justify-content:center',
                'font-family:-apple-system,system-ui,sans-serif'
            ].join(';');
            modal.innerHTML = `
                <div style="background:#1a2540;border-radius:12px;padding:24px;max-width:340px;width:90%;">
                    <div style="color:#e8ecf0;font-size:17px;font-weight:600;margin-bottom:16px;">SFTP Password</div>
                    <input type="password" id="_fu-pw" placeholder="Password" autocomplete="current-password"
                        style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
                               border:1px solid #3a4a6a;background:#0e1628;color:#e8ecf0;
                               font-size:16px;margin-bottom:12px;">
                    <label style="display:flex;align-items:center;gap:8px;color:#a0b0c8;font-size:14px;margin-bottom:20px;cursor:pointer;">
                        <input type="checkbox" id="_fu-save" checked style="width:18px;height:18px;">
                        Save password on device (encrypted)
                    </label>
                    <div style="display:flex;gap:12px;">
                        <button id="_fu-cancel" style="flex:1;padding:12px;border:none;border-radius:8px;
                                background:#2a3a5c;color:#e8ecf0;font-size:16px;cursor:pointer;touch-action:manipulation;">
                            Cancel
                        </button>
                        <button id="_fu-ok" style="flex:1;padding:12px;border:none;border-radius:8px;
                                background:#1e5caa;color:#fff;font-size:16px;font-weight:600;cursor:pointer;touch-action:manipulation;">
                            OK
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const pwEl = modal.querySelector('#_fu-pw');
            const saveEl = modal.querySelector('#_fu-save');
            setTimeout(() => pwEl.focus(), 100);

            const doOk = async () => {
                const pw = pwEl.value;
                if (!pw) { pwEl.focus(); return; }
                if (saveEl.checked) {
                    try { await Capacitor.Plugins.Sftp.savePassword({ password: pw }); } catch (_) {}
                }
                modal.remove();
                resolve(pw);
            };

            wireTap(modal.querySelector('#_fu-cancel'), () => { modal.remove(); resolve(null); });
            wireTap(modal.querySelector('#_fu-ok'), doOk);
            pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doOk(); });
        });
    }

    _markUploaded(filename, rowEl) {
        this._uploadedSet.add(filename);
        localStorage.setItem(FlightUpload.STORAGE_KEY,
            JSON.stringify([...this._uploadedSet]));
        if (!rowEl) return;
        const badge = rowEl.querySelector('.fu-badge');
        if (badge) { badge.className = 'fu-badge fu-badge--uploaded'; badge.textContent = 'UPLOADED'; }
        const btn = rowEl.querySelector('.fu-upload-btn');
        if (btn) { btn.textContent = '✓'; btn.className = 'fu-upload-btn fu-upload-btn--done'; btn.disabled = true; }
    }

    _markCompanionUploaded(name) {
        this._companionSet.add(name);
        localStorage.setItem(FlightUpload.COMPANION_KEY,
            JSON.stringify([...this._companionSet]));
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'logbook-page';
        this._el.innerHTML = `
            <div class="logbook-header">
                <span class="logbook-title">Flight Upload</span>
                <button class="btn-close fu-close-btn">✕</button>
            </div>
            <div class="fu-toolbar">
                <button class="fu-upload-all-btn">Upload All Pending</button>
                <button class="fu-change-pw-btn">Change Password</button>
            </div>
            <div class="fu-list"></div>
        `;

        wireTap(this._el.querySelector('.fu-close-btn'), () => this.hide());
        wireTap(this._el.querySelector('.fu-upload-all-btn'), () => this._uploadAllPending());
        wireTap(this._el.querySelector('.fu-change-pw-btn'), async () => {
            try { await Capacitor.Plugins.Sftp.clearPassword(); } catch (_) {}
            window.app?.showToast('Password cleared. You will be prompted on next upload.', null, 3000);
        });

        document.body.appendChild(this._el);
    }

    _setMapControlsVisible(visible) {
        document.querySelectorAll('.leaflet-control-container')
            .forEach(c => c.style.display = visible ? '' : 'none');
    }
}
