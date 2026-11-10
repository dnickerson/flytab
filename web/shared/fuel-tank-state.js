/**
 * FlyTab — Synthetic Per-Tank Fuel State
 * Integrates measured fuel flow against pilot-reported tank selection.
 * Flight-safety critical: errors cause fuel exhaustion risk.
 * Never auto-corrects from senders. Requires human-in-the-loop confirmation.
 *
 * Engine model (state.engine, persisted with the tank state). One explicit model of
 * what the engine is doing decides which un-integrated time is dropped burn:
 *   state          'off' | 'running' | 'unknown'
 *   since          ISO time the state was entered
 *   covered_at     ISO time up to which engine time is accounted for: integrated,
 *                  known zero (engine off, a fuel-flow reading of 0 while running),
 *                  or added to pending_gap_ms. Gap = now − covered_at.
 *   zero_flow_since ISO start of the current FF-0 running stretch, or null
 *   pending_gap_ms running time that burned fuel but has not been booked yet (an
 *                  outage, an unobserved stretch, a stuck sender, burn while
 *                  requires_confirm blocks integration). Booked as dropped burn at
 *                  the next frame with flow, at that frame's GPH.
 * plus the top-level flow_lost_at / flow_lost_reason ('data' | 'zero_flow') and
 * last_burn_at. Transitions: onFrame()/onSample() (current engine frames),
 * markFlowLost() (stale / disconnect / frozen frames), init(), migration in _load().
 * markConfirmed() never touches it. See the transition table in onFrame().
 */

class FuelTankState {
    static STORAGE_KEY = 'flytab_tank_state';
    /** If last sample is older than this, require confirmation before trusting state */
    static STALE_MS = 45 * 60 * 1000;
    /** Imbalance warning threshold in gallons */
    static IMBALANCE_GAL = 5;
    /** How often to prompt pilot to confirm current tank selection */
    static CONFIRM_INTERVAL_MS = 30 * 60 * 1000;
    /** Cap dt between samples to avoid large jumps on reconnect */
    static MAX_SAMPLE_DT_MS = 10000;
    /** markFlowLost() with no current frame seen this app session, and migration of
     *  state stored before the engine model: the engine counts as running only if it
     *  was known running (or burn was integrated) this recently. */
    static RECENT_BURN_MS = 2 * 60 * 1000;
    /** Running vs stopped is decided by RPM only, never by fuel flow: above this RPM
     *  the engine is running. A stopped engine can still report residual flow (3 of
     *  126 recorded flights end with RPM 0 and Fuel Flow 0.5-0.9), and the D-180 reads
     *  FF 0 at 1000-1900 RPM with the engine running (11 of 126 files; 33 s at taxi in
     *  20260130_KLKR-KUZA, two rows at 81 kt in 20261014); no RPM <= 300 reading lies
     *  between RPM > 1500 readings in any recorded file. */
    static RUNNING_RPM_MIN = 300;
    /** A running engine (current frames, RPM > RUNNING_RPM_MIN) reporting FF 0 for
     *  longer than this, measured from the start of the FF-0 stretch
     *  (engine.zero_flow_since), is not a low-flow reading but a stuck / failed
     *  sender: flow is marked lost ('zero_flow'). The recorded flights
     *  (~/engine_analysis, Nov 2026) show FF-0 stretches with the engine running of
     *  at most about 60 s (taxi / idle; 33 s in 20260130_KLKR-KUZA). */
    static ZERO_FLOW_MAX_MS = 90 * 1000;
    /** The engine cannot still be running this long after data was lost: 36 gal
     *  usable at the lowest power-setting flow in aircraft-config.json (5.0 gph) lasts
     *  7.2 h. Used for init() during an outage (older outage → not carried) and for a
     *  gap longer than this (not booked: unquantifiable, figure stays UNCONFIRMED). */
    static OUTAGE_RUNNING_MAX_MS = 8 * 60 * 60 * 1000;

    static _state = null;
    static _loaded = false;
    static _lastConfirmPromptAt = 0;

