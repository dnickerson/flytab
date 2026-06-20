# Plates Server-as-Source-of-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Data & Maps so that adding new states to the pipeline on the home server causes the Approach Plates section to show UPDATE AVAILABLE and sync those new states.

**Architecture:** Three targeted edits in `web/cockpit/data-status.js` — the plates render block, the `needsSync` expression, and the `_syncAll()` plates block. All three currently filter against a static `configuredStates` list from the tablet's local config; replace that list with `serverStates` derived from the server's `plates_cycle_info.json`.

**Tech Stack:** Vanilla JS, no bundler. Edit the file directly; build with `bash build.sh`.

---

### Task 1: Fix `_render()` — plates section

**Files:**
- Modify: `web/cockpit/data-status.js:309–365`

The block currently reads `configuredStates` from `CockpitConfig.raw?.plateStates` and drives all comparison logic from it. Replace with `serverStates` (what the server actually has).

- [ ] **Step 1: Replace the plates section in `_render()`**

Find this block (starts at line 309):

```javascript
        // ── Plates section ───────────────────────────────────────────────────
        const configuredStates = (typeof CockpitConfig !== 'undefined' && CockpitConfig.raw?.plateStates)
            || ['NC', 'SC', 'VA', 'GA', 'TN'];
        const syncedStates = JSON.parse(localStorage.getItem('flypi_plates_synced_states') || '[]');
        const plateSCode   = sPlates?.cycle?.effective_date || null;
        const plateDCode   = dPlates?.effective_date || null;
        let platesServerLine, platesDevLine, platesBadge, platesPrimary = '', platesSecondary = '';

        const adminUrl = base ? `${base}/admin-states.html` : null;
        const configureLink = adminUrl
            ? `<a href="${adminUrl}" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;margin-left:8px">&#9881; Configure states</a>`
            : '';

        if (!base) {
            platesServerLine = '<span class="ds-muted">Server not reachable</span>';
        } else if (plateSCode) {
            const serverStateSet = new Set((sPlates?.states || []).map(s => s.state));
            const avail = configuredStates.filter(s => serverStateSet.has(s)).length;
            platesServerLine = `Cycle ${plateSCode} &mdash; ${avail}/${configuredStates.length} states &mdash; IAP, DP, STAR, DIAG, A/FD${configureLink}`;
        } else {
            platesServerLine = `<span class="ds-muted">Unavailable</span>${configureLink}`;
        }

        // Per-state chips
        const serverStateSet = new Set((sPlates?.states || []).map(s => s.state));
        const serverStateSizes = Object.fromEntries((sPlates?.states || []).map(s => [s.state, s.size_mb]));
        const cycleOkForStates = !plateSCode || plateDCode === plateSCode;
        const stateChips = configuredStates.map(st => {
            const onDevice = syncedStates.includes(st);
            const onServer = serverStateSet.has(st);
            const ok = onDevice && cycleOkForStates;
            const sizeTxt = serverStateSizes[st] ? ` ${serverStateSizes[st]}MB` : '';
            const cls = ok ? 'ds-state-ok' : 'ds-state-missing';
            const icon = ok ? '&#10003;' : '&#9675;';
            const notOnServer = !onServer && base ? ' <span class="ds-muted">(server n/a)</span>' : '';
            return `<span class="ds-state-chip ${cls}">${icon} ${st}${sizeTxt}${notOnServer}</span>`;
        }).join('');

        const platesIncludesNote = '<span class="ds-muted" style="font-size:10px">Includes: IAP &middot; DP &middot; STAR &middot; Airport Diagrams (DIAG) &middot; Airport Info (A/FD)</span>';

        if (!plateDCode && syncedStates.length === 0) {
            platesDevLine = stateChips || '<span class="ds-muted">Not on tablet</span>';
            platesBadge   = this._badge('NOT DOWNLOADED', 'gray');
            if (base && plateSCode) platesPrimary = `<button class="ds-action-btn" id="dsPlatesBtn">DOWNLOAD</button>`;
        } else {
            platesDevLine = stateChips + '<br>' + platesIncludesNote;
            const allSynced = configuredStates.every(s => syncedStates.includes(s));
            if (!allSynced || !cycleOkForStates) {
                platesBadge   = this._badge('UPDATE AVAILABLE', 'yellow');
                if (base) platesPrimary = `<button class="ds-action-btn ds-update" id="dsPlatesBtn">SYNC</button>`;
            } else {
                const expDate = sNasr?.expiration_date ? new Date(sNasr.expiration_date) : null;
                platesBadge   = expDate ? this._cycleStatus(expDate, now) : this._badge('CURRENT', 'green');
                if (base) platesPrimary = `<button class="ds-action-btn ds-secondary" id="dsPlatesBtn">SYNC</button>`;
            }
            if (base) platesSecondary = `<button class="ds-action-btn ds-secondary" id="dsPlatesRedownloadBtn">RE-DOWNLOAD</button>`;
        }
