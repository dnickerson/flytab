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

        if (tabId === 'map') {
            // Close any open overlays, return to map
            if (c.enginePage?.visible) c.enginePage.hide();
            if (c.checklist?.hide) c.checklist.hide();
            if (c.logbook?.hide) c.logbook.hide();
            this._closeMoreDrawer();
        } else if (tabId === 'eng') {
            this._closeMoreDrawer();
            if (c.enginePage) {
                if (c.enginePage.visible) c.enginePage.hide();
                else c.enginePage.show();
            }
        } else if (tabId === 'chk') {
            this._closeMoreDrawer();
            if (c.checklist?.show) c.checklist.show();
        } else if (tabId === 'clr') {
            this._closeMoreDrawer();
            if (c.ifrClearance) c.ifrClearance.show();
        } else if (tabId === 'apt') {
            this._closeMoreDrawer();
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
