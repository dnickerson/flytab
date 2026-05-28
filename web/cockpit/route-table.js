/**
 * FlyPi — Route Table (Bottom Sheet)
 * Collapsible bottom sheet showing enroute nav data with live updates.
 * Includes inline edit mode: delete, reorder, and smart waypoint insertion.
 */

/**
 * Ray-casting point-in-polygon test.
 * boundary is [[lat, lon], ...] or [{lat, lon}, ...]
 */
function _pointInPolygon(lat, lon, boundary) {
    let inside = false;
    const n = boundary.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const pi = boundary[i], pj = boundary[j];
        const yi = Array.isArray(pi) ? pi[0] : pi.lat;
        const xi = Array.isArray(pi) ? pi[1] : pi.lon;
        const yj = Array.isArray(pj) ? pj[0] : pj.lat;
        const xj = Array.isArray(pj) ? pj[1] : pj.lon;
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// ── Terminology hierarchy ───────────────────────────────────────────────────
//  Trip   — the full plan from departure to final destination
//   └── Flight  — one airport-to-airport segment (there may be 1 or more)
//        └── Leg — the path from one waypoint to the next within a Flight
//             └── Segment — a phase subdivision within a Leg: CLB / CRZ / DES

/**
 * A waypoint is a fuel stop if it is an APT-type point that is neither the
 * overall trip departure (index 0) nor the final destination (last index).
 * Fuel stops divide the Trip into discrete Flights; the pilot refuels there.
 */
function isFuelStop(wp, index, waypoints) {
    if (index === 0) return false;
    // Explicit pilot override takes precedence over heuristic
    if (wp.is_fuel_stop === false) return false;
    if (wp.is_fuel_stop === true) return true;
    // Non-airport types are never fuel stops
    if (wp.type === 'VOR' || wp.type === 'NDB' || wp.type === 'FIX' || wp.type === 'GPS' || wp.type === 'WPT') return false;

    const isApt = wp.type === 'APT' ||
        // Fallback: plans loaded from legs-only (waypoints:null) don't have type set.
        // Treat any 4-char K-prefix ICAO as an airport.
        (() => { const id = wp.icao || wp.name || ''; return id.length === 4 && id.startsWith('K'); })();

    if (!isApt) return false;

    // A fuel stop is an airport that has another airport later in the route.
    // The destination is the last APT — approach fixes and MAP points after it
    // do not make the destination a fuel stop.
    return waypoints.slice(index + 1).some(w => {
        if (w.type === 'APT') return true;
        const id = w.icao || w.name || '';
        return !w.type && id.length === 4 && id.startsWith('K');
    });
}

class RouteTable {
    constructor(container, map) {
        this._container = container;
        this._map = map;
        this._waypoints = [];   // trip.waypoints[] — all waypoints across all flights
        this._flights = [];     // trip.flights[]   — computed by _buildFlights()
        this._activeIndex = -1;
        this._lastGpsPosition = null;  // for auto-pan after drag
        this._preCompactHeight = null; // for compact-mode height restore

        this._editMode = false;

        this._el = null;
        this._handleEl = null;
        this._bodyEl = null;
        this._tableEl = null;
        this._searchRowEl = null;
        this._searchInput = null;
        this._resultsEl = null;

        this._lastSituation = null;
        this._nasrDb = null;
        this._undoStack = [];
        this._searchDebounce = null;
        this._onRouteChanged = null; // callback when route is edited
        this._cruisePower = null; // user-selected cruise power override (%)
        this._powerPresets = [55, 65, 75]; // cycle through these
        this._flightRules = Settings.get('flight_rules') ?? 'VFR'; // VFR or IFR
        this._emitting = false; // re-entrancy guard for _emitRouteChange
        this._lastAirspaceBands = [];   // cached from last _buildProfileData for alt picker hints
        this._lastWaypointDists = [];   // cumulative distances per waypoint for picker hints

        this._buildDOM();
    }


    /** Wire EngineMLBridge so the status card stays in sync */
    setEngineML(engineML) {
        this._engineML = engineML;
        if (!engineML) return;
        this._onEngineMLResult = (e) => this._updateEngineStatusCard(e.detail);
        document.addEventListener('engineml:result', this._onEngineMLResult);
    }

    /** Set NasrDB reference for search */
    setNasrDb(db) {
        this._nasrDb = db;
    }

    /** Set callback for when route is edited */
    onRouteChanged(callback) {
        this._onRouteChanged = callback;
    }

    /** Recompute and re-render (e.g. after fuel source change) */
    refresh() {
        const gs = this._lastSituation?.ground_speed || 0;
        this._computeEnroute(gs);
        this._updateSummary();
        this._renderTable();
    }

    /** Set FIS-B client for winds aloft updates */
    setFisbClient(fisbClient) {
        // Remove old listener if switching clients
        if (this._fisbClient && this._fisbWindsHandler) {
            this._fisbClient.removeEventListener('fisb:winds', this._fisbWindsHandler);
        }
        this._fisbClient = fisbClient;
        if (fisbClient) {
            this._fisbWindsHandler = () => this._applyFisbWinds();
            fisbClient.addEventListener('fisb:winds', this._fisbWindsHandler);
        }
    }

    /** Apply FIS-B winds aloft to waypoints if fresher than plan data */
    _applyFisbWinds() {
        if (!this._fisbClient || this._waypoints.length === 0) return;
        let changed = false;

        for (let i = 1; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (!wp.lat || !wp.lon) continue;
            const alt = wp.alt || 5000;
            const fisbWind = this._fisbClient.getNearestWind(wp.lat, wp.lon, alt);
            if (fisbWind && fisbWind.dir != null && fisbWind.spd != null) {
                // Override if no plan wind, or existing wind was already from FIS-B (safe to update)
                const planWind = wp.wind;
                if (!planWind || planWind._fisbApplied) {
                    wp.wind = { dir: fisbWind.dir, spd: fisbWind.spd, _fisbApplied: true };
                    wp._wind = wp.wind;
                    changed = true;
                }
            }
        }

        if (changed) {
            this._computeEnroute();
            if (!this._editMode) {
                this._renderTable();
            }
        }
    }

    /**
     * Load waypoints from a flight plan.
     */
    loadPlan(plan) {
        // Plans saved before waypoints were populated (waypoints:null) are rebuilt
        // from the legs array so the route table still functions correctly.
        if (plan && !plan.waypoints?.length) {
            const legs = plan.flight_plan?.legs || [];
            if (legs.length > 0) {
                // Reconstruct a flat waypoint list from legs: dep, then each leg.to
                const dep = plan.flight_plan?.departure;
                const dest = plan.flight_plan?.destination;
                const wps = [];
                if (dep) {
                    wps.push({ icao: dep, name: dep, lat: null, lon: null,
                        type: 'APT' });
                }
                for (const leg of legs) {
                    const isApt = leg.to === dest
                        || (leg.to?.length === 4 && leg.to.startsWith('K'));
                    wps.push({
                        icao: leg.to, name: leg.to, lat: null, lon: null,
                        type: isApt ? 'APT' : undefined,
                        alt: plan.flight_plan?.altitude || null,
                        wind: (leg.windDir != null && leg.windSpd != null)
                            ? { dir: leg.windDir, spd: leg.windSpd } : null,
                        _segments: leg.segments || [],
                        tas: leg.tasKt ?? null, gs: leg.gsKt ?? null,
                        gph: ((leg.segments || []).find(s => s.phase === 'CRZ') || leg.segments?.[leg.segments.length - 1])?.gph || null,
                    });
                }
                plan = { ...plan, waypoints: wps };

                // Async NASR resolution: fill in lat/lon for waypoints reconstructed
                // from legs so HDG/BRG/DIST columns show real values instead of dashes.
                if (this._nasrDb) {
                    this._resolveWaypointCoords(wps);
                }
            }
        }

        if (!plan || !plan.waypoints?.length) {
            this._waypoints = [];
            this._activeIndex = -1;
            this._updateSummary();
            this._renderTable();
            // Auto-enter edit mode when plan is empty so user can type a route immediately
            if (!this._editMode) {
                this._editMode = true;
                this._el?.classList.add('route-table-editing');
                if (this._searchRowEl) this._searchRowEl.hidden = false;
                if ((this._bodyEl?.offsetHeight || 0) === 0) this.toggle?.();
            }
            return;
        }

        this._trip = plan;  // trip — top-level plan object (renamed from _plan)
        const rawLegs = plan.flight_plan?.legs || plan.legs || [];
        // Only use legs if they align with waypoints (legs.length === wps.length - 1).
        // After in-cockpit edits, the plan may have updated waypoints but stale legs
        // from the original route — using them would map wrong segments to wrong waypoints.
        const legs = rawLegs.length === plan.waypoints.length - 1 ? rawLegs : [];

        // Restore persisted cruise power override
        try {
            const saved = localStorage.getItem('flypi_cruise_power');
            if (saved) this._cruisePower = parseFloat(saved);
        } catch {}

        const planDep  = plan.flight_plan?.departure  || plan.waypoints[0]?.icao;
        const planDest = plan.flight_plan?.destination || plan.waypoints[plan.waypoints.length - 1]?.icao;

        this._waypoints = plan.waypoints.map((wp, i) => {
            // Map leg performance data onto waypoints.
            // Legs array: leg[0] is dep→wp[1], so wp[i] uses leg[i-1].
            const leg = i > 0 ? (legs[i - 1] || {}) : {};
            // Prefer explicit segments; synthesize one CRZ segment from planning-library
            // fuelGal/timeHrs when present so _computeEnroute uses the planner's fuel
            // model instead of the flat aircraft-config GPH fallback.
            const segments = wp._segments || leg.segments
                || (leg.fuelGal != null && leg.timeHrs > 0
                    ? [{ phase: 'CRZ',
                         gph: leg.fuelGal / leg.timeHrs,
                         ete_min: leg.timeHrs * 60,
                         tas: leg.tasKt,
                         gs: leg.gsKt,
                         percent_power: leg.percentPwr,
                         dist: leg.distNm,
                         altFrom: leg.altFt ?? plan.cruise_altitude ?? null,
                         altTo:   leg.altFt ?? plan.cruise_altitude ?? null }]
                    : []);
            // Use cruise segment for default rpm/mp/pwr display
            const cruiseSeg = segments.find(s => s.phase === 'CRZ')
                           || segments[segments.length - 1]
                           || {};
            // Wind is at leg level as windDir/windSpd
            const wind = (leg.windDir != null && leg.windSpd != null)
                ? { dir: leg.windDir, spd: leg.windSpd } : (wp.wind || null);

            // Departure/destination: use field elevation, not cruise altitude.
            // Planning-library waypoints carry altFt (not alt); prefer it so
            // pilot-entered per-waypoint altitude restrictions are displayed.
            let wpAlt = wp.altFt ?? wp.alt;
            if (i === 0) {
                // Departure has no inbound leg — look at the first outbound leg for CLB altFrom
                const depSegs = legs[0]?.segments || [];
                const clbSeg = depSegs.find(s => s.phase === 'CLB');
                wpAlt = wp.elev_ft ?? clbSeg?.altFrom ?? null;
            } else if (i === plan.waypoints.length - 1) {
                // Destination: show user-set cruise altitude, not field elevation
                const desSeg = segments.find(s => s.phase === 'DES');
                wpAlt = wp.alt || desSeg?.altFrom || wp.elev_ft || null;
            } else if (wp.type === 'APT' && wp.elev_ft != null) {
                // Intermediate airport (e.g., destination with missed-approach
                // waypoints after it) — use field elevation, not cruise altitude.
                wpAlt = wp.elev_ft;
            }

            const isApt = wp.type === 'APT' || wp.icao === planDep || wp.icao === planDest;
            return {
                ...wp,
                type: isApt ? 'APT' : (wp.type || undefined),
                alt: wpAlt,
                index: i,
                active: false,
                passed: false,
                wind,
                _segments: segments,
                percent_power: wp.percent_power ?? leg.percentPwr ?? cruiseSeg.percent_power ?? null,
                rpm: wp.rpm ?? cruiseSeg.rpm ?? null,
                mp: wp.mp ?? cruiseSeg.mp ?? null,
                tas: wp.tas ?? leg.tasKt ?? null,
                gs: wp.gs ?? leg.gsKt ?? null,
                gph: wp.gph ?? cruiseSeg.gph ?? null,
                _eta: leg.eta ?? null,        // UTC ms ETA at this waypoint (from recomputeLegs)
                _planAltFt: leg.altFt ?? null, // cruise altitude used for this leg's TAS/fuel
            };
        });

        // Pre-compute leg distances between consecutive waypoints
        for (let i = 1; i < this._waypoints.length; i++) {
            const prev = this._waypoints[i - 1];
            const wp = this._waypoints[i];
            if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                wp._legDist = NasrDB.haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
            } else if (wp._segments?.length > 0) {
                // Fallback for plans reconstructed from legs (no lat/lon on waypoints):
                // sum segment distances which are already computed by the planner.
                wp._legDist = wp._segments.reduce((s, seg) => s + (seg.dist || 0), 0);
            } else {
                wp._legDist = 0;
            }
        }

        // Generate segments for waypoints that don't already have them
        this._buildMissingSegments();

        this._activeIndex = 0;
        if (this._waypoints.length > 0) this._waypoints[0].active = true;

        // Register plan with ActiveRoute so InstrumentStrip stays in sync.
        // ActiveRoute.setPlan() resets the index to 1 (first en-route WP);
        // mirror that here so both start on the same waypoint.
        if (typeof ActiveRoute !== 'undefined') {
            ActiveRoute.setPlan({ waypoints: this._waypoints });
            this._activeIndex = ActiveRoute.getIndex();
            if (this._activeIndex < this._waypoints.length) {
                this._waypoints.forEach((wp, i) => { wp.active = i === this._activeIndex; });
            }
            // Listen for advances triggered by InstrumentStrip (proximity-only path)
            if (!this._onActiveRouteAdvance) {
                this._onActiveRouteAdvance = (e) => {
                    const newIdx = e.detail.index;
                    if (newIdx !== this._activeIndex && newIdx < this._waypoints.length) {
                        this._waypoints[this._activeIndex].active = false;
                        this._waypoints[this._activeIndex].passed = true;
                        this._activeIndex = newIdx;
                        this._waypoints[this._activeIndex].active = true;
                    }
                };
                window.addEventListener('activeroute:advance', this._onActiveRouteAdvance);
            }
        }

        this._computeEnroute();
        this._updateSummary();
        this._renderTable();
    }

    /**
     * Attempt to resolve lat/lon for waypoints that are missing coordinates
     * (e.g. reconstructed from a legs-only saved plan). Looks up each ident
     * in NasrDB (airports → navaids → fixes) and patches the waypoint in-place,
     * then recomputes the route so HDG/BRG/DIST columns populate.
     */
    async _resolveWaypointCoords(waypoints) {
        const db = this._nasrDb;
        if (!db) return;

        let resolved = 0;
        for (const wp of waypoints) {
            if (wp.lat != null && wp.lon != null) continue;
            const ident = wp.icao || wp.name;
            if (!ident) continue;

            try {
                // Try airport first, then navaid, then fix
                let rec = await db.getAirport(ident);
                if (!rec) rec = await db.getAirport('K' + ident); // US ICAO prefix
                if (!rec) rec = await db.getNavaid(ident);
                if (!rec) rec = await db.getFix(ident);

                if (rec && rec.lat != null && rec.lon != null) {
                    wp.lat = rec.lat;
                    wp.lon = rec.lon;
                    if (rec.name && !wp.name) wp.name = rec.name;
                    resolved++;
                }
            } catch { /* NASR DB may not be loaded yet — leave as dashes */ }
        }

        if (resolved > 0) {
            this._computeEnroute();
            this._updateSummary();
            this._renderTable();
        }
    }

    /**
     * Update live data (GS, position) from Stratux situation.
     */
    updateLive(situation) {
        if (!situation || this._waypoints.length === 0) return;
        this._lastSituation = situation;

        if (situation.lat && situation.lon) {
            this._lastGpsPosition = { lat: situation.lat, lng: situation.lon };
        }

        const lat = situation.lat;
        const lon = situation.lon;
        const gs = situation.ground_speed || 0;

        // Check waypoint passage — advance on proximity OR if waypoint is behind us
        if (this._activeIndex >= 0 && this._activeIndex < this._waypoints.length) {
            const wp = this._waypoints[this._activeIndex];
            if (wp.lat && wp.lon && lat && lon) {
                const dist = NasrDB.haversineNm(lat, lon, wp.lat, wp.lon);
                const track = situation.true_course ?? situation.gps_track ?? null;
                const bearingToWpt = FlyTabPlanning.bearing(lat, lon, wp.lat, wp.lon);

                // Passed if within 1nm, OR if waypoint is >90° behind our track
                // (handles flying past without getting within 1nm of it)
                const isPast = dist < 1.0 ||
                    (track !== null && gs > 30 &&
                     Math.abs(((bearingToWpt - track + 540) % 360) - 180) > 90);

                if (isPast && this._activeIndex < this._waypoints.length - 1) {
                    this._advanceWaypoint();
                }
            }
        }

        // Compute live nav data for active leg
        const active = this._waypoints[this._activeIndex];
        if (active && active.lat && active.lon && lat && lon) {
            active._liveDist = NasrDB.haversineNm(lat, lon, active.lat, active.lon);
            active._liveHdg = FlyTabPlanning.bearing(lat, lon, active.lat, active.lon);
        }

        // Recompute all enroute data with current GS
        this._computeEnroute(gs);
        this._updateSummary();
        // Skip full DOM rebuild while editing — live updates would destroy
        // the edit-mode button event listeners mid-interaction (issue #30)
        if (!this._editMode) {
            // Try selective cell update first to avoid full innerHTML rebuild every
            // GPS tick (1 Hz). Falls back to full render when structure changes.
            if (!this._updateTableCells()) {
                this._renderTable();
            }
        }
    }

    /**
     * Smart waypoint insertion: add a waypoint at the optimal position.
     * Calculates minimum route deviation for each existing leg.
     */
    addWaypointSmart(wp) {
        if (this._waypoints.length < 2) {
            // Less than 2 waypoints: just append
            this._pushUndo();
            this._waypoints.push(wp);
            this._reindex();
            this._onEdited();
            return;
        }

        // For each leg A→B, compute detour: dist(A,NEW) + dist(NEW,B) - dist(A,B)
        let bestIdx = this._waypoints.length; // default: append
        let bestDetour = Infinity;

        for (let i = 0; i < this._waypoints.length - 1; i++) {
            const a = this._waypoints[i];
            const b = this._waypoints[i + 1];
            if (!a.lat || !a.lon || !b.lat || !b.lon) continue;

            const directDist = NasrDB.haversineNm(a.lat, a.lon, b.lat, b.lon);
            const viaNew = NasrDB.haversineNm(a.lat, a.lon, wp.lat, wp.lon)
                         + NasrDB.haversineNm(wp.lat, wp.lon, b.lat, b.lon);
            const detour = viaNew - directDist;

            if (detour < bestDetour) {
                bestDetour = detour;
                bestIdx = i + 1; // insert after waypoint i
            }
        }

        this._pushUndo();
        this._waypoints.splice(bestIdx, 0, wp);
        this._reindex();

        // If the inserted waypoint qualifies as a fuel stop by position, suppress
        // the heuristic and prompt the pilot before committing.
        if (isFuelStop(this._waypoints[bestIdx], bestIdx, this._waypoints)) {
            this._waypoints[bestIdx].is_fuel_stop = false;
            this._onEdited();
            this._promptFuelStop(bestIdx);
        } else {
            this._onEdited();
            if (typeof app !== 'undefined') {
                const id = wp.icao || wp.name || '?';
                const toast = app.showToast(`Added ${id} at position ${bestIdx + 1}`);
                setTimeout(() => toast?.remove(), 3000);
            }
        }
    }

    /** Whether edit mode is active */
    isEditing() {
        return this._editMode;
    }

    // ========== Edit Mode ==========

    _toggleEditMode() {
        this._editMode = !this._editMode;
        this._el.classList.toggle('route-table-editing', this._editMode);

        if (this._editMode) {
            // Auto-expand when entering edit mode
            if ((this._bodyEl?.offsetHeight || 0) === 0) this.toggle();
            this._searchRowEl.hidden = false;
        } else {
            this._searchRowEl.hidden = true;
            this._clearSearch();
            this._hideAltPicker();
        }
        this._updateSummary();
        this._renderTable();
    }

    _pushUndo() {
        this._undoStack.push({
            waypoints: JSON.parse(JSON.stringify(this._waypoints)),
            activeIndex: this._activeIndex,
        });
        if (this._undoStack.length > 15) this._undoStack.shift();
    }

    _popUndo() {
        if (this._undoStack.length === 0) return;
        const state = this._undoStack.pop();
        this._waypoints = state.waypoints;
        this._activeIndex = state.activeIndex;
        this._reindex();
        this._onEdited();
    }

    _removeWaypoint(index) {
        if (index < 0 || index >= this._waypoints.length) return;
        this._pushUndo();
        this._waypoints.splice(index, 1);
        // Keep _activeIndex valid after removal
        if (this._activeIndex >= this._waypoints.length) {
            this._activeIndex = Math.max(this._waypoints.length - 1, -1);
        }
        this._reindex();
        this._onEdited();
    }

    _promptFuelStop(idx) {
        const wp = this._waypoints[idx];
        if (!wp || typeof app === 'undefined') return;
        const id = wp.icao || wp.name || '?';
        app.showToast(`Make ${id} a fuel stop?`, [
            { label: 'Yes', action: () => { wp.is_fuel_stop = true;  this._onEdited(); } },
            { label: 'No',  action: () => { /* wp.is_fuel_stop already false */ } }
        ]);
    }

    _demoteFuelStop(idx) {
        if (idx < 0 || idx >= this._waypoints.length) return;
        this._pushUndo();
        this._waypoints[idx].is_fuel_stop = false;
        this._onEdited();
    }

    _setWaypointAlt(index, alt, altUpper = null) {
        if (index < 0 || index >= this._waypoints.length) return;
        this._pushUndo();
        this._waypoints[index].alt = alt;
        this._waypoints[index].altitude = alt;
        this._waypoints[index].altLocked = true;
        if (altUpper !== null) this._waypoints[index].alt_constraint_upper = altUpper;
        this._onEdited();
    }

    _setWaypointConstraint(index, constraint) {
        if (index < 0 || index >= this._waypoints.length) return;
        this._waypoints[index].alt_constraint = constraint;
        this._onEdited();
    }

    _showAltPicker(wpIndex, anchorEl) {
        if (wpIndex < 0 || wpIndex >= this._waypoints.length) {
            this._hideAltPicker();
            return;
        }
        const wp = this._waypoints[wpIndex];
        if (!wp) return;
        const currentAlt = wp.alt ?? wp.altitude ?? 0;
        const currentConstraint = wp.alt_constraint || 'AT';
        const currentAltUpper = wp.alt_constraint_upper || '';

        // Determine bearing to pick E/W hemisphere altitude rules
        // 0-179° = eastbound (odd thousands), 180-359° = westbound (even)
        const hdg = wp._brg ?? wp._hdg ?? 0;
        const isEast = hdg >= 0 && hdg < 180;
        const isVfr = this._flightRules === 'VFR';
        const vfrOffset = isVfr ? 500 : 0;

        // Build altitude presets: 5 altitudes for the heading + rules combo
        const alts = [];
        for (let a = isEast ? 3000 : 2000; a <= 12000; a += 2000) {
            alts.push(a + vfrOffset);
        }

        const dir = isEast ? 'E odd' : 'W even';
        const constraints = [
            { key: 'AT',           label: 'AT' },
            { key: 'AT_OR_ABOVE',  label: 'AT OR\u00a0ABOVE' },
            { key: 'AT_OR_BELOW',  label: 'AT OR\u00a0BELOW' },
            { key: 'BETWEEN',      label: 'BETWEEN' },
        ];
        let html = `<div class="rt-alt-picker-header">${this._flightRules} \u00b7 ${dir} \u00b7 ${Math.round(hdg)}\u00b0</div>`;

        // Constraint selector row
        html += '<div class="rt-alt-constraint-row">';
        for (const c of constraints) {
            const active = c.key === currentConstraint ? ' rt-alt-constraint-active' : '';
            html += `<button class="rt-alt-constraint-btn${active}" data-constraint="${c.key}">${c.label}</button>`;
        }
        html += '</div>';

        // Airspace context hint (if data available)
        const wpDist = this._lastWaypointDists[wpIndex] ?? null;
        if (wpDist !== null && this._lastAirspaceBands.length > 0) {
            const activeBands = this._lastAirspaceBands.filter(
                b => wpDist >= b.distFrom && wpDist <= b.distTo
            );
            for (const band of activeBands) {
                if (band.lowerFt > 0) {
                    const floorK = band.lowerFt >= 1000 ? band.lowerFt.toLocaleString() + 'ft' : band.lowerFt + 'ft';
                    html += `<button class="rt-alt-hint-btn" data-constraint="AT_OR_BELOW" data-alt="${band.lowerFt}">`;
                    html += `\u26A0 Class ${band.class} floor: ${floorK} \u2014 set AT OR BELOW?`;
                    html += '</button>';
                }
                if (band.upperFt > 0 && band.upperFt < 99999) {
                    const ceilK = band.upperFt >= 1000 ? band.upperFt.toLocaleString() + 'ft' : band.upperFt + 'ft';
                    html += `<button class="rt-alt-hint-btn" data-constraint="AT_OR_ABOVE" data-alt="${band.upperFt}">`;
                    html += `\u26A0 Class ${band.class} ceiling: ${ceilK} \u2014 set AT OR ABOVE?`;
                    html += '</button>';
                }
            }
        }

        // Altitude presets row
        html += '<div class="rt-alt-picker-row">';
        for (const alt of alts) {
            const sel = alt === currentAlt ? ' rt-alt-selected' : '';
            const label = isVfr ? (alt / 1000).toFixed(1) : (alt / 1000).toFixed(0);
            html += `<button class="rt-alt-option${sel}" data-alt="${alt}">${label}</button>`;
        }
        html += '</div>';

        // Custom input (one or two for BETWEEN)
        if (currentConstraint === 'BETWEEN') {
            html += `<div class="rt-alt-custom">
                <input type="number" class="rt-alt-input" value="${currentAlt || ''}" placeholder="Floor" step="500" min="0" max="45000">
                <input type="number" class="rt-alt-input-upper" value="${currentAltUpper || ''}" placeholder="Ceiling" step="500" min="0" max="45000">
                <button class="rt-alt-set-btn">SET</button>
            </div>`;
        } else {
            html += `<div class="rt-alt-custom">
                <input type="number" class="rt-alt-input" value="${currentAlt || ''}" placeholder="Custom" step="500" min="0" max="45000">
                <button class="rt-alt-set-btn">SET</button>
            </div>`;
        }

        this._altPicker.innerHTML = html;
        this._altPicker.hidden = false;
        this._altPickerIndex = wpIndex;
        this._altPickerAnchorEl = anchorEl;

        // Position: prefer below anchor, flip above if it would go off screen
        const rect = anchorEl.getBoundingClientRect();
        const containerRect = document.getElementById('cockpitContainer').getBoundingClientRect();
        const pickerH = 160; // increased for constraint row
        const spaceBelow = containerRect.bottom - rect.bottom;
        if (spaceBelow < pickerH) {
            this._altPicker.style.top = '';
            this._altPicker.style.bottom = (containerRect.bottom - rect.top + 4) + 'px';
        } else {
            this._altPicker.style.bottom = '';
            this._altPicker.style.top = (rect.bottom - containerRect.top + 4) + 'px';
        }
        this._altPicker.style.left = Math.max(0, rect.left - containerRect.left - 40) + 'px';

        // Wire Enter key on custom input (delegation handles click on SET/presets/constraints)
        const input = this._altPicker.querySelector('.rt-alt-input');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = parseInt(input.value);
                    if (!isNaN(val) && val > 0) {
                        const upper = this._altPicker.querySelector('.rt-alt-input-upper');
                        const upperVal = upper ? parseInt(upper.value) : null;
                        this._setWaypointAlt(this._altPickerIndex, val, upperVal > 0 ? upperVal : null);
                        this._hideAltPicker();
                    }
                }
            });
        }
    }

    _hideAltPicker() {
        this._altPicker.hidden = true;
        this._altPickerIndex = -1;
    }

    _moveWaypoint(fromIdx, toIdx) {
        if (fromIdx === toIdx) return;
        if (fromIdx < 0 || fromIdx >= this._waypoints.length) return;
        if (toIdx < 0 || toIdx >= this._waypoints.length) return;
        this._pushUndo();
        const [wp] = this._waypoints.splice(fromIdx, 1);
        this._waypoints.splice(toIdx, 0, wp);
        this._reindex();
        this._onEdited();
    }

    _reindex() {
        for (let i = 0; i < this._waypoints.length; i++) {
            this._waypoints[i].index = i;
        }
        // Recompute leg distances
        for (let i = 1; i < this._waypoints.length; i++) {
            const prev = this._waypoints[i - 1];
            const wp = this._waypoints[i];
            if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                wp._legDist = NasrDB.haversineNm(prev.lat, prev.lon, wp.lat, wp.lon);
            } else if (wp._segments?.length > 0) {
                wp._legDist = wp._segments.reduce((s, seg) => s + (seg.dist || 0), 0);
            } else {
                wp._legDist = 0;
            }
        }
        if (this._waypoints.length > 0 && this._waypoints[0]) {
            this._waypoints[0]._legDist = 0;
        }
    }

    /** Called after any edit — recompute, re-render, notify parent */
    _onEdited() {
        // Clear all segments and rebuild — leg distances changed so old
        // plan segments (CLB/CRZ/DES splits) are no longer valid.
        for (let i = 1; i < this._waypoints.length; i++) {
            this._waypoints[i]._segments = [];
        }
        this._buildMissingSegments();
        this._computeEnroute();
        this._updateSummary();
        this._renderTable();
        this._emitRouteChange();
    }

    _emitRouteChange() {
        if (!this._onRouteChanged) return;
        if (this._emitting) return;
        this._emitting = true;
        const plan = {
            ...(this._trip || {}),
            // trip.waypoints[] — all waypoints across all flights
            waypoints: this._waypoints.map(wp => {
                const out = {
                    icao: wp.icao,
                    name: wp.name,
                    lat: wp.lat,
                    lon: wp.lon,
                    alt: wp.alt ?? wp.altitude,
                };
                if (wp.type) out.type = wp.type;
                if (wp.fuel_add_gal != null) out.fuel_add_gal = wp.fuel_add_gal;
                if (wp.alt_constraint) out.alt_constraint = wp.alt_constraint;
                if (wp.alt_constraint_upper != null) out.alt_constraint_upper = wp.alt_constraint_upper;
                if (wp.elev_ft != null) out.elev_ft = wp.elev_ft;
                return out;
            }),
            // trip.flights[] — airport-to-airport Flight segments
            flights: (this._flights || []).map(f => ({
                dep:  f.dep,
                dest: f.dest,
            })),
            flight_plan: {
                ...(this._trip?.flight_plan || {}),
                departure: this._waypoints[0]?.icao || '',
                destination: this._waypoints[this._waypoints.length - 1]?.icao || '',
                // Clear stale legs — they were for the original route, not the edited one
                legs: [],
                // Preserve the original airway route array when waypoints are structurally
                // unchanged — route table edits (altitude, fuel stops) must not strip airways.
                // If waypoints were added/removed, fall back to the current waypoint list.
                route: (() => {
                    const curr = this._waypoints.map(wp => wp.icao).filter(Boolean);
                    const orig = Array.isArray(this._trip?.flight_plan?.route) ? this._trip.flight_plan.route : null;
                    if (!orig) return curr;
                    const origFixes = orig.filter(id => !/^[VTJQ]\d/.test(id) && id !== 'DIRECT');
                    if (origFixes.length === curr.length && origFixes.every((id, i) => id === curr[i])) return orig;
                    return curr;
                })(),
            },
        };
        try {
            this._onRouteChanged(plan);
        } finally {
            this._emitting = false;
        }
    }

    // ========== Search ==========

    _onSearchInput() {
        clearTimeout(this._searchDebounce);
        const q = this._searchInput.value.trim();
        if (q.length < 2) {
            this._resultsEl.hidden = true;
            this._resultsEl.innerHTML = '';
            return;
        }
        // Route string mode: space-separated tokens (e.g. "KLKR V54 GSP KMEB")
        // Debounce heavily — each parse fires multiple IDB lookups
        if (q.includes(' ')) {
            this._searchDebounce = setTimeout(() => this._parseRouteString(q), 600);
            return;
        }
        this._searchDebounce = setTimeout(() => this._doSearch(q), 200);
    }

    _isAirwayToken(token) {
        if (/^[VJTQ]\d+[A-Z]?$/i.test(token)) return true;
        const SKIP = new Set(['DCT', 'DIRECT', 'IFR', 'VFR', 'SID', 'STAR']);
        return SKIP.has(token.toUpperCase());
    }

    _dbLookup(promise) {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('idb timeout')), 2000)),
        ]);
    }

    async _resolveToken(token) {
        const t = token.toUpperCase();
        try {
            // 1. Exact 4-char ICAO airport (KLKR, KMEB — user typed full ICAO)
            if (t.length >= 4) {
                const apt = await this._dbLookup(this._nasrDb.getAirport(t));
                if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
            }
        } catch {}
        try {
            // 2. Navaid before K-prefix — 3-char tokens like SAV/ORF are VORTACs in route strings
            const nav = await this._dbLookup(this._nasrDb.getNavaid(t));
            if (nav) return { icao: nav.id, name: nav.name, lat: nav.lat, lon: nav.lon, type: nav.type || 'VOR' };
        } catch {}
        try {
            // 3. Fix
            const fix = await this._dbLookup(this._nasrDb.getFix(t));
            if (fix) return { icao: fix.id, name: fix.id, lat: fix.lat, lon: fix.lon, type: 'FIX' };
        } catch {}
        try {
            // 4. K-prefixed airport fallback (LKR → KLKR, MMT → KMMT)
            if (t.length <= 3 && !t.startsWith('K')) {
                const apt = await this._dbLookup(this._nasrDb.getAirport('K' + t));
                if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
            }
        } catch {}
        try {
            // 5. Exact airport last resort
            const apt = await this._dbLookup(this._nasrDb.getAirport(t));
            if (apt) return { icao: apt.icao, name: apt.name, lat: apt.lat, lon: apt.lon, type: 'APT' };
        } catch {}
        return null;
    }

    async _parseRouteString(str) {
        // Serial guard — cancel any in-progress parse so IDB transactions don't pile up
        const seq = (this._parseSeq = (this._parseSeq || 0) + 1);
        const cancelled = () => this._parseSeq !== seq;

        const tokens = str.trim().split(/\s+/);
        this._resultsEl.hidden = false;
        this._resultsEl.innerHTML = '<div class="route-search-empty">Parsing route...</div>';
        if (cancelled()) return;

        const wayTokens = tokens.map(t => this._isAirwayToken(t) ? null : t.toUpperCase());

        const doResolve = async () => {
            const results = await Promise.all(
                wayTokens.map(t => t ? this._resolveToken(t) : Promise.resolve(null))
            );
            const resolved = [], unresolved = [];
            for (let i = 0; i < tokens.length; i++) {
                if (wayTokens[i] === null) continue;
                if (results[i]) resolved.push(results[i]);
                else unresolved.push(tokens[i].toUpperCase());
            }
            return { resolved, unresolved };
        };

        let { resolved, unresolved } = await doResolve();
        if (cancelled()) return;

        if (resolved.length === 0 && unresolved.length > 0) {
            this._resultsEl.innerHTML = '<div class="route-search-empty">Retrying...</div>';
            await new Promise(r => setTimeout(r, 1500));
            if (cancelled()) return;
            ({ resolved, unresolved } = await doResolve());
            if (cancelled()) return;
        }

        const chips = resolved.map(wp =>
            `<span class="route-token-ok">${wp.icao}</span>`
        ).join('<span class="route-token-arrow">→</span>');

        const warnHtml = unresolved.length > 0
            ? `<div class="route-token-warn">Not found: ${unresolved.map(t => `<span class="route-token-bad">${t}</span>`).join(' ')}</div>`
            : '';

        this._resultsEl.innerHTML = `
            <div class="route-parse-preview">
                <div class="route-parse-chips">${chips || '<span class="route-search-empty">Nothing resolved</span>'}</div>
                ${warnHtml}
                ${resolved.length > 0 ? `<button class="btn btn-primary route-parse-apply">LOAD ${resolved.length} WAYPOINTS</button>` : ''}
            </div>
        `;

        const applyBtn = this._resultsEl.querySelector('.route-parse-apply');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                this._pushUndo();
                this._waypoints = resolved.map(wp => ({ ...wp, alt: wp.alt || 3500 }));
                this._reindex();
                this._onEdited();
                this._clearSearch();
            });
        }
    }

    async _doSearch(query) {
        if (!this._nasrDb) return;
        try {
            const results = await this._nasrDb.searchAll(query);
            this._renderSearchResults(results.airports || [], results.navaids || [], results.fixes || [], query);
        } catch (err) {
            console.warn('[RouteTable] Search error:', err);
        }
    }

    _renderSearchResults(airports, navaids, fixes, query = '') {
        const q = query.toUpperCase();
        const sit = this._lastSituation;
        const results = [];

        for (const a of airports) {
            const dist = sit?.lat ? NasrDB.haversineNm(sit.lat, sit.lon, a.lat, a.lon) : null;
            results.push({ type: 'APT', id: a.icao, name: a.name, lat: a.lat, lon: a.lon, dist });
        }
        for (const n of navaids) {
            const dist = sit?.lat ? NasrDB.haversineNm(sit.lat, sit.lon, n.lat, n.lon) : null;
            results.push({ type: n.type || 'NAV', id: n.id, name: n.name, lat: n.lat, lon: n.lon, dist });
        }
        for (const f of fixes) {
            const dist = sit?.lat ? NasrDB.haversineNm(sit.lat, sit.lon, f.lat, f.lon) : null;
            results.push({ type: 'FIX', id: f.id, name: '', lat: f.lat, lon: f.lon, dist });
        }

        // Sort: ID matches first (airports → navaids → fixes), then name matches
        const isIdMatch = r => r.id.startsWith(q) || r.id === 'K' + q || r.id.startsWith('K' + q);
        const typeRank = r => r.type === 'APT' ? 0 : r.type === 'FIX' ? 2 : 1;
        results.sort((a, b) => {
            const aId = isIdMatch(a) ? 0 : 1;
            const bId = isIdMatch(b) ? 0 : 1;
            if (aId !== bId) return aId - bId;
            const aExact = (a.id === q || a.id === 'K' + q) ? 0 : 1;
            const bExact = (b.id === q || b.id === 'K' + q) ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;
            const tDiff = typeRank(a) - typeRank(b);
            if (tDiff !== 0) return tDiff;
            if (a.dist != null && b.dist != null) return a.dist - b.dist;
            return 0;
        });

        const limited = results.slice(0, 15);
        this._resultsEl.hidden = limited.length === 0;
        this._resultsEl.innerHTML = limited.map(r => `
            <button class="route-search-result" data-lat="${r.lat}" data-lon="${r.lon}" data-id="${r.id}" data-name="${r.name || r.id}" data-type="${r.type}">
                <span class="result-type">${r.type}</span>
                <span class="result-id">${r.id}</span>
                <span class="result-name">${r.name || ''}</span>
                <span class="result-dist">${r.dist != null ? r.dist.toFixed(0) + 'nm' : ''}</span>
            </button>
        `).join('');

        this._resultsEl.querySelectorAll('.route-search-result').forEach(btn => {
            btn.addEventListener('click', () => {
                const wp = {
                    icao: btn.dataset.id,
                    name: btn.dataset.name || btn.dataset.id,
                    lat: parseFloat(btn.dataset.lat),
                    lon: parseFloat(btn.dataset.lon),
                    type: btn.dataset.type || undefined,
                };
                this.addWaypointSmart(wp);
                this._clearSearch();
            });
        });
    }

    _clearSearch() {
        if (this._searchInput) this._searchInput.value = '';
        if (this._resultsEl) {
            this._resultsEl.hidden = true;
            this._resultsEl.innerHTML = '';
        }
    }

    // ========== Segment Generation ==========

    /**
     * Build CLB/CRZ/DES segments for waypoints that don't already have them.
     * Uses departure/destination elevation, cruise altitude, and aircraft performance config.
     * This allows plans without pre-computed legs (e.g. saved from cockpit) to show multi-segment rows.
     */
    _buildMissingSegments() {
        const needsSegments = this._waypoints.some((wp, i) => i > 0 && (!wp._segments || wp._segments.length === 0));
        // Also run if the destination has segments but is missing a DES-to-field segment
        const dest = this._waypoints[this._waypoints.length - 1];
        const needsDestDescent = dest && dest.elev_ft != null && dest._segments?.length > 0 &&
            !dest._segments.some(s => s.phase === 'DES' && s.altTo != null && Math.abs(s.altTo - dest.elev_ft) < 100);
        if (!needsSegments && !needsDestDescent) return;

        const cruiseAlt = this._trip?.cruise_altitude
            || this._trip?.flight_plan?.altitude
            || this._trip?.flight_plan?.cruise_altitude
            || null;

        const cfgCruiseSpeed = CockpitConfig.aircraft('performance.cruise_speed_kt') ?? 120;
        const cfgGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const cfgCruiseRpm = CockpitConfig.aircraft('performance.cruise_rpm') ?? null;
        const cfgCruiseMp = CockpitConfig.aircraft('performance.cruise_mp') ?? null;
        const cfgCruisePwr = CockpitConfig.aircraft('performance.cruise_pwr_pct') ?? null;
        const climbRate = CockpitConfig.aircraft('performance.climb_fpm') ?? 500;
        const descentRate = CockpitConfig.aircraft('performance.descent_fpm') ?? 500;
        const climbSpeed = CockpitConfig.aircraft('performance.climb_speed_kt') ?? cfgCruiseSpeed * 0.85;
        const climbGph = CockpitConfig.aircraft('performance.climb_gph') ?? cfgGph * 1.3;
        const climbRpm = CockpitConfig.aircraft('performance.climb_rpm') ?? cfgCruiseRpm;
        const climbMp = CockpitConfig.aircraft('performance.climb_mp') ?? cfgCruiseMp;
        const climbPwr = CockpitConfig.aircraft('performance.climb_pwr_pct') ?? 100;
        const descentSpeed = CockpitConfig.aircraft('performance.descent_speed_kt') ?? cfgCruiseSpeed;
        const descentGph = CockpitConfig.aircraft('performance.descent_gph') ?? cfgGph * 0.6;
        const descentRpm = CockpitConfig.aircraft('performance.descent_rpm') ?? cfgCruiseRpm;
        const descentMp = CockpitConfig.aircraft('performance.descent_mp') ?? cfgCruiseMp;
        const descentPwr = CockpitConfig.aircraft('performance.descent_pwr_pct') ?? 50;

        // Use departure waypoint's alt or elev_ft as starting altitude
        let prevAlt = this._waypoints[0]?.elev_ft ?? this._waypoints[0]?.alt ?? 0;

        for (let i = 1; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            const isLast = i === this._waypoints.length - 1;
            if (wp._segments && wp._segments.length > 0) {
                // Already has segments from plan data.
                // For the destination, check if a DES-to-field elevation segment is missing
                // and append one if needed (e.g. plans from flywhere.app don't include this).
                if (isLast && wp.elev_ft != null) {
                    const hasDesToField = wp._segments.some(
                        s => s.phase === 'DES' && s.altTo != null && Math.abs(s.altTo - wp.elev_ft) < 100
                    );
                    if (!hasDesToField) {
                        const lastSeg = wp._segments[wp._segments.length - 1];
                        const topAlt = lastSeg.altTo ?? lastSeg.altFrom;
                        if (topAlt != null && topAlt > wp.elev_ft + 50) {
                            const drop = topAlt - wp.elev_ft;
                            const dMin = drop / descentRate;
                            const dDist = (descentSpeed / 60) * dMin;
                            const dFuel = (descentGph / 60) * dMin;
                            wp._segments.push({
                                phase: 'DES',
                                altFrom: topAlt,
                                altTo: wp.elev_ft,
                                dist: parseFloat(dDist.toFixed(1)),
                                tas: Math.round(descentSpeed), gs: Math.round(descentSpeed),
                                ete_min: parseFloat(dMin.toFixed(2)),
                                gph: parseFloat(descentGph.toFixed(1)),
                                fuel: parseFloat(dFuel.toFixed(2)),
                                fuelRemaining: 0,
                                percent_power: descentPwr, rpm: descentRpm, mp: descentMp,
                            });
                        }
                    }
                }
                prevAlt = wp._segments[wp._segments.length - 1].altTo ?? prevAlt;
                continue;
            }

            const legDist = wp._legDist || 0;
            // Intermediate airports use field elevation (e.g. destination with a
            // missed-approach fix after it). Last waypoint uses cruise altitude
            // with field-elevation descent handled below. Others use wp.alt/cruiseAlt.
            const isIntermediateApt = !isLast && wp.type === 'APT' && wp.elev_ft != null;
            const wpAlt = isLast
                ? (wp.alt || cruiseAlt || wp.elev_ft || prevAlt)
                : (isIntermediateApt
                    ? wp.elev_ft
                    : (wp.alt || cruiseAlt || prevAlt));
            const segments = [];
            let remainingDist = legDist;

            // Altitude difference between previous waypoint and this one
            const altDiff = wpAlt - prevAlt;

            // Climb segment: if we need to go up
            if (altDiff > 0) {
                const climbTimeMin = altDiff / climbRate;
                const climbDist = Math.min((climbSpeed / 60) * climbTimeMin, remainingDist);
                const actualTime = climbDist > 0 ? climbTimeMin * (climbDist / ((climbSpeed / 60) * climbTimeMin)) : 0;
                const cFuel = (climbGph / 60) * actualTime;
                segments.push({
                    phase: 'CLB', altFrom: prevAlt, altTo: wpAlt,
                    dist: parseFloat(climbDist.toFixed(1)),
                    tas: Math.round(climbSpeed), gs: Math.round(climbSpeed),
                    ete_min: actualTime, gph: parseFloat(climbGph.toFixed(1)),
                    fuel: parseFloat(cFuel.toFixed(1)),
                    fuelRemaining: 0,
                    percent_power: climbPwr, rpm: climbRpm, mp: climbMp,
                });
                remainingDist -= climbDist;
            }

            // Descent segment: if we need to go down
            let deferredDescent = null;
            if (altDiff < 0) {
                const drop = Math.abs(altDiff);
                const dMin = drop / descentRate;
                const dDist = Math.min((descentSpeed / 60) * dMin, remainingDist);
                const actualTime = dDist > 0 ? dMin * (dDist / ((descentSpeed / 60) * dMin)) : 0;
                const dFuel = (descentGph / 60) * actualTime;
                const desSeg = {
                    phase: 'DES',
                    altFrom: prevAlt,
                    altTo: wpAlt,
                    dist: parseFloat(dDist.toFixed(1)),
                    tas: Math.round(descentSpeed), gs: Math.round(descentSpeed),
                    ete_min: actualTime, gph: parseFloat(descentGph.toFixed(1)),
                    fuel: parseFloat(dFuel.toFixed(1)),
                    fuelRemaining: 0,
                    percent_power: descentPwr, rpm: descentRpm, mp: descentMp,
                };
                if (isLast) {
                    deferredDescent = desSeg;
                } else {
                    segments.push(desSeg);
                }
                remainingDist -= dDist;
            }

            // Last leg: always descend from cruise to field elevation
            if (isLast && wp.elev_ft != null && wpAlt > wp.elev_ft) {
                const drop = wpAlt - wp.elev_ft;
                const dMin = drop / descentRate;
                const dDist = Math.min((descentSpeed / 60) * dMin, remainingDist);
                const actualTime = dDist > 0 ? dMin * (dDist / ((descentSpeed / 60) * dMin)) : 0;
                const dFuel = (descentGph / 60) * actualTime;
                deferredDescent = {
                    phase: 'DES',
                    altFrom: wpAlt,
                    altTo: wp.elev_ft,
                    dist: parseFloat(dDist.toFixed(1)),
                    tas: Math.round(descentSpeed), gs: Math.round(descentSpeed),
                    ete_min: actualTime, gph: parseFloat(descentGph.toFixed(1)),
                    fuel: parseFloat(dFuel.toFixed(1)),
                    fuelRemaining: 0,
                    percent_power: descentPwr, rpm: descentRpm, mp: descentMp,
                };
                remainingDist -= dDist;
            }

            // Cruise segment (whatever distance remains)
            if (remainingDist > 0) {
                const crzAlt = deferredDescent ? Math.max(prevAlt, wpAlt) : wpAlt;
                const cruiseTime = cfgCruiseSpeed > 0 ? (remainingDist / cfgCruiseSpeed) * 60 : 0;
                const cFuel = (cfgGph / 60) * cruiseTime;
                segments.push({
                    phase: 'CRZ', altFrom: crzAlt, altTo: crzAlt,
                    dist: parseFloat(remainingDist.toFixed(1)),
                    tas: Math.round(cfgCruiseSpeed), gs: Math.round(cfgCruiseSpeed),
                    ete_min: cruiseTime, gph: parseFloat(cfgGph.toFixed(1)),
                    fuel: parseFloat(cFuel.toFixed(1)),
                    fuelRemaining: 0,
                    rpm: cfgCruiseRpm, mp: cfgCruiseMp, percent_power: cfgCruisePwr,
                });
            }

            // Append deferred descent after cruise
            if (deferredDescent) {
                segments.push(deferredDescent);
            }

            if (segments.length > 0) {
                wp._segments = segments;
            }

            prevAlt = wpAlt;
        }
    }

    // ========== Trip / Flight Structure ==========

    /**
     * Build trip.flights[] by splitting this._waypoints at fuel stop airports.
     * Each Flight spans from one APT to the next (inclusive). Fuel stops are
     * shared: they appear as the destination of one Flight and the departure of
     * the next. Annotates each waypoint with _flightIndex.
     *
     * @returns {Array<{index, dep, dest, depWpIndex, destWpIndex}>}
     */
    _buildFlights() {
        const wps = this._waypoints;
        if (wps.length <= 1) return [];

        const flights = [];
        let depIdx = 0;

        for (let i = 1; i < wps.length; i++) {
            // Close a flight when we hit a fuel stop or the final destination
            if (isFuelStop(wps[i], i, wps) || i === wps.length - 1) {
                flights.push({
                    index:       flights.length,
                    dep:         wps[depIdx].icao || wps[depIdx].name || '?',
                    dest:        wps[i].icao      || wps[i].name      || '?',
                    depWpIndex:  depIdx,
                    destWpIndex: i,
                    // Per-flight computed totals filled by _computeEnroute()
                    _totDist: 0,
                    _totEte:  0,
                    _totFuel: 0,
                });
                // Next flight departs from this fuel stop (shared boundary)
                depIdx = i;
            }
        }

        // Annotate waypoints with their flight index.
        // A fuel stop waypoint is the shared boundary between two flights — it is the
        // destination of Flight N and the departure of Flight N+1. We assign it the
        // departing flight's index (N+1) so the overlay can use _flightIndex as
        // nextFlight and derive prevFlight via flights[_flightIndex - 1].
        for (const flight of flights) {
            for (let j = flight.depWpIndex; j <= flight.destWpIndex; j++) {
                wps[j]._flightIndex = flight.index; // last (later) flight wins at shared boundary
            }
        }

        return flights;
    }

    // ========== Enroute Computation ==========

    /**
     * Compute enroute data for all waypoints: dist, ETE, fuel remaining.
     * Uses per-segment data (CLB/CRZ/DES) when available from flight plan.
     */
    /** Calculate manifold pressure from power%, RPM, and max RPM */
    _mpFromPower(pwr, rpm, maxRpm) {
        if (pwr == null || rpm == null || maxRpm == null) return null;
        return Math.round(((pwr / 100) * 29.92 * (maxRpm / rpm)) * 10) / 10;
    }

    _computeEnroute(gs) {
        if (this._activeIndex < 0 || this._waypoints.length === 0) return;
        // Build trip.flights[] — splits waypoints at fuel stop airports.
        // Must run before the computation loop so we know fuel-reset boundaries.
        this._flights = this._buildFlights();

        // Set of waypoint indices where a new Flight begins (fuel stop departures).
        // The fuel counter resets and tanks are considered full at each of these.
        const fuelResetIndices = new Set(
            this._flights.slice(1).map(f => f.depWpIndex)
        );

        const cfgCruiseSpeed = CockpitConfig.aircraft('performance.cruise_speed_kt') ?? 120;
        const cfgGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const fuelCap = CockpitConfig.aircraft('performance.fuel_capacity_gal') ?? 50;

        // Determine which Flight contains the active waypoint so we can set the
        // right starting fuel (actual FuelState for flight 0, full tanks for later flights).
        const activeFlightNum = this._waypoints[this._activeIndex]?._flightIndex ?? 0;
        // Starting fuel for the active flight.
        // For Flight 0: read from FuelState (actual fuel on board).
        // For Flight N>0: computed after the main loop using per-flight totals,
        //   then applied via fuelResetIndices during a second pass if needed.
        // On first entry we don't have _totFuel yet, so start with FuelState/capacity
        // and let the fuelResetIndices path correct it mid-loop at each fuel stop.
        // `let` — reassigned at each fuel stop boundary during the computation loop below
        let startFuel = (activeFlightNum === 0)
            ? ((typeof FuelState !== 'undefined') ? FuelState.getStartFuel().gallons : fuelCap)
            : (this._flights[activeFlightNum]?._plannedStartFuel ?? fuelCap);
        const cfgCruiseRpm = CockpitConfig.aircraft('performance.cruise_rpm') ?? null;
        const cfgCruiseMp = CockpitConfig.aircraft('performance.cruise_mp') ?? null;
        const cfgCruisePwr = CockpitConfig.aircraft('performance.cruise_pwr_pct') ?? null;
        const maxHp = CockpitConfig.aircraft('performance.max_hp') ?? 180;
        const maxRpm = CockpitConfig.aircraft('performance.max_rpm') ?? 2700;
        const lopSfc = CockpitConfig.aircraft('performance.lop_sfc') ?? 0.067;

        // Phase-specific config — hoisted out of the per-segment inner loop so
        // these are read once per _computeEnroute call, not once per segment.
        const cfgClbSpeed = CockpitConfig.aircraft('performance.climb_speed_kt') ?? cfgCruiseSpeed * 0.85;
        const cfgClbGph   = CockpitConfig.aircraft('performance.climb_gph') ?? cfgGph * 1.3;
        const cfgClbPwr   = CockpitConfig.aircraft('performance.climb_pwr_pct') ?? 100;
        const cfgClbRpm   = CockpitConfig.aircraft('performance.climb_rpm') ?? cfgCruiseRpm;
        const cfgClbMp    = CockpitConfig.aircraft('performance.climb_mp') ?? cfgCruiseMp;
        const cfgDesSpeed = CockpitConfig.aircraft('performance.descent_speed_kt') ?? cfgCruiseSpeed;
        const cfgDesGph   = CockpitConfig.aircraft('performance.descent_gph') ?? cfgGph * 0.6;
        const cfgDesPwr   = CockpitConfig.aircraft('performance.descent_pwr_pct') ?? 50;
        const cfgDesRpm   = CockpitConfig.aircraft('performance.descent_rpm') ?? cfgCruiseRpm;
        const cfgDesMp    = CockpitConfig.aircraft('performance.descent_mp') ?? cfgCruiseMp;

        // Cruise power override from user selection
        const cruisePwrOverride = this._cruisePower;

        let cumulativeDistRemaining = 0;

        // First pass: sum total remaining distance from active waypoint
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (i === this._activeIndex) {
                cumulativeDistRemaining += (wp._liveDist != null && wp._liveDist > 0)
                    ? wp._liveDist : (wp._legDist || 0);
            } else {
                cumulativeDistRemaining += wp._legDist || 0;
            }
        }

        // Second pass: compute per-waypoint values
        let fuelBurned = 0;
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            const segs = wp._segments || [];

            let legDist;
            if (i === this._activeIndex) {
                // Use live distance when GPS is active (ground speed > 0 and liveDist set).
                // On the ground / pre-departure, fall back to _legDist so DIST column
                // shows the planned leg distance rather than blank.
                legDist = (wp._liveDist != null && wp._liveDist > 0)
                    ? wp._liveDist
                    : (wp._legDist || 0);
            } else {
                legDist = wp._legDist || 0;
            }

            // Bearing (true, geometric) and wind-corrected magnetic heading
            if (i > this._activeIndex && i > 0) {
                const prev = this._waypoints[i - 1];
                if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                    wp._brg = FlyTabPlanning.bearing(prev.lat, prev.lon, wp.lat, wp.lon);
                }
            } else if (i === this._activeIndex) {
                // Live bearing from GPS when airborne; fall back to planned bearing on ground
                if (wp._liveHdg != null) {
                    wp._brg = wp._liveHdg;
                } else if (i > 0) {
                    const prev = this._waypoints[i - 1];
                    if (prev.lat != null && prev.lon != null && wp.lat != null && wp.lon != null) {
                        wp._brg = FlyTabPlanning.bearing(prev.lat, prev.lon, wp.lat, wp.lon);
                    }
                }
            }

            wp._wind = wp.wind || null;

            // Compute wind-corrected magnetic heading from bearing + wind + TAS
            wp._hdg = (wp._brg != null && wp.lat != null && wp.lon != null)
                ? FlyTabPlanning.windCorrectedMagHdg(wp._brg, wp.lat, wp.lon, wp._tas ?? 0, wp._wind?.dir ?? 0, wp._wind?.spd ?? 0)
                : null;

            // Multi-flight: reset fuel counter when a new Flight departs from a fuel stop.
            // This waypoint is the departure of the next Flight — pilot refuelled here.
            if (fuelResetIndices.has(i) && i > this._activeIndex) {
                const fuelRemAtStop = startFuel - fuelBurned;
                const fuelAdded = wp.fuel_add_gal != null
                    ? Math.min(wp.fuel_add_gal, fuelCap - fuelRemAtStop)  // explicit: add only what was pumped
                    : (fuelCap - fuelRemAtStop);                           // default: fill to capacity
                wp._fuelAdded = fuelAdded;   // stash for "Fuel added" row in _renderTable
                fuelBurned = 0;
                startFuel  = fuelRemAtStop + fuelAdded;
            }

            // If we have segment data, use it for phase, fuel, and time
            if (segs.length > 0 && i > 0) {
                // Determine dominant phase: CLB > DES > CRZ
                const hasClb = segs.some(s => s.phase === 'CLB');
                const hasDes = segs.some(s => s.phase === 'DES');
                wp._phase = hasClb ? 'CLB' : hasDes ? 'DES' : 'CRZ';

                // Sum fuel and time from all segments, writing computed values back
                let segFuel = 0;
                let segTime = 0;
                let segFuelBurnedSoFar = fuelBurned; // track running total within this leg
                for (const seg of segs) {
                    // Use phase-appropriate config fallbacks (all values hoisted above the loop)
                    const isClb = seg.phase === 'CLB';
                    const isDes = seg.phase === 'DES';
                    const phaseFallbackSpeed = isClb ? cfgClbSpeed : isDes ? cfgDesSpeed : cfgCruiseSpeed;
                    const phaseFallbackGph   = isClb ? cfgClbGph   : isDes ? cfgDesGph   : cfgGph;
                    const phaseFallbackPwr   = isClb ? cfgClbPwr   : isDes ? cfgDesPwr   : cfgCruisePwr;
                    const phaseFallbackRpm   = isClb ? cfgClbRpm   : isDes ? cfgDesRpm   : cfgCruiseRpm;
                    const phaseFallbackMp    = isClb ? cfgClbMp    : isDes ? cfgDesMp    : cfgCruiseMp;

                    let segGph = seg.gph || phaseFallbackGph;
                    let segEte = seg.ete_min || 0;
                    let segTas = seg.tas || phaseFallbackSpeed;
                    let segGs = seg.gs || phaseFallbackSpeed;
                    let segPwr = seg.percent_power || phaseFallbackPwr;
                    let segRpm = seg.rpm || phaseFallbackRpm;
                    let segMp = seg.mp || phaseFallbackMp;

                    // Apply cruise power override to CRZ segments
                    if (seg.phase === 'CRZ' && cruisePwrOverride) {
                        segGph = (cruisePwrOverride / 100) * maxHp * lopSfc;
                        const origPwr = seg.percent_power || cfgCruisePwr || 65;
                        const tasRatio = Math.sqrt(cruisePwrOverride / origPwr);
                        segTas = (seg.tas || cfgCruiseSpeed) * tasRatio;
                        segGs = segTas + ((seg.gs || 0) - (seg.tas || cfgCruiseSpeed));
                        segPwr = cruisePwrOverride;
                        segRpm = cfgCruiseRpm;
                        segMp = this._mpFromPower(cruisePwrOverride, cfgCruiseRpm, maxRpm) || cfgCruiseMp;
                        if (segGs > 0 && seg.dist > 0) {
                            segEte = (seg.dist / segGs) * 60;
                        }
                    }

                    const thisSegFuel = (segGph / 60) * segEte;
                    segFuel += thisSegFuel;
                    segTime += segEte;

                    // Write computed values back to segment for _getCellValue
                    seg._fuel = thisSegFuel;
                    seg._ete = segEte;
                    seg._tas = Math.round(segTas);
                    seg._gs = Math.round(segGs);
                    seg._pwr = segPwr;
                    seg._rpm = segRpm;
                    seg._mp = segMp;
                    seg._fuelRem = startFuel - (segFuelBurnedSoFar + thisSegFuel);
                    segFuelBurnedSoFar += thisSegFuel;
                }

                fuelBurned += segFuel;

                // Display values: show the dominant segment's engine data
                const displaySeg = segs.find(s => s.phase === wp._phase)
                                || segs[segs.length - 1];

                if (wp._phase === 'CRZ' && cruisePwrOverride) {
                    wp._pwr = cruisePwrOverride;
                    wp._rpm = cfgCruiseRpm;
                    wp._mp = this._mpFromPower(cruisePwrOverride, cfgCruiseRpm, maxRpm) || cfgCruiseMp;
                    const overrideGph = (cruisePwrOverride / 100) * maxHp * lopSfc;
                    const origPwr = displaySeg.percent_power || cfgCruisePwr || 65;
                    const tasRatio = Math.sqrt(cruisePwrOverride / origPwr);
                    wp._tas = Math.round((displaySeg.tas || cfgCruiseSpeed) * tasRatio);
                    wp._gs = (wp.active && gs > 30) ? gs : Math.round(wp._tas + ((displaySeg.gs || 0) - (displaySeg.tas || cfgCruiseSpeed)));
                } else {
                    wp._pwr = displaySeg.percent_power || wp.percent_power || cfgCruisePwr;
                    wp._rpm = displaySeg.rpm || wp.rpm || cfgCruiseRpm;
                    wp._mp = displaySeg.mp || wp.mp || cfgCruiseMp;
                    wp._tas = displaySeg.tas || wp.tas || cfgCruiseSpeed;
                    wp._gs = (wp.active && gs > 30) ? gs : (displaySeg.gs || wp.gs || cfgCruiseSpeed);
                }

                wp._dist = Math.round(legDist);
                // For the active leg, override segment-plan ETE with live time (liveDist / actual GS).
                // Segment ETE is the original planned duration for the full leg — it doesn't shrink
                // as the aircraft approaches the waypoint, making the total ETE appear frozen.
                if (i === this._activeIndex && gs > 30 && wp._liveDist != null) {
                    wp._ete = (wp._liveDist / gs) * 60;
                } else {
                    wp._ete = segTime;
                }
                wp._fuel = segFuel;
                wp._fuelRem = startFuel - fuelBurned;
            } else if (i === 0) {
                // Departure waypoint: no leg data to compute — show starting fuel only
                wp._phase = null;
                wp._dist = null;
                wp._ete = null;
                wp._fuel = null;
                wp._fuelRem = startFuel;
                wp._tas = null;
                wp._gs = null;
                wp._rpm = null;
                wp._mp = null;
                wp._pwr = null;
            } else {
                // No segments (manually added intermediate or destination): fallback logic
                if (i === this._waypoints.length - 1) {
                    wp._phase = 'ARR';
                } else {
                    wp._phase = 'CRZ';
                }

                const fallbackGph = cruisePwrOverride
                    ? (cruisePwrOverride / 100) * maxHp * lopSfc
                    : cfgGph;
                const fallbackSpeed = gs > 30 ? gs : cfgCruiseSpeed;

                wp._tas = wp.tas || cfgCruiseSpeed;
                wp._gs = (wp.active && gs > 30) ? gs : (wp.gs || fallbackSpeed);
                wp._rpm = wp.rpm || cfgCruiseRpm;
                wp._mp = cruisePwrOverride
                    ? (this._mpFromPower(cruisePwrOverride, wp.rpm || cfgCruiseRpm, maxRpm) || cfgCruiseMp)
                    : (wp.mp || cfgCruiseMp);
                wp._pwr = cruisePwrOverride || wp.percent_power || cfgCruisePwr;

                const legSpeed = wp._gs > 0 ? wp._gs : fallbackSpeed;
                const legTimeHrs = legSpeed > 0 ? legDist / legSpeed : 0;
                const legFuel = legTimeHrs * fallbackGph;
                fuelBurned += legFuel;

                wp._dist = Math.round(legDist);
                wp._ete = legTimeHrs * 60;
                wp._fuel = legFuel;
                wp._fuelRem = startFuel - fuelBurned;
            }

            wp._distRemaining = Math.round(cumulativeDistRemaining);
            cumulativeDistRemaining -= legDist;
        }

        // Mark passed waypoints
        for (let i = 0; i < this._activeIndex; i++) {
            this._waypoints[i]._dist = null;
            this._waypoints[i]._ete = null;
            this._waypoints[i]._fuel = null;
            this._waypoints[i]._fuelRem = null;
            this._waypoints[i]._brg = null;
            this._waypoints[i]._hdg = null;
            this._waypoints[i]._phase = '\u2014';
        }

        // Compute cumulative dist/ete from the aircraft's current position forward.
        // Each row shows total remaining distance/time to reach that waypoint, so all
        // rows shrink as the aircraft moves — not just the active leg.
        // Totals footer continues to sum per-leg _dist/_ete (unchanged).
        let cumDist = 0, cumEte = 0;
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            cumDist += wp._dist || 0;
            cumEte  += wp._ete  || 0;
            // Use i > _activeIndex check rather than cumDist > 0 so the first
            // non-departure leg shows its distance even when the active waypoint
            // is at index 0 (pre-departure, cumDist accumulates from the first leg).
            wp._cumDist = (i > this._activeIndex || cumDist > 0) ? Math.round(cumDist) : null;
            wp._cumEte  = (i > this._activeIndex || cumEte  > 0) ? cumEte : null;
        }

        // Compute per-Flight totals for the multi-flight footer rows.
        // Each Flight sums its Legs (waypoints depWpIndex+1 … destWpIndex).
        for (const flight of this._flights) {
            let flightDist = 0, flightEte = 0, flightFuel = 0;
            for (let j = flight.depWpIndex + 1; j <= flight.destWpIndex; j++) {
                const wp = this._waypoints[j];
                flightDist += wp._dist || 0;
                flightEte  += wp._ete  || 0;
                flightFuel += wp._fuel || 0;
            }
            flight._totDist = Math.round(flightDist);
            flight._totEte  = flightEte;
            flight._totFuel = flightFuel;
        }

        // Back-fill _plannedStartFuel for Flight N+1 now that _totFuel is known.
        // Used by the next _computeEnroute call so Flight 2+ show correct pre-stop fuel numbers.
        const depFuel0 = (typeof FuelState !== 'undefined') ? FuelState.getStartFuel().gallons : fuelCap;
        let rollingFuel = depFuel0;
        for (let fi = 0; fi < this._flights.length; fi++) {
            this._flights[fi]._plannedStartFuel = rollingFuel;
            if (fi + 1 < this._flights.length) {
                const stopWp  = this._waypoints[this._flights[fi + 1].depWpIndex];
                const fuelRem = Math.max(0, rollingFuel - (this._flights[fi]._totFuel || 0));
                const added   = stopWp?.fuel_add_gal != null
                    ? Math.min(stopWp.fuel_add_gal, fuelCap - fuelRem)
                    : (fuelCap - fuelRem);
                rollingFuel = fuelRem + added;
            }
        }

        // Emit leg update event so InstrumentStrip and PowerTradeoff can update
        // without polling. Fires after every _computeEnroute() — ~1Hz in flight.
        this._emitLegUpdate();
    }

    /**
     * Publish activeroute:legupdate with nav data for the route nav strip,
     * instrument strip, and power tradeoff panel.
     */
    _emitLegUpdate() {
        const active = this._activeIndex >= 0 ? this._waypoints[this._activeIndex] : null;
        if (!active) return;

        // Destination waypoint for current flight
        const activeFlight = this._flights?.find(f =>
            this._activeIndex >= f.depWpIndex && this._activeIndex <= f.destWpIndex
        );
        const destIdx = activeFlight?.destWpIndex ?? (this._waypoints.length - 1);
        const destWp  = this._waypoints[destIdx];
        if (!destWp) return;

        // Next waypoint after active (for preview row)
        const nextIdx = this._activeIndex + 1;
        const nextWp = nextIdx < this._waypoints.length ? this._waypoints[nextIdx] : null;

        // Planned GPH for remaining cruise (from config)
        const plannedGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;

        // Live fuel remaining
        const engData = window.enginePanel?.lastData;
        const fuelRem = engData?.fuel_remaining_gal ?? engData?.fuel_gal ?? engData?.Gallons_Rem ?? engData?.Fuel_Remaining ?? null;
        const liveGph = (engData?.fuel_flow_gph ?? engData?.gph ?? engData?.Fuel_Flow ?? null);

        // Cross-track error: perpendicular distance from current position to the
        // planned track line (previous waypoint → active waypoint).
        let xtk = null; // nm, positive = right of track, negative = left
        const sit = this._lastSituation;
        if (sit?.lat != null && sit?.lon != null && active.lat != null && active.lon != null) {
            const prevIdx = this._activeIndex > 0 ? this._activeIndex - 1 : 0;
            const prevWp = this._waypoints[prevIdx];
            if (prevWp?.lat != null && prevWp?.lon != null && prevIdx !== this._activeIndex) {
                xtk = FlyTabPlanning.crossTrackDistanceNm(prevWp.lat, prevWp.lon, active.lat, active.lon, sit.lat, sit.lon);
            }
        }

        // Active waypoint crossing altitude
        const activeAlt = this._getCrossingAlt(active);

        // Build upcoming waypoints array for expanded nav strip view
        const upcoming = [];
        for (let i = this._activeIndex + 1; i < this._waypoints.length && upcoming.length < 5; i++) {
            const wp = this._waypoints[i];
            upcoming.push({
                icao: wp.icao || wp.id || '',
                name: wp.name || '',
                dist: wp._cumDist,
                ete:  wp._cumEte,
                alt:  this._getCrossingAlt(wp),
                fuelRem: wp._fuelRem,
            });
        }

        window.dispatchEvent(new CustomEvent('activeroute:legupdate', {
            detail: {
                // Active waypoint
                activeIcao:     active.icao || active.id || '',
                activeName:     active.name || '',
                activeDistNm:   active._liveDist ?? active._legDist ?? null,
                activeEteMin:   active._ete ?? null,
                activeAlt,
                hdg:            active._hdg,          // wind-corrected mag heading
                brg:            active._brg,          // true bearing to active
                activeWind:     active._wind,          // { dir, spd } wind at active leg
                activeTas:      active._tas,           // planned TAS for active leg
                xtk,                                   // cross-track error (nm, +R/-L)

                // Next waypoint preview
                nextIcao:       nextWp?.icao || nextWp?.id || null,
                nextDistNm:     nextWp?._cumDist ?? null,

                // Destination
                destIcao:       destWp.icao || destWp.id || '',
                destDistNm:     destWp._cumDist,       // nm remaining to dest
                destEteMin:     destWp._cumEte,        // planned ETE to dest (minutes)
                destFuelRem:    destWp._fuelRem,       // planned fuel remaining at dest

                // ETA fields (from plan legs via recomputeLegs)
                eta:         active._eta ?? null,       // ETA at active waypoint (UTC ms)
                destEta:     destWp._eta ?? null,       // ETA at destination (UTC ms)
                legAltFt:    active._planAltFt ?? active.alt ?? null,  // cruise altitude for active leg

                // Fuel
                plannedGph,
                fuelRemaining:  fuelRem,
                liveGph,

                // Live performance
                liveGs: sit?.ground_speed ?? null,
                livePctPower: engData?.percent_power ?? engData?.pwr ?? null,

                // Upcoming waypoints for expanded view
                upcoming,
            }
        }));
    }

    /**
     * Get crossing altitude for a waypoint from its segments or constraint.
     */
    _getCrossingAlt(wp) {
        const segs = wp.segments || [];
        if (segs.length > 0) {
            const last = segs[segs.length - 1];
            return last.alt_to ?? last.alt_from ?? wp.alt ?? null;
        }
        return wp.alt ?? wp.constraint_alt ?? null;
    }

    /** Toggle flight rules between VFR and IFR */
    _toggleFlightRules() {
        this._flightRules = this._flightRules === 'IFR' ? 'VFR' : 'IFR';
        Settings.set('flight_rules', this._flightRules);
        this._renderTable();
    }

    /**
     * Set cruise power override. Recalculates all CRZ segment fuel/time.
     * @param {number|null} pct - Power percentage (55, 65, 75, etc.) or null to clear
     */
    _setCruisePower(pct) {
        this._cruisePower = pct;
        try {
            if (pct != null) {
                localStorage.setItem('flypi_cruise_power', String(pct));
            } else {
                localStorage.removeItem('flypi_cruise_power');
            }
        } catch {}
        this._computeEnroute();
        this._updateSummary();
        this._renderTable();
    }

    /** Cycle through cruise power presets (tap %PWR header) */
    _cycleCruisePower() {
        const presets = this._powerPresets;
        if (this._cruisePower == null) {
            // First tap: use first preset
            this._setCruisePower(presets[0]);
        } else {
            const idx = presets.indexOf(this._cruisePower);
            if (idx >= 0 && idx < presets.length - 1) {
                this._setCruisePower(presets[idx + 1]);
            } else {
                // Past last preset: clear override (back to plan values)
                this._setCruisePower(null);
            }
        }
    }

    /** Open/close the route table body. Called externally by app.js (left rail ≡ button). */
    toggle() {
        const h = this._bodyEl?.offsetHeight ?? 0;
        if (h > 0) {
            this._closeBody();
        } else {
            const saved = parseInt(localStorage.getItem('flypi_route_table_height'), 10) || 120;
            if (this._bodyEl) {
                this._bodyEl.style.height = saved + 'px';
                this._broadcastHeight();
                this._updateOpenHint(saved);
            }
            this._map?.invalidateSize();
            this._autoPanOwnship();
        }
    }

    setCompact(compact) {
        if (compact) {
            this._preCompactHeight = this._bodyEl?.offsetHeight || 0;
        } else {
            const restoreH = this._preCompactHeight ??
                (parseInt(localStorage.getItem('flypi_route_table_height'), 10) || 0);
            this._preCompactHeight = null;
            if (this._bodyEl) {
                this._bodyEl.style.height = restoreH + 'px';
                this._updateOpenHint(restoreH);
            }
        }
        setTimeout(() => {
            this._map?.invalidateSize();
            this._broadcastHeight();
        }, 0);
    }

    _broadcastHeight() {
        const h = this._el ? this._el.offsetHeight : 0;
        document.documentElement.style.setProperty('--route-table-height', h + 'px');
    }

    _closeBody() {
        if (!this._bodyEl) return;
        this._bodyEl.style.height = '0px';
        this._broadcastHeight();
        this._updateOpenHint(0);
        this._map?.invalidateSize();
    }

    _updateOpenHint(heightPx) {
        if (!this._openHintEl) return;
        this._openHintEl.hidden = heightPx > 0;
    }

    _autoPanOwnship() {
        if (!this._lastGpsPosition || !this._map) return;
        const mapHeight = this._map.getSize().y;
        const tableH   = this._el?.offsetHeight || 0;
        const pt = this._map.latLngToContainerPoint([
            this._lastGpsPosition.lat, this._lastGpsPosition.lng
        ]);
        if (pt.y > mapHeight * 0.66) {
            this._map.panBy([0, -(tableH / 2)], { animate: true, duration: 0.3 });
        }
    }

    _initDragHandlers() {
        let dragStartY  = 0;
        let dragStartH  = 0;
        let dragStartT  = 0;
        let lastClientY = 0;

        this._handleEl.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            if (e.target.closest('button')) return;   // let button taps through without drag
            dragStartY  = e.touches[0].clientY;
            dragStartH  = this._bodyEl?.offsetHeight || 0;
            dragStartT  = Date.now();
            lastClientY = dragStartY;
        }, { passive: true });

        this._handleEl.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            const clientY = e.touches[0].clientY;
            lastClientY   = clientY;

            const dy      = dragStartY - clientY;
            const isPortrait = window.innerWidth <= window.innerHeight;
            const maxH = isPortrait
                ? Math.min(window.innerHeight * 0.40, window.innerHeight - 200)
                : Math.min(window.innerHeight * 0.65, window.innerHeight - 200);
            const newH = Math.max(0, Math.min(maxH, dragStartH + dy));

            this._bodyEl.style.height = newH + 'px';
            this._broadcastHeight();
            this._updateOpenHint(newH);
        }, { passive: false });

        this._handleEl.addEventListener('touchend', (e) => {
            const elapsed = Math.max(1, Date.now() - dragStartT);
            const totalDy = dragStartY - (e.changedTouches[0]?.clientY ?? lastClientY);
            const velocity = (totalDy / elapsed) * 1000;

            if (velocity < -300) {
                this._closeBody();
                return;
            }

            const h = this._bodyEl?.offsetHeight || 0;
            if (h === 0) {
                this._closeBody();
                return;
            }

            localStorage.setItem('flypi_route_table_height', String(h));
            this._map?.invalidateSize();
            this._broadcastHeight();
            this._autoPanOwnship();
        }, { passive: true });
    }

    // ========== Save Route ==========

    async _saveRoute() {
        if (!this._waypoints || this._waypoints.length < 2) {
            if (typeof app !== 'undefined' && app.showToast) {
                app.showToast('Need at least 2 waypoints to save a route');
            }
            return;
        }

        const dep = this._waypoints[0]?.icao || '?';
        const dest = this._waypoints[this._waypoints.length - 1]?.icao || '?';
        const defaultName = `${dep}-${dest}`;

        // Build a simple name prompt overlay
        const overlay = document.createElement('div');
        overlay.className = 'plan-picker-overlay';
        overlay.innerHTML = `
            <div class="plan-picker" style="max-width:320px">
                <div class="plan-picker-header">
                    <span>Save Route</span>
                    <button class="plan-picker-close">\u2715</button>
                </div>
                <div style="padding:16px">
                    <label style="font-size:16px;color:var(--text-secondary)">Route name</label>
                    <input type="text" class="input rt-save-name" value="${defaultName}"
                        style="width:100%;margin:8px 0;padding:8px;background:var(--bg-surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;font-size:16px"
                        autocomplete="off" autocorrect="off" spellcheck="false">
                    <button class="rt-save-confirm" style="width:100%;padding:10px;margin-top:8px;background:#0088ff;color:#fff;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:16px">SAVE</button>
                </div>
            </div>`;

        const openedAt = Date.now();
        overlay.querySelector('.plan-picker-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (Date.now() - openedAt < 500) return; // ignore synthetic click from opening tap
            if (e.target === overlay) overlay.remove();
        });

        const nameInput = overlay.querySelector('.rt-save-name');
        const confirmBtn = overlay.querySelector('.rt-save-confirm');

        const doSave = async () => {
            const name = nameInput.value.trim() || defaultName;
            // Build plan object from current waypoints
            const plan = {
                name,
                flight_plan: { departure: dep, destination: dest },
                waypoints: this._waypoints.map(w => ({
                    icao: w.icao, name: w.name, lat: w.lat, lon: w.lon,
                    alt: w.alt, elev_ft: w.elev_ft,
                })),
                edited_at: new Date().toISOString(),
            };

            confirmBtn.textContent = 'Saving...';
            confirmBtn.disabled = true;
            try {
                // Save to localStorage (FlyTab stores plans locally, not on Pi)
                const savedPlans = JSON.parse(localStorage.getItem('flypi_saved_plans') || '[]');
                // Replace existing plan with same name, or append
                const existingIdx = savedPlans.findIndex(p => p.name === name);
                if (existingIdx >= 0) savedPlans[existingIdx] = plan;
                else savedPlans.unshift(plan);
                localStorage.setItem('flypi_saved_plans', JSON.stringify(savedPlans));
                localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
                overlay.remove();
                if (typeof app !== 'undefined' && app.showToast) app.showToast(`Route saved: ${name}`);
            } catch (err) {
                console.warn('Save route failed:', err);
                confirmBtn.textContent = 'SAVE';
                confirmBtn.disabled = false;
            }
        };

        confirmBtn.addEventListener('click', doSave);
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });

        document.body.appendChild(overlay);
        setTimeout(() => nameInput.select(), 100);
    }

    // ========== Plan Picker ==========

    async _showPlanPicker() {
        // Load saved plans from localStorage (FlyTab stores plans locally)
        let plans = [];
        try {
            plans = JSON.parse(localStorage.getItem('flypi_saved_plans') || '[]');
        } catch (err) {
            console.warn('Failed to read saved plans:', err);
        }

        // Build overlay
        const overlay = document.createElement('div');
        overlay.className = 'plan-picker-overlay';
        overlay.innerHTML = `
            <div class="plan-picker">
                <div class="plan-picker-header">
                    <span>Saved Flight Plans</span>
                    <button class="plan-picker-close">\u2715</button>
                </div>
                <div class="plan-picker-list">
                    ${plans.length === 0 ? '<div class="plan-picker-empty">No saved plans.<br>Create a plan on flywhere.app</div>' : ''}
                    ${plans.map((p, idx) => {
                        const fp = p.flight_plan || {};
                        const route = [fp.departure, fp.destination].filter(Boolean).join(' \u2192 ') || 'Unknown route';
                        const label = p.name || route;
                        const date = p.edited_at ? new Date(p.edited_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
                        }) : '';
                        return `<button class="plan-picker-item" data-idx="${idx}">
                            <span class="plan-picker-route">${label}</span>
                            ${p.name ? `<span class="plan-picker-route-sub" style="font-size:14px;color:var(--text-secondary)">${route}</span>` : ''}
                            <span class="plan-picker-date">${date}</span>
                        </button>`;
                    }).join('')}
                </div>
                <div class="plan-picker-footer"></div>
            </div>`;

        wireTap(overlay.querySelector('.plan-picker-close'), () => overlay.remove());
        // Dismiss on tap outside modal — guard against synthetic click from opening tap
        const openedAt = Date.now();
        const dismissOverlay = (e) => {
            if (Date.now() - openedAt < 500) return;
            if (e.target === overlay) overlay.remove();
        };
        overlay.addEventListener('click', dismissOverlay);
        overlay.addEventListener('touchend', dismissOverlay);

        // Plan items — load from localStorage by index
        overlay.querySelectorAll('.plan-picker-item').forEach(btn => {
            wireTap(btn, async () => {
                try {
                    const idx = parseInt(btn.dataset.idx);
                    const plan = plans[idx];
                    if (plan) {
                        localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
                        overlay.remove();
                        if (typeof app !== 'undefined' && app._applyPlan) {
                            await app._applyPlan(plan);
                            app.showToast('Plan loaded');
                        }
                    }
                } catch (err) {
                    console.warn('Failed to load plan:', err);
                }
            });
        });

        document.body.appendChild(overlay);
    }

    _showUploadModal() {
        const overlay = document.createElement('div');
        overlay.className = 'plan-picker-overlay';
        overlay.innerHTML = `
            <div class="plan-picker-modal" style="max-width:340px">
                <div class="plan-picker-header">
                    <span>Load Route File</span>
                    <button class="plan-picker-close">✕</button>
                </div>
                <div style="padding:16px;color:var(--text-secondary);font-size:14px">
                    Select a flight plan file (.json, .fpl, .gpx)
                </div>
                <div style="padding:0 16px 16px">
                    <input type="file" id="rt-upload-input" accept=".json,.fpl,.gpx,application/json,application/gpx+xml,text/xml"
                        style="width:100%;padding:8px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:6px;font-size:14px">
                </div>
                <div id="rt-upload-status" style="padding:0 16px 16px;font-size:13px;color:var(--text-secondary);min-height:20px"></div>
            </div>`;

        const dismiss = () => overlay.remove();
        const openedAt = Date.now();
        overlay.querySelector('.plan-picker-close').addEventListener('click', dismiss);
        overlay.addEventListener('click', e => {
            if (Date.now() - openedAt < 500) return;
            if (e.target === overlay) dismiss();
        });

        overlay.querySelector('#rt-upload-input').addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const status = overlay.querySelector('#rt-upload-status');
            status.textContent = `Reading ${file.name}…`;
            try {
                const text = await file.text();
                let plan = null;

                if (file.name.endsWith('.gpx') || text.trimStart().startsWith('<')) {
                    // GPX — extract route points as waypoints
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(text, 'application/xml');
                    const rtepts = [...doc.querySelectorAll('rtept')];
                    const wptEls = rtepts.length ? rtepts : [...doc.querySelectorAll('wpt')];
                    const waypoints = wptEls.map(el => ({
                        icao: (el.querySelector('name')?.textContent || '').trim().toUpperCase() || 'WPT',
                        lat: parseFloat(el.getAttribute('lat')),
                        lon: parseFloat(el.getAttribute('lon')),
                    })).filter(w => !isNaN(w.lat) && !isNaN(w.lon));
                    if (!waypoints.length) throw new Error('No route points found in GPX');
                    plan = { waypoints };
                } else {
                    // JSON / .fpl
                    plan = JSON.parse(text);
                }

                if (!plan?.waypoints?.length) throw new Error('No waypoints in file');

                dismiss();
                if (typeof app !== 'undefined' && app._applyPlan) {
                    await app._applyPlan(plan);
                    app.showToast?.(`Loaded ${file.name}`);
                }
            } catch (err) {
                status.style.color = 'var(--color-warning, #f97316)';
                status.textContent = `Error: ${err.message}`;
            }
        });

        document.body.appendChild(overlay);
    }

    _confirmNewRoute() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed;inset:0;z-index:20000;
            background:rgba(0,0,0,0.7);
            display:flex;align-items:center;justify-content:center;
        `;
        overlay.innerHTML = `
            <div style="background:var(--bg-surface,#1a2540);border-radius:12px;padding:24px;max-width:300px;width:88%;text-align:center;">
                <div style="color:var(--text-primary,#e8ecf0);font-size:17px;font-weight:600;margin-bottom:8px;">Clear route?</div>
                <div style="color:var(--text-secondary,#8899aa);font-size:14px;margin-bottom:20px;">This will delete the current route and open a blank editor.</div>
                <div style="display:flex;gap:12px;justify-content:center;">
                    <button id="_nrCancel" style="flex:1;padding:12px;border:none;border-radius:8px;background:var(--bg-surface-raised,#2a3a5c);color:var(--text-primary,#e8ecf0);font-size:16px;cursor:pointer;touch-action:manipulation;">CANCEL</button>
                    <button id="_nrConfirm" style="flex:1;padding:12px;border:none;border-radius:8px;background:#c0392b;color:#fff;font-size:16px;font-weight:600;cursor:pointer;touch-action:manipulation;">CLEAR</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const openedAt = Date.now();
        const dismiss = () => overlay.remove();
        overlay.querySelector('#_nrCancel').addEventListener('click', dismiss);
        overlay.querySelector('#_nrConfirm').addEventListener('click', () => {
            dismiss();
            try { localStorage.removeItem('flypi_active_plan'); } catch {}
            if (typeof app !== 'undefined') {
                app.openRoutePlanner(null);
            }
        });
        overlay.addEventListener('click', (e) => {
            if (Date.now() - openedAt < 500) return;
            if (e.target === overlay) dismiss();
        });
    }

    _reverseRoute() {
        if (!this._waypoints?.length || this._waypoints.length < 2) {
            if (typeof app !== 'undefined') app.showToast('Need at least 2 waypoints to reverse', 'amber');
            return;
        }
        const reversed = [...this._waypoints].reverse();
        const trip = app?._currentTrip || {};
        const plan = {
            ...trip,
            departure: reversed[0]?.icao || '',
            destination: reversed[reversed.length - 1]?.icao || '',
            waypoints: reversed,
            flight_plan: {
                ...(trip.flight_plan || {}),
                departure: reversed[0]?.icao || '',
                destination: reversed[reversed.length - 1]?.icao || '',
                route: reversed.map(w => w.icao || w.name).filter(Boolean),
                legs: [],
            },
        };
        if (typeof app !== 'undefined') {
            app.applyRouteEdit(plan);
            app.showToast('Route reversed');
        }
    }

    // ========== DOM ==========

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'route-table-sheet';

        // Handle bar — read-only display, tap to toggle collapsed/expanded
        this._handleEl = document.createElement('div');
        this._handleEl.className = 'route-table-handle';
        this._handleEl.innerHTML = `
    <div class="rt-drag-pill"></div>
    <div class="rt-handle-row">
        <span class="handle-summary"></span>
        <button class="rt-profile-btn" title="Terrain profile" style="min-width:44px;min-height:44px;font-size:18px;background:none;border:none;color:inherit;cursor:pointer;padding:0 8px">&#x26F0;</button>
        <button class="route-table-edit-btn">EDIT</button>
        <button class="rt-close-btn" title="Close route table">&#x2715;</button>
        <span class="rt-open-hint" hidden>&#x2191;</span>
    </div>
`;

        // EDIT button opens the route planner panel
        this._editBtn = this._handleEl.querySelector('.route-table-edit-btn');
        wireTap(this._editBtn, () => {
            if (typeof app !== 'undefined') {
                app.openRoutePlanner(app._currentTrip);
            }
        });

        this._profileBtn = this._handleEl.querySelector('.rt-profile-btn');
        wireTap(this._profileBtn, () => this._openProfileView());

        this._closeBtn = this._handleEl.querySelector('.rt-close-btn');
        wireTap(this._closeBtn, () => this._closeBody());

        this._openHintEl = this._handleEl.querySelector('.rt-open-hint');

        // Terrain profile panel (created once, floats above the sheet)
        this._profileView = (typeof RouteProfileView !== 'undefined')
            ? new RouteProfileView()
            : null;

        // Body
        this._bodyEl = document.createElement('div');
        this._bodyEl.className = 'route-table-body';
        this._bodyEl.style.height = '0px';

        this._tableEl = document.createElement('table');
        this._tableEl.className = 'route-table-content';

        // Delegated event listeners for all interactive table elements.
        // Delegation survives DOM rebuilds from live Stratux updates (issue #30).
        // Belt-and-suspenders: also check _wireTapLastTouchAt (from tap-utils.js) to
        // suppress synthetic clicks that slip through e.preventDefault() on some Android versions.
        this._tableEl.addEventListener('click', (e) => {
            if (Date.now() - (_wireTapLastTouchAt || 0) < 350) return;
            const del = e.target.closest('.rt-delete-btn');
            if (del) { e.stopPropagation(); this._removeWaypoint(parseInt(del.dataset.idx)); return; }
            const demote = e.target.closest('.rt-demote-fuel-stop-btn');
            if (demote) { e.stopPropagation(); this._demoteFuelStop(parseInt(demote.dataset.idx)); return; }
            const up = e.target.closest('.rt-up-btn');
            if (up) { e.stopPropagation(); this._moveWaypoint(parseInt(up.dataset.idx), parseInt(up.dataset.idx) - 1); return; }
            const down = e.target.closest('.rt-down-btn');
            if (down) { e.stopPropagation(); this._moveWaypoint(parseInt(down.dataset.idx), parseInt(down.dataset.idx) + 1); return; }
            // Altitude cell opens picker in edit mode
            const altCell = e.target.closest('.rt-alt-cell');
            if (altCell && this._editMode) { e.stopPropagation(); this._showAltPicker(parseInt(altCell.dataset.idx), altCell); return; }
            // Power header cycles cruise power
            const pwr = e.target.closest('.rt-pwr-header');
            if (pwr) { e.stopPropagation(); this._cycleCruisePower(); return; }
            // ALT header toggles IFR/VFR
            const rules = e.target.closest('.rt-rules-header');
            if (rules) { e.stopPropagation(); this._toggleFlightRules(); return; }
            // Row click pans map to waypoint
            const row = e.target.closest('.rt-row');
            if (row) {
                const idx = parseInt(row.dataset.idx);
                const wp = this._waypoints[idx];
                if (wp && wp.lat && wp.lon && this._map) {
                    this._map.panTo([wp.lat, wp.lon]);
                }
            }
        });
        // Touchend delegation for Android reliability — covers all row interactions.
        // e.preventDefault() suppresses the synthetic click; _wireTapLastTouchAt provides
        // a second guard in case preventDefault() is ignored by the WebView.
        this._tableEl.addEventListener('touchend', (e) => {
            const del = e.target.closest('.rt-delete-btn');
            if (del) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._removeWaypoint(parseInt(del.dataset.idx)); return; }
            const demote = e.target.closest('.rt-demote-fuel-stop-btn');
            if (demote) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._demoteFuelStop(parseInt(demote.dataset.idx)); return; }
            const up = e.target.closest('.rt-up-btn');
            if (up) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._moveWaypoint(parseInt(up.dataset.idx), parseInt(up.dataset.idx) - 1); return; }
            const down = e.target.closest('.rt-down-btn');
            if (down) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._moveWaypoint(parseInt(down.dataset.idx), parseInt(down.dataset.idx) + 1); return; }
            const altCell = e.target.closest('.rt-alt-cell');
            if (altCell && this._editMode) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._showAltPicker(parseInt(altCell.dataset.idx), altCell); return; }
            const pwr = e.target.closest('.rt-pwr-header');
            if (pwr) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._cycleCruisePower(); return; }
            const rules = e.target.closest('.rt-rules-header');
            if (rules) { e.preventDefault(); e.stopPropagation(); _wireTapLastTouchAt = Date.now(); this._toggleFlightRules(); return; }
            const row = e.target.closest('.rt-row');
            if (row) {
                const idx = parseInt(row.dataset.idx);
                const wp = this._waypoints[idx];
                if (wp?.lat && wp.lon && this._map) {
                    e.preventDefault();
                    this._map.panTo([wp.lat, wp.lon]);
                }
            }
        });

        // Altitude picker overlay (reused, hidden by default)
        this._altPicker = document.createElement('div');
        this._altPicker.className = 'rt-alt-picker';
        this._altPicker.hidden = true;
        this._altPickerIndex = -1;
        this._altPickerAnchorEl = null;
        // Delegated click handler for picker buttons (survives innerHTML rebuilds)
        this._altPicker.addEventListener('click', (e) => {
            // Constraint type selector
            const constraintBtn = e.target.closest('.rt-alt-constraint-btn');
            if (constraintBtn) {
                e.stopPropagation();
                const newConstraint = constraintBtn.dataset.constraint;
                this._setWaypointConstraint(this._altPickerIndex, newConstraint);
                if (this._altPickerAnchorEl) this._showAltPicker(this._altPickerIndex, this._altPickerAnchorEl);
                return;
            }
            // Airspace context hint button
            const hintBtn = e.target.closest('.rt-alt-hint-btn');
            if (hintBtn) {
                e.stopPropagation();
                const hintConstraint = hintBtn.dataset.constraint;
                const hintAlt = parseInt(hintBtn.dataset.alt);
                if (!isNaN(hintAlt) && hintAlt > 0) {
                    this._setWaypointConstraint(this._altPickerIndex, hintConstraint);
                    this._setWaypointAlt(this._altPickerIndex, hintAlt);
                    this._hideAltPicker();
                }
                return;
            }
            const optBtn = e.target.closest('.rt-alt-option');
            if (optBtn) {
                e.stopPropagation();
                this._setWaypointAlt(this._altPickerIndex, parseInt(optBtn.dataset.alt));
                this._hideAltPicker();
                return;
            }
            const setBtn = e.target.closest('.rt-alt-set-btn');
            if (setBtn) {
                e.stopPropagation();
                const input = this._altPicker.querySelector('.rt-alt-input');
                const upper = this._altPicker.querySelector('.rt-alt-input-upper');
                const val = parseInt(input?.value);
                const upperVal = upper ? parseInt(upper.value) : NaN;
                if (!isNaN(val) && val > 0) {
                    this._setWaypointAlt(this._altPickerIndex, val, (!isNaN(upperVal) && upperVal > 0) ? upperVal : null);
                    this._hideAltPicker();
                }
                return;
            }
        });
        // Close picker on outside click — scoped to cockpitContainer (picker lives there now)
        document.getElementById('cockpitContainer').addEventListener('click', (e) => {
            if (!this._altPicker.hidden && !this._altPicker.contains(e.target) && !e.target.closest('.rt-alt-cell')) {
                this._hideAltPicker();
            }
        });

        this._bodyEl.appendChild(this._tableEl);

        this._el.appendChild(this._handleEl);
        this._el.appendChild(this._bodyEl);
        const cockpitContainer = document.getElementById('cockpitContainer');
        cockpitContainer.appendChild(this._el);
        // Alt picker floats above the table — append to cockpitContainer too
        cockpitContainer.appendChild(this._altPicker);

        this._buildEngineStatusCard();
        if (this._initDragHandlers) this._initDragHandlers();
    }

    // ── Terrain Profile View ──────────────────────────────────────────────────

    async _openProfileView() {
        if (!this._profileView) {
            if (typeof app !== 'undefined') app.showToast('Profile view unavailable');
            return;
        }
        const profileData = await this._buildProfileData();
        this._profileView.show(profileData);
    }

    async _buildProfileData() {
        const wps     = this._waypoints;
        const totalDist = wps.reduce((s, wp) => s + (wp._legDist || 0), 0);
        const cruiseAlt = wps.length > 1
            ? Math.max(...wps.map(wp => wp.alt || 0))
            : 10000;
        // Use field elevation for dep/dest, not cruise alt
        const depAlt  = wps.length > 0 ? (wps[0].elev_ft || 0) : 0;
        const destAlt = wps.length > 1 ? (wps[wps.length - 1].elev_ft || 0) : 0;

        // Build legs array for the profile chart
        const legs = [];
        for (let i = 1; i < wps.length; i++) {
            const prev = wps[i - 1];
            const wp   = wps[i];
            legs.push({
                from:     prev.icao || prev.name || `WP${i - 1}`,
                to:       wp.icao   || wp.name   || `WP${i}`,
                dist:     wp._legDist || 0,
                altitude: wp.alt || cruiseAlt,
                phase:    wp._segments?.find(s => s.phase === 'CRZ')?.phase || 'CRZ',
                segments: wp._segments || [],
            });
        }

        // Build terrain profile from in-memory grid (synchronous, works offline)
        const coords = wps
            .filter(wp => wp.lat != null && wp.lon != null)
            .map(wp => ({ lat: wp.lat, lon: wp.lon }));
        const terrainProfile = this._fetchTerrainProfile(coords);

        // Fetch airspace intersections along route
        let airspaceBands = [];
        try {
            airspaceBands = await this._buildAirspaceBands(coords);
        } catch (e) {
            console.warn('[RouteTable] airspace bands failed:', e?.message);
        }

        // Cache airspace bands and waypoint distances for alt picker hints
        this._lastAirspaceBands = airspaceBands;
        const wpDists = [];
        let cumD = 0;
        for (let i = 0; i < wps.length; i++) {
            if (i > 0) cumD += wps[i]._legDist || 0;
            wpDists.push(cumD);
        }
        this._lastWaypointDists = wpDists;

        // Build waypoint constraints array for profile chart
        const waypointConstraints = [];
        cumD = 0;
        for (let i = 0; i < wps.length; i++) {
            if (i > 0) cumD += wps[i]._legDist || 0;
            const wp = wps[i];
            if (wp.alt_constraint && wp.alt) {
                waypointConstraints.push({
                    id:        wp.icao || wp.name || `WP${i}`,
                    dist:      cumD,
                    alt:       wp.alt,
                    constraint: wp.alt_constraint,
                    altUpper:  wp.alt_constraint_upper || null,
                });
            }
        }

        // Build fuelStops for the profile chart — cumulative dist at each fuel stop
        // so the chart can draw a vertical marker at each inter-flight boundary.
        const fuelStops = [];
        let fsCumDist = 0;
        for (let i = 0; i < wps.length; i++) {
            if (i > 0) fsCumDist += wps[i]._legDist || 0;
            if (isFuelStop(wps[i], i, wps)) {
                fuelStops.push({ icao: wps[i].icao || wps[i].name || '?', dist: fsCumDist });
            }
        }

        return {
            legs,
            totalDistNm:  totalDist,
            cruiseAltFt:  cruiseAlt,
            depElevFt:    depAlt,
            destElevFt:   destAlt,
            terrainProfile,
            coords,
            airspaceBands,
            waypointConstraints,
            fuelStops,   // trip.flights[] boundary markers for the profile chart
        };
    }

    async _buildAirspaceBands(coords) {
        if (!this._nasrDb || coords.length < 2) return [];

        // Get bounding box of entire route with buffer
        const lats = coords.map(c => c.lat);
        const lons = coords.map(c => c.lon);
        const south = Math.min(...lats) - 0.5;
        const north = Math.max(...lats) + 0.5;
        const west  = Math.min(...lons) - 0.5;
        const east  = Math.max(...lons) + 0.5;

        // Fetch airspace in bounds
        let allAirspace = [];
        try {
            allAirspace = await this._nasrDb.getAirspaceInBounds(south, west, north, east);
        } catch (e) {
            console.warn('[RouteTable] airspace fetch failed:', e.message);
            return [];
        }

        // Filter to only B, C, D
        const relevant = allAirspace.filter(a => ['B','C','D'].includes(a.class));
        if (!relevant.length) return [];

        const bands = [];

        for (const asp of relevant) {
            const boundary = asp.boundary || asp.points || [];
            if (boundary.length < 3) continue;

            // Sample points along route, check against polygon
            const STEP_NM = 2.0;
            const samplePts = [];
            let d = 0;
            samplePts.push({ lat: coords[0].lat, lon: coords[0].lon, dist: 0 });
            for (let i = 0; i < coords.length - 1; i++) {
                const from = coords[i], to = coords[i + 1];
                const segDist = NasrDB.haversineNm(from.lat, from.lon, to.lat, to.lon);
                const steps = Math.max(1, Math.ceil(segDist / STEP_NM));
                for (let s = 1; s <= steps; s++) {
                    const t = s / steps;
                    d += segDist / steps;
                    samplePts.push({
                        lat: from.lat + (to.lat - from.lat) * t,
                        lon: from.lon + (to.lon - from.lon) * t,
                        dist: d
                    });
                }
            }

            // Find intervals where route is inside this airspace polygon
            const intervals = [];
            let currentInterval = null;
            for (const pt of samplePts) {
                const inside = _pointInPolygon(pt.lat, pt.lon, boundary);
                if (inside && !currentInterval) {
                    currentInterval = { distFrom: pt.dist };
                } else if (!inside && currentInterval) {
                    currentInterval.distTo = pt.dist;
                    intervals.push({ ...currentInterval });
                    currentInterval = null;
                }
            }
            if (currentInterval) {
                currentInterval.distTo = samplePts[samplePts.length - 1].dist;
                intervals.push(currentInterval);
            }

            for (const interval of intervals) {
                bands.push({
                    class:    asp.class,
                    name:     asp.name || '',
                    lowerFt:  asp.lower_ft ?? asp.lower ?? 0,
                    upperFt:  (asp.upper_ft ?? asp.upper ?? 0) > 0 ? (asp.upper_ft ?? asp.upper) : 18000,
                    distFrom: interval.distFrom,
                    distTo:   interval.distTo,
                });
            }
        }

        // Sort by class priority: B first, then C, then D
        const priority = { B: 0, C: 1, D: 2 };
        bands.sort((a, b) => (priority[a.class] ?? 9) - (priority[b.class] ?? 9));

        return bands;
    }

    _fetchTerrainProfile(coords) {
        if (!coords || coords.length < 2) return [];
        // Use in-memory terrain grid (synchronous, works offline)
        if (window.terrainGrid?.isLoaded) {
            return window.terrainGrid.buildProfile(coords, 1.0);
        }
        return [];
    }

    // Drag removed in v5 — route display uses tap-to-toggle only

    _updateSummary() {
        const summaryEl = this._handleEl.querySelector('.handle-summary');
        if (!summaryEl) return;

        // Update edit button text
        if (this._editBtn) {
            this._editBtn.textContent = this._editMode ? 'DONE' : 'EDIT';
            this._editBtn.classList.toggle('rt-edit-active', this._editMode);
        }

        // Show/hide save button based on route state
        if (this._saveBtn) this._saveBtn.style.display = this._waypoints.length >= 2 ? '' : 'none';

        if (this._waypoints.length === 0) {
            summaryEl.textContent = 'NO ROUTE';
            return;
        }

        const dep = this._waypoints[0];
        // Use last airport waypoint as destination (not MAP or other appended fixes)
        const dest = [...this._waypoints].reverse().find(wp => wp.type === 'APT')
                  || this._waypoints[this._waypoints.length - 1];
        const active = this._waypoints[this._activeIndex];

        let remainDist = 0;
        for (let i = this._activeIndex; i < this._waypoints.length; i++) {
            const wp = this._waypoints[i];
            if (i === this._activeIndex) {
                remainDist += wp._liveDist || wp._legDist || 0;
            } else {
                remainDist += wp._legDist || 0;
            }
        }

        const gs = this._lastSituation?.ground_speed || 0;
        const cruiseSpeed = gs > 30 ? gs : (CockpitConfig.aircraft('performance.cruise_speed_kt') || 120);
        const remainEte = cruiseSpeed > 0 ? (remainDist / cruiseSpeed * 60) : 0;

        // Format ETE
        const eteH = Math.floor(remainEte / 60);
        const eteM = Math.round(remainEte % 60);
        const eteFmt = eteH > 0 ? `${eteH}:${String(eteM).padStart(2, '0')}` : `${eteM}m`;

        // Total fuel burn from flight computations
        let totalFuelBurn = 0;
        if (this._flights?.length) {
            for (const f of this._flights) totalFuelBurn += f._totFuel || 0;
        }
        const fuelBurnFmt = totalFuelBurn > 0 ? totalFuelBurn.toFixed(1) : null;

        // Fuel at destination — live engine GPH if available, else planned
        const engData = window.enginePanel?.lastData;
        const currentFuel = engData?.fuel_remaining_gal ?? engData?.fuel_gal ?? null;
        const liveGph = engData?.fuel_flow_gph ?? engData?.gph ?? null;
        const plannedGph = CockpitConfig.aircraft('performance.cruise_gph') ?? 9.0;
        const destWp = this._waypoints[this._waypoints.length - 1];
        let fuelAtDest = null;
        if (currentFuel != null && remainDist > 0 && cruiseSpeed > 0) {
            const gph = liveGph ?? plannedGph;
            fuelAtDest = currentFuel - (remainDist / cruiseSpeed) * gph;
        } else if (destWp?._fuelRem != null) {
            fuelAtDest = destWp._fuelRem;
        }

        // Color code fuel@dest
        const cautionGal = CockpitConfig.get('enginePage.fuelCautionGal') ?? 8;
        const warnGal = CockpitConfig.get('enginePage.fuelWarningGal') ?? 4;
        let fuelColor = 'var(--status-ok)';
        if (fuelAtDest != null) {
            if (fuelAtDest <= warnGal) fuelColor = 'var(--status-danger)';
            else if (fuelAtDest <= cautionGal) fuelColor = 'var(--status-warning)';
        }
        const fuelDestHtml = fuelAtDest != null
            ? `<span style="color:${fuelColor};font-weight:700">DEST:${fuelAtDest.toFixed(1)}</span>`
            : '';

        summaryEl.innerHTML =
            `<span style="color:var(--accent)">${dep.icao || '?'}\u2009\u2192\u2009${dest.icao || '?'}</span>` +
            `<span class="handle-stat">${Math.round(remainDist)}nm</span>` +
            `<span class="handle-stat">${eteFmt}</span>` +
            (fuelBurnFmt ? `<span class="handle-stat">${fuelBurnFmt}g</span>` : '') +
            (fuelDestHtml ? `<span class="handle-stat">${fuelDestHtml}</span>` : '');
    }

    /**
     * Render the route table.
     *
     * Terminology used in this method:
     *   LegRow     — one table row per waypoint (the standard case)
     *   SegmentRow — one row per CLB/CRZ/DES segment within a multi-segment Leg
     *
     * For multi-flight Trips (trips with fuel stops) the table is structured as:
     *   ┌─ Flight N header row ─────────────────────────────────┐
     *   │  LegRow (dep waypoint — no inbound leg data)          │
     *   │  LegRow / SegmentRows … (intermediate + dest legs)    │
     *   │  Per-Flight totals row                                 │
     *   └───────────────────────────────────────────────────────┘
     *   ⛽ Fuel stop row  (between flights)
     *   ┌─ Flight N+1 header row ─── … ─────────────────────────┐
     *   …
     *   TRIP TOTAL footer row
     */
    _renderTable() {
        const columns  = CockpitConfig.get('routeTable.columns') || [];
        const numCols  = columns.length + (this._editMode ? 2 : 0);
        const hasMultipleFlights = this._flights.length > 1;

        // ── Colgroup: pin column widths so WPT doesn't expand into fuel-stop spans ──
        const COL_WIDTHS = {
            wpt: '52px', alt: '7%', hdg: '7%', brg: '7%',
            dist: '8%',  ete: '8%', gs:  '7%', fuel: '8%',
        };

        let colgroupHtml = '<colgroup>';
        if (this._editMode) colgroupHtml += '<col style="width:36px">';   // reorder handle
        for (const col of columns) {
            const w = COL_WIDTHS[col.key];
            colgroupHtml += w ? `<col style="width:${w}">` : '<col>';
        }
        if (this._editMode) colgroupHtml += '<col style="width:36px">';   // delete button
        colgroupHtml += '</colgroup>';

        // ── Column headers ────────────────────────────────────────────────────
        let html = '<thead><tr>';
        if (this._editMode) html += '<th style="width:32px"></th>'; // reorder
        for (const col of columns) {
            if (col.key === 'pwr') {
                const pwrLabel = this._cruisePower
                    ? `${col.label} <span class="rt-pwr-badge">${this._cruisePower}%</span>`
                    : col.label;
                html += `<th style="width:${col.width || 'auto'};cursor:pointer" class="rt-pwr-header">${pwrLabel}</th>`;
            } else if (col.key === 'alt') {
                const rulesLabel = `${col.label} <span class="rt-rules-badge">${this._flightRules}</span>`;
                html += `<th style="width:${col.width || 'auto'};cursor:pointer" class="rt-rules-header">${rulesLabel}</th>`;
            } else {
                html += `<th style="width:${col.width || 'auto'}">${col.label}</th>`;
            }
        }
        if (this._editMode) html += '<th style="width:32px"></th>'; // delete
        html += '</tr></thead><tbody>';

        // ── Per-Flight sections ───────────────────────────────────────────────
        // Fall back to a virtual single-flight covering all waypoints when the
        // trip has no fuel stops (the common case — behaviour identical to before).
        const flightsToRender = hasMultipleFlights
            ? this._flights
            : [{ index: 0, dep: null, dest: null, depWpIndex: 0, destWpIndex: this._waypoints.length - 1, _totDist: 0, _totEte: 0, _totFuel: 0 }];

        for (let fi = 0; fi < flightsToRender.length; fi++) {
            const flight = flightsToRender[fi];

            // Flight header (only shown for multi-flight trips)
            if (hasMultipleFlights) {
                html += `<tr class="rt-flight-header"><td colspan="${numCols}" class="rt-flight-header-cell">`;
                html += `Flight ${fi + 1}\u2002\u00b7\u2002${flight.dep}\u2009\u2192\u2009${flight.dest}`;
                html += `</td></tr>`;
            }

            // Build LegRows / SegmentRows for this flight's waypoints.
            //
            // Fuel stop boundary: a fuel stop waypoint is the destWpIndex of Flight N
            // and the depWpIndex of Flight N+1. Its _segments describe the INBOUND leg
            // (arriving into the stop) so they belong visually inside Flight N, rendered
            // just before the fuel stop divider.
            //
            // Render strategy:
            //   Flight N  : depWpIndex → destWpIndex  (inclusive, WITH segments on dest)
            //   Flight N+1: depWpIndex+1 → destWpIndex (skip the shared fuel stop; it was
            //               already rendered as the last row of Flight N with its segments)
            const wpStart = fi > 0 ? flight.depWpIndex + 1 : flight.depWpIndex;
            const wpEnd   = flight.destWpIndex;

            for (let wpIdx = wpStart; wpIdx <= wpEnd; wpIdx++) {
                const wp = this._waypoints[wpIdx];
                const isDepRow = wpIdx === 0; // trip departure — never has inbound segments
                const segs = (!isDepRow && (wp._segments?.length ?? 0) > 1 && wp.index > 0)
                    ? wp._segments
                    : [];

                if (segs.length > 1) {
                    // Multi-segment Leg: emit one SegmentRow per CLB/CRZ/DES phase
                    for (let si = 0; si < segs.length; si++) {
                        html += this._renderLegRow(wp, columns, segs[si], si, segs.length);
                    }
                } else {
                    // Single-segment or departure waypoint: one LegRow
                    html += this._renderLegRow(wp, columns, null, 0, 1);
                }
            }

            // Per-flight totals (multi-flight trips only)
            if (hasMultipleFlights) {
                html += `<tr class="rt-flight-totals">`;
                if (this._editMode) html += '<td></td>';
                for (const col of columns) {
                    switch (col.key) {
                        case 'wpt':  html += `<td class="rt-totals-label">FL${fi + 1}</td>`; break;
                        case 'dist': html += `<td>${flight._totDist || 0}nm</td>`; break;
                        case 'ete':  html += `<td>${this._formatTime(flight._totEte)}</td>`; break;
                        case 'fuel': html += `<td>${(flight._totFuel || 0).toFixed(1)}</td>`; break;
                        default:     html += `<td></td>`; break;
                    }
                }
                if (this._editMode) html += '<td></td>';
                html += '</tr>';
            }

            // Fuel stop row between flights (not after the last flight)
            if (fi < flightsToRender.length - 1) {
                const nextFlight = flightsToRender[fi + 1];
                const stopIdx = nextFlight.depWpIndex;
                // The DES rows above are the arrival into this stop; CLB rows below are
                // the departure — this row is the boundary between those two legs.
                html += `<tr class="rt-fuel-stop-row"><td colspan="${numCols}" class="rt-fuel-stop-cell">`;
                html += `<span>\u26FD\u2002Arrived ${flight.dest} \u2014 Refuel \u00b7 Flight ${fi + 2} continues to ${nextFlight.dest}</span>`;
                html += `<button class="rt-demote-fuel-stop-btn" data-idx="${stopIdx}" title="Not a fuel stop">Not a stop</button>`;
                html += `</td></tr>`;
                // Fuel added row — only shown if pilot explicitly set fuel_add_gal on this waypoint
                const stopWp = this._waypoints[nextFlight.depWpIndex];
                if (stopWp?.fuel_add_gal != null) {
                    const added = stopWp._fuelAdded ?? stopWp.fuel_add_gal;
                    html += `<tr class="rt-fuel-added-row"><td colspan="${numCols}" class="rt-fuel-added-cell">`;
                    html += `+\u2009${added.toFixed(1)}\u2009gal added`;
                    html += `</td></tr>`;
                }
            }
        }

        html += '</tbody>';

        // ── Trip total footer ─────────────────────────────────────────────────
        if (this._waypoints.length >= 2) {
            let totDist = 0, totEte = 0, totFuel = 0;
            // Cap at destination airport — exclude MAP/missed-approach waypoints beyond it
            const destIdx = typeof ActiveRoute !== 'undefined' ? ActiveRoute.getDestIndex() : -1;
            const limitIdx = destIdx >= 0 ? destIdx : this._waypoints.length - 1;
            for (let i = 0; i <= limitIdx; i++) {
                const wp = this._waypoints[i];
                totDist += wp._dist || 0;
                totEte  += wp._ete  || 0;
                totFuel += wp._fuel || 0;
            }
            const totalLabel = hasMultipleFlights ? 'TRIP' : 'TOTAL';
            html += '<tfoot><tr class="rt-totals-row">';
            if (this._editMode) html += '<td></td>';
            for (const col of columns) {
                switch (col.key) {
                    case 'wpt':  html += `<td class="rt-totals-label">${totalLabel}</td>`; break;
                    case 'dist': html += `<td>${Math.round(totDist)}nm</td>`; break;
                    case 'ete':  html += `<td>${this._formatTime(totEte)}</td>`; break;
                    case 'fuel': html += `<td>${totFuel.toFixed(1)}</td>`; break;
                    default:     html += `<td></td>`; break;
                }
            }
            if (this._editMode) html += '<td></td>';
            html += '</tr></tfoot>';
        }

        this._tableEl.innerHTML = colgroupHtml + html;

        // Scroll active row into view within the table body
        const activeRow = this._tableEl.querySelector('.rt-row.active');
        if (activeRow) activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        // All interactive events (edit buttons, power header, row clicks) handled
        // by delegated listeners on _tableEl set up in _buildDOM().
    }

    /**
     * Selective cell update for live GPS ticks (non-edit mode only).
     * Walks existing <tr> rows and patches cell text in-place instead of
     * destroying/recreating the entire DOM tree. Returns false if the table
     * structure has changed (row count or waypoint order) and a full rebuild
     * is needed.
     */
    _updateTableCells() {
        if (!this._tableEl) return false;
        const columns = CockpitConfig.get('routeTable.columns') || [];
        const rows = this._tableEl.querySelectorAll('tbody tr.rt-row');

        // Build the expected list of (wp, seg, segIndex) tuples that _renderTable would emit
        const expected = [];
        const hasMultipleFlights = this._flights.length > 1;
        const flightsToRender = hasMultipleFlights
            ? this._flights
            : [{ index: 0, depWpIndex: 0, destWpIndex: this._waypoints.length - 1 }];

        for (let fi = 0; fi < flightsToRender.length; fi++) {
            const flight = flightsToRender[fi];
            const wpStart = fi > 0 ? flight.depWpIndex + 1 : flight.depWpIndex;
            const wpEnd = flight.destWpIndex;

            for (let wpIdx = wpStart; wpIdx <= wpEnd; wpIdx++) {
                const wp = this._waypoints[wpIdx];
                const isDepRow = wpIdx === 0;
                const segs = (!isDepRow && (wp._segments?.length ?? 0) > 1 && wp.index > 0)
                    ? wp._segments : [];

                if (segs.length > 1) {
                    for (let si = 0; si < segs.length; si++) {
                        expected.push({ wp, seg: segs[si], segIndex: si });
                    }
                } else {
                    expected.push({ wp, seg: null, segIndex: 0 });
                }
            }
        }

        // Bail if row count doesn't match — structure changed, need full rebuild
        if (rows.length !== expected.length) return false;

        // Patch each row's cells in-place
        for (let r = 0; r < rows.length; r++) {
            const tr = rows[r];
            const { wp, seg, segIndex } = expected[r];

            // Verify row identity matches
            if (parseInt(tr.dataset.idx) !== wp.index) return false;

            // Update active/passed classes
            const newCls = wp.active ? 'active' : (wp.passed ? 'passed' : '');
            const segCls = segIndex > 0 ? 'rt-seg-row' : '';
            const wantClass = `rt-row ${segCls} ${newCls}`.replace(/\s+/g, ' ').trim();
            if (tr.className !== wantClass) tr.className = wantClass;

            // Update cell values (skip edit-mode columns since we're never in edit mode here)
            const cells = tr.children;
            for (let c = 0; c < columns.length && c < cells.length; c++) {
                const val = seg
                    ? this._getCellValue(wp, columns[c].key, seg, segIndex)
                    : this._getCellValue(wp, columns[c].key);
                const valStr = String(val);
                if (cells[c].innerHTML !== valStr) {
                    cells[c].innerHTML = valStr;
                }
            }
        }

        // Update totals footer
        const footerCells = this._tableEl.querySelectorAll('tfoot .rt-totals-row td');
        if (footerCells.length > 0 && this._waypoints.length >= 2) {
            let totDist = 0, totEte = 0, totFuel = 0;
            const destIdx = typeof ActiveRoute !== 'undefined' ? ActiveRoute.getDestIndex() : -1;
            const limitIdx = destIdx >= 0 ? destIdx : this._waypoints.length - 1;
            for (let i = 0; i <= limitIdx; i++) {
                const wp = this._waypoints[i];
                totDist += wp._dist || 0;
                totEte  += wp._ete  || 0;
                totFuel += wp._fuel || 0;
            }
            const totalLabel = hasMultipleFlights ? 'TRIP' : 'TOTAL';
            let ci = 0;
            for (const col of columns) {
                if (ci >= footerCells.length) break;
                let val;
                switch (col.key) {
                    case 'wpt':  val = `<span class="rt-totals-label">${totalLabel}</span>`; break;
                    case 'dist': val = `${Math.round(totDist)}nm`; break;
                    case 'ete':  val = this._formatTime(totEte); break;
                    case 'fuel': val = totFuel.toFixed(1); break;
                    default:     val = ''; break;
                }
                const valStr = String(val);
                if (footerCells[ci].innerHTML !== valStr) footerCells[ci].innerHTML = valStr;
                ci++;
            }
        }

        // Scroll active row into view
        const activeRow = this._tableEl.querySelector('.rt-row.active');
        if (activeRow) activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        return true;
    }

    /**
     * Render a single LegRow or SegmentRow as an HTML <tr> string.
     * @param {object} wp        — waypoint object
     * @param {Array}  columns   — column config array
     * @param {object|null} seg  — segment object (SegmentRow) or null (LegRow)
     * @param {number} segIndex  — index within the segment array (0 for a LegRow)
     * @param {number} segCount  — total segments for this leg (1 for a LegRow)
     */
    _renderLegRow(wp, columns, seg, segIndex, segCount) {
        const cls     = wp.active ? 'active' : (wp.passed ? 'passed' : '');
        const segCls  = segIndex > 0 ? ' rt-seg-row' : '';
        let row = `<tr class="rt-row${segCls} ${cls}" data-idx="${wp.index}">`;

        if (this._editMode) {
            if (segIndex === 0) {
                row += `<td class="rt-reorder-cell">
                    <button class="rt-up-btn" data-idx="${wp.index}" ${wp.index === 0 ? 'disabled' : ''}>\u25B2</button>
                    <button class="rt-down-btn" data-idx="${wp.index}" ${wp.index === this._waypoints.length - 1 ? 'disabled' : ''}>\u25BC</button>
                </td>`;
            } else {
                row += '<td></td>';
            }
        }

        for (const col of columns) {
            if (col.key === 'alt' && this._editMode) {
                if (segIndex === 0) {
                    // Tappable altitude cell in edit mode
                    const altVal  = wp.alt ?? wp.altitude ?? '\u2014';
                    const display = typeof altVal === 'number' ? (altVal >= 1000 ? altVal.toLocaleString() : altVal) : altVal;
                    row += `<td class="rt-alt-cell" data-idx="${wp.index}">${display} <span class="rt-alt-edit-icon">\u25BE</span></td>`;
                } else {
                    row += `<td></td>`;
                }
            } else {
                const val = seg ? this._getCellValue(wp, col.key, seg, segIndex) : this._getCellValue(wp, col.key);
                row += `<td>${val}</td>`;
            }
        }

        if (this._editMode) {
            if (segIndex === 0) {
                row += `<td><button class="rt-delete-btn" data-idx="${wp.index}">\u00d7</button></td>`;
            } else {
                row += '<td></td>';
            }
        }

        row += '</tr>';
        return row;
    }

    _getCellValue(wp, key, seg = null, segIndex = 0) {
        // When seg is provided, use segment-specific computed values
        if (seg) {
            switch (key) {
                case 'wpt': return segIndex === 0 ? (wp.icao || wp.name || '?') : '';
                case 'phase': return seg.phase || '\u2014';
                case 'alt': return this._formatSegAlt(seg);
                case 'hdg':
                    return segIndex === 0 ? (wp._hdg != null ? Math.round(wp._hdg) + '\u00b0' : '\u2014') : '';
                case 'brg':
                    return segIndex === 0 ? (wp._brg != null ? Math.round(wp._brg) + '\u00b0' : '\u2014') : '';
                case 'dist':
                    // Show cumulative remaining distance on the first segment row only;
                    // subsequent sub-rows of the same waypoint leave it blank to avoid
                    // repeating the same number across CLB/CRZ/DES rows.
                    return segIndex === 0
                        ? (wp._cumDist != null ? wp._cumDist : '\u2014')
                        : '';
                case 'ete':
                    // First segment row: show cumulative ETE to this waypoint
                    // Sub-rows: show per-segment ETE so pilot can see e.g. CLB=5m, CRZ=15m
                    return segIndex === 0
                        ? (wp._cumEte != null ? this._formatTime(wp._cumEte) : '\u2014')
                        : (seg._ete != null ? this._formatTime(seg._ete) : '');
                case 'eta':
                    if (segIndex === 0 && wp._eta) {
                        return new Date(wp._eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    }
                    return segIndex === 0 ? '\u2014' : '';
                case 'fuel':
                    return seg._fuel != null ? seg._fuel.toFixed(1) : '\u2014';
                case 'fuel_rem': {
                    if (seg._fuelRem == null) return '\u2014';
                    const cautionGal = CockpitConfig.get('enginePage.fuelCautionGal') || 8;
                    const warnGal = CockpitConfig.get('enginePage.fuelWarningGal') || 4;
                    const val = seg._fuelRem.toFixed(1);
                    if (seg._fuelRem <= warnGal) return `<span class="fuel-red">${val}</span>`;
                    if (seg._fuelRem <= cautionGal) return `<span class="fuel-yellow">${val}</span>`;
                    return val;
                }
                case 'tas':
                    return seg._tas != null ? Math.round(seg._tas) : '\u2014';
                case 'gs': {
                    if (wp.active && segIndex === 0 && this._lastSituation?.ground_speed > 30) {
                        return Math.round(this._lastSituation.ground_speed);
                    }
                    return seg._gs != null ? Math.round(seg._gs) : '\u2014';
                }
                case 'wind':
                    if (segIndex === 0 && wp._wind) {
                        const dir = Math.round(wp._wind.dir || 0);
                        const spd = Math.round(wp._wind.spd || 0);
                        return `${String(dir).padStart(3, '0')}/${spd}`;
                    }
                    return segIndex === 0 ? '\u2014' : '';
                case 'pwr':
                    return seg._pwr != null ? Math.round(seg._pwr) + '%' : '\u2014';
                case 'rpm':
                    return seg._rpm != null ? seg._rpm : '\u2014';
                case 'mp':
                    return seg._mp != null ? seg._mp : '\u2014';
                default: return segIndex === 0 ? (wp[key] || '\u2014') : '';
            }
        }

        // Original wp-level fallback (single segment or no segments)
        switch (key) {
            case 'wpt': return wp.icao || wp.name || '?';
            case 'phase': return wp._phase || '\u2014';
            case 'alt': return wp.alt ?? wp.altitude ?? '\u2014';
            case 'hdg':
                return wp._hdg != null ? Math.round(wp._hdg) + '\u00b0' : '\u2014';
            case 'brg':
                return wp._brg != null ? Math.round(wp._brg) + '\u00b0' : '\u2014';
            case 'dist':
                return wp._cumDist != null ? wp._cumDist : '\u2014';
            case 'ete':
                return wp._cumEte != null ? this._formatTime(wp._cumEte) : '\u2014';
            case 'eta':
                return wp._eta
                    ? new Date(wp._eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '\u2014';
            case 'fuel':
                return wp._fuel != null ? wp._fuel.toFixed(1) : '\u2014';
            case 'fuel_rem': {
                if (wp._fuelRem == null) return '\u2014';
                const cautionGal = CockpitConfig.get('enginePage.fuelCautionGal') || 8;
                const warnGal = CockpitConfig.get('enginePage.fuelWarningGal') || 4;
                const val = wp._fuelRem.toFixed(1);
                if (wp._fuelRem <= warnGal) return `<span class="fuel-red">${val}</span>`;
                if (wp._fuelRem <= cautionGal) return `<span class="fuel-yellow">${val}</span>`;
                return val;
            }
            case 'tas':
                return wp._tas != null ? Math.round(wp._tas) : '\u2014';
            case 'gs': {
                if (wp.active && this._lastSituation?.ground_speed > 30) {
                    return Math.round(this._lastSituation.ground_speed);
                }
                return wp._gs != null ? Math.round(wp._gs) : '\u2014';
            }
            case 'wind':
                if (wp._wind) {
                    const dir = Math.round(wp._wind.dir || 0);
                    const spd = Math.round(wp._wind.spd || 0);
                    return `${String(dir).padStart(3, '0')}/${spd}`;
                }
                return '\u2014';
            case 'pwr':
                return wp._pwr != null ? Math.round(wp._pwr) + '%' : '\u2014';
            case 'rpm':
                return wp._rpm != null ? wp._rpm : '\u2014';
            case 'mp':
                return wp._mp != null ? wp._mp : '\u2014';
            default: return wp[key] || '\u2014';
        }
    }

    _advanceWaypoint() {
        if (this._activeIndex >= 0) {
            this._waypoints[this._activeIndex].active = false;
            this._waypoints[this._activeIndex].passed = true;
        }
        this._activeIndex++;
        if (this._activeIndex < this._waypoints.length) {
            this._waypoints[this._activeIndex].active = true;
        }
        // Notify ActiveRoute so InstrumentStrip (and any other subscriber) stays in sync
        if (typeof ActiveRoute !== 'undefined') ActiveRoute.setIndex(this._activeIndex);
    }

    _formatTime(minutes) {
        if (!minutes || minutes <= 0) return '\u2014';
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
    }

    /** Format altitude for a segment: "486→8,500" for CLB/DES, "8,500" for level */
    _formatSegAlt(seg) {
        if (!seg) return '\u2014';
        const fmtAlt = (v) => {
            if (v == null) return '?';
            return v >= 1000 ? v.toLocaleString() : String(v);
        };
        if (seg.altFrom != null && seg.altTo != null && seg.altFrom !== seg.altTo) {
            const base = `${fmtAlt(seg.altFrom)}\u2192${fmtAlt(seg.altTo)}`;
            // Append planned VS for CLB/DES so pilot knows the rate, not just the delta
            if (seg._ete > 0 && (seg.phase === 'CLB' || seg.phase === 'DES')) {
                const altDelta = Math.abs(seg.altTo - seg.altFrom);
                const vs = Math.round(altDelta / seg._ete);  // fpm
                const arrow = seg.phase === 'CLB' ? '\u2191' : '\u2193';
                return `${base} <span class="rt-vs">${arrow}${vs.toLocaleString()}</span>`;
            }
            return base;
        }
        return fmtAlt(seg.altTo ?? seg.altFrom ?? seg.alt);
    }


    _buildEngineStatusCard() {
        const card = document.createElement('div');
        card.id = 'engineStatusCard';
        card.className = 'engine-status-card engine-status-card--waiting';
        card.innerHTML = `
            <span class="esc-phase">ML: warming up</span>
            <span class="esc-score"></span>
        `;
        this._engineCardEl = card;
        this._engineCardPhaseEl = card.querySelector('.esc-phase');
        this._engineCardScoreEl = card.querySelector('.esc-score');
        // Insert as first child of the sheet so it sits above the handle bar
        this._el.insertBefore(card, this._el.firstChild);
    }

    _updateEngineStatusCard(result) {
        if (!this._engineCardEl || !result) return;
        const { phase, score, anomaly, windowReady } = result;

        this._engineCardEl.className = 'engine-status-card';
        if (!windowReady) {
            this._engineCardEl.classList.add('engine-status-card--waiting');
            this._engineCardPhaseEl.textContent = `ML: warming up`;
            this._engineCardScoreEl.textContent = '';
        } else if (anomaly) {
            this._engineCardEl.classList.add('engine-status-card--alert');
            this._engineCardPhaseEl.textContent = `\u26a0 ${(phase || 'ALERT').toUpperCase()}`;
            this._engineCardScoreEl.textContent = score != null ? `${Math.round(score * 100)}%` : '';
        } else {
            this._engineCardEl.classList.add('engine-status-card--ok');
            this._engineCardPhaseEl.textContent = (phase || 'OK').toUpperCase();
            this._engineCardScoreEl.textContent = score != null ? `${Math.round(score * 100)}%` : '';
        }
    }
}
