/**
 * FlyTab — Engine ML Bridge
 * Feeds engine data from EngineClient into the EngineML Capacitor plugin
 * at 1Hz, displays anomaly status and advisories on the engine panel/page.
 */

class EngineMLBridge {
    constructor() {
        this._plugin = window.Capacitor?.Plugins?.EngineML;
        this._initialized = false;
        this._delegate = null;
        this._lastResult = null;
        this._advisoryEl = null;
        this._badgeEl = null;

        // Post-flight logging
        this._log = [];           // 1Hz ring buffer, max 10800 entries (3 hours)
        this._logMaxLen = 10800;
        this._logStartTime = null;
        this._logActive = false;

        // Multi-layer anomaly detection (Scenario 5)
        this._prevSample = null;              // previous engine sample for delta checks
        this._baseline = {};                  // rolling parameter averages
        this._baselineWindow = [];            // last 60 samples for baseline computation
        this._baselineWindowMax = 60;
        this._flightPhase = 'ground';         // derived phase: ground/climb/cruise/descent
        // Last phase PhaseDetector.classify() actually produced. Left unset
        // (not pre-seeded to 'cruise') so the 'cruise' fallback in _onEngineData
        // only applies on a genuine cold-start-with-no-GPS-ever case (or when the
        // last computed phase was 'shutdown', which has no trained ML threshold),
        // not a mid-flight transient GPS gap — see Task 15 and its follow-up fix.
        this._lastComputedPhase = undefined;
        this._advisoryLog = [];               // ring buffer, last 20 advisories for debrief
        this._advisoryLogMax = 20;
        this._lastAdvisoryTime = {};          // type → timestamp, for per-type rate-limiting

        // Physics rules state — Scenario 6 emergency trigger
        this._prevMAP = null;       // previous manifold pressure (inches Hg)
        this._prevRPM = null;       // previous RPM
        this._physicsAlarm = false; // true when physics rule fired this cycle

        // GPS-based phase smoothing — prevents model phase thrashing on turbulence
        this._altHistory = [];      // circular buffer of MSL altitudes, last 60s
        this._altHistoryMax = 60;
        // Field elevation (MSL) is no longer tracked here — Task 13 deleted this
        // file's own never-reset running-minimum estimator (it locked to leg 1's
        // departure airport and never cleared on a multi-leg day, corrupting the
        // landing-flare AGL guard below on leg 2+). Both consumers now read
        // this._phaseDetector.getFieldElevationFt(), the single reset-aware
        // estimate PhaseDetector already maintains for its own phase classification.
        this._hasLaunched = false;  // true once aircraft has left the ground

        // Long-press state for test mode trigger
        this._lpTimer = null;
        this._lpProgressTimer = null;
        this._lpProgress = 0;

        window.engineML = this;   // expose globally for logbook.js
    }

    /** Initialize the ML engine. Call once after app init. */
    async init() {
        if (!this._plugin) {
            console.log('[EngineML] Plugin not available (browser mode)');
            return;
        }

        try {
            const result = await this._plugin.initialize({});
            this._initialized = result.status === 'ok' || result.status === 'already_initialized';
            this._delegate = result.delegate;
            console.log(`[EngineML] Initialized — delegate: ${this._delegate}`);
            // Update badge now that plugin is ready
            if (this._badgeEl) {
                this._badgeEl.textContent = 'ML:—';
                this._badgeEl.style.color = 'var(--text-muted)';
            }
        } catch (err) {
            console.error('[EngineML] Init failed:', err);
        }
    }

    /**
     * Start listening to engine data events.
     * @param {EngineClient} engineClient
     * @param {StratuxClient} stratuxClient — for altitude/speed
     */
    start(engineClient, stratuxClient) {
        this._engineClient = engineClient;
        this._stratuxClient = stratuxClient;
        this._phaseDetectorReady = window.loadPhaseSpec()
            .then((spec) => { this._phaseDetector = new window.PhaseDetector(spec); })
            .catch((err) => {
                DiagLog?.error?.('EngineML', `Failed to load phase_spec.json: ${err.message}`);
                this._phaseDetector = null; // _onEngineData falls back to a fixed phase below
            });

        // Always listen for engine data — Layer 1 physics rules run without the native plugin.
        // ML inference (Layer 2) is skipped gracefully when _initialized is false.
        engineClient.addEventListener('engine:data', (e) => {
            this._onEngineData(e.detail);
        });
    }

    get lastResult() { return this._lastResult; }
    get delegate() { return this._delegate; }
    get advisoryLog() { return [...this._advisoryLog]; }

    /** Set DOM elements for advisory display */
    setDisplayElements(badgeEl, advisoryEl) {
        this._badgeEl = badgeEl;
        this._advisoryEl = advisoryEl || null;
        if (badgeEl) {
            this._wireLongPress(badgeEl);
            // Show initial state immediately — OFF if plugin unavailable, waiting dash if ready
            badgeEl.textContent = this._initialized ? 'ML:—' : 'ML:OFF';
            badgeEl.style.color = 'var(--text-muted)';
        }
    }