```

Replace with:

```javascript
        // ── Plates section ───────────────────────────────────────────────────
        const serverStates    = (sPlates?.states || []).map(s => s.state);
        const syncedStates    = JSON.parse(localStorage.getItem('flypi_plates_synced_states') || '[]');
        const plateSCode      = sPlates?.cycle?.effective_date || null;
        const plateDCode      = dPlates?.effective_date || null;
        let platesServerLine, platesDevLine, platesBadge, platesPrimary = '', platesSecondary = '';

        const adminUrl = base ? `${base}/admin-states.html` : null;
        const configureLink = adminUrl
            ? `<a href="${adminUrl}" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;margin-left:8px">&#9881; Configure states</a>`
            : '';

        if (!base) {
            platesServerLine = '<span class="ds-muted">Server not reachable</span>';
        } else if (plateSCode) {
            platesServerLine = `Cycle ${plateSCode} &mdash; ${serverStates.length} states &mdash; IAP, DP, STAR, DIAG, A/FD${configureLink}`;
        } else {
            platesServerLine = `<span class="ds-muted">Unavailable</span>${configureLink}`;
        }

        // Per-state chips — server states drive the list; synced states removed from server shown dimmed
        const serverStateSet   = new Set(serverStates);
        const serverStateSizes = Object.fromEntries((sPlates?.states || []).map(s => [s.state, s.size_mb]));
        const cycleOkForStates = !plateSCode || plateDCode === plateSCode;
        const allDisplayStates = [...serverStates, ...syncedStates.filter(s => !serverStateSet.has(s))];
        const stateChips = allDisplayStates.map(st => {
            const onDevice = syncedStates.includes(st);
            const onServer = serverStateSet.has(st);
            const ok = onDevice && onServer && cycleOkForStates;
            const sizeTxt = serverStateSizes[st] ? ` ${serverStateSizes[st]}MB` : '';
            const cls = ok ? 'ds-state-ok' : 'ds-state-missing';
            const icon = ok ? '&#10003;' : '&#9675;';
            const note = !onServer ? ' <span class="ds-muted">(removed from server)</span>' : '';
            return `<span class="ds-state-chip ${cls}">${icon} ${st}${sizeTxt}${note}</span>`;
        }).join('');

        const platesIncludesNote = '<span class="ds-muted" style="font-size:10px">Includes: IAP &middot; DP &middot; STAR &middot; Airport Diagrams (DIAG) &middot; Airport Info (A/FD)</span>';

        if (!plateDCode && syncedStates.length === 0) {
            platesDevLine = stateChips || '<span class="ds-muted">Not on tablet</span>';
            platesBadge   = this._badge('NOT DOWNLOADED', 'gray');
            if (base && plateSCode) platesPrimary = `<button class="ds-action-btn" id="dsPlatesBtn">DOWNLOAD</button>`;
        } else {
            platesDevLine = stateChips + '<br>' + platesIncludesNote;
            const allSynced = serverStates.every(s => syncedStates.includes(s));
            if (!allSynced || !cycleOkForStates) {
                platesBadge   = this._badge('UPDATE AVAILABLE', 'yellow');
                if (base) platesPrimary = `<button class="ds-action-btn ds-update" id="dsPlatesBtn">SYNC</button>`;
            } else {
                const expDate = sNasr?.expiration_date ? new Date(sNasr.expiration_date) : null;
                platesBadge   = expDate ? this._cycleStatus(expDate, now) : this._badge('CURRENT', 'green');
                if (base) platesPrimary = `<button class="ds-action-btn ds-secondary" id="dsPlatesBtn">SYNC</button>`;
            }
            if (base) platesSecondary = `<button class="ds-action-btn ds-secondary" id="dsPlatesRedownloadBtn">RE-DOWNLOAD</button>`;
        }
```

- [ ] **Step 2: Fix the `needsSync` expression** (4 lines below the plates block, around line 397)

Find:
```javascript
            (plateSCode      && (!cycleOkForStates || !configuredStates.every(s => syncedStates.includes(s)))) ||
```

Replace with:
```javascript
            (plateSCode      && (!cycleOkForStates || serverStates.some(s => !syncedStates.includes(s)))) ||
```

(`serverStates` is in scope — it was defined just above in the plates block.)

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/data-status.js
git commit -m "fix: plates _render uses server states as source of truth"
```

---

### Task 2: Fix `_syncAll()` — plates block

