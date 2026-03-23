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
                this._closeMoreDrawer();
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

    /** Show help overlay in-app (no external browser) */
    _showHelp() {
        document.getElementById('flytabHelpOverlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'flytabHelpOverlay';
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 100000;
            background: #0a1628; color: #e8ecf0;
            display: flex; flex-direction: column;
            font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
            font-size: 14px; line-height: 1.6;
        `;

        const closeBtn = `<button onclick="document.getElementById('flytabHelpOverlay').remove()" style="
            background:#0055cc; color:#fff; border:none; border-radius:6px;
            padding:6px 14px; font-size:14px; font-weight:600; cursor:pointer;
            touch-action:manipulation;">✕ Back to Map</button>`;

        overlay.innerHTML = `<div style="
            flex:1; overflow-y:scroll; -webkit-overflow-scrolling:touch;
            touch-action:pan-y; overscroll-behavior:contain;
            padding:12px 16px 40px;
        ">
<div style="position:sticky;top:0;background:#0a1628;border-bottom:1px solid #1a3055;padding:10px 0 10px;display:flex;align-items:center;gap:12px;z-index:1">
  ${closeBtn}
  <span style="font-size:18px;font-weight:700;flex:1">FlyTab Help</span>
  <span style="font-size:12px;color:#8899aa;background:#0f1f3a;padding:2px 8px;border-radius:10px">v${typeof FLYTAB_VERSION !== 'undefined' ? FLYTAB_VERSION : '4.10'}</span>
</div>

<div style="background:#0f1f3a;border-radius:8px;padding:12px;margin:14px 0">
  <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8899aa;margin-bottom:8px">Contents</div>
  <div style="display:flex;flex-wrap:wrap;gap:6px">
    ${['#tabs','#map','#engine','#instruments','#checklist','#logbook','#charts','#weather','#routing','#recording','#fuel','#offline','#config'].map((id,i)=>
      `<a href="${id}" style="color:#0088ff;text-decoration:none;font-size:13px;padding:3px 10px;border-radius:4px;background:#152847">${['Tabs','Map','Engine','Instruments','Checklists','Logbook','Approach Charts','Weather','Routing','Flight Recording','Fuel','Offline','Configuration'][i]}</a>`
    ).join('')}
  </div>
</div>

<h2 id="tabs" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Bottom Tab Bar</h2>
<p>The tab bar is always visible at the bottom of the screen. Tap any tab to switch views.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Tab</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Function</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">🗺 MAP</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Moving map with ownship, route, traffic, and airspace</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✈ APT</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Airport info — frequencies, runways, weather for any airport</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">⚙️ ENG</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Engine instruments — RPM, EGT/CHT, oil, fuel flow, trend charts</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">✅ CHK</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Interactive checklists — Normal, Abnormal, Emergency</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">📻 CLR</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">IFR clearance helper — CRAFT format, CD phone, squawk</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">⏱ TMR</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Flight timer — Zulu time, leg timer, Hobbs timer</td></tr>
  <tr><td style="padding:6px 8px">⋯ MORE</td><td style="padding:6px 8px">Additional tools — logbook, weather, approach charts, fuel, settings</td></tr>
</table>

<h2 id="map" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Moving Map</h2>
<p>The map tab shows your position, route, traffic, and aviation data layers.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>Ownship</strong> — blue triangle at your GPS position, rotated to heading</li>
  <li style="margin:4px 0"><strong>Traffic</strong> — ADS-B targets from Stratux, color-coded by proximity. Tap for callsign and altitude.</li>
  <li style="margin:4px 0"><strong>Route line</strong> — active leg highlighted. Tap a waypoint to see leg details.</li>
  <li style="margin:4px 0"><strong>Track log</strong> — breadcrumb trail of your flight path</li>
  <li style="margin:4px 0"><strong>Airspace</strong> — Class B/C/D/E polygons with altitude labels</li>
</ul>
<p><strong>Left-side layer buttons:</strong> Toggle base map (Vector/Sectional/IFR), NEXRAD radar, airports, navaids, fixes, airways.</p>
<p><strong>Top-right buttons:</strong> Auto-pan toggle (📍), Direct-To (D→).</p>

<h2 id="engine" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Engine Page (⚙️ ENG)</h2>
<p>Full-screen engine instruments sourced from your engine monitor via the Pi.</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Gauge</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Warning</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">RPM</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Red above 2700</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">MAP (manifold pressure)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">—</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Fuel Flow (GPH)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">—</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Oil Temp (°F)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Yellow &gt;220, Red &gt;245</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Oil Pressure (PSI)</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Red &lt;25 or &gt;95</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Volts</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Yellow &lt;13.0</td></tr>
  <tr><td style="padding:6px 8px">Carb Temp (°F)</td><td style="padding:6px 8px">Yellow &lt;40°F, Red &lt;32°F</td></tr>
</table>
<p><strong>Cylinder bars</strong> — EGT and CHT per cylinder, color-coded green/yellow/red.</p>
<p><strong>Trend charts</strong> — 30-minute scrolling history of EGT, CHT, oil temp, and fuel flow.</p>
<p><strong>Engine ML</strong> — On-device machine learning monitors for anomalies (sticky valve, phase detection). Access via MORE → Engine ML.</p>

<h2 id="instruments" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Instrument Strip</h2>
<p>The instrument strip at the top of the map shows live flight data from Stratux:</p>
<table style="width:100%;border-collapse:collapse;margin:10px 0;font-size:13px">
  <tr style="background:#152847"><th style="padding:6px 8px;text-align:left;color:#8899aa">Field</th><th style="padding:6px 8px;text-align:left;color:#8899aa">Description</th></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GS</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GPS ground speed (knots)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">ALT</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Barometric altitude (feet)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">VS</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Vertical speed (feet/min)</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">HDG</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">GPS track / magnetic heading</td></tr>
  <tr><td style="padding:6px 8px;border-bottom:1px solid #1a3055">NEXT / DEST</td><td style="padding:6px 8px;border-bottom:1px solid #1a3055">Next waypoint and destination — distance (nm) and ETE</td></tr>
  <tr><td style="padding:6px 8px">FUEL / RANGE</td><td style="padding:6px 8px">Fuel remaining (gallons) and fuel-based range (nm)</td></tr>
</table>
<p>Status badges (GPS, FIS-B, REC, NET, NASR, WX) are color-coded: green = good, amber = caution, red = problem. Long-press the version badge to see the diagnostic log.</p>

<h2 id="checklist" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Checklists (✅ CHK)</h2>
<p>Three tabs: <strong>Normal</strong>, <strong>Abnormal</strong>, and <strong>Emergency</strong>. Tap each item to check it off. Items are customized for N194JT.</p>
<div style="background:rgba(255,68,68,0.1);border-left:3px solid #ff4444;padding:8px 12px;border-radius:0 6px 6px 0;margin:10px 0;font-size:13px">
  Emergency checklists are a reference only. Always follow your aircraft's POH/AFM as primary authority.
</div>

<h2 id="logbook" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Logbook (MORE → Logbook)</h2>
<p>The logbook auto-creates a draft entry when flight recording stops. Entries include date, departure, destination, flight time, and Hobbs.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0"><strong>Flights tab</strong> — all entries, tap to edit or review</li>
  <li style="margin:4px 0"><strong>Currency tab</strong> — recent landings and flight time for currency tracking</li>
  <li style="margin:4px 0"><strong>Oil tab</strong> — oil service log</li>
  <li style="margin:4px 0"><strong>ML tab</strong> — engine ML logs linked to each flight</li>
  <li style="margin:4px 0"><strong>SYNC</strong> — manually push entries to flywhere.app</li>
  <li style="margin:4px 0"><strong>+ NEW</strong> — create a manual entry</li>
</ul>
<p>Entries are stored locally in IndexedDB and sync to flywhere.app when online.</p>

<h2 id="charts" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Approach Charts (MORE → Approach Charts)</h2>
<p>Route-aware plate viewer for FAA approach charts.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Auto-populates plates for airports on your flight plan</li>
  <li style="margin:4px 0">Search any airport by ICAO to browse its plates</li>
  <li style="margin:4px 0">Plates cached for offline use once viewed</li>
  <li style="margin:4px 0">Georeferenced overlay available — shows ownship on the plate</li>
</ul>

<h2 id="weather" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Weather</h2>
<p><strong>In flight (primary):</strong> FIS-B via Stratux — live METARs, TAFs, PIREPs, SIGMETs, NEXRAD radar.</p>
<p><strong>Pre-flight:</strong> MORE → Weather Briefing for online weather from flywhere.app.</p>
<p><strong>NEXRAD radar:</strong> Tap the WX layer button on the map. Radar loop controls appear at the bottom.</p>
<p><strong>Airport weather:</strong> Tap any airport on the map for its METAR and TAF.</p>

<h2 id="routing" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Routing</h2>
<p><strong>Load a flight plan:</strong> MORE → Load Flight Plan to sync from flywhere.app.</p>
<p><strong>Direct-To:</strong> Tap D→ on the map to fly direct to any airport, navaid, or fix.</p>
<p><strong>Route table:</strong> Drag up the bottom handle to expand. Shows waypoints with leg distance, time, and fuel burn. Tap Edit to modify the route.</p>
<p><strong>Airport popup:</strong> Tap any airport on the map for frequencies, runways, weather, and a Direct-To button.</p>

<h2 id="recording" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Flight Recording</h2>
<p>Auto-starts when RPM exceeds 500, auto-stops 60 seconds after RPM drops below 100. The red ● REC badge shows it's active.</p>
<p>Records GPS position, altitude, ground speed, all engine parameters (RPM, EGT 1–4, CHT 1–4, oil, fuel flow, carb temp), fuel state, and G-load at ~1 Hz. Compatible with Savvy Aviation CSV format.</p>
<p>Recordings are saved to <code>Documents/FlyTab/flights/</code> on the device and can be uploaded via MORE → Save Flight CSV.</p>

<h2 id="fuel" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Fuel Entry (MORE → Fuel Entry)</h2>
<p>Set fuel state by tic mark reading. Use the sliders or fine +/− buttons for left and right tanks. FlyTab converts tic marks to gallons using your aircraft's calibration curve.</p>
<p>Tap <strong>Apply</strong> to update the nav strip FUEL and RANGE displays immediately.</p>

<h2 id="offline" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Offline Use</h2>
<p>FlyTab is offline-first. The NET/OFFL badge shows Pi connectivity. Everything except live weather and plan sync works offline.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Map, instruments, engine data — all load from cache instantly</li>
  <li style="margin:4px 0">NASR database (airports, navaids, airspace) — stored in IndexedDB</li>
  <li style="margin:4px 0">Previously viewed approach plates — cached</li>
  <li style="margin:4px 0">Flight plan — persists across restarts</li>
  <li style="margin:4px 0">Checklists, logbook, configuration — all local</li>
</ul>
<p>Engine data is real-time only — stale engine data is never shown.</p>

<h2 id="config" style="font-size:17px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:1px solid #1a3055;color:#00ff88">Configuration (MORE → Configuration)</h2>
<p>Runtime editor for all cockpit settings. Changes apply immediately without restarting.</p>
<ul style="padding-left:20px;margin:8px 0">
  <li style="margin:4px 0">Engine polling and thresholds</li>
  <li style="margin:4px 0">Map defaults and layer visibility</li>
  <li style="margin:4px 0">Flight recording auto-start RPM</li>
  <li style="margin:4px 0">Radar loop playback speed</li>
  <li style="margin:4px 0">Approach chart georef and orientation</li>
  <li style="margin:4px 0">Takeoff alert altitudes</li>
</ul>
<p>Aircraft-specific settings (V-speeds, fuel calibration, performance profiles) are in <code>aircraft-config.json</code>.</p>

<div style="margin:40px 0 20px;padding-top:16px;border-top:1px solid #1a3055;text-align:center;font-size:12px;color:#8899aa">
  FlyTab v${typeof FLYTAB_VERSION !== 'undefined' ? FLYTAB_VERSION : '4.10'} — N194JT RV-9A
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
