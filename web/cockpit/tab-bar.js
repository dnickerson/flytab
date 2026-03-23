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
    }

    _buildTabBar() {
        const tabBar = document.getElementById('tabBar');
        if (!tabBar) return;
        this._tabBar = tabBar;

        const tabs = [
            { id: 'map',  icon: '🗺', label: 'MAP'  },
            { id: 'apt',  icon: '✈',  label: 'APT'  },
            { id: 'eng',  icon: '⚙️',  label: 'ENG'  },
            { id: 'chk',  icon: '✅', label: 'CHK'  },
            { id: 'clr',  icon: '📻', label: 'CLR'  },
            { id: 'tmr',  icon: '⏱', label: 'TMR'  },
            { id: 'more', icon: '⋯',  label: 'MORE' },
        ];

        for (const tab of tabs) {
            const btn = document.createElement('button');
            btn.className = 'tab-btn' + (tab.id === 'map' ? ' active' : '');
            btn.dataset.tab = tab.id;
            btn.innerHTML = `<span class="tab-btn-icon">${tab.icon}</span>${tab.label}`;
            this._fastTap(btn, () => this._selectTab(tab.id, btn));
            tabBar.appendChild(btn);
        }
    }

    _selectTab(tabId, btn) {
        // Update active state
        this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        if (btn) btn.classList.add('active');

        const c = this._comps;

        // Always close all full-screen overlays first, then open the requested one
        if (tabId !== 'more') this._closeMoreDrawer();
        if (c.enginePage?.visible) c.enginePage.hide();
        if (c.checklist?.hide) c.checklist.hide();
        if (c.logbook?.hide) c.logbook.hide();
        if (c.wxBriefing?.hide) c.wxBriefing.hide();
        if (c.ifrClearance?.hide) c.ifrClearance.hide();
        if (c.dataStatus?.hide) c.dataStatus.hide();
        if (c.configEditor?.hide) c.configEditor.hide();
        if (c.approachCharts?.closeViewer) c.approachCharts.closeViewer();
        if (c.fuelOverlay?.hide) c.fuelOverlay.hide();
        if (c.planSync?.hide) c.planSync.hide();
        if (c.airportPopup?.close) c.airportPopup.close();

        if (tabId === 'tmr') {
            // Timer is a floating popup — toggle without closing other views
            this._toggleTimer();
            // Restore previous tab highlight
            this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            const prev = this._tabBar.querySelector('.tab-btn[data-tab="map"]');
            if (prev) prev.classList.add('active');
            return;
        }

        if (tabId === 'map') {
            // Already closed everything above — just return to map
        } else if (tabId === 'eng') {
            if (c.enginePage) c.enginePage.show();
        } else if (tabId === 'chk') {
            if (c.checklist?.show) c.checklist.show();
        } else if (tabId === 'clr') {
            if (c.ifrClearance) c.ifrClearance.show();
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
            { icon: '✈', label: 'Load Flight Plan', action: () => {
                if (c.planSync?.show) c.planSync.show();
                this._closeMoreDrawer();
            }},
            { icon: '🧠', label: 'Engine ML', action: () => {
                this._closeMoreDrawer();
                this._showMLMonitor();
            }},
            { icon: '📋', label: 'Logbook', action: () => {
                if (c.logbook?.show) c.logbook.show();
                this._closeMoreDrawer();
            }},
            { icon: '⛅', label: 'Weather Briefing', action: () => {
                if (c.wxBriefing?.show) c.wxBriefing.show();
                this._closeMoreDrawer();
            }},
            { icon: '📊', label: 'Approach Charts', action: () => {
                if (c.approachCharts) {
                    c.approachCharts._currentPlate
                        ? c.approachCharts._showPlate(c.approachCharts._plateIdx)
                        : c.approachCharts.showForRoute();
                }
                this._closeMoreDrawer();
            }},
            { icon: '⛽', label: 'Fuel Entry', action: () => {
                if (c.fuelOverlay?.show) c.fuelOverlay.show();
                this._closeMoreDrawer();
            }},
            { icon: '📡', label: 'Stratux Status', action: () => {
                const ip = c.stratuxIp || '192.168.10.1';
                window.open(`http://${ip}`, '_blank');
            }},
            { icon: '🗄', label: 'Data Status', action: () => {
                if (c.dataStatus?.show) c.dataStatus.show();
                this._closeMoreDrawer();
            }},
            { icon: '⚙', label: 'Configuration', action: () => {
                if (c.configEditor?.show) c.configEditor.show();
                this._closeMoreDrawer();
            }},
            { icon: '🗺', label: 'Export Track GPX', action: () => {
                this._closeMoreDrawer();
                if (c.trackLog?.points?.length) {
                    c.trackLog.exportGpx();
                } else {
                    window.app?.showToast('No track points recorded yet.');
                }
            }},
            { icon: '📥', label: 'Save Flight CSV', action: () => {
                this._closeMoreDrawer();
                window.app?.showToast('Flight CSV export coming in Phase 3.');
            }},
            { icon: '🔄', label: 'Reset NASR Data', action: () => {
                this._closeMoreDrawer();
                window.app?.showToast('Delete and reimport all NASR data? This will reload the page.', [
                    { label: 'Reset', action: () => {
                        const req = indexedDB.deleteDatabase('flypi');
                        req.onsuccess = () => location.reload();
                        req.onerror = () => location.reload();
                        req.onblocked = () => location.reload();
                    }},
                ]);
            }},
            { icon: '❓', label: 'Help', action: () => {
                window.open('./help.html', '_blank');
                this._closeMoreDrawer();
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
            this._fastTap(closeBtn, () => this._closeMoreDrawer());
        }

        const body = this._moreDrawer.querySelector('.more-drawer-body');
        for (const row of rows) {
            const el = document.createElement('div');
            el.className = 'md-row';
            el.innerHTML = `<span class="md-icon">${row.icon}</span><span class="md-label">${row.label}</span><span class="md-chevron">›</span>`;
            this._fastTap(el, row.action);
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
        // If more tab is still highlighted, switch back to map visually
        const activeBtn = this._tabBar?.querySelector('.tab-btn.active[data-tab="more"]');
        if (activeBtn) {
            this._tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            this._tabBar.querySelector('[data-tab="map"]')?.classList.add('active');
        }
    }

    // ========== ML Monitor ==========

    _showMLMonitor() {
        document.getElementById('mlMonitor')?.remove();

        const ml = window.app?.engineML;
        const result = ml?.lastResult;

        const overlay = document.createElement('div');
        overlay.id = 'mlMonitor';
        overlay.className = 'ml-monitor';

        const closeBtn = '<button class="ep-close" id="mlMonClose">MAP</button>';
        overlay.innerHTML = `${closeBtn}<h2 class="ml-mon-title">Engine ML Monitor</h2><div class="ml-mon-body" id="mlMonBody"></div>`;

        document.body.appendChild(overlay);
        this._fastTap(overlay.querySelector('#mlMonClose'), () => overlay.remove());

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
            this._fastTap(body.querySelector('#mlResetThresholds'), async () => {
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

        this._fastTap(body.querySelector('#mlResetThresholds'), async () => {
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

        this._fastTap(startBtn, () => {
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

        this._fastTap(resetBtn, () => {
            this._timerRunning = false;
            this._timerElapsed = 0;
            this._timerStartMs = 0;
            clearInterval(this._timerInterval);
            this._timerDisplayEl.textContent = '0:00';
            startBtn.textContent = 'START';
            startBtn.classList.remove('ft-running');
        });

        this._fastTap(closeBtn, () => {
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

    /** Reliable tap handler for both touch and mouse */
    _fastTap(btn, handler) {
        let touchFired = false;
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            touchFired = true;
            handler(e);
        }, { passive: false });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (touchFired) { touchFired = false; return; }
            handler(e);
        });
    }
}
