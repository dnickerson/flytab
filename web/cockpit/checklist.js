/**
 * FlyTab — Interactive Checklist
 * Full-screen overlay with tabbed Normal/Abnormal/Emergency checklists.
 * Data loaded from checklist.json (ForeFlight-derived format).
 */

class Checklist {
    constructor(parentEl) {
        this._parentEl = parentEl;
        this._visible = false;
        this._data = null;
        this._activeGroup = 'normal';
        this._activeSection = 0;
        this._activeChecklist = 0;
        // Restore checked state from localStorage (persists across reloads)
        try { this._checked = JSON.parse(localStorage.getItem('flypi_checklist_state') || '{}'); }
        catch { this._checked = {}; }
        // Track which item indices have their note expanded (survives _renderItems re-builds)
        this._openNotes = new Set();

        this._buildDOM();
        this._load();
    }

    // ========== Overlay lifecycle ==========

    show() {
        this._el.classList.add('visible');
        this._visible = true;
        this._setMapControlsVisible(false);
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

    // ========== DOM ==========

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'checklist-page';
        this._el.innerHTML = `
            <div class="checklist-header">
                <span class="checklist-title">Checklist</span>
                <button class="btn-close checklist-close">✕</button>
            </div>
            <div class="checklist-tabs"></div>
            <div class="checklist-sub-tabs"></div>
            <div class="checklist-content">
                <div class="checklist-sidebar"></div>
                <div class="checklist-body"></div>
            </div>
        `;

        this._titleEl = this._el.querySelector('.checklist-title');
        this._tabsEl = this._el.querySelector('.checklist-tabs');
        this._subTabsEl = this._el.querySelector('.checklist-sub-tabs');
        this._sidebarEl = this._el.querySelector('.checklist-sidebar');
        this._bodyEl = this._el.querySelector('.checklist-body');

        const closeBtn = this._el.querySelector('.checklist-close');
        this._wire(closeBtn, () => this.hide());

        this._parentEl.appendChild(this._el);
    }

    // ========== Data loading ==========

    async _load() {
        try {
            const resp = await fetch('./checklist.json');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            this._data = await resp.json();
            if (this._data.metadata) {
                this._titleEl.textContent = `Checklist — ${this._data.metadata.tailNumber || ''}`;
            }
            this._renderTabs();
            this._selectGroup('normal');
        } catch (err) {
            console.error('Checklist load failed:', err);
            this._bodyEl.innerHTML = '<p style="color:#f88;padding:20px;">Failed to load checklist data.</p>';
        }
    }

    // ========== Tabs ==========

    _renderTabs() {
        if (!this._data) return;
        const types = [
            { type: 'normal', label: 'NORMAL', cls: 'tab-normal' },
            { type: 'abnormal', label: 'ABNORMAL', cls: 'tab-abnormal' },
            { type: 'emergency', label: 'EMERGENCY', cls: 'tab-emergency' },
        ];

        this._tabsEl.innerHTML = '';
        for (const t of types) {
            const group = this._data.groups.find(g => g.type === t.type);
            if (!group) continue;
            const btn = document.createElement('button');
            btn.className = `checklist-tab ${t.cls}`;
            btn.textContent = t.label;
            btn.dataset.type = t.type;
            this._wire(btn, () => this._selectGroup(t.type));
            this._tabsEl.appendChild(btn);
        }
    }

    _selectGroup(type) {
        this._activeGroup = type;
        this._activeSection = 0;
        this._activeChecklist = 0;
        this._openNotes.clear();

        // Highlight active tab
        this._tabsEl.querySelectorAll('.checklist-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.type === type);
        });

        const group = this._data.groups.find(g => g.type === type);
        if (!group) return;