    static _load() {
        if (FuelTankState._loaded) return;
        FuelTankState._loaded = true;
        try {
            const raw = localStorage.getItem(FuelTankState.STORAGE_KEY);
            FuelTankState._state = raw ? JSON.parse(raw) : null;
        } catch (_) {
            FuelTankState._state = null;
        }
        if (FuelTankState._state && !FuelTankState._state.engine) {
            FuelTankState._state.engine = FuelTankState._migrateEngine(FuelTankState._state, Date.now());
            delete FuelTankState._state.engine_stopped_at;
            delete FuelTankState._state.stop_seen_at;
            FuelTankState._save();
        }
        FuelTankState._checkStaleness();
    }

    static _ms(iso) {
        if (!iso) return NaN;
        const t = new Date(iso).getTime();
        return Number.isFinite(t) ? t : NaN;
    }

    static _iso(ms) { return new Date(ms).toISOString(); }

    /**
     * Engine model for state stored before it existed (v13.7 and earlier). Derived
     * conservatively: a noted stop → 'off'; flow lost with the engine running →
     * 'running' (the outage is still booked at the next frame with flow); burn
     * integrated within RECENT_BURN_MS → 'running'; otherwise 'unknown' (the first
     * sample books nothing). The old engine_stopped_at / stop_seen_at are read here
     * only. covered_at = last_sample_at (what the old code measured gaps from).
     */
    static _migrateEngine(st, nowMs) {
        const covered = st.last_sample_at || FuelTankState._iso(nowMs);
        const burnMs = FuelTankState._ms(st.last_burn_at);
        let state = 'unknown';
        if (st.engine_stopped_at) state = 'off';
        else if (st.flow_lost_at) state = 'running';
        else if (Number.isFinite(burnMs) && nowMs - burnMs >= 0 && nowMs - burnMs <= FuelTankState.RECENT_BURN_MS) {
            state = 'running';
        }
        return { state, since: covered, covered_at: covered, zero_flow_since: null, pending_gap_ms: 0 };
    }

    /** Re-evaluate staleness against the current clock. Called on every getState()/needsConfirmation(),
     *  not just once per page load, so a silent mid-session data gap is caught. */
    static _checkStaleness() {
        if (FuelTankState._state && !FuelTankState._state.requires_confirm) {
            const lastMs = FuelTankState._state.last_sample_at
                ? new Date(FuelTankState._state.last_sample_at).getTime()
                : 0;
            if (lastMs && (Date.now() - lastMs) > FuelTankState.STALE_MS) {
                FuelTankState._state.requires_confirm = true;
                FuelTankState._save();
            }
        }
    }

    static _save() {
        try {
            localStorage.setItem(FuelTankState.STORAGE_KEY, JSON.stringify(FuelTankState._state));
        } catch (_) {}
    }

    static _fire() {
        window.dispatchEvent(new CustomEvent('fueltankstate:changed'));
    }