    // ========== Long-press test mode trigger ==========

    _wireLongPress(el) {
        const DURATION = 2000;  // ms
        const TICK = 40;        // ms per progress update

        const start = (e) => {
            // Only primary touch/button
            if (e.type === 'mousedown' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            if (typeof DiagLog !== 'undefined') DiagLog.log('ml', `Long-press start (${e.type})`);
            this._lpProgress = 0;
            el.classList.add('ml-badge-pressing');

            this._lpTimer = setTimeout(() => {
                this._endPress(el, true);
                if (typeof DiagLog !== 'undefined') DiagLog.log('ml', 'Long-press fired — calling simulateAnomaly');
                this.simulateAnomaly();
            }, DURATION);

            this._lpProgressTimer = setInterval(() => {
                this._lpProgress = Math.min(100, this._lpProgress + (TICK / DURATION * 100));
                el.style.setProperty('--lp-pct', this._lpProgress + '%');
            }, TICK);
        };

        const cancel = (e) => {
            // If _lpTimer is null, the timeout already fired and handled itself — don't cancel.
            // This prevents touchend (finger lift at 2s) from racing against the setTimeout.
            if (!this._lpTimer) return;
            if (typeof DiagLog !== 'undefined') DiagLog.log('ml', `Long-press cancelled (${e?.type})`);
            this._endPress(el, false);
        };

        el.addEventListener('touchstart', start, { passive: false });
        el.addEventListener('touchend', cancel);
        el.addEventListener('touchcancel', cancel);
        el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false }); // prevent scroll cancelling long-press
        el.addEventListener('mousedown', start);
        el.addEventListener('mouseup', cancel);
        el.addEventListener('mouseleave', cancel);
    }

    _endPress(el, fired) {
        clearTimeout(this._lpTimer);
        clearInterval(this._lpProgressTimer);
        this._lpTimer = null;
        this._lpProgressTimer = null;
        this._lpProgress = 0;
        el.classList.remove('ml-badge-pressing');
        el.style.removeProperty('--lp-pct');
        if (!fired) {
            el.classList.add('ml-badge-cancelled');
            setTimeout(() => el.classList.remove('ml-badge-cancelled'), 300);
        }
    }

    // ========== Anomaly Simulation ==========

    /**
     * Inject a fake engine frame with MAP -6" Hg and RPM -350 to trigger
     * the full anomaly detection pipeline (physics rules + ML confirmation).
     * Calls EmergencyGlide.trigger() with testMode: true.
     */
    async simulateAnomaly() {
        console.log('[EngineML] simulateAnomaly() — injecting synthetic engine frame');
        if (typeof DiagLog !== 'undefined') DiagLog.log('ml', `simulateAnomaly: emergencyGlide=${!!window.emergencyGlide} EmergencyGlide=${typeof EmergencyGlide}`);

        // Use last known real values as baseline, fall back to cruise defaults
        const base = window.enginePanel?.lastData ?? {};
        const num = (v, fallback) => { const n = Number(v); return isFinite(n) && n > 0 ? n : fallback; };

        const baseRpm = num(base.rpm ?? base.RPM, 2400);
        const baseMp  = num(base.manifold_pressure ?? base.mp ?? base.MAP, 25);

        // Synthetic frame: MAP drop >5" Hg, RPM drop >300 (trips Layer 1 physics rules)
        const fakeFrame = {
            ...base,
            rpm:                 baseRpm - 350,
            manifold_pressure:   baseMp  - 6,
            mp:                  baseMp  - 6,
            MAP:                 baseMp  - 6,
            _simulated:          true,
        };

        // Build the plugin input (same flattening as _onEngineData)
        const d = fakeFrame;
        const sit = this._stratuxClient?.situation;

        let result = null;
        try {
            if (this._initialized && this._plugin) {
                result = await this._plugin.processSample({
                    rpm:            fakeFrame.rpm,
                    egt1:           num(d.egt1 ?? d.EGT1 ?? d['EGT 1'], 1400),
                    egt2:           num(d.egt2 ?? d.EGT2 ?? d['EGT 2'], 1400),
                    egt3:           num(d.egt3 ?? d.EGT3 ?? d['EGT 3'], 1400),
                    egt4:           num(d.egt4 ?? d.EGT4 ?? d['EGT 4'], 1400),
                    cht1:           num(d.cht1 ?? d.CHT1 ?? d['CHT 1'], 350),
                    cht2:           num(d.cht2 ?? d.CHT2 ?? d['CHT 2'], 350),
                    cht3:           num(d.cht3 ?? d.CHT3 ?? d['CHT 3'], 350),
                    cht4:           num(d.cht4 ?? d.CHT4 ?? d['CHT 4'], 350),
                    oil_temp:       num(d.oil_temp ?? d.oil_temp_f ?? d.Oil_Temp, 190),
                    oil_press:      num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press, 60),
                    fuel_flow:      num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow, 8),
                    altitude:       num(sit?.alt_msl ?? d.altitude_ft, 3000),
                    mp:             fakeFrame.manifold_pressure,
                    carb_temp:      num(d.carb_temp ?? d.Carb_Temp, 40),
                    fuel_remaining: num(d.fuel_remaining_gal ?? d.fuel_gal ?? d.Gallons_Rem, 20),
                    ground_speed:   num(sit?.ground_speed, 100),
                    distance_nm:    0,
                    phase:          (this._lastComputedPhase && this._lastComputedPhase !== 'shutdown') ? this._lastComputedPhase : (this._flightPhase ?? 'cruise'),
                });
            }
        } catch (err) {
            console.warn('[EngineML] simulateAnomaly plugin.processSample failed:', err);
        }

        // Force Layer 2 anomaly confirmation even if plugin unavailable
        const simResult = result
            ? { ...result, anomaly: true, _simulated: true }
            : { anomaly: true, phase: 'sim', score: 1.0, _simulated: true };

        this._lastResult = simResult;
        this._updateDisplay(simResult);

        // Trigger emergency glide overlay in test mode
        if (typeof EmergencyGlide !== 'undefined' && window.emergencyGlide) {
            window.emergencyGlide.trigger({
                testMode:   true,
                engineRaw:  fakeFrame,
                engineData: fakeFrame,
                mlResult:   simResult,
            });
        } else {
            console.warn('[EngineML] EmergencyGlide not available');
        }

        console.log('[EngineML] simulateAnomaly complete', { test: true, result: simResult });
    }

    async _onEngineData(raw) {
        if (!this._initialized || !this._plugin) return;

        // Flatten nested data
        const d = raw.data ? { ...raw, ...raw.data } : raw;
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

        // Get altitude and speed from Stratux situation
        const sit = this._stratuxClient?.situation;

        // Compute the causal flight phase once per sample via the shared PhaseDetector
        // (Tasks 1-6). If the spec hasn't loaded yet or GPS is momentarily unavailable,
        // retain the last phase PhaseDetector actually produced instead of resetting to
        // 'cruise' — a transient GPS dropout mid-climb must not snap phase to 'cruise'
        // (wrong CHT limit, skipped sticky-valve latch, wrong ML threshold). Only fall
        // back to 'cruise' when there's genuinely no prior phase yet, e.g. the very
        // first sample of the app session before GPS has ever been available. The
        // detector's own internal state (windows/latches) is left undisturbed during
        // the gap since classify() simply isn't called — it resumes correctly once GPS
        // returns. See Task 15.
        //
        // 'shutdown' is excluded from retention: it has no entry in
        // anomaly_v2_metadata.json's phase_thresholds (the ML model was never trained
        // on it), so passing phase='shutdown' into the plugin makes ThresholdAdapter
        // fall back to its hardcoded global default (0.88) — far looser than every
        // trained phase, including cruise (0.0745). A GPS gap spanning a shutdown→
        // restart boundary (e.g. leg 2 of a multi-leg day, engine started before
        // Stratux reacquires a fix) would otherwise silently disable ML anomaly
        // detection through taxi/runup/takeoff/initial climb. 'cruise' is used as the
        // safe default bucket here instead, matching EngineMLPlugin.java's own
        // call.getString("phase", "cruise") convention. See Task 15 follow-up.
        let phase = (this._lastComputedPhase && this._lastComputedPhase !== 'shutdown')
            ? this._lastComputedPhase
            : 'cruise';
        if (this._phaseDetector && sit?.lat != null && sit?.lon != null) {
            phase = this._phaseDetector.classify({
                rpm: d.rpm ?? d.RPM ?? 0,
                mp: d.manifold_pressure ?? d.mp ?? d.MAP ?? 0,
                fuelFlow: d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow ?? 0,
                lat: sit.lat,
                lon: sit.lon,
                altitudeFt: sit.alt_msl ?? d.altitude_ft ?? 0,
                speedKts: sit.ground_speed ?? d.speed_kts ?? 0,
            });
            this._lastComputedPhase = phase;
        }
        this._flightPhase = phase;
        this._updateLaunchState(sit, d);

        this._updateBaseline(d);

        // Layer 1: physics rules — run before ML (no latency)
        const physicsAdvisories = this._checkPhysicsRules(d);
        for (const adv of physicsAdvisories) {
            this._dispatchAdvisory(adv);
        }

        try {
            const result = await this._plugin.processSample({
                rpm: num(d.rpm ?? d.RPM),
                egt1: num(d.egt1 ?? d.EGT1 ?? d['EGT 1']),
                egt2: num(d.egt2 ?? d.EGT2 ?? d['EGT 2']),
                egt3: num(d.egt3 ?? d.EGT3 ?? d['EGT 3']),
                egt4: num(d.egt4 ?? d.EGT4 ?? d['EGT 4']),
                cht1: num(d.cht1 ?? d.CHT1 ?? d['CHT 1']),
                cht2: num(d.cht2 ?? d.CHT2 ?? d['CHT 2']),
                cht3: num(d.cht3 ?? d.CHT3 ?? d['CHT 3']),
                cht4: num(d.cht4 ?? d.CHT4 ?? d['CHT 4']),
                oil_temp: num(d.oil_temp ?? d.oil_temp_f ?? d.Oil_Temp),
                oil_press: num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press),
                fuel_flow: num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow),
                altitude: num(sit?.alt_msl ?? d.altitude_ft ?? 0),
                mp: num(d.manifold_pressure ?? d.mp ?? d.MAP ?? 0),
                carb_temp: num(d.carb_temp ?? d.Carb_Temp ?? 0),
                fuel_remaining: num(d.fuel_remaining_gal ?? d.fuel_gal ?? d.Gallons_Rem ?? 0),
                ground_speed: num(sit?.ground_speed ?? 0),
                distance_nm: 0, // TODO: compute from route
                phase,
            });

            // no post-hoc override — result.phase now just echoes what was computed and sent

            this._lastResult = result;

            // Layer 2+3: ML anomaly analysis with advisory template mapping
            if (result.anomaly) {
                const mlAdvisory = this._analyzeMLAnomaly(result, d);
                if (mlAdvisory) this._dispatchAdvisory(mlAdvisory);
            }

            this._updateDisplay(result);

            // ── Scenario 6: physics + ML joint trigger ────────────────────
            this._checkEmergencyTrigger(d, sit, result);

            // Append to ring buffer
            if (this._logActive && result) {
                this._log.push({
                    t: Math.round((Date.now() - this._logStartTime) / 1000),
                    ph: result.phase,
                    sc: result.score != null ? Math.round(result.score * 1000) / 1000 : null,
                    an: result.anomaly ? 1 : 0,
                    lt: result.latencyMs,
                });
                if (this._log.length > this._logMaxLen) this._log.shift();
            }
        } catch (err) {
            // Don't spam console — plugin may not be ready
        }

        // Store sample for next delta checks (after ML call so prev is last complete sample)
        this._prevSample = d;
    }

    // ========== Layer 1: Physics Rules ==========

    /**
     * Hard limit checks run every sample, no ML required.
     * Returns array of advisory objects (may be empty).
     */
    _checkPhysicsRules(d) {
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
        const advisories = [];

        const rpm = num(d.rpm ?? d.RPM ?? 0);
        const mp = num(d.manifold_pressure ?? d.mp ?? d.MAP ?? 0);
        const oilP = num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press ?? 0);
        const fuelFlow = num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow ?? 0);

        // Oil pressure critically low — only when engine is at idle or above (~600 RPM).
        // Below 600 RPM the oil sensor reads residual pressure on the ground even with
        // the engine off; 600 RPM aligns with Lycoming minimum idle and avoids startup noise.
        if (rpm > 600 && oilP > 0 && oilP < 25) {
            advisories.push({
                type: 'oil_pressure_critical',
                message: `Oil pressure critically low — ${Math.round(oilP)} PSI. Reduce power. Land as soon as practical.`,
                severity: 'act-now',
            });
        }

        // CHT exceedance >420°F — skip during climb (normal CHT rise expected)
        const chtLimit = 420;
        const chtClimbLimit = 440; // relaxed limit during climb
        // Task 17: use pending-OR-committed 'climb' for this check specifically,
        // not just the committed phase. PhaseDetector requires dwell_seconds.climb
        // (15) consecutive qualifying samples before actually COMMITTING to
        // 'climb', but the first ~15 seconds of a real climb are exactly the
        // highest-CHT-stress window of flight -- waiting for commit here would
        // apply the tighter 420°F limit and risk a spurious "act now" advisory.
        // Relaxing a few seconds early is the safe direction (both limits sit
        // well below the real 450°F max); this does NOT change the FSM's own
        // commit timing (no golden-parity impact), only what this check reads.
        // Falls back to the pre-Task-17 committed-phase check if the detector
        // isn't ready yet, so the relaxation degrades gracefully instead of
        // being lost entirely.
        const isClimb = this._phaseDetector
            ? this._phaseDetector.isPendingOrCommitted('climb')
            : this._flightPhase === 'climb';
        for (let i = 1; i <= 4; i++) {
            const cht = num(d[`cht${i}`] ?? d[`CHT${i}`] ?? 0);
            const limit = isClimb ? chtClimbLimit : chtLimit;
            if (cht > limit) {
                advisories.push({
                    type: `cht${i}_exceedance`,
                    message: `CHT #${i} exceeding limit — ${Math.round(cht)}°F (limit: ${limit}°F). Enrich mixture, reduce power, or increase airspeed.`,
                    severity: 'act-now',
                });
            }
        }

        // MAP sudden drop >3" Hg (unexplained power loss) — airborne only
        if (this._hasLaunched && this._prevSample && mp > 0) {
            const prevMp = num(this._prevSample.manifold_pressure ?? this._prevSample.mp ?? this._prevSample.MAP ?? 0);
            const delta = prevMp - mp;
            if (prevMp > 0 && delta > 3) {
                advisories.push({
                    type: 'map_sudden_drop',
                    message: `MAP dropped ${delta.toFixed(1)}" unexpectedly — now ${mp.toFixed(1)}" Hg. Check throttle, carb heat, mixture.`,
                    severity: 'act-now',
                });
            }
        }

        // RPM sudden drop >200 RPM — airborne only
        if (this._hasLaunched && this._prevSample && rpm > 500) {
            const prevRpm = num(this._prevSample.rpm ?? this._prevSample.RPM ?? 0);
            const delta = prevRpm - rpm;
            if (prevRpm > 500 && delta > 200) {
                advisories.push({
                    type: 'rpm_sudden_drop',
                    message: `RPM dropped ${Math.round(delta)} unexpectedly — now ${Math.round(rpm)} RPM. Check carb heat, mixture, ignition.`,
                    severity: 'act-now',
                });
            }
        }

        // Fuel flow collapse at cruise power
        if (rpm > 2000 && fuelFlow > 0 && fuelFlow < 2) {
            advisories.push({
                type: 'fuel_flow_collapse',
                message: `Fuel flow critically low at cruise power — ${fuelFlow.toFixed(1)} GPH at ${Math.round(rpm)} RPM. Check fuel selector, boost pump, mixture.`,
                severity: 'act-now',
            });
        }

        return advisories;
    }

    // ========== Layer 2: ML Anomaly Analysis ==========

    /**
     * When ML flags an anomaly, find the most-deviated parameter and generate advisory.
     * Returns advisory object or null.
     */
    _analyzeMLAnomaly(result, d) {
        if (!result.anomaly) return null;
        if (Object.keys(this._baseline).length < 5) return null; // need baseline data

        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

        const params = {
            cht1: num(d.cht1 ?? d.CHT1 ?? 0),
            cht2: num(d.cht2 ?? d.CHT2 ?? 0),
            cht3: num(d.cht3 ?? d.CHT3 ?? 0),
            cht4: num(d.cht4 ?? d.CHT4 ?? 0),
            egt1: num(d.egt1 ?? d.EGT1 ?? 0),
            egt2: num(d.egt2 ?? d.EGT2 ?? 0),
            egt3: num(d.egt3 ?? d.EGT3 ?? 0),
            egt4: num(d.egt4 ?? d.EGT4 ?? 0),
            oil_press: num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press ?? 0),
            fuel_flow: num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow ?? 0),
            rpm: num(d.rpm ?? d.RPM ?? 0),
            mp: num(d.manifold_pressure ?? d.mp ?? d.MAP ?? 0),
        };

        let maxDeviation = 0;
        let maxParam = null;

        for (const [key, value] of Object.entries(params)) {
            const base = this._baseline[key];
            if (!base || base === 0 || value === 0) continue;
            const deviation = Math.abs(value - base) / base;
            if (deviation > maxDeviation) {
                maxDeviation = deviation;
                maxParam = key;
            }
        }

        // Require at least 5% deviation to generate advisory
        if (!maxParam || maxDeviation < 0.05) return null;

        return this._mapAdvisory(maxParam, params, this._baseline);
    }

    // ========== Layer 3: Advisory Templates ==========

    /**
     * Map the most-deviated parameter to a pre-written advisory text.
     */
    _mapAdvisory(paramKey, params, baseline) {
        const r1 = (v) => Math.round(v * 10) / 10;

        const chtMatch = paramKey.match(/^cht(\d)$/);
        if (chtMatch) {
            const cyl = chtMatch[1];
            const current = Math.round(params[paramKey]);
            const base = Math.round(baseline[paramKey]);
            if (current > base) {
                return {
                    type: `ml_cht${cyl}_rising`,
                    message: `CHT #${cyl} rising faster than baseline — ${current}°F (baseline: ${base}°F). Possible cooling restriction or lean misfire. Monitor.`,
                    severity: current > 400 ? 'act-now' : 'monitor',
                };
            } else {
                return {
                    type: `ml_cht${cyl}_drop`,
                    message: `CHT #${cyl} dropped below baseline — ${current}°F (baseline: ${base}°F). Possible misfire or fuel imbalance. Monitor.`,
                    severity: 'monitor',
                };
            }
        }

        const egtMatch = paramKey.match(/^egt(\d)$/);
        if (egtMatch) {
            const cyl = egtMatch[1];
            const current = Math.round(params[paramKey]);
            const base = Math.round(baseline[paramKey]);
            if (current > base) {
                return {
                    type: `ml_egt${cyl}_high`,
                    message: `EGT #${cyl} elevated — ${current}°F (baseline: ${base}°F). Check mixture. Enrich if needed.`,
                    severity: current > 1650 ? 'act-now' : 'monitor',
                };
            } else {
                return {
                    type: `ml_egt${cyl}_low`,
                    message: `EGT #${cyl} low vs baseline — ${current}°F (baseline: ${base}°F). Possible misfire or fouled plug on cylinder ${cyl}.`,
                    severity: 'monitor',
                };
            }
        }

        if (paramKey === 'fuel_flow') {
            const current = r1(params.fuel_flow);
            const base = r1(baseline.fuel_flow);
            if (current > base) {
                return {
                    type: 'ml_fuel_flow_high',
                    message: `Fuel flow elevated vs power setting — check mixture. Current: ${current} GPH, expected: ${base} GPH.`,
                    severity: 'monitor',
                };
            } else {
                return {
                    type: 'ml_fuel_flow_low',
                    message: `Fuel flow below baseline — ${current} GPH (expected: ${base} GPH). Check fuel selector, boost pump.`,
                    severity: 'monitor',
                };
            }
        }

        if (paramKey === 'oil_press') {
            const current = Math.round(params.oil_press);
            const base = Math.round(baseline.oil_press);
            return {
                type: 'ml_oil_press_trending',
                message: `Oil pressure trending low — ${current} PSI, baseline ${base} PSI. Monitor closely.`,
                severity: current < 40 ? 'act-now' : 'monitor',
            };
        }

        if (paramKey === 'rpm') {
            const current = Math.round(params.rpm);
            const base = Math.round(baseline.rpm);
            return {
                type: 'ml_rpm_anomaly',
                message: `RPM deviation detected — ${current} RPM (baseline: ${base} RPM). Check throttle, governor, magnetos.`,
                severity: 'monitor',
            };
        }

        if (paramKey === 'mp') {
            const current = r1(params.mp);
            const base = r1(baseline.mp);
            return {
                type: 'ml_map_anomaly',
                message: `Manifold pressure anomaly — ${current}" Hg (baseline: ${base}" Hg). Check throttle, turbo, wastegate.`,
                severity: 'monitor',
            };
        }

        return null;
    }

    // ========== Phase Tracking ==========

    /**
     * Maintain GPS-derived launch/field-elevation state consumed by the
     * "airborne only" physics rules (MAP/RPM sudden-drop, _checkPhysicsRules)
     * and the Scenario 6 emergency joint-trigger's landing-flare AGL guard
     * (_checkEmergencyTrigger). Flight *phase* itself is now owned entirely
     * by the causal PhaseDetector (Tasks 1-6, see _onEngineData) — this
     * method no longer computes or returns a phase string.
     *
     * Task 7 deviation from the brief: the brief's Step 3 said to delete
     * this function entirely as "the cosmetic GPS override." That's true of
     * the phase string it used to return (superseded by PhaseDetector), but
     * the side effects below are not cosmetic — _hasLaunched gates two
     * "act-now" physics advisories and the entire emergency-glide joint
     * trigger, and nothing else in the file ever sets _hasLaunched = true.
     * A literal full deletion would silently and permanently disable those
     * safety checks for the whole flight. Kept as state-tracking only;
     * flagged in task-7-report.md for review.
     */
    _updateLaunchState(sit, d) {
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
        const altMSL = num(sit?.alt_msl ?? d.altitude_ft ?? 0);
        const groundSpeed = num(sit?.ground_speed ?? d.speed_kts ?? 0);
        const rpm = num(d.rpm ?? d.RPM ?? 0);

        if (altMSL === 0 && groundSpeed === 0) return; // no GPS

        // Maintain 60-sample altitude history (read by _checkEmergencyTrigger's
        // AGL guard; falls back to sit.alt_msl directly when empty).
        this._altHistory.push(altMSL);
        if (this._altHistory.length > this._altHistoryMax) this._altHistory.shift();

        // Field elevation estimate now comes from the shared, reset-aware
        // PhaseDetector (Task 13) instead of a duplicate estimator here — see
        // the constructor comment. Falls back to raw MSL altitude (agl = 0)
        // when no estimate exists yet (spec not loaded, GPS unavailable this
        // sample, or not enough ground samples since the last reset), matching
        // this function's own prior `?? altMSL` fallback shape exactly.
        const fieldElev = this._phaseDetector?.getFieldElevationFt() ?? altMSL;
        const agl = altMSL - fieldElev;

        // NOTE: the original _computeGPSPhase had `if (this._altHistory.length < 10)
        // return null;` right here, before evaluating launch state. That guard gated
        // an altitude-rate-based phase computation that no longer exists in this
        // trimmed function (phase is now PhaseDetector's job entirely) — it is
        // intentionally NOT carried over, since there is nothing left for it to gate.
        // Effect: _hasLaunched can now go true on the very first sample instead of
        // only after 10 samples of _altHistory accumulate. This only differs from the
        // old behavior in one edge case — the app/plugin restarting while the
        // aircraft is already airborne (e.g. after a crash mid-flight) — where it now
        // arms _hasLaunched (and the airborne-only physics advisories + emergency-glide
        // trigger) sooner rather than later. That's fail-safe-direction, not a
        // regression, and was reviewed and accepted as intentional (Dana, task-7 review).

        // Not yet airborne / back on the ground and slowed
        if (groundSpeed < 30 && agl < 200) {
            this._hasLaunched = false;
            return;
        }

        this._hasLaunched = true;
    }

    // ========== Baseline Computation ==========

    /** Maintain rolling 60-sample average baseline for anomaly comparison. */
    _updateBaseline(d) {
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

        const sample = {
            cht1: num(d.cht1 ?? d.CHT1 ?? 0),
            cht2: num(d.cht2 ?? d.CHT2 ?? 0),
            cht3: num(d.cht3 ?? d.CHT3 ?? 0),
            cht4: num(d.cht4 ?? d.CHT4 ?? 0),
            egt1: num(d.egt1 ?? d.EGT1 ?? 0),
            egt2: num(d.egt2 ?? d.EGT2 ?? 0),
            egt3: num(d.egt3 ?? d.EGT3 ?? 0),
            egt4: num(d.egt4 ?? d.EGT4 ?? 0),
            oil_press: num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press ?? 0),
            fuel_flow: num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow ?? 0),
            rpm: num(d.rpm ?? d.RPM ?? 0),
            mp: num(d.manifold_pressure ?? d.mp ?? d.MAP ?? 0),
        };

        this._baselineWindow.push(sample);
        if (this._baselineWindow.length > this._baselineWindowMax) {
            this._baselineWindow.shift();
        }

        // Recompute rolling averages (skip zero values)
        const keys = Object.keys(sample);
        const newBaseline = {};
        for (const key of keys) {
            let sum = 0, count = 0;
            for (const s of this._baselineWindow) {
                if (s[key] > 0) { sum += s[key]; count++; }
            }
            newBaseline[key] = count > 0 ? sum / count : 0;
        }
        this._baseline = newBaseline;
    }

    // ========== Advisory Dispatch ==========

    /**
     * Rate-limit, log, dispatch advisory event, and update display.
     * Same advisory type won't fire more than once per 30 seconds.
     */
    _dispatchAdvisory(advisory) {
        if (!advisory) return;

        const now = Date.now();
        const rateLimitMs = advisory.severity === 'act-now' ? 5000 : 30000;
        const last = this._lastAdvisoryTime[advisory.type];
        if (last && (now - last) < rateLimitMs) return;

        this._lastAdvisoryTime[advisory.type] = now;

        // Append to post-flight ring buffer
        this._advisoryLog.push({ ...advisory, timestamp: now });
        if (this._advisoryLog.length > this._advisoryLogMax) this._advisoryLog.shift();

        // Update advisory display element if wired
        if (this._advisoryEl) {
            const isCritical = advisory.severity === 'act-now';
            this._advisoryEl.textContent = advisory.message;
            this._advisoryEl.classList.toggle('engine-advisory-banner--critical', isCritical);
            this._advisoryEl.classList.remove('engine-advisory-banner--fadeout');
            // Force reflow so animation restarts cleanly
            void this._advisoryEl.offsetWidth;
            this._advisoryEl.classList.add('engine-advisory-banner--fadeout');
            this._advisoryEl.style.display = 'block';
            clearTimeout(this._advisoryHideTimer);
            this._advisoryHideTimer = setTimeout(() => {
                this._advisoryEl.textContent = '';
                this._advisoryEl.style.display = 'none';
                this._advisoryEl.classList.remove('engine-advisory-banner--fadeout', 'engine-advisory-banner--critical');
            }, 15000);
        }

        console.log(`[EngineML] Advisory [${advisory.severity}]: ${advisory.message}`);
        document.dispatchEvent(new CustomEvent('engineml:advisory', { detail: advisory }));
    }

    // ========== Scenario 6: Emergency Trigger (Physics + ML) ==========

    /**
     * Physics rules check + joint confirmation with ML anomaly.
     * Both layers must fire to trigger the emergency glide overlay.
     *
     * Physics rules (any one sufficient):
     *   - MAP drop  >5 inches Hg since last sample
     *   - RPM drop  >300 RPM since last sample
     *   - Oil press  <20 PSI
     *
     * ML confirmation: result.anomaly === true
     */
    _checkEmergencyTrigger(d, sit, result) {
        if (!result) return;

        const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };

        const curMAP = num(d.manifold_pressure ?? d.mp ?? d.MAP);
        const curRPM = num(d.rpm ?? d.RPM);
        const oilPress = num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press);

        // Evaluate physics rules
        let physicsAlarm = false;

        if (curMAP !== null && this._prevMAP !== null) {
            if ((this._prevMAP - curMAP) > 5) {
                physicsAlarm = true;
                console.warn(`[EngineML] Physics: MAP drop ${(this._prevMAP - curMAP).toFixed(1)}" detected`);
            }
        }
        if (curRPM !== null && this._prevRPM !== null) {
            if ((this._prevRPM - curRPM) > 300) {
                physicsAlarm = true;
                console.warn(`[EngineML] Physics: RPM drop ${Math.round(this._prevRPM - curRPM)} detected`);
            }
        }
        if (oilPress !== null && oilPress > 0 && oilPress < 20) {
            physicsAlarm = true;
            console.warn(`[EngineML] Physics: Low oil pressure ${oilPress} PSI`);
        }

        // Update previous values for next cycle
        if (curMAP !== null) this._prevMAP = curMAP;
        if (curRPM !== null) this._prevRPM = curRPM;

        this._physicsAlarm = physicsAlarm;

        // Joint trigger: physics AND ML must both confirm — airborne only.
        // Runup→idle drops >300 RPM on the ground and the 60-sample ML window
        // flags the transition as anomalous once ThresholdAdapter tightens.
        if (physicsAlarm && result.anomaly === true && this._hasLaunched) {
            // AGL lower-bound guard: below 500 ft AGL, throttle retard during the landing
            // flare is indistinguishable from an engine failure by physics rules (same MAP
            // and RPM drop). _hasLaunched stays true while groundSpeed > 30 kts so the
            // existing ground guard doesn't catch the flare. Below 500 ft the pilot is
            // committed to the runway ahead regardless — the emergency overlay adds no
            // actionable value and a false squawk-7700 alert is dangerous noise.
            const altMSL = this._altHistory.length > 0
                ? this._altHistory[this._altHistory.length - 1]
                : (sit?.alt_msl ?? 0);
            // Deliberately NOT `getFieldElevationFt() ?? altMSL` collapsed into a
            // single fallback-then-subtract (that would silently turn "no estimate
            // yet" into agl = altMSL - altMSL = 0, which is BELOW the 500ft guard
            // and would wrongly suppress a real emergency trigger any time the
            // estimate isn't locked yet). Preserves the original ternary: no
            // estimate yet -> agl = altMSL (a large number for anyone airborne),
            // so the guard only suppresses once a real ground-elevation estimate
            // says the aircraft is genuinely low — never as a side effect of the
            // estimate simply not existing yet.
            const fieldElevFt = this._phaseDetector?.getFieldElevationFt() ?? null;
            const agl = fieldElevFt !== null ? (altMSL - fieldElevFt) : altMSL;
            if (agl < 500) {
                console.log(`[EngineML] Emergency suppressed — AGL ${Math.round(agl)} ft < 500 ft (landing flare guard)`);
                return;
            }

            console.warn('[EngineML] EMERGENCY: physics + ML joint confirmation — power loss');
            if (typeof EmergencyGlide !== 'undefined' && window.emergencyGlide) {
                window.emergencyGlide.trigger({ engineRaw: d, sit, mlResult: result });
            }
        }
    }

    // ========== Flight Logging ==========

    startLogging() {
        this._log = [];
        this._logStartTime = Date.now();
        this._logActive = true;
        console.log('[EngineML] Logging started');
    }

    stopLogging() {
        this._logActive = false;
        console.log(`[EngineML] Logging stopped — ${this._log.length} samples`);
    }

    /** Returns compact summary for logbook custom_fields. Returns null if no data. */
    getFlightSummary() {
        if (!this._log.length) return null;
        const phases = {};
        let anomalyCount = 0;
        let latSum = 0;
        let latCount = 0;
        for (const s of this._log) {
            phases[s.ph] = (phases[s.ph] || 0) + 1;
            if (s.an) anomalyCount++;
            if (s.lt != null) { latSum += s.lt; latCount++; }
        }
        const total = this._log.length;
        return {
            samples: total,
            duration_s: this._log[this._log.length - 1].t,
            anomaly_count: anomalyCount,
            anomaly_pct: Math.round(anomalyCount / total * 100),
            avg_latency_ms: latCount ? Math.round(latSum / latCount) : null,
            phase_dist: Object.fromEntries(
                Object.entries(phases).map(([k, v]) => [k, Math.round(v / total * 100)])
            ),
            advisory_count: this._advisoryLog.length,
        };
    }

    /** Returns a shallow copy of the ring buffer for IDB storage. */
    getFullLog() {
        return [...this._log];
    }

    /** Reset all adapted thresholds (call after maintenance or phase bug fix). */
    async resetThresholds() {
        if (!this._plugin) return;
        try {
            await this._plugin.resetThresholds({});
            console.log('[EngineML] Adapted thresholds reset');
        } catch (err) {
            console.error('[EngineML] resetThresholds failed:', err);
        }
    }

    /** Saves ML log CSV to NanoHTTPD filesystem (Documents/FlyTab/flights/). */
    async exportLogCSV(filename = 'engineml_log.csv') {
        if (!this._log.length) return;
        const rows = ['t_s,phase,score,anomaly,latency_ms'];
        for (const s of this._log) {
            rows.push(`${s.t},${s.ph ?? ''},${s.sc ?? ''},${s.an},${s.lt ?? ''}`);
        }
        const content = rows.join('\n') + '\n';
        await fetch(`http://localhost:9090/flights/${filename}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/csv' },
            body: content,
        });
    }

    _updateDisplay(result) {
        if (!result) return;

        // Update badge (on engine panel or status bar)
        if (this._badgeEl) {
            if (!result.windowReady) {
                this._badgeEl.textContent = `ML:${result.phase || '...'}`;
                this._badgeEl.style.color = 'var(--text-muted)';
            } else if (result.anomaly) {
                this._badgeEl.textContent = `ML:ALERT`;
                this._badgeEl.style.color = 'var(--status-danger)';
                this._badgeEl.style.animation = 'thermal-flash 1s infinite';
            } else {
                this._badgeEl.textContent = `ML:${result.phase || 'OK'}`;
                this._badgeEl.style.color = 'var(--status-ok)';
                this._badgeEl.style.animation = '';
            }
        }

        document.dispatchEvent(new CustomEvent('engineml:result', { detail: result }));
    }
}
