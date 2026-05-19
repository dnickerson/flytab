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
        if (c.fisbStatus?.hide) c.fisbStatus.hide();
        if (c.flightUpload?.hide) c.flightUpload.hide();
        if (c.airportPopup?.close) c.airportPopup.close();

        // Hide radar loop controls when leaving map — they bleed through
        // full-screen panels in Android WebView despite lower z-index.
        if (tabId !== 'map' && tabId !== 'tmr' && tabId !== 'more') {
            this._hideRadarControls();
        } else if (tabId === 'map') {
            this._restoreRadarControls();
        }

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
            { icon: '✈️', label: 'Plan on flywhere.app', action: () => {
                window.open('https://flywhere.app/plan', '_blank');
                this._closeMoreDrawer();
            }},
            { icon: '🗺', label: 'New Route', action: () => {
                this._closeMoreDrawer();
                this._showNewRouteConfirm();
            }},
            { icon: '💾', label: 'Save Plan', action: () => {
                this._closeMoreDrawer();
                (c.app || window.app)?.saveCurrentPlan?.();
            }},
            { icon: '✈', label: 'Load Plan', action: () => {
                if (c.planSync?.show) c.planSync.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '🧠', label: 'Engine ML', action: () => {
                this._closeMoreDrawer();
                this._hideRadarControls();
                this._showMLMonitor();
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
            { icon: '⛅', label: 'Weather Briefing', action: () => {
                if (c.wxBriefing?.show) c.wxBriefing.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
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
            { icon: '⛽', label: 'Fuel Entry', action: () => {
                if (c.fuelOverlay?.show) c.fuelOverlay.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '📡', label: 'Stratux Status', action: () => {
                const ip = c.stratuxIp || '192.168.10.1';
                window.open(`http://${ip}`, '_blank');
            }},
            { icon: '📶', label: 'FIS-B Status', action: () => {
                if (c.fisbStatus?.show) c.fisbStatus.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '🗄', label: 'Data Status', action: () => {
                if (c.dataStatus?.show) c.dataStatus.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '⚙', label: 'Configuration', action: () => {
                if (c.configEditor?.show) c.configEditor.show();
                this._hideRadarControls();
                this._closeMoreDrawer();
            }},
            { icon: '🗺', label: () => {
                    const n = c.trackLog?.points?.length || 0;
                    return n ? `Export Track GPX (${n} pts)` : 'Export Track GPX';
                }, action: () => {
                this._closeMoreDrawer();
                if (c.trackLog?.points?.length) {
                    c.trackLog.exportGpx();
                } else {
                    window.app?.showToast('No track points recorded yet.', null, 3000);
                }
            }},
            { icon: '📍', label: () => {
                    const n = c.trackLog?.points?.length || 0;
                    return n ? `Export Track CSV (${n} pts)` : 'Export Track CSV';
                }, action: () => {
                this._closeMoreDrawer();
                if (c.trackLog?.points?.length) {
                    c.trackLog.exportCsv();
                } else {
                    window.app?.showToast('No track points recorded yet.', null, 3000);
                }
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
                this._closeMoreDrawer();
                this._hideRadarControls();
                this._showHelp();
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
            const el = document.createElement('div');
            el.className = 'md-row';
            const labelText = typeof row.label === 'function' ? row.label() : row.label;
            el.innerHTML = `<span class="md-icon">${row.icon}</span><span class="md-label">${labelText}</span><span class="md-chevron">›</span>`;
            // Use scroll-safe tap: don't preventDefault on touchstart so scroll still works
            wireTap(el, row.action);
            body.appendChild(el);
        }

        document.body.appendChild(this._moreDrawer);
    }

    _showNewRouteConfirm() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 200000;
            background: rgba(0,0,0,0.7);
            display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
        `;
        overlay.innerHTML = `
            <div style="background: var(--bg-surface, #1a2540); border-radius: 12px; padding: 24px; max-width: 320px; width: 90%; text-align: center;">
                <div style="color: var(--text-primary, #e8ecf0); font-size: 17px; font-weight: 600; margin-bottom: 12px;">Clear current route and start new?</div>
                <div style="display: flex; gap: 12px; margin-top: 20px; justify-content: center;">
                    <button id="_newRouteCancel" style="flex:1; padding: 12px; border: none; border-radius: 8px; background: var(--bg-surface-raised, #2a3a5c); color: var(--text-primary, #e8ecf0); font-size: 16px; cursor: pointer; touch-action: manipulation;">CANCEL</button>
                    <button id="_newRouteConfirm" style="flex:1; padding: 12px; border: none; border-radius: 8px; background: var(--status-ok, #1e8c3a); color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; touch-action: manipulation;">CONFIRM</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const openedAt = Date.now();
        overlay.querySelector('#_newRouteCancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#_newRouteConfirm').addEventListener('click', () => {
            overlay.remove();
            if (typeof app !== 'undefined') app.openRoutePlanner(null);
        });
        overlay.addEventListener('click', (e) => {
            if (Date.now() - openedAt < 500) return;
            if (e.target === overlay) overlay.remove();
        });
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

    /** Show help overlay in-app (no external browser) */
    _showHelp() {
        document.getElementById('flytabHelpOverlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'flytabHelpOverlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0;
            bottom: var(--tab-bar-height, 72px);
            z-index: 100000;
            background: #0a1628; color: #e8ecf0;
            display: flex; flex-direction: column;
            font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
            font-size: 14px; line-height: 1.6;
        `;
        // note: content set below

        const ver = typeof FLYTAB_VERSION !== 'undefined' ? FLYTAB_VERSION : '4.42';
        const closeBtn = `<button onclick="document.getElementById('flytabHelpOverlay').remove()" style="background:#0055cc;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:14px;font-weight:600;cursor:pointer;touch-action:manipulation;">✕ Back to Map</button>`;

        const sections = [
            ['#tabs','Tabs'],['#status','Status Bar'],['#map','Map'],
            ['#instruments','Instruments'],['#power','Power Tradeoff'],
            ['#route','Route Table'],['#profile','Terrain Profile'],
            ['#engine','Engine'],['#engineml','Engine ML'],
            ['#emergency','Emergency Glide'],
            ['#checklist','Checklists'],['#logbook','Logbook'],
            ['#charts','Approach Charts'],['#weather','Weather'],
            ['#recording','Recording'],['#fuel','Fuel'],
            ['#offline','Offline'],['#config','Config'],
            ['#releases','Releases'],
        ];

        // Pull aircraft config for dynamic values
        const acTail = (typeof CockpitConfig !== 'undefined' ? CockpitConfig.aircraft('tail') : null) || 'your aircraft';
        const acType = (typeof CockpitConfig !== 'undefined' ? CockpitConfig.aircraft('type') : null) || 'RV-9A';
        const acFuelCap = (typeof CockpitConfig !== 'undefined' ? CockpitConfig.aircraft('performance.fuel_capacity_gal') : null) || 36;
        const acDmmsKt = (typeof CockpitConfig !== 'undefined' ? Math.round(CockpitConfig.dmmsKt) : null) || 80;

        overlay.innerHTML = `<div style="flex:1;overflow-y:scroll;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;padding:12px 16px 40px;">

<div style="position:sticky;top:0;background:#0a1628;border-bottom:1px solid #1a3055;padding:10px 0;display:flex;align-items:center;gap:12px;z-index:1">
  ${closeBtn}
  <span style="font-size:18px;font-weight:700;flex:1">FlyTab Help</span>
  <span style="font-size:12px;color:#8899aa;background:#0f1f3a;padding:2px 8px;border-radius:10px">${ver}</span>
</div>

<div style="background:#0f1f3a;border-radius:8px;padding:12px;margin:14px 0">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8899aa;margin-bottom:8px">Contents</div>
  <div style="display:flex;flex-wrap:wrap;gap:6px">
    ${sections.map(([id,label])=>`<a href="${id}" style="color:#0088ff;text-decoration:none;font-size:13px;padding:3px 10px;border-radius:4px;background:#152847">${label}</a>`).join('')}
  </div>
</div>

<!-- ═══ TABS ═══ -->
<h2 id="tabs" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Bottom Tab Bar</h2>
<p>Always visible at the bottom. Tap any tab to switch views. Tapping the active tab returns to the map.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Tab</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Function</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">🗺 MAP</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Moving map — ownship, route, traffic, airspace, NEXRAD</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✈ APT</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Airport info — frequencies, runways, METAR/TAF for any airport</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">⚙️ ENG</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Full-screen engine instruments — RPM, EGT/CHT, oil, fuel, trend charts</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ CHK</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Interactive checklists — Normal, Abnormal, Emergency</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">📻 CLR</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">IFR clearance helper — CRAFT format, CD phone number, squawk</td></tr>
  <tr><td style="padding:6px 8px">⋯ MORE</td><td style="padding:6px 8px">Logbook, weather briefing, approach charts, fuel, data status, config</td></tr>
</table>

<!-- ═══ STATUS BAR ═══ -->
<h2 id="status" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Status Bar Badges</h2>
<p>Color-coded badges across the top. Green = good, amber = caution, red = problem.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Badge</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Meaning</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GPS</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Green = position fix active (shows source: STX=Stratux, INT=device GPS). Red = no fix.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">FIS-B</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Green = receiving weather data from ground towers. Red = no towers in range (aircraft UAT traffic alone does not trigger green).</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">● REC</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Red dot = flight recording active. Auto-starts at RPM &gt;500, auto-stops 60s after RPM &lt;100.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">NET / OFFL</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Pi connectivity status. OFFL = no Pi connection (offline mode).</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">NASR</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Aviation database currency. Shows cycle date when current.</td></tr>
  <tr><td style="padding:6px 8px">v4.xx</td><td style="padding:6px 8px">Version badge — long-press to view the diagnostic log.</td></tr>
</table>

<!-- ═══ MAP ═══ -->
<h2 id="map" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Moving Map</h2>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>Ownship (red airplane)</strong> — your GPS position, rotated to track. Dims when no fix, hides when Stratux disconnects.</li>
  <li style="margin:4px 0"><strong>Traffic</strong> — ADS-B targets from Stratux. Color = proximity. Altitude offset shown next to each chevron. Tap for callsign and altitude.</li>
  <li style="margin:4px 0"><strong>Route line</strong> — magenta. Active leg solid, future dashed, past dimmed.</li>
  <li style="margin:4px 0"><strong>Airspace</strong> — Class B (blue), C (magenta), D (blue dashed). Altitude labels shown.</li>
  <li style="margin:4px 0"><strong>Track log</strong> — breadcrumb trail of your flight path.</li>
  <li style="margin:4px 0"><strong>PIREPs</strong> — FIS-B pilot reports as diamond icons (🔶 orange = turbulence, 🔷 blue = icing). Enable in layer panel → Weather → PIREPs (FIS-B).</li>
  <li style="margin:4px 0"><strong>TFRs</strong> — FIS-B NOTAM TFRs shown as red dashed polygons/circles. Enable in layer panel → Aviation → TFRs (FIS-B). Tap for full NOTAM text and expiry.</li>
</ul>
<p><strong>Map orientation:</strong> North-up by default. Heading-up mode available via the compass button.</p>
<p><strong>Left rail layer buttons:</strong> Base map cycle (Vector/Sectional/IFR Low), NEXRAD, airports, navaids, fixes, airways, SUA/Restricted, TFRs.</p>
<p><strong>Map corner buttons (top-right):</strong></p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>📍 Auto-pan</strong> — keeps ownship centered. Tap to toggle.</li>
  <li style="margin:4px 0"><strong>D→ Direct-To</strong> — fly direct to any airport, navaid, or fix.</li>
  <li style="margin:4px 0"><strong>⋮ Menu</strong> — access route editor, terrain profile, range rings.</li>
</ul>
<p>Tap any airport on the map to see its frequencies, runways, METAR, and a Direct-To button.</p>

<!-- ═══ INSTRUMENTS ═══ -->
<h2 id="instruments" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Instrument Strip</h2>
<p>Live flight data bar between the map and the tab bar. Updates every GPS tick (~1 Hz). When a flight plan is loaded, switches to destination-aware mode.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Field</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Description</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GS</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GPS ground speed (knots)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">ALT</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GPS/barometric altitude (feet MSL)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">HDG</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Wind-corrected magnetic heading — set this on your heading bug</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">FUEL</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Fuel remaining (gal). Small delta below shows actual vs planned burn rate (±GPH). Tap to enter fuel.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">DEST</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Nautical miles to destination. Tap to open Power Tradeoff panel.</td></tr>
  <tr><td style="padding:6px 8px">ETE</td><td style="padding:6px 8px">Estimated time en route to destination (recalculated from live GS). Delta below shows ahead/behind plan. Tap to open Power Tradeoff panel.</td></tr>
</table>
<p>Delta sub-labels: <span style="color:#44ff44">green</span> = on/ahead of plan, <span style="color:#ffaa00">amber</span> = slightly behind, <span style="color:#ff4444">red</span> = significantly behind.</p>

<!-- ═══ POWER TRADEOFF ═══ -->
<h2 id="power" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Power Tradeoff Panel</h2>
<p>Tap the <strong>ETE</strong> or <strong>DEST</strong> field on the instrument strip to open a live comparison of fuel and time at different power settings.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Column</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Meaning</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">PWR</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Power setting (%). ▶ marks your current setting.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GS</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Projected ground speed at that power (wind-corrected)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GPH</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Fuel flow. Current row uses live EDM value; others use data-derived table.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">ETE</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Time to destination at that power setting</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">FUEL@DEST</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Estimated fuel remaining on arrival. Red &lt;4 gal, amber &lt;8 gal.</td></tr>
  <tr><td style="padding:6px 8px">△TIME</td><td style="padding:6px 8px">Time cost/savings vs current setting</td></tr>
</table>
<p>Power table is derived from <strong>2,004 actual cruise data points</strong> from ${acTail} flight logs — not generic Lycoming charts.</p>

<!-- ═══ ROUTE TABLE ═══ -->
<h2 id="route" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Route Table</h2>
<p>Drag the handle above the instrument strip upward to expand the route table. Shows all waypoints with live nav data.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Column</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Meaning</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">WPT</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Waypoint ICAO identifier</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">PHASE</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Flight phase: CLB / CRZ / DES</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">ALT</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Planned altitude for this leg. Tap to set.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">HDG</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Wind-corrected magnetic heading — what you set on the heading bug</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">BRG</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">True geometric bearing (no wind correction — situational awareness)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">DIST</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Cumulative remaining distance to this waypoint</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">TIME</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Cumulative ETE to this waypoint</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">FUEL / REM</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Fuel burned on leg / remaining at waypoint</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">TAS / GS</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">True airspeed / ground speed for leg</td></tr>
  <tr><td style="padding:6px 8px">WIND</td><td style="padding:6px 8px">Forecast wind at this waypoint (dir/spd)</td></tr>
</table>
<p>The active leg is highlighted. Tap any waypoint row to see its details. Drag the handle down to collapse.</p>

<!-- ═══ TERRAIN PROFILE ═══ -->
<h2 id="profile" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Terrain Profile (⛰ Profile)</h2>
<p>Accessible via the ⋮ map menu. Shows a cross-section of terrain and your planned flight path along the route.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>Brown fill</strong> — terrain elevation from SRTM 30m data</li>
  <li style="margin:4px 0"><strong>Red fill</strong> — terrain within 1,000 ft of your flight path</li>
  <li style="margin:4px 0"><strong>Blue line</strong> — planned flight path (amber = climb, cyan = cruise, steel = descent)</li>
  <li style="margin:4px 0"><strong>Dashed gray</strong> — planned cruise altitude</li>
  <li style="margin:4px 0"><strong>Indigo dashed</strong> — freezing level (FZL) when available</li>
  <li style="margin:4px 0"><strong>Gray bands</strong> — cloud layers when available</li>
</ul>
<p>Pinch to zoom in on a section. Tap the ⊕ button to expand to full height. Tap Reset to restore full route view.</p>

<!-- ═══ ENGINE ═══ -->
<h2 id="engine" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Engine Page (⚙️ ENG)</h2>
<p>Full-screen engine instruments from a <strong>Dynon D-180</strong> engine monitor connected to the Raspberry Pi via a USB-to-RS-232 serial adapter (INSIGNIA 23k02h). The Pi relays data over HTTP and WebSocket to the tablet. Tap ✕ to close and return to the map.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Gauge</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Limits (O-360-A1A)</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">RPM</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Max 2700 RPM</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">MAP (inHg)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Max 28" (full throttle)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">% Power</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Typical cruise 55–75%</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Fuel Flow (GPH)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">~6.5–9.0 GPH at cruise</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Oil Temp (°F)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Amber &gt;220°F, Red &gt;245°F</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Oil Pressure (PSI)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Red &lt;25 or &gt;95 PSI</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Volts</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Amber &lt;13.0V (charging issue)</td></tr>
  <tr><td style="padding:6px 8px">Carb Temp (°F)</td><td style="padding:6px 8px">Amber &lt;40°F (ice risk), Red &lt;32°F (ice forming)</td></tr>
</table>
<p><strong>EGT/CHT bars</strong> — per-cylinder, color-coded. Spread values shown for mixture diagnostics.</p>
<p><strong>Trend charts</strong> — 30-minute scrolling history. Sticky valve detection banner appears when a valve anomaly is detected.</p>
<p><strong>Fuel endurance</strong> — shows time remaining at current fuel flow.</p>

<!-- ═══ ENGINE ML ═══ -->
<h2 id="engineml" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Engine ML (ML badge — status bar)</h2>
<p>On-device machine learning monitors all engine parameters at 1 Hz. The <strong>ML:</strong> badge in the status bar shows current status. Long-press the badge for 2 seconds to run a simulation.</p>
<p><strong>Two-layer detection pipeline:</strong></p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>Layer 1 — Physics rules</strong> — hard limits that fire immediately: oil pressure &lt;25 PSI, CHT &gt;420°F, MAP or RPM sudden drops, fuel flow collapse at cruise power. Generates plain-language advisories on the engine page.</li>
  <li style="margin:4px 0"><strong>Layer 2 — ML model</strong> — TFLite model trained on actual flight data. Compares each sample against a rolling 60-second baseline. Identifies the most-deviated parameter and generates a specific advisory (e.g. "EGT #3 low vs baseline — possible misfire").</li>
  <li style="margin:4px 0"><strong>Phase detection</strong> — classifies ground / takeoff / climb / cruise / descent using GPS altitude rate (60-second smoothed), overriding the model's phase to prevent turbulence-driven thrashing.</li>
</ul>
<p><strong>Emergency trigger (Scenario 6):</strong> Both layers must confirm simultaneously — a physics alarm (MAP drop &gt;5", RPM drop &gt;300, or oil pressure &lt;20 PSI) <em>and</em> ML anomaly flag — before the Emergency Glide overlay appears. Neither layer alone can trigger it.</p>
<p>ML advisory logs are saved with each flight and viewable in Logbook → ML.</p>
<div style="background:rgba(255,170,0,0.1);border-left:3px solid #ffaa00;padding:8px 12px;border-radius:0 6px 6px 0;margin:10px 0;font-size:13px">
  Engine ML is advisory only. Always cross-check with your primary gauges. Never substitute ML output for direct instrument monitoring.
</div>

<!-- ═══ EMERGENCY GLIDE ═══ -->
<h2 id="emergency" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Emergency Glide (Engine Anomaly overlay)</h2>
<p>When the ML system confirms a serious engine anomaly (both physics and ML layers agree), a full-screen overlay lists the nearest airports reachable under glide.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Airports ranked by glide margin — <strong>BEST</strong> badge on the top choice, <strong>MARGINAL</strong> for airports at the edge of range</li>
  <li style="margin:4px 0">Glide range adjusted for wind (headwind reduces range, tailwind increases it)</li>
  <li style="margin:4px 0">Tap any airport to open the live <strong>Approach Guidance Panel</strong></li>
</ul>
<p><strong>Approach Guidance Panel</strong> (updates every second):</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>HDG</strong> — magnetic bearing to the airport from current position</li>
  <li style="margin:4px 0"><strong>DIST</strong> — distance in nautical miles, live</li>
  <li style="margin:4px 0"><strong>BEST GLIDE — ${acDmmsKt} kt</strong> — maintain this airspeed for maximum glide distance</li>
  <li style="margin:4px 0"><strong>OVERHEAD TGT</strong> — altitude (MSL) to arrive overhead the airport with enough energy to complete a 2 nm emergency pattern and cross the runway threshold at 500 ft AGL</li>
  <li style="margin:4px 0"><strong>Profile status</strong> — ON PROFILE (green) / HIGH — S-TURNS OR SLIP (amber) / LOW — FLY BEST GLIDE (red)</li>
  <li style="margin:4px 0"><strong>REQ V/S</strong> — descent rate needed to arrive at the overhead altitude</li>
  <li style="margin:4px 0"><strong>Best runway</strong> — computed from METAR wind (uses nearest available METAR if own airport has no report)</li>
  <li style="margin:4px 0"><strong>Frequencies</strong> — CTAF or Tower listed first</li>
</ul>
<p>When an airport is selected, the overlay shrinks to the top of the screen revealing the map below. A dashed red line is drawn from your position to the airport, and the map zooms to show the full glide path.</p>
<p><strong>FLY TO</strong> — sets the selected airport as your active route destination. <strong>← BACK</strong> — returns to the airport list.</p>
<div style="background:rgba(255,68,68,0.1);border-left:3px solid #ff4444;padding:8px 12px;border-radius:0 6px 6px 0;margin:10px 0;font-size:13px">
  Emergency guidance is advisory only. Fly the aircraft first. Use your POH emergency procedures as primary authority.
</div>

<!-- ═══ CHECKLISTS ═══ -->
<h2 id="checklist" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Checklists (✅ CHK)</h2>
<p>Three tabs: <strong>Normal</strong>, <strong>Abnormal</strong>, and <strong>Emergency</strong>. Customized for ${acTail} — edit <code>checklist.json</code> to tailor items to your aircraft.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Tap each item to check it off (item turns green)</li>
  <li style="margin:4px 0">Tap the section header to expand/collapse</li>
  <li style="margin:4px 0">Tap Reset to clear all items for the next flight</li>
</ul>
<div style="background:rgba(255,68,68,0.1);border-left:3px solid #ff4444;padding:8px 12px;border-radius:0 6px 6px 0;margin:10px 0;font-size:13px">
  Emergency checklists are a reference only. Always follow the aircraft's POH/AFM as primary authority.
</div>

<!-- ═══ LOGBOOK ═══ -->
<h2 id="logbook" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Logbook (MORE → Logbook)</h2>
<p>Auto-creates a draft entry when flight recording stops. Includes date, route, flight time, and Hobbs.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>Flights</strong> — all entries. Tap to edit or review.</li>
  <li style="margin:4px 0"><strong>Currency</strong> — recent landings and flight time for IFR/currency tracking</li>
  <li style="margin:4px 0"><strong>Oil</strong> — oil service log</li>
  <li style="margin:4px 0"><strong>ML</strong> — engine ML summaries linked to each flight</li>
  <li style="margin:4px 0"><strong>SYNC</strong> — push entries to flywhere.app</li>
  <li style="margin:4px 0"><strong>+ NEW</strong> — create a manual entry</li>
</ul>
<p>Stored locally in IndexedDB. Syncs to flywhere.app when online and authenticated.</p>

<!-- ═══ APPROACH CHARTS ═══ -->
<h2 id="charts" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Approach Charts (MORE → Approach Charts)</h2>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Auto-populates plates for airports on your active flight plan</li>
  <li style="margin:4px 0">Search any airport by ICAO to browse all its plates</li>
  <li style="margin:4px 0">Plates cached offline once viewed</li>
  <li style="margin:4px 0"><strong>Georef mode</strong> — shows ownship position overlaid on the plate (GPS-position-aware)</li>
  <li style="margin:4px 0">Pinch to zoom, drag to pan</li>
</ul>
<p>Plate states preloaded: NC, SC, VA, GA, TN. Others available via search when online.</p>

<!-- ═══ WEATHER ═══ -->
<h2 id="weather" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Weather</h2>
<p><strong>In flight — FIS-B (primary):</strong> Stratux receives live METARs, TAFs, PIREPs, SIGMETs, AIRMETs, TFR NOTAMs, and NEXRAD radar via UAT ground stations. FIS-B badge turns green only when ground towers are in range (aircraft traffic alone does not trigger green).</p>
<p><strong>PIREPs:</strong> Enable layer panel → Weather → PIREPs (FIS-B). Diamond icons appear at report location, color-coded by type and sized by severity. Tap for type, altitude, and raw text. Auto-expire after 60 minutes.</p>
<p><strong>TFRs:</strong> Enable layer panel → Aviation → TFRs (FIS-B). Shown as red dashed polygons or circles. Tap for NOTAM text and expiry time.</p>
<p><strong>SIGMETs/AIRMETs:</strong> Shown as colored overlays (toggle buttons: SIG/SRA/TNG/ZLU) from FIS-B in flight or from the weather brief pre-flight.</p>
<p><strong>NEXRAD radar:</strong> Tap the WX layer button on the left rail. A 2-hour radar loop plays automatically.</p>
<p><strong>Airport weather popup:</strong> Tap any airport marker on the map for its METAR and TAF.</p>
<p><strong>Pre-flight briefing:</strong> MORE → Weather Briefing opens the flywhere.app weather brief (requires connectivity).</p>
<p><strong>Weather cache:</strong> MORE → Data &amp; Maps shows all cached pre-flight airport weather with flight category, wind, visibility, and age. Tap any row to open that airport's WX tab.</p>

<!-- ═══ FLIGHT RECORDING ═══ -->
<h2 id="recording" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Flight Recording</h2>
<p>Auto-starts when RPM &gt;500. Auto-stops 60 seconds after RPM &lt;100. The red <strong>● REC</strong> badge shows it's active.</p>
<p>Records at ~1 Hz:</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">GPS: position, altitude, ground speed, track, vertical speed</li>
  <li style="margin:4px 0">Engine: RPM, EGT 1–4, CHT 1–4, oil temp/pressure, fuel flow, carb temp, % power</li>
  <li style="margin:4px 0">Fuel state, G-load</li>
</ul>
<p>Output format is compatible with <strong>Savvy Aviation CSV</strong> for upload to SavvyAnalysis.</p>
<p>Files saved to device storage. Access via the Android Files app under Documents/FlyTab/flights/.</p>
<p><strong>Track log export:</strong> MORE → Export Track GPX or Export Track CSV — exports the GPS breadcrumb trail (recorded every 10 seconds throughout the flight). The label shows how many points are in the current session. GPX format works with ForeFlight, SkyVector, and Google Earth.</p>

<!-- ═══ FUEL ═══ -->
<h2 id="fuel" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Fuel Entry</h2>
<p>Tap the <strong>FUEL</strong> field on the instrument strip, or use MORE → Fuel Entry.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Set left and right tank tic mark readings using sliders or +/− buttons</li>
  <li style="margin:4px 0">FlyTab converts tic marks to gallons using ${acTail}'s calibration polynomial (set in <code>aircraft-config.json</code>)</li>
  <li style="margin:4px 0">Tap <strong>Apply</strong> to update FUEL and RANGE in the instrument strip immediately</li>
  <li style="margin:4px 0">If the engine monitor reports live fuel remaining, that overrides the manual entry during flight</li>
</ul>
<p>Configured fuel capacity: ${acFuelCap} gal total.</p>

<!-- ═══ OFFLINE ═══ -->
<h2 id="offline" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Offline Use</h2>
<p>FlyTab is offline-first. The <strong>NET/OFFL</strong> badge shows Pi connectivity. Everything except live weather and plan sync works without internet.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Feature</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Offline?</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Moving map (vector)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ Always available</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Engine instruments</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ Real-time from Stratux/Pi</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">NASR database (airports, navaids)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ Stored in IndexedDB</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Approach plates (cached)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ Previously viewed plates</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Flight plan</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ Persists across restarts</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Checklists, logbook, config</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ All local</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">FIS-B weather</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ Via Stratux (no internet needed)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Pre-flight weather brief</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">❌ Requires internet</td></tr>
  <tr><td style="padding:6px 8px">Plan sync from flywhere.app</td><td style="padding:6px 8px">❌ Requires internet</td></tr>
</table>

<!-- ═══ CONFIGURATION ═══ -->
<h2 id="config" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Configuration (MORE → Configuration)</h2>
<p>Runtime JSON editor — changes apply immediately without restarting.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>enginePage</strong> — fuel caution/warning levels, trend chart window, sticky valve thresholds</li>
  <li style="margin:4px 0"><strong>map</strong> — default center, zoom, overlay visibility</li>
  <li style="margin:4px 0"><strong>flightRecording</strong> — auto-start RPM threshold, stop delay</li>
  <li style="margin:4px 0"><strong>routeTable.columns</strong> — which columns appear in the route table (HDG, BRG, FUEL, etc.)</li>
  <li style="margin:4px 0"><strong>instrumentStrip.fields</strong> — which fields appear in the instrument strip</li>
  <li style="margin:4px 0"><strong>radar</strong> — loop duration, playback speed, opacity</li>
  <li style="margin:4px 0"><strong>approachCharts</strong> — georef enable, ownship icon size</li>
  <li style="margin:4px 0"><strong>traffic</strong> — max altitude separation filter, callsign display</li>
</ul>
<p>Aircraft-specific data (V-speeds, fuel calibration, power settings table, engine limits) is in <code>aircraft-config.json</code>. The power settings table in that file is derived from actual ${acTail} flight data — 2,004 data points across 33 flights.</p>
<p><strong>Stratux IP</strong> — tap the Stratux field to set a custom IP if your network uses a non-default address.</p>

<!-- ═══ RELEASE NOTES ═══ -->
<h2 id="releases" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Release Notes</h2>
<div style="background:rgba(0,136,255,0.08);border-left:3px solid #0088ff;padding:8px 12px;border-radius:0 6px 6px 0;margin:10px 0;font-size:13px">
  <strong>Rollback:</strong> Previous APKs are saved in the repo at each version bump. To roll back during flight: open the Android Files app, navigate to the Downloads or FlyTab folder, and tap the previous APK to install. The app will downgrade in place — your plan, logbook, and settings are preserved in IndexedDB.
</div>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Version</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Changes</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v5.00</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055"><strong>Route nav strip</strong> — new always-visible strip showing active waypoint HDG, DIST, ETE, crossing ALT, cross-track deviation, and live fuel-at-destination (calculated from engine GPH). Tap to expand upcoming waypoints. <strong>ADS-B fix</strong> — maxBelowAlt filter wired up, diagnostic logging added. <strong>Config persistence</strong> — settings now survive app restarts (separate localStorage keys). <strong>Airport sidebar</strong> — frequency touch no longer blocks scrolling, gap below sidebar fixed. <strong>RWY extensions</strong> — now shown for both departure and destination. Route editor touch targets enlarged for turbulence.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.87</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">FIS-B Status page — reception health, tower list, product freshness table with route-aware prioritization. Tap FIS-B badge or More → FIS-B Status. Tower polling added to Stratux client.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.86</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Runway extensions fetch from AWC API (fixes missing rwy ext on map). Airport popup RWY tab populated from AWC. Layer panel accordion max-height fix (Rwy Ext / Show ±ALT toggles no longer clipped).</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.85</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Route editor auto-apply on every edit (add/remove/move/undo). NEW and REV buttons on route table. Airport sidebar no longer overlaps route table. Fuel moved below frequencies in airport INFO tab. SAVE button always visible.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.76</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Selective live update (only active leg recalcs in flight). NASR coordinate resolution for all waypoint types. Undo depth increased. CRZ/DES segment column alignment fix.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.75</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Auto GPS fallback to device GPS when Stratux unavailable. Issues #16-19: emergency overlay, NOTAM flood protection, offline route editing, fuel stop delete.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.69</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Fuel K-factor calculator. Measurement history. EDM fuel persist. Weather dots fix. Radar NO DATA fix. Altimeter hPa/inHg fix. Power tradeoff panel visibility fix.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.50</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Emergency glide approach guidance with live HDG/DIST/profile. Deep link support. METAR age parsing fix.</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055;white-space:nowrap;vertical-align:top">v4.46</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Route editor overhaul — New Route, Edit Route, APCH labels, save integrity. GPS track recording independent of engine data.</td></tr>
  <tr><td style="padding:6px 8px;white-space:nowrap;vertical-align:top">v4.42</td><td style="padding:6px 8px">Terrain profile view with SRTM 30m data. Airspace bands in profile. Collision highlighting. Preflight brief package with Claude AI summary.</td></tr>
</table>

<div style="margin:40px 0 20px;padding-top:16px;border-top:1px solid #1a3055;text-align:center;font-size:12px;color:#8899aa">
  FlyTab ${ver} · ${acTail} ${acType}
</div>

</div>`;

        document.body.appendChild(overlay);

        // Block all touch/pointer events from reaching elements underneath
        overlay.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        overlay.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
        overlay.addEventListener('touchend', (e) => e.stopPropagation(), { passive: true });
        overlay.addEventListener('pointerdown', (e) => e.stopPropagation());

        // Smooth scroll for anchor links
        overlay.querySelectorAll('a[href^="#"]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const target = overlay.querySelector(a.getAttribute('href'));
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    }
}