    /**
     * Configured per-tank capacity from aircraft-config.json (via CockpitConfig),
     * or `fallback` if unavailable/invalid. Single source for this lookup — shared
     * by init()'s clamp and any caller needing a fat-finger/plausibility ceiling —
     * so a future change to the capacity config path updates every caller at once.
     * @param {number} fallback - value to use when config is unavailable
     */
    static perSideCapGal(fallback) {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) return cap / 2;
            }
        } catch (_) { /* fall through to caller's fallback */ }
        return fallback;
    }


    /**
     * Initialize with preflight fuel quantities. Clears requires_confirm.
     * The engine model is carried over from the state being replaced, because a
     * re-entry (widget SET, recovery CONFIRM) can happen in flight:
     *  - outage ongoing (engine running, flow_lost_at set, the outage younger than
     *    OUTAGE_RUNNING_MAX_MS): stays 'running' and flow-lost (UNCONFIRMED stays
     *    until a frame with flow books the time from this entry to it);
     *  - engine running with data flowing (covered within STALE_MS): stays 'running';
     *  - otherwise (engine seen off, no prior state, 45+ min stale with no flow lost,
     *    an outage older than OUTAGE_RUNNING_MAX_MS): 'off' if it was off, else
     *    'unknown'; flow-lost cleared.
     * In every case covered_at = now and pending_gap_ms = 0: the entered quantity
     * replaces anything unbooked before it.
     *
     * `source` narrows the carry for ground measurements (a tic is a dipstick
     * reading on the ground, a fuel stop is on the ground):
     *  - 'fuel_stop' (RECORD FUEL STOP): never carries;
     *  - 'tic' (APPLY TIC): carries only 'running' with no outage and covered within
     *    STALE_MS (an unseen shutdown with the app closed: the documented known
     *    limit); an outage is never carried (Pi off before the engine);
     *  - 'reentry' (widget SET / recovery CONFIRM, in flight) and a missing or
     *    unknown source: the rules above. Missing = in-flight rules on purpose: a
     *    caller that forgets the source can at worst offer a false correction the
     *    pilot reviews, never silently lose real burn.
     * @param {number} leftGal
     * @param {number} rightGal
     * @param {'L'|'R'} activeTank - this airframe has no BOTH selector position
     * @param {'tic'|'fuel_stop'|'reentry'} [source]
     */
    static init(leftGal, rightGal, activeTank = 'L', source) {
        const nowMs = Date.now();
        const now = FuelTankState._iso(nowMs);
        FuelTankState._load();
        const prior = FuelTankState._state;
        const peng = prior && prior.engine;
        let engState = (peng && peng.state === 'off') ? 'off' : 'unknown';
        let since = now;
        let flowLostAt = null;
        let flowLostReason = null;
        if (peng && peng.state === 'running' && source !== 'fuel_stop') {
            const lostMs = FuelTankState._ms(prior.flow_lost_at);
            const covMs = FuelTankState._ms(peng.covered_at);
            if (source !== 'tic' && Number.isFinite(lostMs) &&
                nowMs - lostMs <= FuelTankState.OUTAGE_RUNNING_MAX_MS) {
                engState = 'running';
                flowLostAt = prior.flow_lost_at;
                flowLostReason = prior.flow_lost_reason === 'zero_flow' ? 'zero_flow' : 'data';
            } else if (!Number.isFinite(lostMs) && Number.isFinite(covMs) &&
                       nowMs - covMs <= FuelTankState.STALE_MS) {
                engState = 'running';
            }
            if (engState === 'running') since = peng.since || now;
        }
        // This aircraft draws from one tank at a time — there is no BOTH position on the
        // selector. A legacy 'BOTH' (or anything else) is not a tank we can integrate
        // against, so fall back to L and make the pilot confirm rather than guessing.
        const validTank = (activeTank === 'L' || activeTank === 'R');
        FuelTankState._lastConfirmPromptAt = nowMs;
        const perSideCap = FuelTankState.perSideCapGal(Infinity);
        FuelTankState._state = {
            left_gal: Math.min(perSideCap, Math.max(0, leftGal)),
            right_gal: Math.min(perSideCap, Math.max(0, rightGal)),
            active_tank: validTank ? activeTank : 'L',
            tank_switched_at: now,
            // Time of the last integrated sample, init() or markConfirmed(): the
            // STALE_MS confirmation rule only. Gap booking uses engine.covered_at.
            last_sample_at: now,
            requires_confirm: !validTank,
            initialized_at: now,
            imbalance: false,
            dropped_burn_estimate_gal: 0,
            dropped_burn_ambiguous: false,
            // Gallons burned since this init() (tic measurement / fuel stop): the ENG
            // page USED gauge. State stored before this field existed has no such
            // field; it is left absent (read as null, shown '—') rather than counted
            // from 0, which would understate the burn.
            burned_since_init_gal: 0,
            // Gallons of pilot-applied dropped-burn corrections since this init()
            // (applyDroppedBurn). They lower the tanks but are an estimate, not
            // measured flow, so the K-factor calculator subtracts them out of the
            // tracked burn. Absent in state stored before the field existed.
            dropped_applied_since_init_gal: 0,
            // Fuel-flow data lost with the engine running (markFlowLost, an
            // unobserved stretch, a stuck sender): burn is not integrated, so the
            // figure reads high. Cleared by the next frame with flow (which books the
            // unbooked time) or by init() unless the outage is ongoing.
            // needsConfirmation() is true while it is set.
            flow_lost_at: flowLostAt,
            // 'data' (engine data stopped / froze / unobserved) or 'zero_flow' (FF 0
            // with the engine running > ZERO_FLOW_MAX_MS: a stuck sender). Absent in
            // older state (read as 'data').
            flow_lost_reason: flowLostReason,
            // Time of the last sample that integrated burn (also residual flow).
            last_burn_at: null,
            // Gallons of comms-gap burn estimated since this init(): every amount
            // added to dropped_burn_estimate_gal, applied or not. The K-factor
            // calculator excludes a leg with a real gap. Absent in older state.
            gap_burn_since_init_gal: 0,
            engine: { state: engState, since, covered_at: now, zero_flow_since: null, pending_gap_ms: 0 },
        };
        FuelTankState._loaded = true;
        FuelTankState._save();
        FuelTankState._fire();
    }

    /** A finite RPM at or below RUNNING_RPM_MIN: the engine is stopped. */
    static _isStoppedRpm(rpm) {
        return typeof rpm === 'number' && Number.isFinite(rpm) && rpm <= FuelTankState.RUNNING_RPM_MIN;
    }

    static _setFlowLost(st, nowMs, reason) {
        if (st.flow_lost_at && st.flow_lost_reason === reason) return false;
        if (!st.flow_lost_at) st.flow_lost_at = FuelTankState._iso(nowMs);
        st.flow_lost_reason = reason;
        return true;
    }

    /**
     * One CURRENT engine frame (EngineClient.edmCurrent). fuel-tanks.js calls this
     * for every current frame; frames with flow go through onSample().
     * @param {number} nowMs
     * @param {number} gph - fuel flow (0 / missing = no flow reading)
     * @param {number} [rpm] - frame RPM (missing → frames with flow count as running)
     */
    static onFrame(nowMs, gph, rpm) {
        const g = Number(gph);
        if (Number.isFinite(g) && g > 0) return FuelTankState.onSample(g, nowMs, rpm);
        return FuelTankState._frame(nowMs, 0, rpm);
    }

    /**
     * A current engine frame with fuel flow > 0 (also residual flow on a stopped
     * engine). Integrates against the active tank and books unbooked running time.
     * Kept as the entry point for frames with flow (and for direct callers).
     * @param {number} gph - Fuel flow in gallons per hour (must be > 0)
     * @param {number} nowMs - Current timestamp (Date.now())
     * @param {number} [rpm] - frame RPM; missing → running, but from 'off' /
     *   'unknown' it integrates the capped dt and books nothing (no start seen)
     */
    static onSample(gph, nowMs, rpm) {
        if (!gph || gph <= 0) return;
        FuelTankState._frame(nowMs, gph, rpm);
    }

    /**
     * Engine-model transition for one current frame. Kinds: STOPPED (finite RPM <=
     * RUNNING_RPM_MIN), FLOW (running or RPM missing, GPH > 0), ZERO (RPM > 300,
     * GPH 0). gap = now − covered_at; "unobserved" = gap > MAX_SAMPLE_DT_MS.
     *
     *  prior state  | kind    | effect
     *  running      | any, unobserved (gap ≤ OUTAGE_RUNNING_MAX_MS) | gap → pending
     *               |         | (FLOW: the first MAX_SAMPLE_DT_MS integrated instead);
     *               |         | not FLOW: flow lost 'data'; zero_flow_since reset
     *  running      | any, gap > OUTAGE_RUNNING_MAX_MS | gap not booked; flow lost
     *               |         | 'data' unless FLOW (state treated as unknown)
     *  running      | FLOW    | integrate min(pending + gap, MAX) at GPH; book the
     *               |         | rest of pending + gap as dropped burn; clear flow lost
     *               |         | and zero_flow_since (requires_confirm: gap → pending)
     *  running      | ZERO    | flow lost: gap → pending (unconfirmed reading).
     *               |         | Else a reading: nothing booked. zero_flow_since =
     *               |         | covered_at (continuous) / now; > ZERO_FLOW_MAX_MS →
     *               |         | flow lost 'zero_flow', the stretch → pending
     *  off/unknown  | FLOW/ZERO with RPM | engine start: nothing integrated before now
     *  off/unknown  | FLOW, RPM missing | integrate min(gap, MAX); book nothing
     *  any          | STOPPED | state off; zero_flow_since null; residual flow
     *               |         | integrated (capped) only when nothing is pending and
     *               |         | flow is not lost (else UNCONFIRMED stays; the pending
     *               |         | time is booked at the next frame with flow, i.e. the
     *               |         | restart)
     * Always: covered_at = now.
     */
    static _frame(nowMs, gph, rpm) {
        FuelTankState._load();
        const st = FuelTankState._state;
        if (!st) return;
        if (!st.engine) st.engine = FuelTankState._migrateEngine(st, nowMs);
        const eng = st.engine;
        const MAX = FuelTankState.MAX_SAMPLE_DT_MS;
        const rpmKnown = typeof rpm === 'number' && Number.isFinite(rpm);
        const stopped = FuelTankState._isStoppedRpm(rpm);
        const flow = !stopped && gph > 0;
        const zero = !stopped && !(gph > 0) && rpmKnown;
        if (!stopped && !flow && !zero) return;   // FF 0 with no RPM: says nothing
        const block = !!st.requires_confirm;

        const covMs = FuelTankState._ms(eng.covered_at);
        const gapMs = Number.isFinite(covMs) ? Math.max(0, nowMs - covMs) : 0;
        let running = eng.state === 'running';
        let pending = Number(eng.pending_gap_ms) || 0;
        let changed = false;
        let integrateMs = 0;
        let intervalStart = Number.isFinite(covMs) ? covMs : nowMs;

        if (running && gapMs > FuelTankState.OUTAGE_RUNNING_MAX_MS) {
            // Longer than the engine can run: unquantifiable; the figure stays
            // UNCONFIRMED (and the STALE_MS rule asks for a re-entry).
            if (!flow) changed = FuelTankState._setFlowLost(st, nowMs, 'data') || changed;
            eng.zero_flow_since = null;
            eng.state = 'unknown';
            running = false;
        } else if (running && gapMs > MAX) {
            // Unobserved running time: app restart, outage, frames frozen.
            if (flow && !block) {
                integrateMs = MAX;
                pending += gapMs - MAX;
            } else {
                pending += gapMs;
            }
            // Data stopped: a stuck-sender mark becomes 'data'; FF 0 after the return
            // starts a new zero-flow stretch (the 90 s rule from the return time).
            if (!flow) changed = FuelTankState._setFlowLost(st, nowMs, 'data') || changed;
            eng.zero_flow_since = null;
        } else if (running) {
            if (flow) {
                if (block) pending += gapMs;
                else integrateMs = gapMs;
            } else if (zero && st.flow_lost_at) {
                pending += gapMs;                    // not a confirmed reading yet
            }
        }

        const startedNow = !running && (flow || zero);
        if (stopped) {
            if (eng.state !== 'off') { eng.state = 'off'; eng.since = FuelTankState._iso(nowMs); }
            eng.zero_flow_since = null;
            // Residual flow on a stopped engine integrates as before, unless an
            // unbooked stretch is open (it would be booked at the residual GPH).
            if (gph > 0 && !block && !st.flow_lost_at && pending === 0) {
                integrateMs = Math.min(gapMs, MAX);
            } else {
                integrateMs = 0;
            }
        } else {
            if (startedNow) {
                eng.state = 'running';
                eng.since = FuelTankState._iso(nowMs);
                // A start seen in the frames: nothing burned before now. A frame with
                // flow but no RPM (direct callers): the capped dt, nothing booked.
                integrateMs = (flow && !rpmKnown && !block) ? Math.min(gapMs, MAX) : 0;
            }
            if (zero) {
                if (eng.zero_flow_since == null) {
                    eng.zero_flow_since = (running && gapMs <= MAX && Number.isFinite(covMs))
                        ? eng.covered_at : FuelTankState._iso(nowMs);
                }
                const zMs = FuelTankState._ms(eng.zero_flow_since);
                if (Number.isFinite(zMs) && nowMs - zMs > FuelTankState.ZERO_FLOW_MAX_MS &&
                    st.flow_lost_reason !== 'zero_flow') {
                    if (!st.flow_lost_at) pending += nowMs - zMs;   // the stretch so far
                    changed = FuelTankState._setFlowLost(st, nowMs, 'zero_flow') || changed;
                }
            }
        }

        let integrated = false;
        if (flow && !block) {
            // Book pending time with the 10 s convention over all unbooked time:
            // integrate min(total, MAX), book the rest.
            const total = pending + integrateMs;
            const intMs = Math.min(total, MAX);
            const bookMs = total - intMs;
            if (bookMs > 0) {
                const droppedGal = gph * (bookMs / 1000) / 3600;
                st.dropped_burn_estimate_gal = (st.dropped_burn_estimate_gal || 0) + droppedGal;
                if (typeof st.gap_burn_since_init_gal === 'number') st.gap_burn_since_init_gal += droppedGal;
            }
            pending = 0;
            if (!FuelTankState._integrate(st, gph, intMs, nowMs, intervalStart)) {
                eng.pending_gap_ms = 0;
                eng.covered_at = FuelTankState._iso(nowMs);
                FuelTankState._save();
                return;
            }
            integrated = true;
            if (st.flow_lost_at) changed = true;
            st.flow_lost_at = null;
            st.flow_lost_reason = null;
            eng.zero_flow_since = null;
        } else if (stopped && integrateMs > 0) {
            if (!FuelTankState._integrate(st, gph, integrateMs, nowMs, intervalStart)) {
                eng.covered_at = FuelTankState._iso(nowMs);
                FuelTankState._save();
                return;
            }
            integrated = true;
        }

        eng.pending_gap_ms = pending;
        eng.covered_at = FuelTankState._iso(nowMs);
        FuelTankState._save();
        if (integrated || changed) FuelTankState._fire();

        // Periodic confirmation prompt while engine is running
        if (integrated && (nowMs - FuelTankState._lastConfirmPromptAt) > FuelTankState.CONFIRM_INTERVAL_MS) {
            FuelTankState._lastConfirmPromptAt = nowMs;
            window.dispatchEvent(new CustomEvent('fueltankstate:confirm_prompt', {
                detail: { active_tank: st.active_tank }
            }));
        }
    }

    /**
     * Debit `intMs` of burn at `gph` from the tanks. If the pilot switched tanks
     * inside the interval, the burn is split at the switch point instead of being
     * credited to whichever tank is active now. Sets last_sample_at / last_burn_at
     * and the imbalance flag. Returns false if a debit was refused (invalid tank).
     */
    static _integrate(st, gph, intMs, nowMs, intervalStartMs) {
        if (intMs > 0) {
            const burned = gph * (intMs / 1000) / 3600;
            const switchMs = st.tank_switched_at ? FuelTankState._ms(st.tank_switched_at) : null;
            const preSwitchTank = st.pre_switch_tank;
            st.pre_switch_tank = null; // consume regardless of outcome below
            const lenMs = nowMs - intervalStartMs;
            if (preSwitchTank && Number.isFinite(switchMs) && lenMs > 0 &&
                switchMs > intervalStartMs && switchMs < nowMs) {
                const burnedPre = burned * ((switchMs - intervalStartMs) / lenMs);
                if (!FuelTankState._debitTank(preSwitchTank, burnedPre)) return false;
                if (!FuelTankState._debitActiveTank(burned - burnedPre)) return false;
            } else if (!FuelTankState._debitActiveTank(burned)) {
                return false;
            }
        }
        st.last_sample_at = FuelTankState._iso(nowMs);
        st.last_burn_at = st.last_sample_at;
        const diff = Math.abs(st.left_gal - st.right_gal);
        st.imbalance = (diff > FuelTankState.IMBALANCE_GAL && st.left_gal > 2 && st.right_gal > 2);
        return true;
    }

    /**
     * Debit `gallons` from a specific tank ('L' or 'R'). An invalid tank (legacy
     * 'BOTH' state, or corruption) tells us nothing about which tank is draining;
     * splitting the burn would understate the feeding tank, so this stops and
     * flags requires_confirm instead of guessing.
     * @param {'L'|'R'} tank
     * @param {number} gallons
     * @returns {boolean} true if the debit was applied
     */
    static _debitTank(tank, gallons) {
        if (tank === 'L' || tank === 'R') {
            const st = FuelTankState._state;
            if (typeof st.burned_since_init_gal === 'number') st.burned_since_init_gal += gallons;
        }
        if (tank === 'L') {
            FuelTankState._state.left_gal = Math.max(0, FuelTankState._state.left_gal - gallons);
            return true;
        } else if (tank === 'R') {
            FuelTankState._state.right_gal = Math.max(0, FuelTankState._state.right_gal - gallons);
            return true;
        }
        FuelTankState._state.requires_confirm = true;
        FuelTankState._save();
        FuelTankState._fire();
        return false;
    }

    /**
     * Debit `gallons` from whichever tank is active. Shared by onSample() and
     * applyDroppedBurn() so the two burn-accounting paths can't drift apart.
     * @param {number} gallons
     * @returns {boolean} true if the debit was applied
     */
    static _debitActiveTank(gallons) {
        return FuelTankState._debitTank(FuelTankState._state.active_tank, gallons);
    }

    /**
     * Switch the active fuel tank.
     * @param {'L'|'R'} tank - this airframe has no BOTH selector position
     */
    static switchTank(tank) {
        FuelTankState._load();
        if (!FuelTankState._state) return;
        if (tank !== 'L' && tank !== 'R') return;   // no BOTH on this aircraft
        const prevTank = FuelTankState._state.active_tank;
        if ((prevTank === 'L' || prevTank === 'R') && prevTank !== tank) {
            FuelTankState._state.pre_switch_tank = prevTank;
            FuelTankState._state.tank_switched_at = new Date().toISOString();
            // A comms-gap correction accrued while feeding from prevTank has no record of
            // which tank was active for each contributing gap — dropped_burn_estimate_gal
            // is one running total, not a per-tank breakdown. Once the pilot has moved to
            // a different tank it can no longer be safely auto-attributed to either one.
            // Same "stop and ask, don't guess" rule as an invalid active_tank; clears on
            // the next fresh measurement via init().
            if ((FuelTankState._state.dropped_burn_estimate_gal || 0) > 0.05) {
                FuelTankState._state.dropped_burn_ambiguous = true;
            }
        }
        FuelTankState._state.active_tank = tank;
        FuelTankState._save();
        FuelTankState._fire();
    }

    /**
     * Apply a pilot-confirmed correction for fuel burned during a comms gap
     * (tracked in dropped_burn_estimate_gal by onSample() but never auto-applied —
     * the gap-time estimate extrapolates from whatever GPH arrived right after the
     * gap, which may not represent what was actually happening during it, so this
     * requires the pilot to review/edit the amount before it touches the gauge).
     * Subtracts from the active tank and reduces the outstanding estimate by the
     * same amount; does not touch the inactive tank. Refuses while
     * requires_confirm is set — same rationale as onSample(): a stale or
     * unconfirmed tank selection means we can't safely say which tank to charge.
     * requires_confirm can also become true as a SIDE EFFECT of this very call
     * (an invalid active_tank caught by _debitActiveTank()), so callers must
     * check the return value rather than assuming a call that didn't throw
     * actually applied anything.
     * @param {number} gallons - pilot-confirmed (or edited) correction amount
     * @returns {boolean} true if the correction was actually applied
     */
    static applyDroppedBurn(gallons) {
        FuelTankState._load();
        if (!FuelTankState._state || FuelTankState._state.requires_confirm || !(gallons > 0)) return false;
        if (FuelTankState._state.dropped_burn_ambiguous) return false;
        if (!FuelTankState._debitActiveTank(gallons)) return false;
        if (typeof FuelTankState._state.dropped_applied_since_init_gal === 'number') {
            FuelTankState._state.dropped_applied_since_init_gal += gallons;
        }
        FuelTankState._state.dropped_burn_estimate_gal =
            Math.max(0, (FuelTankState._state.dropped_burn_estimate_gal || 0) - gallons);
        FuelTankState._save();
        FuelTankState._fire();
        return true;
    }

    /** True if a tank switch occurred while a comms-gap correction was still
     *  outstanding, making it unsafe to auto-attribute to either tank. Clears
     *  on the next init() (fresh tic measurement or fuel stop). */
    static isDroppedBurnAmbiguous() {
        FuelTankState._load();
        return !!(FuelTankState._state && FuelTankState._state.dropped_burn_ambiguous);
    }


    /**
     * Fuel-flow data stopped (engine:stale / engine:disconnect) or froze (a frame
     * that is not EngineClient.edmCurrent). If the engine was running, the tracked
     * figure stops falling while fuel still burns, so it is marked at once
     * (flow_lost_at, reason 'data' → needsConfirmation() true) instead of 45 min
     * later (STALE_MS). Running: the last CURRENT frame this session had RPM >
     * RUNNING_RPM_MIN, whatever its GPH (FF reads 0 at idle / taxi); with no current
     * frame seen yet this session (`lastCurrentGph` null: app restarted with the data
     * already frozen) the engine model says 'running' and was covered within
     * RECENT_BURN_MS. Engine off (last current RPM ≤ 300, even with residual flow) is
     * not marked. A stuck-sender mark ('zero_flow') becomes 'data': the data stopped.
     * The engine model is set 'running' when marked; covered_at is not moved, so the
     * outage is booked from the last frame.
     * @param {number} nowMs
     * @param {number|null} lastCurrentGph - GPH of the last current frame, null if none
     * @param {number} [lastCurrentRpm] - RPM of that frame (missing → not running)
     * @returns {boolean} true if the state is (now) marked flow-lost
     */
    static markFlowLost(nowMs, lastCurrentGph, lastCurrentRpm) {
        FuelTankState._load();
        const st = FuelTankState._state;
        if (!st) return false;
        if (!st.engine) st.engine = FuelTankState._migrateEngine(st, nowMs);
        if (st.flow_lost_at) {
            if (st.flow_lost_reason === 'zero_flow') {
                st.flow_lost_reason = 'data';
                FuelTankState._save();
                FuelTankState._fire();
            }
            return true;
        }
        let running;
        if (lastCurrentGph != null) {
            running = lastCurrentRpm > FuelTankState.RUNNING_RPM_MIN;
        } else {
            const covMs = FuelTankState._ms(st.engine.covered_at);
            running = st.engine.state === 'running' && Number.isFinite(covMs) &&
                nowMs - covMs >= 0 && nowMs - covMs <= FuelTankState.RECENT_BURN_MS;
        }
        if (!running) return false;
        st.flow_lost_at = FuelTankState._iso(nowMs);
        st.flow_lost_reason = 'data';
        if (st.engine.state !== 'running') {
            st.engine.state = 'running';
            st.engine.since = FuelTankState._iso(nowMs);
        }
        FuelTankState._save();
        FuelTankState._fire();
        return true;
    }

    /** Why flow is lost: 'zero_flow' (stuck sender), 'data' (engine data lost; also
     *  for state stored before flow_lost_reason existed), or null when not lost. */
    static flowLostReason() {
        FuelTankState._load();
        const st = FuelTankState._state;
        if (!st || !st.flow_lost_at) return null;
        return st.flow_lost_reason === 'zero_flow' ? 'zero_flow' : 'data';
    }

    /** True while fuel-flow data is lost with the engine running (markFlowLost). */
    static isFlowLost() {
        FuelTankState._load();
        return !!(FuelTankState._state && FuelTankState._state.flow_lost_at);
    }

    /** Returns a copy of current state, or null if not initialized. */
    static getState() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        const st = FuelTankState._state;
        return st ? { ...st, engine: st.engine ? { ...st.engine } : st.engine } : null;
    }

    /**
     * True if pilot confirmation is required before trusting state.
     * True when: no state exists, requires_confirm flag is set, the last sample is
     * stale (STALE_MS), or fuel-flow data is lost with the engine running
     * (flow_lost_at). Only requires_confirm stops burn integration (the burn is then
     * kept as unbooked running time); flow_lost_at clears at the next frame with
     * flow.
     */
    static needsConfirmation() {
        FuelTankState._load();
        FuelTankState._checkStaleness();
        if (!FuelTankState._state) return true;
        return !!FuelTankState._state.requires_confirm || !!FuelTankState._state.flow_lost_at;
    }

    /** Pilot has confirmed the current state is accurate. */
    static markConfirmed() {
        // Confirms the tank SELECTION ("Still on LEFT tank?" YES, also auto-fired
        // after 60 s) and clears requires_confirm; resets last_sample_at for the
        // STALE_MS rule only. It never touches the engine model: gap booking and
        // the stuck-sender timing use engine.covered_at / zero_flow_since, and
        // flow_lost_at clears only at the next frame with flow or init().
        FuelTankState._load();
        if (!FuelTankState._state) return;
        FuelTankState._state.requires_confirm = false;
        FuelTankState._state.last_sample_at = new Date().toISOString();
        FuelTankState._save();
        FuelTankState._fire();
    }
}
