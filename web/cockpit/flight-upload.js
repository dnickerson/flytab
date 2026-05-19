/**
 * FlyTab — Flight Upload
 * Lists completed flight CSV files and uploads them via SFTP.
 * Upload status persisted in localStorage; password stored encrypted via SftpPlugin.
 */

class FlightUpload {
    static LOCAL_BASE = 'http://localhost:9090';
    static STORAGE_KEY = 'flytab_uploaded_flights';

    constructor() {
        this._el = null;
        this._visible = false;
        this._flights = [];
        this._uploadedSet = new Set(
            JSON.parse(localStorage.getItem(FlightUpload.STORAGE_KEY) || '[]')
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
            listEl.innerHTML = `<div class="ds-error">Failed to load flights: ${err.message}</div>`;
        }
    }

    _render() {
        const listEl = this._el.querySelector('.fu-list');
        if (!this._flights.length) {
            listEl.innerHTML = '<div style="padding:24px;color:var(--text-secondary);text-align:center;">No flight files found.</div>';
            return;
        }
        listEl.innerHTML = '';
        for (const flight of this._flights) {
            const name = flight.name;
            const date = this._parseDate(name, flight.modified_ms);
            const size = this._formatSize(flight.size_bytes);
            const uploaded = this._uploadedSet.has(name);

            const row = document.createElement('div');
            row.className = 'fu-row';
            row.innerHTML = `
                <div class="fu-row-info">
                    <div class="fu-filename">${name}</div>
                    <div class="fu-meta">${date}${size ? ' · ' + size : ''}</div>
                </div>
                <div class="fu-row-actions">
                    <span class="fu-badge ${uploaded ? 'fu-badge--uploaded' : 'fu-badge--pending'}">
                        ${uploaded ? 'UPLOADED' : 'PENDING'}
                    </span>
                    <button class="fu-upload-btn${uploaded ? ' fu-upload-btn--done' : ''}"
                            data-filename="${name}"${uploaded ? ' disabled' : ''}>
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
            const result = await Capacitor.Plugins.Sftp.upload({
                host: cfg.host,
                port: cfg.port || 22,
                username: cfg.username,
                filename,
                remotePath: cfg.remotePath || '~/flights',
                password,
            });

            if (result.ok) {
                this._markUploaded(filename, rowEl);
            } else {
                btn.textContent = 'Retry';
                btn.disabled = false;
                window.app?.showToast(`Upload failed: ${result.error}`, null, 4000);
            }
        } catch (err) {
            btn.textContent = 'Retry';
            btn.disabled = false;
            window.app?.showToast(`Upload error: ${err.message}`, null, 4000);
        }
    }

    async _uploadAllPending() {
        const pending = this._flights.filter(f => !this._uploadedSet.has(f.name));
        if (!pending.length) {
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
        btn.textContent = `Uploading 0 / ${pending.length}...`;

        let uploaded = 0;
        for (const flight of pending) {
            const rowEl = this._el.querySelector(`[data-filename="${flight.name}"]`)?.closest('.fu-row');
            try {
                const result = await Capacitor.Plugins.Sftp.upload({
                    host: cfg.host,
                    port: cfg.port || 22,
                    username: cfg.username,
                    filename: flight.name,
                    remotePath: cfg.remotePath || '~/flights',
                    password,
                });
                if (result.ok) {
                    this._markUploaded(flight.name, rowEl);
                    uploaded++;
                    btn.textContent = `Uploading ${uploaded} / ${pending.length}...`;
                } else {
                    window.app?.showToast(`Stopped: ${flight.name} — ${result.error}`, null, 4000);
                    break;
                }
            } catch (err) {
                window.app?.showToast(`Error: ${err.message}`, null, 4000);
                break;
            }
        }

        btn.disabled = false;
        btn.textContent = 'Upload All Pending';
        if (uploaded > 0) {
            window.app?.showToast(`Uploaded ${uploaded} flight${uploaded !== 1 ? 's' : ''}.`, null, 3000);
        }
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

            modal.querySelector('#_fu-cancel').addEventListener('click', () => {
                modal.remove();
                resolve(null);
            });

            const doOk = async () => {
                const pw = pwEl.value;
                if (!pw) { pwEl.focus(); return; }
                if (saveEl.checked) {
                    try { await Capacitor.Plugins.Sftp.savePassword({ password: pw }); } catch (_) {}
                }
                modal.remove();
                resolve(pw);
            };

            modal.querySelector('#_fu-ok').addEventListener('click', doOk);
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
