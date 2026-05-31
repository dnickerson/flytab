/**
 * FlyPi v5 — Tab Bar + More Drawer
 * Bottom iOS-style tab bar: Map | ENG | CHK | LOG | More
 * More tab opens a right-side drawer with secondary actions.
 */

class TabBar {
    constructor(components) {
        this._comps = components || {};
        this._tabBar = null;
        this._moreDrawer = null;
        this._moreBackdrop = null;
    }

    init() {
        this._buildTabBar();
        this._buildMoreDrawer();

        // Layer panel close → restore MAP tab highlight
        if (this._comps.layerPanel) {
            this._comps.layerPanel.onClose = () => this._closeLayersPanel();
        }

        if (localStorage.getItem('flypi_compact_strips') === '1') {
            // Save height before adding class (same ordering as _toggleCompactStrips)
            this._comps.routeTable?.setCompact(true);
            document.body.classList.add('compact-strips');
            const btn = this._tabBar?.querySelector('.tab-btn[data-tab="cmpct"]');
            if (btn) {
                btn.querySelector('.tab-btn-icon').textContent = '⊞';
                btn.lastChild.textContent = 'MAP';
            }
        }
    }

    _buildTabBar() {
        const tabBar = document.getElementById('tabBar');
        if (!tabBar) return;
        this._tabBar = tabBar;

        const tabs = [
            { id: 'layers', icon: '≡', label: 'LAYERS' },
            { id: 'map',   icon: '🗺', label: 'MAP'   },
            { id: 'apt',   icon: '✈',  label: 'APT'   },
            { id: 'eng',   icon: '⚙️',  label: 'ENG'   },
            { id: 'chk',   icon: '✅', label: 'CHK'   },
            { id: 'clr',   icon: '📻', label: 'CLR'   },
            { id: 'src',   icon: '🔍', label: 'SRC'   },
            { id: 'cmpct', icon: '⊟', label: 'CMPCT' },
            { id: 'more',  icon: '⋯',  label: 'MORE'  },
        ];

        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.className = 'tab-btn' + (tab.id === 'map' ? ' active' : '');
            btn.dataset.tab = tab.id;
            btn.innerHTML = `<span class="tab-btn-icon">${tab.icon}</span>${tab.label}`;
            wireTap(btn, () => this._selectTab(tab.id, btn));
            tabBar.appendChild(btn);
        }
    }

    /** Public: programmatically switch to a tab by id (e.g. 'map') */
    selectTab(tabId) {
        const btn = this._tabBar?.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        this._selectTab(tabId, btn);
    }

    _selectTab(tabId, btn) {
        // cmpct and src are stateless toggles — skip the close-everything prologue
        // so they never accidentally tear down an open fuel overlay or approach chart
        if (tabId === 'cmpct') {
            this._toggleCompactStrips();
            this._setActiveTab('map');
            return;
        }
        if (tabId === 'src') {
            this._comps.everywhereSearch?.toggle();
            this._setActiveTab('map');
            return;
        }

        // Update active state
        this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');

        const c = this._comps;

        // Close all full-screen overlays first, then open the requested one
        if (tabId !== 'more') this._closeMoreDrawer();
        if (tabId !== 'layers') this._comps.layerPanel?.close();
        if (c.enginePage?.visible) c.enginePage.hide();
        if (c.checklist?.hide) c.checklist.hide();
        if (c.logbook?.hide) c.logbook.hide();
        if (c.wxBriefing?.hide) c.wxBriefing.hide();
        if (c.ifrClearance?.hide) c.ifrClearance.hide();
        if (c.dataStatus?.hide) c.dataStatus.hide();
        if (c.configEditor?.hide) c.configEditor.hide();
        if (c.approachCharts?.closeViewer) c.approachCharts.closeViewer();
        if (c.fuelOverlay?.hide) c.fuelOverlay.hide();
        if (c.wbOverlay?.hide) c.wbOverlay.hide();
        if (c.planSync?.hide) c.planSync.hide();
        if (c.fisbStatus?.hide) c.fisbStatus.hide();
        if (c.flightUpload?.hide) c.flightUpload.hide();
        if (c.radarPage?.hide) c.radarPage.hide();
        if (c.airportPopup?.close) c.airportPopup.close();

        // Hide radar loop controls when leaving map — they bleed through
        // full-screen panels in Android WebView despite lower z-index.
        if (tabId !== 'map' && tabId !== 'more' && tabId !== 'layers') {
            this._hideRadarControls();
        } else if (tabId === 'map') {
            this._restoreRadarControls();
        }

        if (tabId === 'layers') {
            this._openLayersPanel();
        } else if (tabId === 'map') {
            // Already closed everything above — just return to map
        } else if (tabId === 'eng') {
            if (c.enginePage) c.enginePage.show();
        } else if (tabId === 'chk') {
            if (c.checklist?.show) c.checklist.show();
        } else if (tabId === 'clr') {
            if (c.ifrClearance) c.ifrClearance.show(null, null, window.app?.stratuxClient?.situation);
        } else if (tabId === 'apt') {
            if (c.airportPopup?.showRouteAirports) c.airportPopup.showRouteAirports();
        } else if (tabId === 'more') {
            this._openMoreDrawer();
        }
    }

    _buildMoreDrawer() {
        // Backdrop
        this._moreBackdrop = document.createElement('div');
        this._moreBackdrop.className = 'layer-panel-backdrop';
        document.body.appendChild(this._moreBackdrop);

        this._moreBackdrop.addEventListener('click', () => this._closeMoreDrawer());
        this._moreBackdrop.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._closeMoreDrawer();
        }, { passive: false });

        // Drawer
        this._moreDrawer = document.createElement('div');
        this._moreDrawer.className = 'more-drawer';

        const c = this._comps;
        const rows = [
            { type: 'section', label: 'In-flight' },
            { icon: '⏱', label: 'Timer', action: () => {
                this._closeMoreDrawer();
                this._toggleTimer();
            }},
            { icon: '📊', label: 'Approach Charts', action: () => {
                if (c.approachCharts) {
                    c.approachCharts._currentPlate
                        ? c.approachCharts._showPlate(c.approachCharts._plateIdx)
                        : c.approachCharts.showForRoute();
                }
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '🌧', label: 'Radar', action: () => {
                c.radarPage?.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '🧠', label: 'Engine ML', action: () => {
                this._closeMoreDrawer();
                this._hideRadarControls();
                this._showMLMonitor();
            }},
            { icon: '📡', label: 'Stratux Status', action: () => {
                const ip = c.stratuxIp || '192.168.10.1';
                window.open(`http://${ip}`, '_blank');
                this._closeMoreDrawer();
            }},

            { type: 'section', label: 'Pre / Post flight' },
            { icon: '⛽', label: 'Fuel Entry', action: () => {
                if (c.fuelOverlay?.show) c.fuelOverlay.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '✈️', label: 'Plan on flywhere.app', action: () => {
                window.open('https://flywhere.app/plan', '_blank');
                this._closeMoreDrawer();
            }},
            { icon: '⛅', label: 'Weather Briefing', action: () => {
                if (c.wxBriefing?.show) c.wxBriefing.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '⚖️', label: 'Weight & Balance', action: () => {
                if (c.wbOverlay?.show) c.wbOverlay.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '📋', label: 'Logbook', action: () => {
                if (c.logbook?.show) c.logbook.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '📤', label: 'Flight Upload', action: () => {
                if (c.flightUpload?.show) c.flightUpload.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '📖', label: 'User Manual', action: () => {
                this._closeMoreDrawer();
                this._showManual();
            }},

            { type: 'section', label: 'Admin' },
            { icon: '🗄', label: 'Data Status', admin: true, action: () => {
                if (c.dataStatus?.show) c.dataStatus.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '⚙', label: 'Configuration', admin: true, action: () => {
                if (c.configEditor?.show) c.configEditor.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '🔄', label: 'Reset NASR Data', admin: true, action: () => {
                this._closeMoreDrawer();
                window.app?.showToast('Delete and reimport all NASR data? This will reload the page.', [
                    { label: 'Reset', action: () => {
                        const req = indexedDB.deleteDatabase('flypi');
                        req.onsuccess = () => location.reload();
                        req.onerror  = () => location.reload();
                        req.onblocked = () => location.reload();
                    }},
                ]);
            }},
        ];

        this._moreDrawer.innerHTML = `
            <div class="more-drawer-header">
                <span class="more-drawer-title">More</span>
                <button class="more-drawer-close" aria-label="Close">&#x2715;</button>
            </div>
            <div class="more-drawer-body"></div>
        `;

        const closeBtn = this._moreDrawer.querySelector('.more-drawer-close');
        if (closeBtn) {
            wireTap(closeBtn, () => this._closeMoreDrawer());
        }

        const body = this._moreDrawer.querySelector('.more-drawer-body');
        for (const row of rows) {
            if (row.type === 'section') {
                const sec = document.createElement('div');
                sec.className = 'md-section-label';
                sec.textContent = row.label;
                body.appendChild(sec);
                continue;
            }
            const el = document.createElement('div');
            el.className = 'md-row' + (row.admin ? ' md-row-admin' : '');
            const labelText = typeof row.label === 'function' ? row.label() : row.label;
            el.innerHTML = `<span class="md-icon">${row.icon}</span><span class="md-label">${labelText}</span><span class="md-chevron">›</span>`;
            wireTap(el, row.action);
            body.appendChild(el);
        }

        document.body.appendChild(this._moreDrawer);
    }

    _openMoreDrawer() {
        this._moreDrawer.classList.add('open');
        this._moreBackdrop.classList.add('open');
    }

    _closeMoreDrawer() {
        this._moreDrawer.classList.remove('open');
        this._moreBackdrop.classList.remove('open');
        const activeBtn = this._tabBar?.querySelector('.tab-btn.active[data-tab="more"]');
        if (activeBtn) this._setActiveTab('map');
    }

    /** Highlight one tab by id, deactivating all others. */
    _setActiveTab(tabId) {
        this._tabBar?.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        this._tabBar?.querySelector(`.tab-btn[data-tab="${tabId}"]`)?.classList.add('active');
    }

    _openLayersPanel() {
        this._comps.layerPanel?.open();
    }

    _closeLayersPanel() {
        // Called when layer panel closes (backdrop tap or ✕) — restore MAP highlight
        const activeBtn = this._tabBar?.querySelector('.tab-btn.active[data-tab="layers"]');
        if (activeBtn) this._setActiveTab('map');
    }

    // ========== Radar Loop Visibility ==========

    _hideRadarControls() {
        const rl = this._comps.radarLoop;
        if (rl?._active) rl._hideControls();
    }

    _restoreRadarControls() {
        const rl = this._comps.radarLoop;
        if (rl?._active) rl._showControls();
    }

    // ========== ML Monitor ==========

    _showMLMonitor() {
        document.getElementById('mlMonitor')?.remove();

        const ml = window.app?.engineML;
        const result = ml?.lastResult;

        const overlay = document.createElement('div');
        overlay.id = 'mlMonitor';
        overlay.className = 'ml-monitor';

        overlay.innerHTML = `
            <div class="ml-mon-header">
                <span class="ml-mon-title">ENGINE ML MONITOR</span>
                <button class="btn-close" id="mlMonClose">✕</button>
            </div>
            <div class="ml-mon-body" id="mlMonBody"></div>`;

        document.body.appendChild(overlay);
        wireTap(overlay.querySelector('#mlMonClose'), () => overlay.remove());

        this._mlMonitorEl = overlay.querySelector('#mlMonBody');
        this._renderMLMonitor();

        // Live update every second
        this._mlMonInterval = setInterval(() => this._renderMLMonitor(), 1000);
        overlay.addEventListener('remove', () => clearInterval(this._mlMonInterval));
        // Also clear on close
        const origRemove = overlay.remove.bind(overlay);
        overlay.remove = () => { clearInterval(this._mlMonInterval); origRemove(); };
    }

    _renderMLMonitor() {
        const body = this._mlMonitorEl;
        if (!body) return;

        const ml = window.app?.engineML;
        const r = ml?.lastResult;

        if (!ml || !ml._initialized) {
            body.innerHTML = '<div class="ml-mon-section"><p>EngineML not initialized. Plugin unavailable in browser mode.</p></div>';
            return;
        }

        if (!r) {
            body.innerHTML = `<div class="ml-mon-section">
                <div class="ml-mon-row"><span>Status</span><span>Waiting for engine data...</span></div>
                <div class="ml-mon-row"><span>Delegate</span><span>${ml.delegate || '?'}</span></div>
            </div>
            <div class="ml-mon-section">
                <h3 class="ml-mon-section-title">Maintenance</h3>
                <button class="ml-mon-reset-btn" id="mlResetThresholds">Reset Adapted Thresholds</button>
            </div>`;
            wireTap(body.querySelector('#mlResetThresholds'), async () => {
                if (!confirm('Reset all adapted thresholds? The model will revert to trained defaults and re-learn from scratch. Do this after engine maintenance or a phase detection bug fix.')) return;
                await window.app?.engineML?.resetThresholds();
                const btn = body.querySelector('#mlResetThresholds');
                if (btn) { btn.textContent = 'Reset done'; btn.disabled = true; }
            });
            return;
        }

        let html = '';

        // Status section
        const phaseColor = r.anomaly ? 'var(--status-danger)' : 'var(--status-ok)';
        html += '<div class="ml-mon-section">';
        html += '<h3 class="ml-mon-section-title">Status</h3>';
        html += `<div class="ml-mon-row"><span>Phase</span><span style="color:${phaseColor};font-weight:700">${r.phase || '—'}</span></div>`;
        html += `<div class="ml-mon-row"><span>Window</span><span>${r.windowReady ? 'Full (60 samples)' : 'Filling...'}</span></div>`;
        html += `<div class="ml-mon-row"><span>Delegate</span><span>${ml.delegate || '?'}</span></div>`;

        if (r.windowReady) {
            html += `<div class="ml-mon-row"><span>Anomaly Score</span><span>${r.score?.toFixed(4) ?? '—'}</span></div>`;
            html += `<div class="ml-mon-row"><span>Threshold</span><span>${r.threshold?.toFixed(4) ?? '—'}${r.thresholdAdapted ? ' (adapted)' : ''}</span></div>`;
            html += `<div class="ml-mon-row"><span>Anomaly</span><span style="color:${r.anomaly ? 'var(--status-danger)' : 'var(--status-ok)'}; font-weight:700">${r.anomaly ? 'YES' : 'No'}</span></div>`;
            html += `<div class="ml-mon-row"><span>Latency</span><span>${r.latencyMs?.toFixed(1) ?? '?'} ms</span></div>`;
        }
        html += '</div>';

        // Feature errors (when inference is running)
        if (r.featureErrors?.length) {
            html += '<div class="ml-mon-section">';
            html += '<h3 class="ml-mon-section-title">Feature Errors</h3>';
            // Sort by error descending
            const sorted = [...r.featureErrors].sort((a, b) => (b.error || 0) - (a.error || 0));
            const maxErr = sorted[0]?.error || 1;
            for (const fe of sorted) {
                const pct = Math.min(100, (fe.error / maxErr) * 100);
                const color = fe.error > r.threshold * 0.5 ? 'var(--status-danger)' :
                    fe.error > r.threshold * 0.1 ? 'var(--status-caution)' : 'var(--status-ok)';
                html += `<div class="ml-mon-row">
                    <span>${fe.name}</span>
                    <span style="display:flex;align-items:center;gap:6px">
                        <span class="ml-mon-bar" style="width:${pct}%;background:${color}"></span>
                        <span>${fe.error?.toFixed(4) ?? '—'}</span>
                    </span>
                </div>`;
            }
            html += '</div>';
        }

        // Advisories
        if (r.advisories?.length) {
            html += '<div class="ml-mon-section">';
            html += '<h3 class="ml-mon-section-title">Advisories</h3>';
            for (const adv of r.advisories) {
                const sevClass = adv.severity === 2 ? 'ml-adv-warn' : adv.severity === 1 ? 'ml-adv-caut' : 'ml-adv-info';
                html += `<div class="ml-mon-advisory ${sevClass}">
                    <span class="ml-adv-cat">${adv.category || ''}</span>
                    ${adv.message}
                </div>`;
            }
            html += '</div>';
        }

        // Maintenance section
        html += '<div class="ml-mon-section">';
        html += '<h3 class="ml-mon-section-title">Maintenance</h3>';
        html += '<div class="ml-mon-row"><span>Adapted thresholds</span><span>' + (r.thresholdAdapted ? 'Active' : 'Learning / not yet adapted') + '</span></div>';
        html += '<button class="ml-mon-reset-btn" id="mlResetThresholds">Reset Adapted Thresholds</button>';
        html += '</div>';

        body.innerHTML = html;

        wireTap(body.querySelector('#mlResetThresholds'), async () => {
            if (!confirm('Reset all adapted thresholds? The model will revert to trained defaults and re-learn from scratch. Do this after engine maintenance or a phase detection bug fix.')) return;
            await window.app?.engineML?.resetThresholds();
            const btn = body.querySelector('#mlResetThresholds');
            if (btn) { btn.textContent = 'Reset done'; btn.disabled = true; }
        });
    }

    // ========== Floating Timer ==========

    _toggleTimer() {
        if (this._timerEl) {
            // Toggle visibility
            this._timerEl.classList.toggle('hidden');
            return;
        }
        this._buildTimer();
    }

    _toggleCompactStrips() {
        const isNowCompact = !document.body.classList.contains('compact-strips');
        // Save height BEFORE adding the class — display:none makes offsetHeight 0
        if (isNowCompact) this._comps.routeTable?.setCompact(true);
        document.body.classList.toggle('compact-strips', isNowCompact);

        const btn = this._tabBar?.querySelector('.tab-btn[data-tab="cmpct"]');
        if (btn) {
            btn.querySelector('.tab-btn-icon').textContent = isNowCompact ? '⊞' : '⊟';
            btn.lastChild.textContent = isNowCompact ? 'MAP' : 'CMPCT';
        }

        // Restore height AFTER removing the class (sheet is visible again)
        if (!isNowCompact) this._comps.routeTable?.setCompact(false);

        localStorage.setItem('flypi_compact_strips', isNowCompact ? '1' : '0');
    }

    _buildTimer() {
        this._timerRunning = false;
        this._timerStartMs = 0;
        this._timerElapsed = 0;
        this._timerInterval = null;

        const el = document.createElement('div');
        el.className = 'floating-timer';
        el.innerHTML = `
            <div class="ft-drag-handle"></div>
            <div class="ft-display">0:00</div>
            <div class="ft-btns">
                <button class="ft-btn ft-start">START</button>
                <button class="ft-btn ft-reset">RESET</button>
                <button class="ft-btn ft-close">\u2715</button>
            </div>
        `;

        this._timerEl = el;
        this._timerDisplayEl = el.querySelector('.ft-display');
        const startBtn = el.querySelector('.ft-start');
        const resetBtn = el.querySelector('.ft-reset');
        const closeBtn = el.querySelector('.ft-close');

        wireTap(startBtn, () => {
            if (this._timerRunning) {
                this._timerElapsed += Date.now() - this._timerStartMs;
                this._timerRunning = false;
                clearInterval(this._timerInterval);
                startBtn.textContent = 'START';
                startBtn.classList.remove('ft-running');
            } else {
                this._timerStartMs = Date.now();
                this._timerRunning = true;
                startBtn.textContent = 'STOP';
                startBtn.classList.add('ft-running');
                this._timerInterval = setInterval(() => this._renderTimer(), 100);
            }
        });

        wireTap(resetBtn, () => {
            this._timerRunning = false;
            this._timerElapsed = 0;
            this._timerStartMs = 0;
            clearInterval(this._timerInterval);
            this._timerDisplayEl.textContent = '0:00';
            startBtn.textContent = 'START';
            startBtn.classList.remove('ft-running');
        });

        wireTap(closeBtn, () => {
            el.classList.add('hidden');
        });

        // Draggable
        this._makeDraggable(el, el.querySelector('.ft-drag-handle'));

        document.body.appendChild(el);
    }

    _renderTimer() {
        const total = this._timerElapsed + (this._timerRunning ? Date.now() - this._timerStartMs : 0);
        const sec = Math.floor(total / 1000);
        const min = Math.floor(sec / 60);
        const s = sec % 60;
        this._timerDisplayEl.textContent = `${min}:${String(s).padStart(2, '0')}`;
    }

    _makeDraggable(el, handle) {
        let startX, startY, origX, origY;
        const onStart = (x, y) => {
            startX = x; startY = y;
            const r = el.getBoundingClientRect();
            origX = r.left; origY = r.top;
            el.style.transition = 'none';
        };
        const onMove = (x, y) => {
            el.style.left = (origX + x - startX) + 'px';
            el.style.top = (origY + y - startY) + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        };

        handle.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const t = e.touches[0];
            onStart(t.clientX, t.clientY);
            const move = (ev) => onMove(ev.touches[0].clientX, ev.touches[0].clientY);
            const end = () => { document.removeEventListener('touchmove', move); };
            document.addEventListener('touchmove', move, { passive: false });
            document.addEventListener('touchend', end, { once: true });
        }, { passive: false });

        handle.addEventListener('mousedown', (e) => {
            onStart(e.clientX, e.clientY);
            const move = (ev) => onMove(ev.clientX, ev.clientY);
            const up = () => { document.removeEventListener('mousemove', move); };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up, { once: true });
        });
    }

    /** Show the user manual in a scrollable full-screen overlay. */
    async _showManual() {
        document.getElementById('flytabManualOverlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'flytabManualOverlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0;
            bottom: var(--tab-bar-height, 72px);
            z-index: 100000;
            background: #fff; color: #111;
            display: flex; flex-direction: column;
            font-family: -apple-system, 'SF Pro Text', system-ui, sans-serif;
            font-size: 15px; line-height: 1.65;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex; align-items: center; gap: 12px;
            padding: 12px 16px; background: #1a3a6b; color: #fff;
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-size:18px;font-weight:700;flex:1">FlyTab User Manual</span>
            <button id="_manualClose" style="background:#0055cc;color:#fff;border:none;border-radius:6px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer;touch-action:manipulation;">✕ Close</button>
        `;
        overlay.appendChild(header);

        const body = document.createElement('div');
        body.style.cssText = `flex:1; overflow-y:scroll; -webkit-overflow-scrolling:touch; touch-action:pan-y; overscroll-behavior:contain; padding:16px 20px 40px;`;
        body.innerHTML = '<p style="color:#888">Loading…</p>';
        overlay.appendChild(body);

        document.body.appendChild(overlay);
        overlay.querySelector('#_manualClose').addEventListener('click', () => overlay.remove());

        // Fetch and render
        try {
            const resp = await fetch('/user-manual.md', { cache: 'no-store' });
            if (!resp.ok) throw new Error(resp.status);
            const md = await resp.text();
            body.innerHTML = TabBar._mdToHtml(md);
        } catch {
            body.innerHTML = '<p style="color:#c00">Could not load user-manual.md</p>';
        }
    }

    /** Minimal markdown → HTML renderer for the user manual. */
    static _mdToHtml(md) {
        const lines = md.split('\n');
        let html = '';
        let inList = false;
        let inCode = false;
        let codeBuf = '';
        let i = 0;

        const endList = () => { if (inList) { html += '</ul>'; inList = false; } };

        while (i < lines.length) {
            const line = lines[i];

            // Fenced code block
            if (line.startsWith('```')) {
                endList();
                inCode = !inCode;
                if (!inCode) {
                    html += `<pre style="background:#f4f4f4;border-radius:6px;padding:10px 12px;overflow-x:auto;font-size:12px;line-height:1.5;margin:10px 0;white-space:pre-wrap">${codeBuf.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`;
                    codeBuf = '';
                }
                i++; continue;
            }
            if (inCode) { codeBuf += line + '\n'; i++; continue; }

            // Table: consume all consecutive | lines at once
            if (line.startsWith('|')) {
                endList();
                const tableLines = [];
                while (i < lines.length && lines[i].startsWith('|')) {
                    tableLines.push(lines[i]);
                    i++;
                }
                // row 0 = header, row 1 = separator (skip), rows 2+ = body
                const parseCells = r => r.split('|').slice(1, -1).map(c => c.trim());
                html += `<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px;display:block;overflow-x:auto">`;
                html += `<thead style="background:#1a3a6b;color:#fff"><tr>`;
                for (const c of parseCells(tableLines[0])) {
                    html += `<th style="padding:6px 10px;text-align:left;border:1px solid #355;white-space:nowrap">${TabBar._inlineMd(c)}</th>`;
                }
                html += `</tr></thead><tbody>`;
                for (let r = 2; r < tableLines.length; r++) {
                    if (/^\|[-| :]+\|$/.test(tableLines[r])) continue;
                    html += `<tr style="${r % 2 === 0 ? 'background:#f8f8ff' : ''}">`;
                    for (const c of parseCells(tableLines[r])) {
                        html += `<td style="padding:6px 10px;border:1px solid #ddd;vertical-align:top">${TabBar._inlineMd(c)}</td>`;
                    }
                    html += `</tr>`;
                }
                html += `</tbody></table>`;
                continue;
            }

            // Horizontal rule
            if (/^---+$/.test(line.trim())) { endList(); html += `<hr style="border:none;border-top:2px solid #ddd;margin:20px 0">`; i++; continue; }

            // Headings
            const h1 = line.match(/^# (.+)/);
            const h2 = line.match(/^## (.+)/);
            const h3 = line.match(/^### (.+)/);
            if (h1) { endList(); html += `<h1 style="font-size:20px;font-weight:800;margin:24px 0 8px;color:#1a3a6b;border-bottom:2px solid #1a3a6b;padding-bottom:4px">${TabBar._inlineMd(h1[1])}</h1>`; i++; continue; }
            if (h2) { endList(); html += `<h2 style="font-size:17px;font-weight:700;margin:22px 0 8px;color:#1a3a6b;border-bottom:1px solid #cce">${TabBar._inlineMd(h2[1])}</h2>`; i++; continue; }
            if (h3) { endList(); html += `<h3 style="font-size:15px;font-weight:700;margin:16px 0 6px;color:#2a4a8b">${TabBar._inlineMd(h3[1])}</h3>`; i++; continue; }

            // List item
            if (/^[-*] /.test(line)) {
                if (!inList) { html += `<ul style="margin:6px 0 6px 20px;padding:0">`; inList = true; }
                html += `<li style="margin:3px 0">${TabBar._inlineMd(line.slice(2))}</li>`;
                i++; continue;
            }

            // Blank line
            if (!line.trim()) { endList(); i++; continue; }

            // Paragraph
            endList();
            html += `<p style="margin:6px 0">${TabBar._inlineMd(line)}</p>`;
            i++;
        }
        endList();
        return html;
    }

    static _inlineMd(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;border-radius:3px;padding:1px 4px;font-size:12px;font-family:monospace">$1</code>')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    }

}