**Files:**
- Modify: `web/cockpit/data-status.js:1388–1400`

Currently `_syncAll()` filters `statesToSync` through `configuredStates`, so newly-available server states are skipped during sync. Remove the filter.

- [ ] **Step 1: Replace the configuredStates block in `_syncAll()`**

Find (around line 1387) — this is the section from `syncedStates` through the opening of the inner `else {` that contains `totalMb`:

```javascript
            const syncedStates = JSON.parse(localStorage.getItem('flypi_plates_synced_states') || '[]');
            const configuredStates = (typeof CockpitConfig !== 'undefined' && CockpitConfig.raw?.plateStates)
                || ['NC', 'SC', 'VA', 'GA', 'TN'];
            const allStatesSynced = configuredStates.every(s => syncedStates.includes(s));
            const needsUpdate = !cycleMatch || !allStatesSynced;

            if (!needsUpdate) {
                setStep('plates', 'skip', `Current — cycle ${serverDate}`);
            } else if (!statesResp.length) {
                setStep('plates', 'skip', 'No plate states available on server');
            } else {
                const statesToSync = statesResp.filter(s => configuredStates.includes(s.state));
                if (!statesToSync.length) {
                    setStep('plates', 'skip', 'No configured states on server (set plateStates in config)');
                } else {
                    const totalMb = statesToSync.reduce((s, r) => s + r.size_mb, 0);
```

Replace with (the inner `if (!statesToSync.length)` check is removed — `statesResp` is already guarded above):

```javascript
            const syncedStates = JSON.parse(localStorage.getItem('flypi_plates_synced_states') || '[]');
            const allStatesSynced = statesResp.every(s => syncedStates.includes(s.state));
            const needsUpdate = !cycleMatch || !allStatesSynced;

            if (!needsUpdate) {
                setStep('plates', 'skip', `Current — cycle ${serverDate}`);
            } else if (!statesResp.length) {
                setStep('plates', 'skip', 'No plate states available on server');
            } else {
                const statesToSync = statesResp;
                const totalMb = statesToSync.reduce((s, r) => s + r.size_mb, 0);
```

- [ ] **Step 2: Remove the now-orphaned closing brace**

The removed inner `if/else` had its own closing `}`. Find the line that reads just `                }` immediately before `            }` at the end of the plates try block (around line 1449), and delete it. After the fix the structure should be:

```javascript
                    setStep('plates', 'ok', `${done} states downloaded — cycle ${serverDate}`);
            }       // ← only ONE closing brace here (the outer else), not two
        } catch (e) { failStep('plates', e); }
```

Correct final structure (lines ~1448–1451):
```javascript
                    setStep('plates', 'ok', `${done} states downloaded — cycle ${serverDate}`);
                }
            }
        } catch (e) { failStep('plates', e); }
```

The inner `}` at line 1449 was closing the `if (!statesToSync.length) { ... } else { ... }` block. With that if-else gone, `}` at 1449 becomes the close of the outer `else` block (line 1450 was already there for that). Delete line 1449.

- [ ] **Step 3: Commit**

```bash
git add web/cockpit/data-status.js
git commit -m "fix: plates _syncAll syncs all server states, not just configured"
```

---

### Task 3: Build and verify

**Files:**
- Read: `web/app.js` (to get current version for bump)

- [ ] **Step 1: Bump version and build**

Open `web/app.js`, find `FLYTAB_VERSION` near the top, increment the patch number (e.g. `v6.48` → `v6.49`), then:

```bash
bash build.sh
```

Expected: build succeeds, APK copied to `data/`.

- [ ] **Step 2: Manual verification checklist**

Install the APK and open **More → Data & Maps** while connected to the home server. Verify:

1. **New state visible as missing:** If the server's `plates_cycle_info.json` → `state_sizes` includes a state not in `flypi_plates_synced_states`, that state appears as an `○` gray chip, the badge shows **UPDATE AVAILABLE**, and the **Sync All Outdated** footer button is enabled.

2. **All synced:** If all server states are in `flypi_plates_synced_states` and the cycle matches, badge shows **CURRENT** and Sync All is disabled.

3. **Removed-from-server state:** If a state is in `flypi_plates_synced_states` but no longer in `sPlates.states`, it appears as a dimmed gray chip with "(removed from server)" and does NOT trigger UPDATE AVAILABLE on its own.

4. **Sync All downloads new state:** Tap **Sync All Outdated** — the new state ZIP is fetched and extracted; after Done–Refresh the state chip turns green `✓`.

- [ ] **Step 3: Commit version bump**

```bash
git add web/app.js
git commit -m "build: bump version after plates source-of-truth fix"
```