        // Render sub-tabs (sections) if more than one
        this._renderSubTabs(group);
        this._renderSidebar(group);
        this._renderItems();
    }

    _renderSubTabs(group) {
        this._subTabsEl.innerHTML = '';
        if (group.sections.length <= 1) {
            this._subTabsEl.style.display = 'none';
            return;
        }
        this._subTabsEl.style.display = '';
        group.sections.forEach((section, i) => {
            const btn = document.createElement('button');
            btn.className = 'checklist-sub-tab';
            btn.textContent = section.name;
            btn.dataset.idx = i;
            if (i === this._activeSection) btn.classList.add('active');
            this._wire(btn, () => {
                this._activeSection = i;
                this._activeChecklist = 0;
                this._subTabsEl.querySelectorAll('.checklist-sub-tab').forEach(b =>
                    b.classList.toggle('active', parseInt(b.dataset.idx) === i));
                this._renderSidebar(group);
                this._renderItems();
            });
            this._subTabsEl.appendChild(btn);
        });
    }

    _renderSidebar(group) {
        const section = group.sections[this._activeSection];
        if (!section) return;

        this._sidebarEl.innerHTML = '';

        // RESET ALL button — clears every checkmark in the current group
        const resetAllBtn = document.createElement('button');
        resetAllBtn.className = 'checklist-reset-all-btn';
        resetAllBtn.textContent = 'RESET ALL';
        this._wire(resetAllBtn, () => this._resetAll());
        this._sidebarEl.appendChild(resetAllBtn);

        section.checklists.forEach((cl, i) => {
            const btn = document.createElement('button');
            btn.className = 'checklist-sidebar-item';
            if (i === this._activeChecklist) btn.classList.add('active');
            btn.dataset.idx = i;

            // Show completion status
            const total = cl.items.length;
            const checked = this._countChecked(this._activeSection, i);
            const dot = document.createElement('span');
            dot.className = 'checklist-sidebar-status';
            if (checked === total && total > 0) {
                dot.classList.add('complete');
                dot.textContent = '\u2713';
            } else if (checked > 0) {
                dot.textContent = `${checked}/${total}`;
            }

            const label = document.createElement('span');
            label.textContent = cl.name;

            btn.appendChild(label);
            btn.appendChild(dot);

            this._wire(btn, () => {
                this._activeChecklist = i;
                this._sidebarEl.querySelectorAll('.checklist-sidebar-item').forEach(b =>
                    b.classList.toggle('active', parseInt(b.dataset.idx) === i));
                this._renderItems();
            });
            this._sidebarEl.appendChild(btn);
        });
    }

    // ========== Items ==========

    _renderItems() {
        const group = this._data.groups.find(g => g.type === this._activeGroup);
        if (!group) return;
        const section = group.sections[this._activeSection];
        if (!section) return;
        const cl = section.checklists[this._activeChecklist];
        if (!cl) return;

        const isEmergency = this._activeGroup === 'emergency';

        let html = `<div class="checklist-items-header">
            <h3>${cl.name}</h3>
            <button class="checklist-reset-btn">Reset</button>
        </div>`;

        html += '<div class="checklist-items-list">';
        cl.items.forEach((item, i) => {
            const key = this._itemKey(this._activeSection, this._activeChecklist, i);
            const checked = this._checked[key] || false;
            const isInfo = item.type === 'info';
            const hasNote = item.note && item.note.trim();
            const hasAction = item.action && item.action.url;
            const noteOpen = this._openNotes.has(i);
            const emergencyClass = isEmergency ? ' emergency-item' : '';
            const infoClass = isInfo ? ' info-item' : '';
            const actionClass = hasAction ? ' action-item' : '';

            // Live status source (e.g. NET/OFFL from connectivity indicator)
            let liveResponse = this._esc(item.response);
            let liveResponseClass = '';
            if (item.statusSource === 'connectivity') {
                const syncEl = document.getElementById('statusSync');
                const txt = syncEl ? syncEl.textContent.trim() : '';
                const isConnected = txt === 'NET' || txt === 'HOME' || txt === 'FLT';
                liveResponse = isConnected ? txt + ' ✓' : 'OFFL ✗';
                liveResponseClass = isConnected ? ' style="color:var(--status-ok)"' : ' style="color:var(--status-danger)"';
            }

            html += `<div class="checklist-item${checked ? ' checked' : ''}${emergencyClass}${infoClass}${actionClass}" data-idx="${i}">
                <div class="checklist-item-main">
                    <span class="checklist-item-title">${this._esc(item.title)}</span>
                    <span class="checklist-item-dots"></span>
                    <span class="checklist-item-response"${liveResponseClass}>${liveResponse}</span>
                    ${hasAction ? '<span class="checklist-item-action-icon">\u25B6</span>' : ''}
                    ${hasNote ? '<span class="checklist-item-note-icon">\u2139</span>' : ''}
                    <span class="checklist-item-check">${checked ? '\u2713' : '\u25CB'}</span>
                </div>
                ${hasNote ? `<div class="checklist-item-note"${noteOpen ? '' : ' style="display:none;"'}>${this._esc(item.note).replace(/\n/g, '<br>')}</div>` : ''}
                <div class="checklist-item-action-status" style="display:none;"></div>
            </div>`;
        });
        html += '</div>';

        // Complete banner
        const total = cl.items.length;
        const checked = this._countChecked(this._activeSection, this._activeChecklist);
        if (checked === total && total > 0) {
            html += `<div class="checklist-complete-banner">\u2713 ${cl.name} Complete</div>`;
        }

        this._bodyEl.innerHTML = html;

        // Wire reset button
        const resetBtn = this._bodyEl.querySelector('.checklist-reset-btn');
        if (resetBtn) {
            this._wire(resetBtn, () => this._resetChecklist());
        }

        // Wire item taps
        this._bodyEl.querySelectorAll('.checklist-item').forEach(el => {
            const idx = parseInt(el.dataset.idx);
            this._wire(el.querySelector('.checklist-item-main'), () => {
                this._toggleItem(idx);
            });
            const noteIcon = el.querySelector('.checklist-item-note-icon');
            const noteEl = el.querySelector('.checklist-item-note');
            if (noteIcon && noteEl) {
                // Use direct listeners (not _wire) so we can call preventDefault,
                // which suppresses the iOS synthetic click that would bubble to the
                // parent .checklist-item-main handler and trigger a spurious _renderItems().
                let noteTouchFired = false;
                noteIcon.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    e.preventDefault(); // stops iOS from synthesizing a click
                    noteTouchFired = true;
                    this._toggleNote(idx, noteEl);
                    setTimeout(() => { noteTouchFired = false; }, 400);
                }, { passive: false });
                noteIcon.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!noteTouchFired) this._toggleNote(idx, noteEl);
                });
            }
        });
    }

    _toggleItem(idx) {
        const group = this._data.groups.find(g => g.type === this._activeGroup);
        const section = group?.sections[this._activeSection];
        const cl = section?.checklists[this._activeChecklist];
        const item = cl?.items[idx];

        const key = this._itemKey(this._activeSection, this._activeChecklist, idx);
        const alreadyChecked = this._checked[key] || false;

        // If item has an action and we're checking it (not unchecking), fire the action first
        if (item?.action && !alreadyChecked) {
            this._fireAction(idx, item.action);
            return; // _fireAction will toggle after success/failure
        }

        this._checked[key] = !alreadyChecked;
        this._persistChecked();
        this._renderItems();
        this._updateSidebarStatus();
    }

    async _fireAction(idx, action) {
        // Show pending state on the item row
        const itemEl = this._bodyEl.querySelector(`.checklist-item[data-idx="${idx}"]`);
        const statusEl = itemEl?.querySelector('.checklist-item-action-status');
        const checkEl = itemEl?.querySelector('.checklist-item-check');
        if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Starting…'; statusEl.className = 'checklist-item-action-status pending'; }
        if (checkEl) checkEl.textContent = '⏳';

        try {
            const resp = await fetch(action.url, { method: action.method || 'POST', signal: AbortSignal.timeout(8000) });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

            // Success — mark checked
            const key = this._itemKey(this._activeSection, this._activeChecklist, idx);
            this._checked[key] = true;
            this._persistChecked();
            if (statusEl) { statusEl.textContent = data.message || 'Started'; statusEl.className = 'checklist-item-action-status success'; }
            setTimeout(() => { this._renderItems(); this._updateSidebarStatus(); }, 800);
        } catch (err) {
            // Failure — show error, leave unchecked, allow retry
            if (statusEl) { statusEl.style.display = ''; statusEl.textContent = `Failed: ${err.message}`; statusEl.className = 'checklist-item-action-status error'; }
            if (checkEl) checkEl.textContent = '○';
            console.warn('Checklist action failed:', action.url, err);
        }
    }

    _toggleNote(idx, noteEl) {
        if (this._openNotes.has(idx)) {
            this._openNotes.delete(idx);
            noteEl.style.display = 'none';
        } else {
            this._openNotes.add(idx);
            noteEl.style.display = '';
        }
    }

    _persistChecked() {
        try { localStorage.setItem('flypi_checklist_state', JSON.stringify(this._checked)); } catch {}
    }

    _resetAll() {
        Object.keys(this._checked).forEach(key => {
            if (key.startsWith(this._activeGroup + '-')) delete this._checked[key];
        });
        this._openNotes.clear();
        this._persistChecked();
        this._renderItems();
        this._updateSidebarStatus();
    }

    _resetChecklist() {
        const group = this._data.groups.find(g => g.type === this._activeGroup);
        if (!group) return;
        const section = group.sections[this._activeSection];
        if (!section) return;
        const cl = section.checklists[this._activeChecklist];
        if (!cl) return;

        cl.items.forEach((_, i) => {
            const key = this._itemKey(this._activeSection, this._activeChecklist, i);
            delete this._checked[key];
        });
        this._openNotes.clear();
        this._persistChecked();
        this._renderItems();
        this._updateSidebarStatus();
    }

    _updateSidebarStatus() {
        const group = this._data.groups.find(g => g.type === this._activeGroup);
        if (!group) return;
        this._renderSidebar(group);
    }

    // ========== Helpers ==========

    _itemKey(sectionIdx, checklistIdx, itemIdx) {
        return `${this._activeGroup}-${sectionIdx}-${checklistIdx}-${itemIdx}`;
    }

    _countChecked(sectionIdx, checklistIdx) {
        const group = this._data.groups.find(g => g.type === this._activeGroup);
        if (!group) return 0;
        const section = group.sections[sectionIdx];
        if (!section) return 0;
        const cl = section.checklists[checklistIdx];
        if (!cl) return 0;
        let count = 0;
        cl.items.forEach((_, i) => {
            if (this._checked[this._itemKey(sectionIdx, checklistIdx, i)]) count++;
        });
        return count;
    }

    _esc(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** Wire touchstart + click with Android-safe debounce */
    _wire(el, handler) {
        if (!el) return;
        let touchFired = false;
        el.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            touchFired = true;
            handler(e);
            setTimeout(() => { touchFired = false; }, 400);
        });
        el.addEventListener('click', (e) => {
            if (!touchFired) handler(e);
        });
    }
}
